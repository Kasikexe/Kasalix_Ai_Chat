#!/usr/bin/env node
/**
 * generate-certs.cjs — Zero-dependency self-signed TLS certificate generator.
 *
 * Generates `localhost.crt` + `localhost.key` (RSA 2048, SHA-256, valid
 * 10 years, SAN: DNS:localhost, IP:127.0.0.1, IP:::1) using ONLY Node's
 * built-in `crypto` module — no openssl binary or external package needed.
 *
 * Consumers (all auto-generate on demand if the files are missing/expired):
 *   - backend/src/index.ts          → ensureCerts() before HTTPS startup
 *   - server-gui/main.cjs           → ensureCerts() before starting the backend
 *   - server-app-installer/run-server.bat → CLI: bun generate-certs.cjs <dir>
 *   - frontend/vite.config.js/.ts   → ensureCerts() before starting Vite
 *
 * CLI usage:
 *   node  generate-certs.cjs [outputDir]           → writes localhost.crt/.key
 *   node  generate-certs.cjs [certPath] [keyPath]  → writes to exact paths
 *   bun   generate-certs.cjs [outputDir]           → same (used by .bat files)
 *
 * Exit code: 0 when the cert files exist afterwards, 1 when they don't.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── ASN.1 DER helpers ────────────────────────────────────────────────
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Low-level tag writer. klass: 0=universal 2=context-specific. */
function derTag(klass, constructed, tag, body) {
  const t = (klass << 6) | (constructed ? 0x20 : 0) | tag;
  return Buffer.concat([Buffer.from([t]), derLen(body.length), body]);
}

const derSeq = (...parts) => derTag(0, true, 0x10, Buffer.concat(parts));
const derSet = (...parts) => derTag(0, true, 0x11, Buffer.concat(parts));
const derNull = () => Buffer.from([0x05, 0x00]);
const derBool = (v) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);
const derUtf8 = (s) => derTag(0, false, 0x0c, Buffer.from(s, 'utf8'));
const derOctetString = (b) => derTag(0, false, 0x04, b);
const derBitString = (b) => derTag(0, false, 0x03, Buffer.concat([Buffer.from([0x00]), b]));

function derOid(oid) {
  const nums = oid.split('.').map(Number);
  const body = [nums[0] * 40 + nums[1]];
  for (let i = 2; i < nums.length; i++) {
    let n = nums[i];
    const stack = [];
    do { stack.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n > 0);
    for (let j = 0; j < stack.length - 1; j++) stack[j] |= 0x80;
    body.push(...stack);
  }
  return derTag(0, false, 0x06, Buffer.from(body));
}

function derTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const s = `${pad(y % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  // UTCTime only supports 1950–2049; use GeneralizedTime beyond that.
  return y >= 2050 ? derTag(0, false, 0x18, Buffer.from(s, 'ascii'))
                   : derTag(0, false, 0x17, Buffer.from(s, 'ascii'));
}

/** INTEGER from raw bytes — prepends 0x00 if the sign bit would be set. */
function derIntBytes(bytes) {
  const b = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return derTag(0, false, 0x02, b);
}

/** Context-specific [n]: constructed (e.g. version, extensions) or primitive (GeneralName). */
const derContext = (tag, body, constructed) => derTag(2, constructed, tag, body);

/** Name ::= SEQUENCE OF SET OF (OID, UTF8String) */
function buildName(attrs) {
  return derSeq(...attrs.map(([oid, value]) => derSet(derSeq(derOid(oid), derUtf8(value)))));
}

/** '127.0.0.1' → 4 bytes, '::1' → 16 bytes */
function ipToBytes(ip) {
  if (ip.includes('.')) return Buffer.from(ip.split('.').map(Number));
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const all = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  all.forEach((part, i) => buf.writeUInt16BE(parseInt(part || '0', 16), i * 2));
  return buf;
}

// ─── Certificate generation ───────────────────────────────────────────
function generateSelfSigned({ commonName = 'localhost', days = 3650, dnsNames = ['localhost'], ipAddresses = ['127.0.0.1', '::1'] } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x010001,
  });
  // PKCS#1 RSAPublicKey DER (n, e)
  const spkiPub = publicKey.export({ type: 'pkcs1', format: 'der' });

  // AlgorithmIdentifiers
  const sha256WithRSA = derSeq(derOid('1.2.840.113549.1.1.11'), derNull());
  const rsaEncryption = derSeq(derOid('1.2.840.113549.1.1.1'), derNull());

  // Extensions (v3)
  // basicConstraints: CA:FALSE
  const basicConstraintsExt = derSeq(
    derOid('2.5.29.19'),
    derBool(true),
    derOctetString(derSeq())
  );
  // keyUsage: digitalSignature + keyEncipherment
  const keyUsageExt = derSeq(
    derOid('2.5.29.15'),
    derBool(true),
    derOctetString(derBitString(Buffer.from([0xa0])))
  );
  // subjectAltName: DNS:localhost, IP:127.0.0.1, IP:::1
  const generalNames = derSeq(
    ...dnsNames.map((n) => derContext(2, Buffer.from(n, 'utf8'), false)),
    ...ipAddresses.map((ip) => derContext(7, ipToBytes(ip), false))
  );
  const sanExt = derSeq(derOid('2.5.29.17'), derOctetString(generalNames));

  const notBefore = new Date(Date.now() - 86400000); // 1 day back: clock-skew slack
  const notAfter = new Date(notBefore.getTime() + days * 86400000);
  const serial = crypto.randomBytes(16);
  const name = buildName([['2.5.4.3', commonName]]); // CN only

  const tbs = derSeq(
    derContext(0, derIntBytes(Buffer.from([2])), true),       // version [0] EXPLICIT v3
    derIntBytes(serial),                                       // serialNumber
    sha256WithRSA,                                             // signature
    name,                                                      // issuer
    derSeq(derTime(notBefore), derTime(notAfter)),             // validity
    name,                                                      // subject
    derSeq(rsaEncryption, derBitString(spkiPub)),              // subjectPublicKeyInfo
    derContext(3, derSeq(basicConstraintsExt, keyUsageExt, sanExt), true) // extensions [3]
  );

  const signature = crypto.createSign('sha256').update(tbs).sign(privateKey);
  const certDer = derSeq(tbs, sha256WithRSA, derBitString(signature));

  const certPem =
    '-----BEGIN CERTIFICATE-----\n' +
    certDer.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  return { certPem, keyPem, notBefore, notAfter };
}

// ─── ensureCerts: check + generate ────────────────────────────────────
function certIsExpired(certPem) {
  if (typeof crypto.X509Certificate !== 'function') return false; // can't check → assume OK
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return new Date(x509.validTo).getTime() < Date.now();
  } catch { return true; } // unparseable → regenerate
}

/** True when the key parses AND matches the certificate's public key. */
function keyMatchesCert(certPem, keyPem) {
  try {
    if (typeof crypto.X509Certificate !== 'function' || typeof crypto.createPrivateKey !== 'function') return true;
    const certPub = new crypto.X509Certificate(certPem).publicKey;
    const keyPub = crypto.createPublicKey(crypto.createPrivateKey(keyPem));
    return certPub.export({ type: 'spki', format: 'der' }).equals(
      keyPub.export({ type: 'spki', format: 'der' })
    );
  } catch { return false; } // unparseable → regenerate
}

/**
 * Ensure a valid cert/key pair exists at the given paths.
 * Generates both files (creating the directory) when either is missing or
 * the certificate is expired. Returns true if it (re)generated, false if the
 * existing pair was already fine OR generation failed (see options.onError).
 */
function ensureCerts(certPath, keyPath, options = {}) {
  const cert = path.resolve(certPath);
  const key = path.resolve(keyPath);

  if (fs.existsSync(cert) && fs.existsSync(key)) {
    const certPem = fs.readFileSync(cert, 'utf8');
    const keyPem = fs.readFileSync(key, 'utf8');
    // Valid pair already present: not expired, key parses and matches.
    if (!certIsExpired(certPem) && keyMatchesCert(certPem, keyPem)) return false;
  }

  try {
    const { certPem, keyPem } = generateSelfSigned({
      commonName: options.commonName || 'localhost',
      days: options.days || 3650,
      dnsNames: options.dnsNames || ['localhost'],
      ipAddresses: options.ipAddresses || ['127.0.0.1', '::1'],
    });
    fs.mkdirSync(path.dirname(cert), { recursive: true });
    fs.writeFileSync(key, keyPem, { mode: 0o600 });
    fs.writeFileSync(cert, certPem, { mode: 0o644 });
    return true;
  } catch (err) {
    if (typeof options.onError === 'function') options.onError(err);
    return false;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────
const isCliEntry =
  typeof require !== 'undefined' &&
  (require.main === module ||
    (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('generate-certs.cjs')));

if (isCliEntry) {
  const args = process.argv.slice(2);
  let certPath;
  let keyPath;
  if (args.length >= 2) {
    certPath = path.resolve(args[0]);
    keyPath = path.resolve(args[1]);
  } else {
    const dir = path.resolve(args[0] || __dirname);
    certPath = path.join(dir, 'localhost.crt');
    keyPath = path.join(dir, 'localhost.key');
  }

  const created = ensureCerts(certPath, keyPath, {
    onError: (err) => console.error(`[certs] Generation failed: ${err.message}`),
  });

  if (created) {
    console.log(`[certs] Generated self-signed certificate:`);
    console.log(`  ${certPath}`);
    console.log(`  ${keyPath}`);
  } else {
    console.log(`[certs] Certificate OK: ${certPath}`);
  }

  process.exit(fs.existsSync(certPath) && fs.existsSync(keyPath) ? 0 : 1);
}

module.exports = { ensureCerts, generateSelfSigned, certIsExpired, keyMatchesCert };
