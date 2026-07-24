import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSwNetDocument } from "../parsers/sw-net.js";

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("network comparison fixtures", () => {
  it("keeps every hand-authored sw-net fixture syntactically valid", async () => {
    const fixturePaths = await collectFixturePaths(fixtureDirectory, ".sw-net");

    expect(fixturePaths.length).toBeGreaterThanOrEqual(7);

    for (const fixturePath of fixturePaths) {
      const source = readFileSync(fixturePath, "utf8");
      expect(() => parseSwNetDocument(source, { sourceName: fixturePath })).not.toThrow();
    }
  });

  it("includes projects with inline and modular forms of the same circuit", () => {
    for (const projectName of ["project-inline", "project-modular"]) {
      const manifest = JSON.parse(readFileSync(join(fixtureDirectory, projectName, "project.json"), "utf8")) as {
        entry?: unknown;
      };

      expect(manifest.entry).toBe("./main.sw-net");
    }
  });
});

async function collectFixturePaths(directory: string, extension: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectFixturePaths(path, extension) : path.endsWith(extension) ? [path] : [];
    }),
  );

  return paths.flat().sort();
}
