const AVATAR_COLOR_COUNT = 8;

/** The single character shown inside an avatar circle: the first Unicode
 * code point of the trimmed label, uppercased. Using `Array.from` rather
 * than a plain index keeps a multi-byte character (an emoji, a Japanese
 * name) intact instead of slicing a surrogate pair in half. */
export function avatarInitial(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return "?";
  }
  const [first] = Array.from(trimmed);
  return (first ?? "?").toUpperCase();
}

/** A deterministic avatar color class for a seed string (typically an
 * email address), so the same sender always renders with the same color
 * without a lookup table. */
export function avatarClass(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    const codePoint = char.codePointAt(0) ?? 0;
    hash = (hash * 31 + codePoint) | 0;
  }
  const bucket = Math.abs(hash) % AVATAR_COLOR_COUNT;
  return `avatar-c${bucket}`;
}
