// Shared bundled JSON loader for package assets copied next to the built Node helpers.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readUtf8TextFile } from "./text-file.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Keep path derivation in one place so new bundled assets do not drift from postbuild layout.
export function getBundledJsonPath(relativeFileName: string): string {
  return resolve(moduleDir, "../..", relativeFileName);
}

// Parse a bundled JSON asset and optionally enforce its top-level schemaVersion contract.
export async function loadBundledJson<T>(
  relativeFileName: string,
  parse: (raw: unknown) => T,
  expectedSchemaVersion?: string,
): Promise<T> {
  const raw = JSON.parse(await readUtf8TextFile(getBundledJsonPath(relativeFileName))) as unknown;
  const parsed = parse(raw);

  if (expectedSchemaVersion !== undefined) {
    const actual = typeof raw === "object" && raw !== null && "schemaVersion" in raw
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined;

    if (actual !== expectedSchemaVersion) {
      throw new Error(
        `Unsupported bundled schema version for ${relativeFileName}: ${String(actual)}. Expected ${expectedSchemaVersion}.`,
      );
    }
  }

  return parsed;
}
