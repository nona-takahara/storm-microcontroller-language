import { readFile } from "node:fs/promises";

export async function readUtf8TextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}
