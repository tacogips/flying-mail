import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { flagString, hasFlag, type ParsedArgs } from "../args";
import { createCliClient } from "../client";
import type { CommandContext, CommandHandler } from "./index";
import { CliError, ExitCode } from "../exit-codes";
import { printJson, printTable } from "../output";

interface BootstrapAdminResult {
  readonly bootstrapAdmin: {
    readonly secret: string;
    readonly apiKey: { readonly keyPrefix: string };
    readonly user: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
      readonly role: string;
    };
  };
}

const BOOTSTRAP_ADMIN_MUTATION = `mutation($email: String!, $name: String!, $token: String!) {
  bootstrapAdmin(email: $email, name: $name, token: $token) {
    secret
    apiKey { keyPrefix }
    user { id email name role }
  }
}`;

export function validateAdminBootstrapInputs(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): { readonly email: string; readonly name: string; readonly token: string } {
  if (hasFlag(args, "token")) {
    throw new CliError(
      "The bootstrap token must be supplied through FLYING_MAIL_BOOTSTRAP_TOKEN, not a flag.",
      ExitCode.UsageError,
    );
  }
  const email = flagString(args, "email")?.trim();
  const name = flagString(args, "name")?.trim();
  if (email === undefined || email.length === 0) {
    throw new CliError("Missing required --email", ExitCode.UsageError);
  }
  if (name === undefined || name.length === 0) {
    throw new CliError("Missing required --name", ExitCode.UsageError);
  }
  const token = env["FLYING_MAIL_BOOTSTRAP_TOKEN"]?.trim();
  if (token === undefined || token.length === 0) {
    throw new CliError(
      "FLYING_MAIL_BOOTSTRAP_TOKEN is not set (run under kinko exec)",
      ExitCode.UsageError,
    );
  }
  return { email, name, token };
}

async function rejectExistingSecretFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new CliError(
    `Secret file already exists: ${path}`,
    ExitCode.GeneralError,
  );
}

async function bootstrapAdmin(ctx: CommandContext): Promise<ExitCode> {
  const { email, name, token } = validateAdminBootstrapInputs(
    ctx.args,
    ctx.env,
  );

  const secretFile = resolve(
    process.cwd(),
    flagString(ctx.args, "secret-file") ?? ".private/bootstrap-admin-api-key",
  );
  await rejectExistingSecretFile(secretFile);
  await mkdir(dirname(secretFile), { recursive: true });

  const client = createCliClient({
    endpoint: ctx.config.endpoint,
    apiKey: null,
  });
  let data: BootstrapAdminResult;
  try {
    data = await client.request<BootstrapAdminResult>(
      BOOTSTRAP_ADMIN_MUTATION,
      { email, name, token },
    );
  } catch (error) {
    if (error instanceof CliError && error.message.includes(token)) {
      throw new CliError("Bootstrap request failed.", error.exitCode);
    }
    throw error;
  }

  const result = data.bootstrapAdmin;
  try {
    await writeFile(secretFile, `${result.secret}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    throw new CliError(
      `Bootstrap succeeded, but the key could not be stored at ${secretFile}.`,
      ExitCode.GeneralError,
    );
  }

  const output = {
    user: result.user,
    apiKey: { keyPrefix: result.apiKey.keyPrefix },
    secretFile,
  };
  if (ctx.json) {
    printJson(output);
  } else {
    printTable(
      ["ID", "EMAIL", "NAME", "ROLE", "KEY PREFIX", "SECRET FILE"],
      [
        [
          result.user.id,
          result.user.email,
          result.user.name,
          result.user.role,
          result.apiKey.keyPrefix,
          secretFile,
        ],
      ],
    );
  }
  return ExitCode.Success;
}

export const adminCommands: ReadonlyMap<string, CommandHandler> = new Map([
  ["bootstrap", bootstrapAdmin],
]);
