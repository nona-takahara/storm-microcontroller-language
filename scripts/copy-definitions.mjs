import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sourcePath = resolve(projectRoot, "src", "definitions.json");
const destinationDir = resolve(projectRoot, "dist");
const destinationPath = resolve(destinationDir, "definitions.json");

await mkdir(destinationDir, { recursive: true });
await cp(sourcePath, destinationPath);
