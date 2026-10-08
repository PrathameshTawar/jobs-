/**
 * pace.js — shared helpers for the auto-apply bots.
 *
 * 1) pace()    : human-like delay so we submit ~1 application per 30–45s
 *                (the bots were firing every 5–15s, which is bot-like).
 *
 * 2) isUnpaid(): paid-internship-only filter. Much broader than the old
 *                regex, which only caught the literal word "unpaid" and
 *                therefore let most unpaid listings through.
 *
 * Usage:
 *   const { pace, isUnpaid } = require('./pace');
 *   ...
 *   await pace(log, 'application submitted');   // logs "[pace] waiting 37s..."
 *   if (isUnpaid(text)) { ...skip... }
 */

// ---- pacing -------------------------------------------------------------
const MIN_DELAY_MS = 30000;  // 30s
const MAX_DELAY_MS = 45000;  // 45s

/**
 * Sleep a random 30–45s so submissions look human.
 * @param {Function} [log]  the bot's log() so the wait lands in its log file
 * @param {string} [label]  what we are waiting after
 * @returns {Promise<number>} milliseconds actually waited
 */
async function pace(log, label = '') {
  const ms = Math.floor(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  const secs = Math.round(ms / 1000);
  const suffix = label ? ` after ${label}` : '';
  if (typeof log === 'function') log(`[pace] cooling down ${secs}s${suffix}...`);
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

// ---- paid-only filter ---------------------------------------------------
const UNPAID_PATTERNS = [
  /\bunpaid\b/i,
  /\bno[\s-]?stipend\b/i,
  /\bwithout[\s-]?stipend\b/i,
  /\bzero[\s-]?stipend\b/i,
  /\bnon[\s-]?paid\b/i,
  /\bnot[\s-]?paid\b/i,
  /\bno\s+pay(?:ment)?\b/i,
  /\bvolunteer\b/i,
  /\bexposure\s+only\b/i,
  /\bcertificate\s+only\b/i,
  /\bfor\s+exposure\b/i,
  /\bacademic\s+credit\b/i,
  /\bstipend\s*(?:is\s*)?(?:not\s+)?(?:applicable|provided|offered)?\s*[:\-–]?\s*(unpaid|nil|none|n\/a|na|zero)\b/i,
  // Zero-amount stipend, either order: "Stipend: 0" / "₹0 stipend".
  // (?<![\d.,]) ensures the 0 is a STANDALONE zero — otherwise the trailing
  // 0 of "15000" would match and we'd wrongly skip paid listings.
  /(?:\bstipend\b|\bsalary\b)[^\n]{0,30}?(?<![\d.,])0(?![\d.])/i,
  /(?<![\d.,])0(?![\d.])[^\n]{0,30}?\bstipend\b/i,
  /\b(?<![\d.,])0(?![\d.])\s*(?:\/\s*month|per\s+month)?\s*stipend\b/i,
];

/**
 * True when the text describes an unpaid / no-stipend internship.
 * @param {string} text  title + card text + (ideally) full description
 */
function isUnpaid(text) {
  const t = String(text || '');
  if (!t) return false;
  return UNPAID_PATTERNS.some((re) => re.test(t));
}

module.exports = { pace, isUnpaid, MIN_DELAY_MS, MAX_DELAY_MS };
