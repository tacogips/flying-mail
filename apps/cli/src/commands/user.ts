import { flagString, hasFlag, type ParsedArgs } from "../args";
import { CliError, ExitCode } from "../exit-codes";
import { printJson, printTable } from "../output";
import type { CommandContext, CommandHandler } from "./index";

export const USER_ADMIN_HINT =
  "User administration needs an API key with USER_ADMIN, created by an admin who is still an active ADMIN. Creating and inviting users is only available in the web UI.";

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly active: boolean;
  readonly invitationStatus: string;
}

interface MailRule {
  readonly id: string;
  readonly effect: string;
  readonly addressPattern: string;
  readonly domain: { readonly id: string; readonly name: string } | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

interface TemplateRule {
  readonly id: string;
  readonly capability: string;
  readonly effect: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

interface DetailedUser extends UserRow {
  readonly permissions: readonly MailRule[];
  readonly templatePermissions: readonly TemplateRule[];
}

interface DomainRow {
  readonly id: string;
  readonly name: string;
}

const USER_LIST_QUERY = `query Users {
  users { id email name role active invitationStatus }
}`;
const DOMAIN_LIST_QUERY = `{ domains { id name } }`;
const GLOBAL_FLAGS: readonly string[] = ["json", "endpoint", "api-key"];
const USER_RULES_QUERY = `query User($id: ID!) {
  user(id: $id) {
    id email name role active invitationStatus
    permissions { id effect addressPattern domain { id name } createdByUserId createdAt }
    templatePermissions { id capability effect createdByUserId createdAt }
  }
}`;

export function operands(args: ParsedArgs, skip: number): readonly string[] {
  return [...args.command.slice(skip), ...args.positionals];
}

function usage(message: string): never {
  throw new CliError(message, ExitCode.UsageError);
}

function requireOperands(
  args: ParsedArgs,
  skip: number,
  count: number,
  line: string,
): readonly string[] {
  const values = operands(args, skip);
  if (values.length !== count || values.some((value) => value.length === 0)) {
    usage(`Usage: ${line}`);
  }
  return values;
}

function normalizedFlag(
  args: ParsedArgs,
  name: string,
  accepted: readonly string[],
  usageLine: string,
): string {
  const raw = flagString(args, name)?.trim();
  const value = raw?.toUpperCase();
  if (
    raw === undefined ||
    raw.length === 0 ||
    !accepted.includes(value ?? "")
  ) {
    usage(`Usage: ${usageLine}`);
  }
  return value ?? "";
}

function requireNonEmptyFlag(
  args: ParsedArgs,
  name: string,
  usageLine: string,
): string {
  const value = flagString(args, name)?.trim();
  if (value === undefined || value.length === 0) {
    usage(`Usage: ${usageLine}`);
  }
  return value;
}

function rejectUnexpectedFlags(
  args: ParsedArgs,
  allowed: readonly string[],
  usageLine: string,
): void {
  const unexpected = [...args.flags.keys()].find(
    (name) => !GLOBAL_FLAGS.includes(name) && !allowed.includes(name),
  );
  if (unexpected !== undefined) {
    usage(`Usage: ${usageLine}`);
  }
}

async function resolveUser(ctx: CommandContext, ref: string): Promise<UserRow> {
  const { users } = await ctx.client.request<{
    readonly users: readonly UserRow[];
  }>(USER_LIST_QUERY);
  const byId = users.find((user) => user.id === ref);
  const user =
    byId ??
    users.find(
      (candidate) => candidate.email.toLowerCase() === ref.toLowerCase(),
    );
  if (user === undefined) {
    throw new CliError(`User not found: ${ref}`, ExitCode.NotFoundError);
  }
  return user;
}

async function resolveDomain(
  ctx: CommandContext,
  ref: string,
): Promise<string> {
  const { domains } = await ctx.client.request<{
    readonly domains: readonly DomainRow[];
  }>(DOMAIN_LIST_QUERY);
  const byId = domains.find((domain) => domain.id === ref);
  const domain = byId ?? domains.find((candidate) => candidate.name === ref);
  if (domain === undefined) {
    throw new CliError(`Domain not found: ${ref}`, ExitCode.NotFoundError);
  }
  return domain.id;
}

function userSummary(user: UserRow): void {
  console.log(`id: ${user.id}`);
  console.log(`email: ${user.email}`);
  console.log(`name: ${user.name}`);
  console.log(`role: ${user.role}`);
  console.log(`active: ${user.active ? "yes" : "no"}`);
  console.log(`invitation: ${user.invitationStatus}`);
}

async function listUsers(ctx: CommandContext): Promise<ExitCode> {
  rejectUnexpectedFlags(ctx.args, [], "flying-mail user list [--json]");
  requireOperands(ctx.args, 2, 0, "flying-mail user list [--json]");
  const { users } = await ctx.client.request<{
    readonly users: readonly UserRow[];
  }>(USER_LIST_QUERY);
  if (ctx.json) {
    printJson(users);
  } else {
    printTable(
      ["ID", "EMAIL", "NAME", "ROLE", "ACTIVE", "INVITATION"],
      users.map((user) => [
        user.id,
        user.email,
        user.name,
        user.role,
        user.active ? "yes" : "no",
        user.invitationStatus,
      ]),
    );
  }
  return ExitCode.Success;
}

async function showUser(ctx: CommandContext): Promise<ExitCode> {
  rejectUnexpectedFlags(ctx.args, [], "flying-mail user show <user> [--json]");
  const [ref] = requireOperands(
    ctx.args,
    2,
    1,
    "flying-mail user show <user> [--json]",
  );
  const found = await resolveUser(ctx, ref ?? "");
  const { user } = await ctx.client.request<{ readonly user: DetailedUser }>(
    USER_RULES_QUERY,
    { id: found.id },
  );
  if (ctx.json) {
    printJson(user);
  } else {
    userSummary(user);
    printTable(
      ["ID", "EFFECT", "DOMAIN", "PATTERN"],
      user.permissions.map((rule) => [
        rule.id,
        rule.effect,
        rule.domain?.name ?? "*",
        rule.addressPattern,
      ]),
    );
    printTable(
      ["ID", "CAPABILITY", "EFFECT"],
      user.templatePermissions.map((rule) => [
        rule.id,
        rule.capability,
        rule.effect,
      ]),
    );
  }
  return ExitCode.Success;
}

async function setRole(ctx: CommandContext): Promise<ExitCode> {
  rejectUnexpectedFlags(
    ctx.args,
    [],
    "flying-mail user set-role <user> <role>",
  );
  const [ref, rawRole] = requireOperands(
    ctx.args,
    2,
    2,
    "flying-mail user set-role <user> <ADMIN|MEMBER|VIEWER>",
  );
  const role = rawRole?.toUpperCase();
  if (role === undefined || !["ADMIN", "MEMBER", "VIEWER"].includes(role)) {
    usage("Usage: flying-mail user set-role <user> <ADMIN|MEMBER|VIEWER>");
  }
  const user = await resolveUser(ctx, ref ?? "");
  const result = await ctx.client.request<{
    readonly setUserRole: { readonly email: string; readonly role: string };
  }>(
    `mutation SetRole($id: ID!, $role: UserRole!) {
      setUserRole(id: $id, role: $role) { id email role }
    }`,
    { id: user.id, role },
  );
  console.log(
    `Role of ${result.setUserRole.email} is now ${result.setUserRole.role}.`,
  );
  return ExitCode.Success;
}

async function setActive(
  ctx: CommandContext,
  active: boolean,
): Promise<ExitCode> {
  const action = active ? "activate" : "deactivate";
  rejectUnexpectedFlags(ctx.args, [], `flying-mail user ${action} <user>`);
  const [ref] = requireOperands(
    ctx.args,
    2,
    1,
    `flying-mail user ${action} <user>`,
  );
  const user = await resolveUser(ctx, ref ?? "");
  const result = await ctx.client.request<{
    readonly setUserActive: {
      readonly email: string;
      readonly active: boolean;
    };
  }>(
    `mutation SetActive($id: ID!, $active: Boolean!) {
      setUserActive(id: $id, active: $active) { id email active }
    }`,
    { id: user.id, active },
  );
  console.log(
    `${result.setUserActive.email} is now ${active ? "active" : "inactive"}.`,
  );
  return ExitCode.Success;
}

type RuleAction = "add" | "remove";

function ruleAction(
  args: ParsedArgs,
  group: "rule" | "template-rule",
): RuleAction {
  const action = operands(args, 2)[0];
  if (action !== "add" && action !== "remove") {
    usage(`Usage: flying-mail user ${group} <add|remove> ...`);
  }
  return action;
}

async function mailRule(ctx: CommandContext): Promise<ExitCode> {
  const action = ruleAction(ctx.args, "rule");
  if (action === "add") {
    const [ref] = requireOperands(
      ctx.args,
      3,
      1,
      "flying-mail user rule add <user> --effect <ALLOW|DENY> --pattern <pattern> [--domain <name|id>]",
    );
    rejectUnexpectedFlags(
      ctx.args,
      ["effect", "pattern", "domain"],
      "flying-mail user rule add <user> --effect <ALLOW|DENY> --pattern <pattern> [--domain <name|id>]",
    );
    const effect = normalizedFlag(
      ctx.args,
      "effect",
      ["ALLOW", "DENY"],
      "flying-mail user rule add <user> --effect <ALLOW|DENY> --pattern <pattern> [--domain <name|id>]",
    );
    const addressPattern = requireNonEmptyFlag(
      ctx.args,
      "pattern",
      "flying-mail user rule add <user> --effect <ALLOW|DENY> --pattern <pattern> [--domain <name|id>]",
    );
    const domainRef = flagString(ctx.args, "domain")?.trim();
    if (
      hasFlag(ctx.args, "domain") &&
      (domainRef === undefined || domainRef.length === 0)
    ) {
      usage(
        "Usage: flying-mail user rule add <user> --effect <ALLOW|DENY> --pattern <pattern> [--domain <name|id>]",
      );
    }
    const user = await resolveUser(ctx, ref ?? "");
    const domainId =
      domainRef === undefined ? null : await resolveDomain(ctx, domainRef);
    const result = await ctx.client.request<{
      readonly addUserMailPermission: MailRule;
    }>(
      `mutation AddRule($userId: ID!, $input: UserMailPermissionInput!) {
        addUserMailPermission(userId: $userId, input: $input) { id effect addressPattern domain { id name } createdByUserId createdAt }
      }`,
      { userId: user.id, input: { effect, domainId, addressPattern } },
    );
    if (ctx.json) printJson(result.addUserMailPermission);
    else console.log(`Added rule ${result.addUserMailPermission.id}.`);
    return ExitCode.Success;
  }

  rejectUnexpectedFlags(
    ctx.args,
    [],
    "flying-mail user rule remove <user> <rule-id>",
  );
  const [ref, ruleId] = requireOperands(
    ctx.args,
    3,
    2,
    "flying-mail user rule remove <user> <rule-id>",
  );
  const user = await resolveUser(ctx, ref ?? "");
  const { user: detailed } = await ctx.client.request<{
    readonly user: Pick<DetailedUser, "permissions">;
  }>(`query UserRules($id: ID!) { user(id: $id) { permissions { id } } }`, {
    id: user.id,
  });
  if (!detailed.permissions.some((rule) => rule.id === ruleId)) {
    throw new CliError(
      `Rule ${ruleId ?? ""} does not belong to ${user.email}`,
      ExitCode.NotFoundError,
    );
  }
  await ctx.client.request<{ readonly removeUserMailPermission: boolean }>(
    `mutation RemoveRule($id: ID!) { removeUserMailPermission(id: $id) }`,
    { id: ruleId },
  );
  if (ctx.json) printJson({ id: ruleId, removed: true });
  else console.log(`Removed rule ${ruleId}.`);
  return ExitCode.Success;
}

async function templateRule(ctx: CommandContext): Promise<ExitCode> {
  const action = ruleAction(ctx.args, "template-rule");
  if (action === "add") {
    const [ref] = requireOperands(
      ctx.args,
      3,
      1,
      "flying-mail user template-rule add <user> --capability <TEMPLATE_READ|TEMPLATE_CREATE|TEMPLATE_UPDATE|TEMPLATE_DELETE> --effect <ALLOW|DENY>",
    );
    const line =
      "flying-mail user template-rule add <user> --capability <TEMPLATE_READ|TEMPLATE_CREATE|TEMPLATE_UPDATE|TEMPLATE_DELETE> --effect <ALLOW|DENY>";
    rejectUnexpectedFlags(ctx.args, ["capability", "effect"], line);
    const capability = normalizedFlag(
      ctx.args,
      "capability",
      [
        "TEMPLATE_READ",
        "TEMPLATE_CREATE",
        "TEMPLATE_UPDATE",
        "TEMPLATE_DELETE",
      ],
      line,
    );
    const effect = normalizedFlag(ctx.args, "effect", ["ALLOW", "DENY"], line);
    const user = await resolveUser(ctx, ref ?? "");
    const result = await ctx.client.request<{
      readonly addUserTemplatePermission: TemplateRule;
    }>(
      `mutation AddTemplateRule($userId: ID!, $input: UserTemplatePermissionInput!) {
        addUserTemplatePermission(userId: $userId, input: $input) { id capability effect createdByUserId createdAt }
      }`,
      { userId: user.id, input: { capability, effect } },
    );
    if (ctx.json) printJson(result.addUserTemplatePermission);
    else
      console.log(
        `Added template rule ${result.addUserTemplatePermission.id}.`,
      );
    return ExitCode.Success;
  }

  rejectUnexpectedFlags(
    ctx.args,
    [],
    "flying-mail user template-rule remove <user> <rule-id>",
  );
  const [ref, ruleId] = requireOperands(
    ctx.args,
    3,
    2,
    "flying-mail user template-rule remove <user> <rule-id>",
  );
  const user = await resolveUser(ctx, ref ?? "");
  const { user: detailed } = await ctx.client.request<{
    readonly user: Pick<DetailedUser, "templatePermissions">;
  }>(
    `query UserTemplateRules($id: ID!) { user(id: $id) { templatePermissions { id } } }`,
    {
      id: user.id,
    },
  );
  if (!detailed.templatePermissions.some((rule) => rule.id === ruleId)) {
    throw new CliError(
      `Rule ${ruleId ?? ""} does not belong to ${user.email}`,
      ExitCode.NotFoundError,
    );
  }
  await ctx.client.request<{ readonly removeUserTemplatePermission: boolean }>(
    `mutation RemoveTemplateRule($id: ID!) { removeUserTemplatePermission(id: $id) }`,
    { id: ruleId },
  );
  if (ctx.json) printJson({ id: ruleId, removed: true });
  else console.log(`Removed template rule ${ruleId}.`);
  return ExitCode.Success;
}

function withForbiddenHint(handler: CommandHandler): CommandHandler {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      if (
        error instanceof CliError &&
        error.exitCode === ExitCode.ForbiddenError
      ) {
        throw new CliError(
          `${error.message}\n${USER_ADMIN_HINT}`,
          error.exitCode,
        );
      }
      throw error;
    }
  };
}

export const userCommands: ReadonlyMap<string, CommandHandler> = new Map([
  ["list", withForbiddenHint(listUsers)],
  ["show", withForbiddenHint(showUser)],
  ["set-role", withForbiddenHint(setRole)],
  ["activate", withForbiddenHint((ctx) => setActive(ctx, true))],
  ["deactivate", withForbiddenHint((ctx) => setActive(ctx, false))],
  ["rule", withForbiddenHint(mailRule)],
  ["template-rule", withForbiddenHint(templateRule)],
]);
