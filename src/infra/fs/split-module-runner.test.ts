import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createBundledNodeDefinitions } from "../../core/definitions/bundled.js";
import { parseSwNetDocument } from "../../core/parsers/sw-net.js";
import { hasErrorDiagnostics } from "../../core/diagnostics.js";
import { planSplitModuleFiles, writeSplitModuleFiles } from "./split-module-runner.js";

const definitions = createBundledNodeDefinitions();

const PROJECT_JSON = JSON.stringify({
  formatVersion: "stormworks-project-json-v11",
  name: "test",
  description: null,
  width: null,
  length: null,
  icon: null,
  nodes: [],
  submodule: { name: "main", relativePath: "main.sw-net" },
  warnings: [],
});

const MAIN_SW_NET = [
  "module main",
  '  port in "extIn" : number',
  "",
  "  inst ADD keep : a=1, b=2 -> out=keep_result",
  '  inst ABS gate_one : a="extIn" -> out=gate_result',
  "end",
  "",
].join("\n");

const MAIN_SW_MCL = JSON.stringify({
  formatVersion: "stormworks-sw-mcl-v1",
  moduleId: "main",
  ports: [],
  instances: [
    { id: "keep", type: "ADD", position: { x: 0, y: 0 } },
    { id: "gate_one", type: "ABS", position: { x: 100, y: 50 } },
  ],
  warnings: [],
});

async function setupProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "storm-mcl-split-"));
  await writeFile(join(directory, "project.json"), PROJECT_JSON, "utf8");
  await writeFile(join(directory, "main.sw-net"), MAIN_SW_NET, "utf8");
  await writeFile(join(directory, "main.sw-mcl"), MAIN_SW_MCL, "utf8");
  return directory;
}

describe("planSplitModuleFiles / writeSplitModuleFiles", () => {
  it("splits a gate into a new file, wiring imports and moving its layout position", async () => {
    const directory = await setupProject();
    const result = await planSplitModuleFiles({
      projectJsonPath: join(directory, "project.json"),
      gateInstanceIds: ["gate_one"],
      outSwNetPath: "sub/extracted.sw-net",
      definitions,
    });

    expect(result.diagnostics).toEqual([]);
    const plan = result.value!;
    expect(plan.movedInstanceIds).toEqual(["gate_one"]);
    expect(plan.newModuleId).toBe("extracted");

    // The original document now imports and calls the new module instead of declaring gate_one itself.
    expect(plan.sourceSwNetText).not.toContain("gate_one");
    expect(plan.sourceSwNetText).toContain('import extracted from "./sub/extracted.sw-net"');
    expect(plan.sourceSwNetText).toContain("use extracted.extracted extracted :");
    expect(plan.sourceSwNetText).toContain("inst ADD keep : a=1, b=2 -> out=keep_result");
    expect(() => parseSwNetDocument(plan.sourceSwNetText)).not.toThrow();

    // The new document declares the extracted module with a forwarded boundary port.
    expect(plan.newSwNetText).toContain("module extracted");
    expect(plan.newSwNetText).toContain('port in "extIn" : number');
    expect(plan.newSwNetText).toContain('inst ABS gate_one : a="extIn" -> out=gate_result');
    expect(() => parseSwNetDocument(plan.newSwNetText)).not.toThrow();

    // gate_one's layout position moved from the original .sw-mcl into a new one for "extracted".
    expect(plan.sourceSwMcl?.instances.map((instance) => instance.id)).toEqual(["keep"]);
    expect(plan.newSwMcl?.moduleId).toBe("extracted");
    expect(plan.newSwMcl?.instances).toEqual([{ id: "gate_one", type: "ABS", position: { x: 100, y: 50 } }]);

    await writeSplitModuleFiles(plan);

    expect(await readFile(plan.sourceSwNetPath, "utf8")).toBe(plan.sourceSwNetText);
    expect(await readFile(plan.newSwNetPath, "utf8")).toBe(plan.newSwNetText);
    expect(JSON.parse(await readFile(plan.sourceSwMclPath, "utf8")).instances).toEqual([
      { id: "keep", type: "ADD", position: { x: 0, y: 0 } },
    ]);
    expect(JSON.parse(await readFile(plan.newSwMclPath, "utf8")).instances).toEqual([
      { id: "gate_one", type: "ABS", position: { x: 100, y: 50 } },
    ]);
  });

  it("rejects an --out path without a .sw-net extension", async () => {
    const directory = await setupProject();
    const result = await planSplitModuleFiles({
      projectJsonPath: join(directory, "project.json"),
      gateInstanceIds: ["gate_one"],
      outSwNetPath: "sub/extracted.txt",
      definitions,
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("rejects an --out path that already exists", async () => {
    const directory = await setupProject();
    await writeFile(join(directory, "extracted.sw-net"), "module extracted\nend\n", "utf8");
    const result = await planSplitModuleFiles({
      projectJsonPath: join(directory, "project.json"),
      gateInstanceIds: ["gate_one"],
      outSwNetPath: "extracted.sw-net",
      definitions,
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
  });

  it("forwards the underlying engine's diagnostics for an unknown gate id", async () => {
    const directory = await setupProject();
    const result = await planSplitModuleFiles({
      projectJsonPath: join(directory, "project.json"),
      gateInstanceIds: ["does_not_exist"],
      outSwNetPath: "extracted.sw-net",
      definitions,
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
  });
});
