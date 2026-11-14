/**
 * Hand-rolled argument parsing.
 *
 * The CLI's surface is a dozen subcommands and a handful of flags; a
 * dependency for that would be more code to audit than the parser itself,
 * and this way the exact accepted syntax is visible in one file.
 */

export interface ParsedArgs {
  /** Leading non-flag tokens, e.g. `["client", "serve"]`. */
  readonly command: readonly string[];
  /** Flag values, accumulated so a repeated flag keeps every value. */
  readonly flags: ReadonlyMap<string, readonly string[]>;
  /** Non-flag tokens after the command, plus everything after `--`. */
  readonly positionals: readonly string[];
}

/** Flags that never take a value, so `--json list` treats `list` as a
 * positional rather than swallowing it. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "quiet",
  "help",
  "version",
  "open",
  "allow-remote",
  "ack",
  "watch",
  "has-attachment",
  "no-attachment",
  "include-spam",
  "unread",
  "no-catch-all",
  "spam-only",
  "mailing-list",
]);

function normalizeName(token: string): string {
  return token.replace(/^--?/, "");
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let commandDone = false;

  function push(name: string, value: string): void {
    const existing = flags.get(name);
    if (existing === undefined) {
      flags.set(name, [value]);
    } else {
      existing.push(value);
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--") {
      // Everything after `--` is a literal positional, never a flag.
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("-") && token !== "-") {
      commandDone = true;
      const equals = token.indexOf("=");
      if (equals !== -1) {
        push(normalizeName(token.slice(0, equals)), token.slice(equals + 1));
        continue;
      }
      const name = normalizeName(token);
      if (BOOLEAN_FLAGS.has(name)) {
        push(name, "true");
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        // A value-taking flag with nothing after it is treated as a
        // present-but-empty flag rather than silently consuming the next
        // flag as its value.
        push(name, "");
        continue;
      }
      push(name, next);
      index += 1;
      continue;
    }

    if (commandDone) {
      positionals.push(token);
    } else {
      command.push(token);
    }
  }

  return { command, flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name);
  return values?.[values.length - 1];
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** A flag is true when present with no value, or with an explicitly truthy
 * one; `--open=false` is honoured rather than being true-because-present. */
export function flagBoolean(args: ParsedArgs, name: string): boolean {
  const raw = flagString(args, name);
  if (raw === undefined) {
    return false;
  }
  return raw !== "false" && raw !== "0";
}

export function flagList(args: ParsedArgs, name: string): readonly string[] {
  return (args.flags.get(name) ?? []).filter((value) => value.length > 0);
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
