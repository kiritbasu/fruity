/**
 * Escapes text destined for an innerHTML template.
 *
 * Several overlay screens are built as HTML strings, and some of the values in
 * them arrive from the other player over the data channel. Anything from the
 * peer is untrusted input.
 */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Coerces an untrusted value to a finite number within bounds. */
export const safeNumber = (v: unknown, lo: number, hi: number, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
};

/**
 * Reduces an untrusted value to a short, single-line, printable string.
 * Markup characters are dropped here rather than escaped, so the value is inert
 * no matter which of the two rendering paths it later reaches.
 */
export const safeLabel = (v: unknown, maxLength = 24, fallback = ''): string => {
  if (typeof v !== 'string') return fallback;
  const cleaned = v
    // Control characters first, then anything that could open markup.
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>&"'`\\]/g, '')
    .trim()
    .slice(0, maxLength);
  return cleaned || fallback;
};
