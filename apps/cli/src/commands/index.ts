import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  flagBoolean,
  flagList,
  flagNumber,
  flagString,
  type ParsedArgs,
} from "../args";
import type { CliGraphQLClient } from "../client";
import {
  type CliConfig,
  configFilePath,
  maskApiKey,
  readConfigFile,
  writeConfigFile,
} from "../config";
import { CliError, ExitCode } from "../exit-codes";
import { printJson, printTable } from "../output";

export interface CommandContext {
  readonly args: ParsedArgs;
  readonly config: CliConfig;
  readonly client: CliGraphQLClient;
  readonly env: Record<string, string | undefined>;
  readonly json: boolean;
}

export type CommandHandler = (ctx: CommandContext) => Promise<ExitCode>;

/** `CAPABILITY[:domain[:pattern]]`, e.g.
 * `MAIL_READ:example.com:support@example.com`. Domain and pattern default
 * to "everything", matching the API's own scope defaults. */
export function parseScopeSpec(spec: string): {
  readonly capability: string;
  readonly domainName: string | null;
  readonly addressPattern: string;
} {
  const parts = spec.split(":");
  const capability = parts[0]?.trim().toUpperCase() ?? "";
  if (capability.length === 0) {
    throw new CliError(
      `Invalid scope "${spec}": expected CAPABILITY[:domain[:pattern]]`,
      ExitCode.UsageError,
    );
  }
  const domainName = parts[1]?.trim();
  const addressPattern = parts[2]?.trim();
  return {
    capability,
    domainName:
      domainName === undefined || domainName.length === 0 ? null : domainName,
    addressPattern:
      addressPattern === undefined || addressPattern.length === 0
        ? "*"
        : addressPattern,
  };
}

/** Reads a body from a file, or from stdin when the path is `-`, so a body
 * can be piped in without a temporary file. */
async function readTextSource(path: string): Promise<string> {
  if (path !== "-") {
    return readFile(path, "utf-8");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const DURATION_PATTERN = /^(\d+)([smhd])$/;
const DURATION_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** `30d`, `12h`, `45m` into an absolute ISO timestamp. Takes `now`
 * explicitly so the result is testable. */
export function parseDuration(value: string, now: Date): string {
  const match = DURATION_PATTERN.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) {
    throw new CliError(
      `Invalid duration "${value}": expected a form like 30d, 12h or 45m`,
      ExitCode.UsageError,
    );
  }
  const seconds = Number(amount) * (DURATION_SECONDS[unit] ?? 0);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

interface DomainRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly verifiedAt: string | null;
  readonly messageCount: number;
  readonly dnsRecords: readonly {
    readonly type: string;
    readonly name: string;
    readonly value: string;
    readonly priority: number | null;
  }[];
}

export const domainCommands: ReadonlyMap<string, CommandHandler> = new Map([
  [
    "list",
    async (ctx) => {
      const data = await ctx.client.request<{
        readonly domains: readonly DomainRow[];
      }>(
        `{ domains { id name status verifiedAt messageCount dnsRecords { type name value priority } } }`,
      );
      if (ctx.json) {
        printJson(data.domains);
        return ExitCode.Success;
      }
      printTable(
        ["ID", "NAME", "STATUS", "MESSAGES"],
        data.domains.map((domain) => [
          domain.id,
          domain.name,
          domain.status,
          String(domain.messageCount),
        ]),
      );
      return ExitCode.Success;
    },
  ],
  [
    "add",
    async (ctx) => {
      const name = ctx.args.positionals[0];
      if (name === undefined) {
        throw new CliError(
          "Usage: mailcal domain add <name>",
          ExitCode.UsageError,
        );
      }
      const data = await ctx.client.request<{
        readonly createDomain: DomainRow;
      }>(
        `mutation Create($name: String!, $catchAll: Boolean) {
           createDomain(name: $name, catchAll: $catchAll) {
             id name status verifiedAt messageCount
             dnsRecords { type name value priority }
           }
         }`,
        { name, catchAll: !flagBoolean(ctx.args, "no-catch-all") },
      );
      if (ctx.json) {
        printJson(data.createDomain);
        return ExitCode.Success;
      }
      console.log(`Added ${data.createDomain.name} (${data.createDomain.id}).`);
      console.log(
        "Publish these DNS records, then run `mailcal domain verify`:",
      );
      printTable(
        ["TYPE", "NAME", "VALUE", "PRIORITY"],
        data.createDomain.dnsRecords.map((record) => [
          record.type,
          record.name,
          record.value,
          record.priority === null ? "" : String(record.priority),
        ]),
      );
      return ExitCode.Success;
    },
  ],
  [
    "verify",
    async (ctx) => {
      const id = ctx.args.positionals[0];
      if (id === undefined) {
        throw new CliError(
          "Usage: mailcal domain verify <id>",
          ExitCode.UsageError,
        );
      }
      const data = await ctx.client.request<{
        readonly verifyDomain: { readonly status: string };
      }>(`mutation Verify($id: ID!) { verifyDomain(id: $id) { id status } }`, {
        id,
      });
      console.log(`Domain is now ${data.verifyDomain.status}.`);
      return ExitCode.Success;
    },
  ],
]);

interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly scopes: readonly {
    readonly capability: string;
    readonly addressPattern: string;
    readonly domain: { readonly name: string } | null;
  }[];
}

export const keyCommands: ReadonlyMap<string, CommandHandler> = new Map([
  [
    "list",
    async (ctx) => {
      const data = await ctx.client.request<{
        readonly apiKeys: readonly ApiKeyRow[];
      }>(
        `{ apiKeys { id name keyPrefix lastUsedAt revokedAt scopes { capability addressPattern domain { name } } } }`,
      );
      if (ctx.json) {
        printJson(data.apiKeys);
        return ExitCode.Success;
      }
      printTable(
        ["ID", "NAME", "PREFIX", "SCOPES", "STATUS"],
        data.apiKeys.map((key) => [
          key.id,
          key.name,
          key.keyPrefix,
          key.scopes
            .map(
              (scope) =>
                `${scope.capability}:${scope.domain?.name ?? "*"}:${scope.addressPattern}`,
            )
            .join(" "),
          key.revokedAt === null ? "active" : "revoked",
        ]),
      );
      return ExitCode.Success;
    },
  ],
  [
    "create",
    async (ctx) => {
      const name = ctx.args.positionals[0];
      const specs = flagList(ctx.args, "scope");
      if (name === undefined || specs.length === 0) {
        throw new CliError(
          "Usage: mailcal key create <name> --scope CAPABILITY[:domain[:pattern]] ...",
          ExitCode.UsageError,
        );
      }

      // Scope specs name domains; the API takes ids, so they are resolved
      // here rather than making the caller look them up.
      const domains = await ctx.client.request<{
        readonly domains: readonly {
          readonly id: string;
          readonly name: string;
        }[];
      }>(`{ domains { id name } }`);
      const byName = new Map(
        domains.domains.map((domain) => [domain.name, domain.id]),
      );

      const scopes = specs.map((spec) => {
        const parsed = parseScopeSpec(spec);
        if (parsed.domainName === null) {
          return {
            capability: parsed.capability,
            domainId: null,
            addressPattern: parsed.addressPattern,
          };
        }
        const domainId = byName.get(parsed.domainName);
        if (domainId === undefined) {
          throw new CliError(
            `Unknown domain "${parsed.domainName}" in scope "${spec}"`,
            ExitCode.NotFoundError,
          );
        }
        return {
          capability: parsed.capability,
          domainId,
          addressPattern: parsed.addressPattern,
        };
      });

      const expiresIn = flagString(ctx.args, "expires-in");
      const data = await ctx.client.request<{
        readonly createApiKey: {
          readonly secret: string;
          readonly apiKey: ApiKeyRow;
        };
      }>(
        `mutation Create($input: CreateApiKeyInput!) {
           createApiKey(input: $input) {
             secret
             apiKey { id name keyPrefix lastUsedAt revokedAt
                      scopes { capability addressPattern domain { name } } }
           }
         }`,
        {
          input: {
            name,
            scopes,
            ...(expiresIn === undefined
              ? {}
              : { expiresAt: parseDuration(expiresIn, new Date()) }),
          },
        },
      );

      if (ctx.json) {
        printJson(data.createApiKey);
        return ExitCode.Success;
      }
      console.log(`Created key ${data.createApiKey.apiKey.id}.`);
      console.log("This secret is shown once and cannot be retrieved again:");
      console.log(data.createApiKey.secret);
      return ExitCode.Success;
    },
  ],
  [
    "revoke",
    async (ctx) => {
      const id = ctx.args.positionals[0];
      if (id === undefined) {
        throw new CliError(
          "Usage: mailcal key revoke <id>",
          ExitCode.UsageError,
        );
      }
      await ctx.client.request(
        `mutation Revoke($id: ID!) { revokeApiKey(id: $id) { id revokedAt } }`,
        { id },
      );
      console.log("Key revoked.");
      return ExitCode.Success;
    },
  ],
]);

const ATTACHMENT_KINDS: readonly string[] = [
  "IMAGE",
  "VIDEO",
  "AUDIO",
  "PDF",
  "DOCUMENT",
  "SPREADSHEET",
  "PRESENTATION",
  "ARCHIVE",
  "TEXT",
  "CALENDAR",
  "OTHER",
];

/** Builds a MessageFilter from `mail list` flags. Undefined when no filter
 * flag was given, so a bare listing sends no filter at all. */
async function buildMailListFilter(
  ctx: CommandContext,
): Promise<Record<string, unknown> | undefined> {
  const filter: Record<string, unknown> = {};

  const from = flagString(ctx.args, "from");
  if (from !== undefined && from.length > 0) {
    filter["fromAddress"] = from;
  }
  // --to is the without-cc recipient filter; --recipient includes cc/bcc.
  const to = flagString(ctx.args, "to");
  if (to !== undefined && to.length > 0) {
    filter["toAddress"] = to;
  }
  const recipient = flagString(ctx.args, "recipient");
  if (recipient !== undefined && recipient.length > 0) {
    filter["recipientAddress"] = recipient;
  }
  const search = flagString(ctx.args, "search");
  if (search !== undefined && search.length > 0) {
    filter["search"] = search;
  }
  if (flagBoolean(ctx.args, "has-attachment")) {
    filter["hasAttachment"] = true;
  }
  if (flagBoolean(ctx.args, "no-attachment")) {
    filter["hasAttachment"] = false;
  }
  const kinds = flagList(ctx.args, "attachment-kind")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  const unknownKind = kinds.find((kind) => !ATTACHMENT_KINDS.includes(kind));
  if (unknownKind !== undefined) {
    throw new CliError(
      `Unknown attachment kind "${unknownKind}". Known: ${ATTACHMENT_KINDS.join(", ").toLowerCase()}`,
      ExitCode.UsageError,
    );
  }
  if (kinds.length > 0) {
    filter["attachmentKinds"] = kinds;
  }
  if (flagBoolean(ctx.args, "include-spam")) {
    filter["includeSpam"] = true;
  }
  if (flagBoolean(ctx.args, "spam-only")) {
    filter["spamOnly"] = true;
  }
  if (flagBoolean(ctx.args, "mailing-list")) {
    filter["mailingList"] = true;
  }
  const statuses = flagList(ctx.args, "status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  const unknownStatus = statuses.find(
    (status) => !["DRAFT", "SENT", "RECEIVED"].includes(status),
  );
  if (unknownStatus !== undefined) {
    throw new CliError(
      `Unknown status "${unknownStatus}". Known: draft, sent, received`,
      ExitCode.UsageError,
    );
  }
  if (statuses.length > 0) {
    filter["statuses"] = statuses;
  }
  if (flagBoolean(ctx.args, "unread")) {
    filter["unreadOnly"] = true;
  }

  // Tag flags name tags; the API takes ids, so resolve them here. An
  // unknown name is an error rather than a silent no-op filter.
  const tagNames = flagList(ctx.args, "tag");
  if (tagNames.length > 0) {
    const data = await ctx.client.request<{
      readonly tags: readonly { readonly id: string; readonly name: string }[];
    }>(`{ tags { id name } }`);
    const tagIds = tagNames.map((name) => {
      const tag = data.tags.find(
        (entry) => entry.name.toLowerCase() === name.toLowerCase(),
      );
      if (tag === undefined) {
        throw new CliError(`Unknown tag "${name}"`, ExitCode.NotFoundError);
      }
      return tag.id;
    });
    filter["tagIds"] = tagIds;
  }

  return Object.keys(filter).length === 0 ? undefined : filter;
}

interface MessageRow {
  readonly id: string;
  readonly subject: string;
  readonly snippet: string;
  readonly occurredAt: string;
  readonly fetchStatus: string;
  readonly from: { readonly address: string };
  readonly attachments: readonly {
    readonly id: string;
    readonly fileName: string;
  }[];
}

const MESSAGE_FIELDS = `
  id subject snippet occurredAt fetchStatus
  from { address }
  attachments { id fileName }
`;

function printMessages(rows: readonly MessageRow[], json: boolean): void {
  if (json) {
    printJson(rows);
    return;
  }
  printTable(
    ["ID", "FROM", "SUBJECT", "WHEN"],
    rows.map((message) => [
      message.id,
      message.from.address,
      message.subject,
      message.occurredAt,
    ]),
  );
}

export const mailCommands: ReadonlyMap<string, CommandHandler> = new Map([
  [
    "list",
    async (ctx) => {
      const filter = await buildMailListFilter(ctx);
      const data = await ctx.client.request<{
        readonly messages: { readonly nodes: readonly MessageRow[] };
      }>(
        `query List($first: Int, $filter: MessageFilter) {
           messages(first: $first, filter: $filter) {
             nodes { ${MESSAGE_FIELDS} }
           }
         }`,
        {
          first: flagNumber(ctx.args, "limit") ?? 20,
          ...(filter === undefined ? {} : { filter }),
        },
      );
      printMessages(data.messages.nodes, ctx.json);
      return ExitCode.Success;
    },
  ],
  [
    "show",
    async (ctx) => {
      const id = ctx.args.positionals[0];
      if (id === undefined) {
        throw new CliError(
          "Usage: mailcal mail show <id>",
          ExitCode.UsageError,
        );
      }
      const data = await ctx.client.request<{
        readonly message: {
          readonly subject: string;
          readonly textBody: string | null;
          readonly snippet: string;
          readonly from: { readonly address: string };
          readonly recipients: readonly { readonly address: string }[];
        } | null;
      }>(
        `query Show($id: ID!) {
           message(id: $id) {
             subject textBody snippet
             from { address }
             recipients { address }
           }
         }`,
        { id },
      );
      if (data.message === null) {
        throw new CliError(`No message ${id}`, ExitCode.NotFoundError);
      }
      if (ctx.json) {
        printJson(data.message);
        return ExitCode.Success;
      }
      console.log(`From:    ${data.message.from.address}`);
      console.log(
        `To:      ${data.message.recipients.map((r) => r.address).join(", ")}`,
      );
      console.log(`Subject: ${data.message.subject}`);
      console.log("");
      console.log(data.message.textBody ?? data.message.snippet);
      return ExitCode.Success;
    },
  ],
  [
    "fetch",
    async (ctx) => {
      const limit = flagNumber(ctx.args, "limit") ?? 20;
      const ack = flagBoolean(ctx.args, "ack");
      const watch = flagBoolean(ctx.args, "watch");
      const intervalMs = (flagNumber(ctx.args, "interval") ?? 30) * 1000;

      const pollOnce = async (): Promise<void> => {
        const data = await ctx.client.request<{
          readonly messages: { readonly nodes: readonly MessageRow[] };
        }>(
          `query Pending($first: Int) {
             messages(filter: { fetchStatus: NOT_FETCHED, direction: INBOUND }, first: $first) {
               nodes { ${MESSAGE_FIELDS} }
             }
           }`,
          { first: limit },
        );
        const nodes = data.messages.nodes;
        if (nodes.length === 0) {
          return;
        }
        printMessages(nodes, ctx.json);
        if (ack) {
          // Acknowledged only *after* printing, so a crash mid-print leaves
          // the messages pending for the next run rather than losing them.
          await ctx.client.request(
            `mutation Ack($ids: [ID!]!) {
               markMessagesFetched(messageIds: $ids) { id fetchStatus }
             }`,
            { ids: nodes.map((message) => message.id) },
          );
        }
      };

      await pollOnce();
      if (!watch) {
        return ExitCode.Success;
      }
      for (;;) {
        await new Promise((done) => setTimeout(done, intervalMs));
        await pollOnce();
      }
    },
  ],
  [
    "send",
    async (ctx) => {
      const from = flagString(ctx.args, "from");
      const recipients = flagList(ctx.args, "to");
      const subject = flagString(ctx.args, "subject");
      if (
        from === undefined ||
        recipients.length === 0 ||
        subject === undefined
      ) {
        throw new CliError(
          "Usage: mailcal mail send --from <addr> --to <addr> --subject <text> [--text <body> | --text-file <path>]",
          ExitCode.UsageError,
        );
      }

      const textFile = flagString(ctx.args, "text-file");
      const text =
        textFile === undefined
          ? (flagString(ctx.args, "text") ?? "")
          : await readTextSource(textFile);

      const attachmentIds: string[] = [];
      for (const path of flagList(ctx.args, "attach")) {
        const bytes = new Uint8Array(await readFile(path));
        const uploaded = await ctx.client.uploadAttachment(
          basename(path),
          "application/octet-stream",
          bytes,
        );
        attachmentIds.push(uploaded.id);
      }

      const data = await ctx.client.request<{
        readonly sendMessage: {
          readonly id: string;
          readonly deliveryStatus: string;
        };
      }>(
        `mutation Send($input: SendMessageInput!) {
           sendMessage(input: $input) { id deliveryStatus }
         }`,
        {
          input: {
            from,
            to: recipients,
            subject,
            text,
            ...(flagList(ctx.args, "cc").length > 0
              ? { cc: flagList(ctx.args, "cc") }
              : {}),
            ...(flagList(ctx.args, "bcc").length > 0
              ? { bcc: flagList(ctx.args, "bcc") }
              : {}),
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          },
        },
      );
      if (ctx.json) {
        printJson(data.sendMessage);
        return ExitCode.Success;
      }
      console.log(`${data.sendMessage.deliveryStatus}: ${data.sendMessage.id}`);
      return data.sendMessage.deliveryStatus === "FAILED"
        ? ExitCode.GeneralError
        : ExitCode.Success;
    },
  ],
]);

export const configCommands: ReadonlyMap<string, CommandHandler> = new Map([
  [
    "show",
    async (ctx) => {
      const path = configFilePath(ctx.env);
      const file = await readConfigFile(path);
      const shown = {
        path,
        endpoint: ctx.config.endpoint,
        // Never the full key: `config show` is exactly the command someone
        // runs while screen-sharing.
        apiKey:
          ctx.config.apiKey === null ? null : maskApiKey(ctx.config.apiKey),
        fromFile: {
          endpoint: file.endpoint ?? null,
          apiKey:
            file.apiKey === undefined || file.apiKey === null
              ? null
              : maskApiKey(file.apiKey),
        },
      };
      printJson(shown);
      return ExitCode.Success;
    },
  ],
  [
    "set",
    async (ctx) => {
      const key = ctx.args.positionals[0];
      const value = ctx.args.positionals[1];
      if ((key !== "endpoint" && key !== "apiKey") || value === undefined) {
        throw new CliError(
          "Usage: mailcal config set <endpoint|apiKey> <value>",
          ExitCode.UsageError,
        );
      }
      const path = configFilePath(ctx.env);
      const existing = await readConfigFile(path);
      await writeConfigFile(path, { ...existing, [key]: value });
      console.log(`Saved ${key} to ${path}`);
      return ExitCode.Success;
    },
  ],
]);
