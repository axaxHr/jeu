/**
 * Wire protocol constants and input sanitisers shared by client and server.
 * The server re-validates everything; the client uses these only to give
 * instant feedback.
 */

export const PROTOCOL_VERSION = 1;

/** Limits on what a client may send. */
export const LIMITS = Object.freeze({
  nameMin: 2,
  nameMax: 16,
  chatMax: 200,
  chatHistory: 60,
  idsPerCommand: 120,
  tokenLength: 48,
});

const NAME_RE = /^[\p{L}\p{N} _.'-]+$/u;

// Control and invisible characters: C0/C1 controls, Arabic letter mark, Hangul
// fillers (render blank), Mongolian vowel separator, zero-width and bidi marks,
// word joiners, BOM, halfwidth Hangul filler. Built from code points so the
// source file itself never contains invisible characters.
const INVISIBLE_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x061c, 0x061c], [0x115f, 0x1160], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x3164, 0x3164],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0],
];
const CONTROL_RE = new RegExp(`[${INVISIBLE_RANGES
  .map(([a, b]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`))
  .join('')}]`, 'gu');

/** Cyrillic and Greek letters that look like Latin ones (code point → Latin), for duplicate-name checks. */
const CONFUSABLES = new Map([
  [0x0430, 'a'], [0x0432, 'b'], [0x0435, 'e'], [0x043a, 'k'], [0x043c, 'm'], [0x043d, 'h'],
  [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0442, 't'], [0x0443, 'y'], [0x0445, 'x'],
  [0x0456, 'i'], [0x0458, 'j'], [0x0455, 's'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'], [0x04cf, 'l'],
  [0x03b1, 'a'], [0x03b2, 'b'], [0x03b5, 'e'], [0x03b7, 'n'], [0x03b9, 'i'], [0x03ba, 'k'],
  [0x03bc, 'u'], [0x03bd, 'v'], [0x03bf, 'o'], [0x03c1, 'p'], [0x03c4, 't'], [0x03c5, 'u'],
  [0x03c7, 'x'], [0x03b6, 'z'], [0x30, 'o'], [0x31, 'l'], [0x7c, 'l'],
]);

/**
 * Normalise a player name, or return null when it is not acceptable.
 * NFKC composes accents (é stays one letter); leftover combining marks are dropped.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(CONTROL_RE, '').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax) return null;
  if (!NAME_RE.test(name)) return null;
  return name;
}

/**
 * Key used to detect duplicate names regardless of case, accents, spacing and
 * look-alike letters (Cyrillic "а" vs Latin "a", "I" vs "l", "0" vs "o").
 */
export function nameKey(name) {
  const base = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let out = '';
  for (const ch of base) out += CONFUSABLES.get(ch.codePointAt(0)) || ch;
  return out.replace(/i/g, 'l').replace(/[\s_.'-]/g, '');
}

/**
 * Normalise a chat line, or return null when empty / not a string.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function cleanChat(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(CONTROL_RE, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1') // no towers of stacked accents
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.chatMax);
  return text.length > 0 ? text : null;
}

/** Is `raw` a well-formed reconnect token (hex)? */
export function isToken(raw) {
  return typeof raw === 'string' && raw.length === LIMITS.tokenLength && /^[0-9a-f]+$/.test(raw);
}
