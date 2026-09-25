/**
 * App-level safety net: blocks genuinely illegal or dangerous requests BEFORE
 * they reach the model. The check runs for every chat model — even models with
 * refusal behavior removed — so the app has to enforce the line itself.
 *
 * The check is intentionally conservative: a message is only blocked when it
 * pairs an INTENT ("make", "how to", "recipe", ...) with a DANGEROUS TOPIC
 * (bomb, meth, doxxing, ...). Innocent mentions ("the movie was a bomb", "how
 * do explosives work?", "is my gun legal?") pass through untouched.
 */

// Topic side: the dangerous thing being asked about.
const TOPIC_PATTERNS: RegExp[] = [
  /\b(pipe bomb|pressure[- ]cooker bomb|fertilizer bomb|improvised explosive\b|ied\b|explosive device|detonator|napalm|thermite|gunpowder|dynamite|c[47]\b|plastic explosive|incendiary device)\b/i,
  /\b(bomb|bombs|explosive|explosives)\b/i,
  /\b(meth|methamphetamine|crystal meth|meth lab)\b/i,
  /\b(synthesiz(?:e|ing) (?:drugs?|mdma|lsd|ecstasy|heroin|fentanyl|meth))\b/i,
  /\b(ricin|sarin|nerve agent|anthrax|cyanide)\b/i,
  /\b(doxx?(?:ing|ed)?|swatting)\b/i,
  /\b(identity theft|credit card fraud|carding|counterfeit (?:money|bills|currency)|forg(?:e|ing) (?:a |an |the )?(?:passports?|documents?|ids?))\b/i,
  /\b(gun|firearm|pistol|rifle|shotgun|silencer|suppressor)\b/i,
];

// Intent side: the user actually asking to make/do it, not discussing it.
const INTENT_PATTERNS: RegExp[] = [
  /\bhow (to|do i|can i|would i)\b/i,
  /\b(make|build|create|construct|produce|manufacture|assemble|prepare|synthesize|forge|craft)\b/i,
  /\b(recipe|instructions?|steps?|step[- ]by[- ]step|tutorial|guide)\b/i,
  /\bwant(s|ed)? to (make|build|create|construct|produce|manufacture|synthesize|forge)\b/i,
];

// Whole phrases that are dangerous on their own — no intent word needed.
const DIRECT_PHRASES: RegExp[] = [
  /\b(pipe bomb recipe|meth recipe|meth lab setup|synthesize meth|make meth|build a bomb|make a bomb|build a pipe bomb|make a pipe bomb)\b/i,
];

/**
 * Returns a short human description of the first dangerous request found in the
 * conversation, or null if the message is safe.
 */
export function findDangerousRequest(messages: { role: string; content: string }[]): string | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return null;
  const text = lastUser.content;

  // Direct phrases are blocked regardless of intent wording.
  for (const p of DIRECT_PHRASES) {
    if (p.test(text)) return p.source;
  }

  const hasIntent = INTENT_PATTERNS.some((p) => p.test(text));
  if (!hasIntent) return null;
  const topic = TOPIC_PATTERNS.find((p) => p.test(text));
  if (!topic) return null;
  return topic.source;
}

/** The canned refusal the app streams when a dangerous request is blocked. */
export const DANGEROUS_REPLY =
  "Ah, that one I'm not going to help with — no instructions for bombs, weapons, drugs, or fraud. Ask me about almost anything else though.";
