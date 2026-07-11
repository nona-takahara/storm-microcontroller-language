// Post-tsc build step: copies bundled JSON assets to dist/ and makes the CLI bin entrypoints
// executable. tsc never sets the executable bit on its output, and package managers' own
// bin-linking chmod behavior isn't something to rely on for direct `./dist/...` invocation
// or non-standard install flows, so this is set explicitly and unconditionally.
import { chmod, cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const destinationDir = resolve(projectRoot, "dist");

const bundledJsonFileNames = ["definitions.json", "node-behavior-notes.json", "stormworks-system-notes.json"];
const executableEntrypoints = ["cli/main.js", "mcp/server.js"];

await mkdir(destinationDir, { recursive: true });

for (const fileName of bundledJsonFileNames) {
  await cp(resolve(projectRoot, "src", fileName), resolve(destinationDir, fileName));
}

for (const relativePath of executableEntrypoints) {
  await chmod(resolve(destinationDir, relativePath), 0o755);
}
