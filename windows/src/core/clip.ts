// Text cut short for a line on screen.

/**
 * `text` cut to at most `max` UTF-16 units, never between the two halves of
 * an emoji (or any character past U+FFFF): `slice` alone leaves half of one,
 * drawn as a broken glyph.
 */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}
