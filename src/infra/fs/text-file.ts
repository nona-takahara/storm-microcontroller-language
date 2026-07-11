// UTF-8 text file helpers shared by the Node-oriented CLI and loader utilities.
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

// Read one UTF-8 text file asynchronously.
export async function readUtf8TextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}


// Write one UTF-8 text file without changing the caller's line-ending policy.
export async function writeUtf8TextFile(filePath: string, text: string): Promise<void> {
  await writeFile(filePath, text, "utf8");
}
