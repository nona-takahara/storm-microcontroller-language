import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSourceDocumentTexts, resolveProjectSource, type StormworksProjectSource, type SynchronizationPlan } from "../../index.js";
import { loadBundledNodeDefinitions } from "./bundled-definitions-loader.js";
import { applySynchronizationPlanToDisk } from "./synchronization-runner.js";

describe("applySynchronizationPlanToDisk", () => {
  it("validates before replacing the explicit project files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "storm-mcl-sync-"));
    const swNetPath = join(directory, "main.sw-net");
    const projectJsonPath = join(directory, "project.json");
    const source = project(swNetPath);
    await writeFile(swNetPath, source.entryDocument.swNetSource!.text, "utf8");
    await writeFile(projectJsonPath, JSON.stringify(source.project), "utf8");
    const resolved = await resolveProjectSource(source);
    const plan = emptyPlan({ ...source.project, name: "updated" });

    await applySynchronizationPlanToDisk(resolved.value!, plan, {
      projectJsonPath,
      definitions: await loadBundledNodeDefinitions(),
    });

    expect(JSON.parse(await readFile(projectJsonPath, "utf8")).name).toBe("updated");
    expect(await readFile(swNetPath, "utf8")).toBe("module main\nend\n");
  });
});

function project(documentId: string): StormworksProjectSource {
  const parsed = parseSourceDocumentTexts({ documentId, swNetText: "module main\nend\n" });
  return {
    project: {
      formatVersion: "stormworks-project-json-v11", name: "old", description: null,
      width: null, length: null, icon: null, nodes: [],
      submodule: { name: "main", relativePath: "main.sw-net" }, warnings: [],
    },
    entryDocument: parsed.value!, entryModuleId: "main", warnings: [],
  };
}

function emptyPlan(projectDocument: SynchronizationPlan["project"]): SynchronizationPlan {
  return {
    applicable: true, changes: [], warnings: [], conflicts: [], sourceEdits: [],
    project: projectDocument, layouts: [], lua: { create: {}, update: {}, remove: [] },
    summary: { added: 0, removed: 0, updated: 0, rewired: 0, conflicts: 0 }, proposedPositions: {},
  };
}
