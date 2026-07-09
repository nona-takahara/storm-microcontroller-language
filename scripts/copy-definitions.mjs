import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const destinationDir = resolve(projectRoot, "dist");

const bundledJsonFileNames = ["definitions.json", "node-behavior-notes.json", "stormworks-system-notes.json"];

await mkdir(destinationDir, { recursive: true });

for (const fileName of bundledJsonFileNames) {
  await cp(resolve(projectRoot, "src", fileName), resolve(destinationDir, fileName));
}
