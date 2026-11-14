import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { configFilePath, maskApiKey } from "./config";

export interface WatchCursorKeyInput {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly domainId: string | null;
  readonly address: string | null;
  readonly types?: readonly string[] | null;
}

export function watchCursorsPath(
  env: Record<string, string | undefined>,
): string {
  return join(dirname(configFilePath(env)), "watch-cursors.json");
}

export function cursorKey(input: WatchCursorKeyInput): string {
  const key = `${input.endpoint}|${maskApiKey(input.apiKey)}|${input.domainId ?? "*"}|${input.address ?? "*"}`;
  return input.types === undefined ||
    input.types === null ||
    input.types.length === 0
    ? key
    : `${key}|types=${input.types.join(",")}`;
}

async function readCursorMap(path: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

export async function readCursor(
  path: string,
  key: string,
): Promise<string | null> {
  return (await readCursorMap(path))[key] ?? null;
}

export async function writeCursor(
  path: string,
  key: string,
  cursor: string | null,
): Promise<void> {
  const values = await readCursorMap(path);
  if (cursor === null) {
    delete values[key];
  } else {
    values[key] = cursor;
  }

  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
