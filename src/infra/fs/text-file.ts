import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

export async function readUtf8TextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export function readUtf8TextFileSync(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export async function writeUtf8TextFile(filePath: string, text: string): Promise<void> {
  await writeFile(filePath, text, "utf8");
}
