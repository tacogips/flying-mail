import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ParsedArgs, flagString } from "./args";

export interface CliConfig {
  readonly endpoint: string | null;
  readonly apiKey: string | null;
}

export function configFilePath(
  env: Record<string, string | undefined>,
): string {
  const override = env["MAILCAL_CONFIG"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const configHome =
    env["XDG_CONFIG_HOME"] ?? join(env["HOME"] ?? homedir(), ".config");
  return join(configHome, "mailcal", "config.json");
}

export async function readConfigFile(
  path: string,
): Promise<Partial<CliConfig>> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record["endpoint"] === "string"
        ? { endpoint: record["endpoint"] }
        : {}),
      ...(typeof record["apiKey"] === "string"
        ? { apiKey: record["apiKey"] }
        : {}),
    };
  } catch {
    // A missing or unreadable config is not an error: flags and environment
    // variables may supply everything needed.
    return {};
  }
}

/** Written `0600`: the file holds an API key, and a world-readable config
 * in a home directory is a credential leak waiting to happen. */
export async function writeConfigFile(
  path: string,
  config: Partial<CliConfig>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

/** Precedence: explicit flags, then environment, then the config file.
 * A flag is the most specific statement of intent, so it wins. */
export async function resolveConfig(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): Promise<CliConfig> {
  const file = await readConfigFile(configFilePath(env));
  return {
    endpoint:
      flagString(args, "endpoint") ??
      env["MAILCAL_ENDPOINT"] ??
      file.endpoint ??
      null,
    apiKey:
      flagString(args, "api-key") ??
      env["MAILCAL_API_KEY"] ??
      file.apiKey ??
      null,
  };
}

/** Renders a key as its non-secret prefix. Used wherever a key would
 * otherwise be printed -- `config show`, error context, the serve banner. */
export function maskApiKey(key: string): string {
  const parts = key.split("_");
  if (parts.length < 3) {
    return "***";
  }
  return `${parts[0]}_${parts[1]}_***`;
}
