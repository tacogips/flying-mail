export type CursorComparison = "older" | "same" | "newer" | "different-epoch";

interface ParsedCursor {
  readonly epoch: string;
  readonly sequence: bigint;
}

function parseCursor(cursor: string): ParsedCursor | null {
  const separator = cursor.indexOf(".");
  if (separator <= 0 || separator === cursor.length - 1) return null;

  const epoch = cursor.slice(0, separator);
  const sequenceText = cursor.slice(separator + 1);
  if (!/^\d+$/.test(sequenceText)) return null;

  try {
    return { epoch, sequence: BigInt(sequenceText) };
  } catch {
    return null;
  }
}

export function compareCursors(a: string, b: string): CursorComparison {
  const left = parseCursor(a);
  const right = parseCursor(b);
  if (left === null || right === null || left.epoch !== right.epoch) {
    return "different-epoch";
  }
  if (left.sequence < right.sequence) return "older";
  if (left.sequence > right.sequence) return "newer";
  return "same";
}
