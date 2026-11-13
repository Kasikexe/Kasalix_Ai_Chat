// A single visible, isolated browser view controlled by the active Koding run.
// The backend sends requests through the authenticated chat stream; no HTTP
// listener or preload is exposed to the page being inspected.
const { WebContentsView, ipcMain } = require('electron');

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
}

function installKodingBrowser(getWindow) {
  let active = null;
  const pendingActions = new Map();
  const notify = (event) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('koding-browser-event', event);
  };
  const destroy = () => {
    if (!active) return;
    const old = active;
    active = null;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(old.view); } catch { /* already detached */ }
    }
    if (!old.view.webContents.isDestroyed()) old.view.webContents.close();
    notify({ type: 'closed', sessionId: old.sessionId, conversationId: old.conversationId });
  };
  const trustedSender = (event) => {
    const win = getWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  };
  const announce = (type, extra = {}) => {
    if (active) notify({ type, sessionId: active.sessionId, conversationId: active.conversationId, ...extra });
  };
  const createView = (sessionId, conversationId) => {
    destroy();
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('The Koding window is unavailable.');
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `koding-browser-${sessionId}`,
    } });
    active = { sessionId, conversationId, view, visible: false, attached: false, console: [] };
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    view.setVisible(false);
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.on('will-navigate', (event, url) => { if (!isLocalUrl(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!isLocalUrl(url)) event.preventDefault(); });
    contents.on('did-navigate', (_event, url) => announce('navigated', { url }));
    contents.on('did-navigate-in-page', (_event, url) => announce('navigated', { url }));
    contents.on('console-message', (_event, level, message, line, sourceId) => {
      if (!active || active.view !== view) return;
      active.console.push({ level, message: String(message).slice(0, 1000), line, source: String(sourceId).slice(0, 300) });
      if (active.console.length > 100) active.console.shift();
    });
    announce('open');
    return active;
  };

  ipcMain.handle('koding-browser-bounds', (event, sessionId, bounds) => {
    if (!trustedSender(event) || !active || active.sessionId !== sessionId) return false;
    if (!bounds || bounds.visible !== true) {
      active.view.setVisible(false);
      active.visible = false;
      active.attached = bounds?.attached === true;
      return true;
    }
    const win = getWindow();
    const [width, height] = win.getContentSize();
    const nums = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (!nums.every(Number.isFinite)) return false;
    const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
    const w = Math.max(0, Math.min(width - x, Math.round(bounds.width)));
    const h = Math.max(0, Math.min(height - y, Math.round(bounds.height)));
    if (w < 20 || h < 20) { active.view.setVisible(false); active.visible = false; return false; }
    active.view.setBounds({ x, y, width: w, height: h });
    active.view.setVisible(true);
    active.visible = true;
    active.attached = true;
    return true;
  });

  ipcMain.handle('koding-browser-close', (event, sessionId) => {
    if (!trustedSender(event) || !active || active.sessionId !== sessionId) return false;
    destroy();
    return true;
  });

  ipcMain.handle('koding-browser-state', (event) => {
    if (!trustedSender(event) || !active || active.view.webContents.isDestroyed()) return null;
    return { sessionId: active.sessionId, conversationId: active.conversationId, url: active.view.webContents.getURL() };
  });

  ipcMain.handle('koding-browser-cancel', (event, key) => {
    if (!trustedSender(event)) return false;
    const pending = pendingActions.get(key);
    if (!pending) return false;
    pending.cancelled = true;
    if (active?.sessionId === pending.sessionId && !active.view.webContents.isDestroyed()) active.view.webContents.stop();
    return true;
  });

  ipcMain.handle('koding-browser-action', async (event, request) => {
    if (!trustedSender(event) || !request || typeof request.sessionId !== 'string' || typeof request.key !== 'string') return { ok: false, error: 'Invalid browser request.' };
    const { sessionId, conversationId, args = {} } = request;
    const pending = { sessionId, cancelled: false };
    pendingActions.set(request.key, pending);
    try {
      if (args.operation === 'open') {
        if (!isLocalUrl(args.url)) return { ok: false, error: 'Only local HTTP(S) URLs are allowed.' };
        if (active && active.sessionId !== sessionId && active.attached && active.conversationId !== conversationId) {
          return { ok: false, error: 'Another Koding chat is using the visible browser. Switch to this chat to open its page.' };
        }
        const entry = active?.sessionId === sessionId ? active : createView(sessionId, conversationId);
        announce('open');
        // The renderer must open the pane and position the native view first.
        for (let i = 0; i < 60 && active === entry && !entry.visible && !pending.cancelled; i++) await new Promise((resolve) => setTimeout(resolve, 50));
        if (pending.cancelled) return { ok: false, error: 'Browser action cancelled.' };
        if (active !== entry || !entry.visible) return { ok: false, error: 'Open the matching Koding chat and browser pane to continue.' };
        let loadTimer;
        try {
          await Promise.race([
            entry.view.webContents.loadURL(args.url),
            new Promise((_resolve, reject) => {
              loadTimer = setTimeout(() => {
                try { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.stop(); } catch { /* already closed */ }
                reject(new Error('Page load timed out.'));
              }, 20000);
            }),
          ]);
        } finally {
          clearTimeout(loadTimer);
        }
        if (pending.cancelled) return { ok: false, error: 'Browser action cancelled.' };
        return { ok: true, output: `Opened ${entry.view.webContents.getURL()} in the visible Koding browser.` };
      }
      if (!active || active.sessionId !== sessionId || active.view.webContents.isDestroyed()) return { ok: false, error: 'No browser is open for this chat. Open a static page with browser {"operation":"open","path":"index.html"}, or open the actual local server URL.' };
      if (args.operation === 'close') { destroy(); return { ok: true, output: 'Closed the Koding browser.' }; }
      // The approval modal may have just closed; let the renderer restore the pane.
      for (let i = 0; i < 40 && active && active.sessionId === sessionId && !active.visible && !pending.cancelled; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      if (pending.cancelled) return { ok: false, error: 'Browser action cancelled.' };
      if (!active || active.sessionId !== sessionId) return { ok: false, error: 'The browser was closed.' };
      if (!active.visible) return { ok: false, error: 'The browser pane is hidden. Open the matching Koding chat to continue.' };
      const contents = active.view.webContents;
      if (args.operation === 'inspect') {
        const data = await contents.executeJavaScript(`(() => {
          const selector = (el) => {
            if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
            const parts = []; while (el && el.nodeType === 1 && el !== document.documentElement) {
              let part = el.localName; const parent = el.parentElement;
              if (parent) { const siblings = Array.from(parent.children).filter(x => x.localName === el.localName);
                if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')'; }
              parts.unshift(part); el = parent;
            } return parts.join(' > ');
          };
          const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]'))
            .filter(el => el.getClientRects().length).slice(0, 80).map(el => ({
              selector: selector(el), tag: el.localName,
              label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('name') || '').trim().slice(0, 160),
              type: (el.getAttribute('type') || '').toLowerCase(), disabled: !!el.disabled,
              value: (el.getAttribute('type') || '').toLowerCase() === 'password' ? '[hidden]' : (typeof el.value === 'string' ? el.value.slice(0, 200) : '')
            }));
          return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 8000), elements };
        })()`);
        return { ok: true, output: JSON.stringify(data) };
      }
      if (args.operation === 'click' || args.operation === 'type') {
        if (typeof args.selector !== 'string' || args.selector.length > 4096) return { ok: false, error: 'A valid selector is required.' };
        contents.focus();
        const selector = JSON.stringify(args.selector);
        const prepared = await contents.executeJavaScript(`(() => {
          try {
            const el = document.querySelector(${selector});
            if (!el) return {ok:false,error:'No element matches this selector. Use browser inspect to find a current selector.'};
            if (!el.getClientRects().length) return {ok:false,error:'The matching element is not visible.'};
            if (el.disabled) return {ok:false,error:'The matching element is disabled.'};
            el.scrollIntoView({block:'center',inline:'center'}); el.focus();
            if (el.animate) el.animate([{outline:'3px solid #8b5cf6'},{outline:'3px solid transparent'}], {duration:900});
            ${args.operation === 'type' ? "if (!('value' in el) && !el.isContentEditable) return {ok:false,error:'The matching element is not editable.'}; if (el.select) el.select();" : ''}
            return {ok:true};
          } catch (error) { return {ok:false,error:'Invalid selector or page error: ' + String(error.message || error)}; }
        })()`);
        if (!prepared.ok) return { ok: false, error: `${args.operation} ${args.selector}: ${prepared.error}` };
        if (pending.cancelled) return { ok: false, error: 'Browser action cancelled.' };
        if (args.operation === 'click') {
          await contents.executeJavaScript(`(() => { const el = document.querySelector(${selector}); if (!el) throw new Error('Element disappeared'); el.click(); })()`);
        } else {
          if (typeof args.text !== 'string' || args.text.length > 4096) return { ok: false, error: 'A valid text value is required.' };
          await contents.insertText(args.text);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        for (let i = 0; i < 100 && !contents.isDestroyed() && contents.isLoadingMainFrame(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, output: `${args.operation === 'click' ? 'Clicked' : 'Typed into'} ${args.selector}. Current URL: ${contents.getURL()}` };
      }
      if (args.operation === 'console') return { ok: true, output: JSON.stringify(active.console) };
      if (args.operation === 'screenshot') {
        let image = await contents.capturePage();
        if (image.getSize().width > 1200) image = image.resize({ width: 1200 });
        const imageData = 'data:image/jpeg;base64,' + image.toJPEG(65).toString('base64');
        if (imageData.length > 4_000_000) return { ok: false, error: 'Screenshot is too large to send to the model.' };
        return { ok: true, output: 'Captured the visible browser page.', imageData };
      }
      return { ok: false, error: 'Unknown browser operation.' };
    } catch (error) {
      if (pending.cancelled) return { ok: false, error: 'Browser action cancelled.' };
      const message = error?.message || String(error);
      if (args.operation === 'open' && message.includes('ERR_CONNECTION_REFUSED')) {
        return { ok: false, error: `Could not connect to ${args.url}. No server accepted the connection. For a static HTML page use browser open with path: "index.html"; for a framework app start its dev server and use its actual URL.` };
      }
      return { ok: false, error: `browser ${args.operation}: ${message}` };
    } finally {
      pendingActions.delete(request.key);
    }
  });
  return { destroy };
}

module.exports = { installKodingBrowser, isLocalUrl };
