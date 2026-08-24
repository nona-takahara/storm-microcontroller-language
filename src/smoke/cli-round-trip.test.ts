import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/main.ts", import.meta.url));

const projectJson = JSON.stringify({
  formatVersion: "stormworks-project-json-v11",
  name: "Smoke test",
  description: null,
  width: 2,
  length: 2,
  icon: null,
  nodes: [
    {
      id: "Input Value",
      type: "number_in",
      label: "Input Value",
      description: null,
      nodePosition: { x: 0, y: 0 },
    },
    {
      id: "Output Value",
      type: "number_out",
      label: "Output Value",
      description: null,
      nodePosition: { x: 1, y: 0 },
    },
  ],
  submodule: { name: "main", relativePath: "main.sw-net" },
  warnings: [],
}, null, 2);

const completeSwNet = [
  "module main",
  '  port in "Input Value" : number',
  '  port out "Output Value" : number',
  '  inst ABS absolute : a="Input Value" -> out="Output Value"',
  "end",
  "",
].join("\n");

const locallyChangedSwNet = [
  "module main",
  '  port in "Input Value" : number',
  '  port out "Output Value" : number',
  '  inst ABS absolute (n="stale local label") : a="Input Value" -> out="Output Value"',
  "end",
  "",
].join("\n");

const languageCases = [
  {
    language: "en",
    autoLayoutLabel: "[auto-layout]",
    wroteLabel: "Wrote ",
    synchronizedLabel: "Synchronization applied. Files were written.",
  },
  {
    language: "ja",
    autoLayoutLabel: "[自動レイアウト]",
    wroteLabel: "書き込みました: ",
    synchronizedLabel: "同期を適用し、ファイルを書き込みました。",
  },
] as const;

describe("CLI smoke: DSL -> XML -> DSL synchronization", () => {
  it.each(languageCases)(
    "starts the CLI and completes the round trip in $language",
    async ({ language, autoLayoutLabel, wroteLabel, synchronizedLabel }) => {
      const directory = await mkdtemp(join(tmpdir(), `storm-mcl-smoke-${language}-`));
      const projectPath = join(directory, "project.json");
      const swNetPath = join(directory, "main.sw-net");
      const xmlPath = join(directory, "round-trip.xml");

      await writeFile(projectPath, `${projectJson}\n`, "utf8");
      await writeFile(swNetPath, completeSwNet, "utf8");

      // Running the real TypeScript CLI entry point covers process startup as well as command dispatch.
      const exported = await runCli(["dsl2xml", projectPath, "--out", xmlPath, "--lang", language]);
      expect(exported.stderr).toContain(autoLayoutLabel);
      expect(exported.stderr).toContain(`${wroteLabel}${xmlPath}`);

      const xml = await readFile(xmlPath, "utf8");
      expect(xml).toContain("<microprocessor");
      // No .sw-mcl was supplied, so a concrete position proves that implicit layout reached export.
      expect(xml).toMatch(/<pos\s+x="-?\d+(?:\.\d+)?"\s+y="-?\d+(?:\.\d+)?"/);

      // Force synchronization to rewrite the matched statement without changing the module boundary.
      // Its bindings contain spaces and must be quoted when the incoming XML is materialized back.
      await writeFile(swNetPath, locallyChangedSwNet, "utf8");
      const synchronized = await runCli([
        "xml2dsl",
        xmlPath,
        "--sync-with",
        projectPath,
        "--lang",
        language,
      ]);

      expect(synchronized.stdout).toContain(synchronizedLabel);
      expect(await readFile(swNetPath, "utf8")).toContain(
        'inst ABS absolute : a="Input Value" -> out="Output Value"',
      );
    },
    30_000,
  );
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
