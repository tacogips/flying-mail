const ESC = "\u001b[";
const RESET = `${ESC}0m`;

const COLORS: Readonly<Record<string, string>> = {
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  dim: `${ESC}2m`,
};

/** Honours `NO_COLOR` (https://no-color.org) and skips colour when stdout is
 * not a TTY, so piped output stays clean. */
export function colorize(
  text: string,
  color: "red" | "green" | "dim",
  env: Record<string, string | undefined> = process.env,
): string {
  if (env["NO_COLOR"] !== undefined || process.stdout?.isTTY !== true) {
    return text;
  }
  return `${COLORS[color] ?? ""}${text}${RESET}`;
}

/** Column-aligned plain text.
 *
 * Values are truncated rather than wrapped: one long subject line should not
 * destroy the alignment of a whole listing, and a caller who needs the full
 * value has `--json`. */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  maxColumnWidth = 48,
): string {
  const widths = headers.map((header, index) => {
    const longestCell = rows.reduce(
      (longest, row) => Math.max(longest, (row[index] ?? "").length),
      header.length,
    );
    return Math.min(longestCell, maxColumnWidth);
  });

  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        const value =
          cell.length > width
            ? `${cell.slice(0, Math.max(width - 3, 0))}...`
            : cell;
        return value.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  return [
    renderRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(renderRow),
  ].join("\n");
}

export function printTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  console.log(renderTable(headers, rows));
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
