import { flagBoolean, type ParsedArgs, parseArgs } from "./args";
import { createCliClient } from "./client";
import {
  createClientServeApp,
  describeServe,
  resolveClientServeOptions,
  startClientServe,
} from "./commands/client-serve";
import {
  type CommandContext,
  type CommandHandler,
  configCommands,
  domainCommands,
  keyCommands,
  mailCommands,
} from "./commands";
import { resolveConfig } from "./config";
import { CliError, ExitCode } from "./exit-codes";
import { colorize } from "./output";

const VERSION = "0.1.0";

const HELP = `mailcal - self-hosted mail on Cloudflare Workers

Usage
  mailcal <command> <subcommand> [flags]

Commands
  client serve                Serve the browser mail client locally
  domain list|add|verify      Manage mail domains
  key list|create|revoke      Manage API keys
  mail list|show|send|fetch   Read and send mail
  config show|set             Manage local CLI configuration

Global flags
  --endpoint <url>            Deployment base URL ($MAILCAL_ENDPOINT)
  --api-key <key>             API key ($MAILCAL_API_KEY)
  --json                      Machine-readable output
  --help, --version

client serve flags
  --port <n>                  Listen port (default 5173)
  --host <addr>               Listen address (default 127.0.0.1)
  --dist <dir>                Serve an alternate build
  --open                      Open a browser on start
  --allow-remote              Permit a non-loopback host; disables API key
                              injection, since a key-injecting proxy on a
                              reachable address is an open relay for that key

mail list flags
  --limit <n>                 Messages to show (default 20)
  --from <addr>               Sender filter
  --to <addr>                 Recipient filter, cc NOT included
  --recipient <addr>          Recipient filter, cc/bcc included
  --search <text>             Full text over subject, snippet and body
  --has-attachment            Only messages with attachments
  --no-attachment             Only messages without attachments
  --attachment-kind <k>       image|video|audio|pdf|document|spreadsheet|
                              presentation|archive|text|calendar|other
                              (repeatable, or comma-separated)
  --tag <name>                Tag filter by name (repeatable)
  --include-spam              Include spam in the listing
  --spam-only                 Only spam (the junk folder)
  --mailing-list              Only mailing-list messages
  --status <s>                draft|sent|received (repeatable/comma-sep)
  --unread                    Unread only

mail fetch flags
  --limit <n>                 Messages per poll (default 20)
  --ack                       Acknowledge after printing
  --watch                     Poll continuously
  --interval <s>              Seconds between polls (default 30)

mail send flags
  --from <addr>               Sender (must be within a MAIL_SEND scope)
  --to/--cc/--bcc <addr>      Recipients; repeatable
  --subject <text>            Subject
  --text <body>               Plain-text body
  --text-file <path>          Read the body from a file, or - for stdin
  --attach <path>             Attach a file; repeatable

key create flags
  --scope <spec>              CAPABILITY[:domain[:pattern]]; repeatable
  --expires-in <dur>          e.g. 30d, 12h, 45m
`;

const COMMAND_GROUPS: ReadonlyMap<
  string,
  ReadonlyMap<string, CommandHandler>
> = new Map([
  ["domain", domainCommands],
  ["key", keyCommands],
  ["mail", mailCommands],
  ["config", configCommands],
]);

/** `client serve` is handled separately because it binds a port and never
 * returns, so it has no place in the request/response command tables. */
async function runClientServe(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): Promise<ExitCode> {
  const config = await resolveConfig(args, env);
  const options = resolveClientServeOptions(args, config);
  const app = createClientServeApp(options);
  const handle = startClientServe(options, app);

  console.log(describeServe(options));
  if (options.open) {
    console.log(`Open ${handle.url} in your browser.`);
  }
  // Resolves only on signal; the listener owns the process from here.
  await new Promise<void>((resolveSignal) => {
    const stop = (): void => {
      handle.stop();
      resolveSignal();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return ExitCode.Success;
}

export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<ExitCode> {
  const args = parseArgs(argv);

  if (flagBoolean(args, "version")) {
    console.log(VERSION);
    return ExitCode.Success;
  }
  if (flagBoolean(args, "help") || args.command.length === 0) {
    console.log(HELP);
    return args.command.length === 0 && !flagBoolean(args, "help")
      ? ExitCode.UsageError
      : ExitCode.Success;
  }

  const [group, subcommand] = args.command;

  if (group === "client") {
    if (subcommand !== "serve") {
      throw new CliError(
        `Unknown client subcommand "${subcommand ?? ""}". Try: mailcal client serve`,
        ExitCode.UsageError,
      );
    }
    return runClientServe(args, env);
  }

  const handlers = group === undefined ? undefined : COMMAND_GROUPS.get(group);
  if (handlers === undefined) {
    throw new CliError(
      `Unknown command "${group ?? ""}". Run \`mailcal --help\`.`,
      ExitCode.UsageError,
    );
  }
  const handler =
    subcommand === undefined ? undefined : handlers.get(subcommand);
  if (handler === undefined) {
    throw new CliError(
      `Unknown ${group} subcommand "${subcommand ?? ""}". Available: ${[...handlers.keys()].join(", ")}`,
      ExitCode.UsageError,
    );
  }

  const config = await resolveConfig(args, env);
  const context: CommandContext = {
    args,
    config,
    client: createCliClient(config),
    env,
    json: flagBoolean(args, "json"),
  };
  return handler(context);
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<ExitCode> {
  try {
    return await runCli(argv, env);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(colorize(error.message, "red", env));
      return error.exitCode;
    }
    console.error(
      colorize(
        error instanceof Error ? error.message : "Unexpected error",
        "red",
        env,
      ),
    );
    return ExitCode.GeneralError;
  }
}

// Guarded so tests can import `runCli`/`main` without the process exiting.
if (import.meta.main === true) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exit(code);
  });
}
