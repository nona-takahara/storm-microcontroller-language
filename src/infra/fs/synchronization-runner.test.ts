import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it.each([false, true])("updates an imported document's Lua sidecar without touching the entry document (out-dir=%s)", async (useOutputDirectory) => {
    const directory = await mkdtemp(join(tmpdir(), "storm-mcl-sync-imported-"));
    const fixture = await importedLuaProject(directory);
    const plan = emptyPlan(fixture.source.project);
    plan.lua.update = [{
      documentPath: fixture.imported.documentId,
      path: "scripts/controller.lua",
      text: "updated imported body",
    }];
    const outputDirectory = useOutputDirectory ? join(directory, "output") : undefined;

    await applySynchronizationPlanToDisk(fixture.resolved, plan, {
      projectJsonPath: fixture.projectJsonPath,
      outputDirectory,
      definitions: await loadBundledNodeDefinitions(),
    });

    const targetRoot = outputDirectory ?? directory;
    expect(await readFile(join(targetRoot, "scripts/controller.lua"), "utf8")).toBe("entry body");
    expect(await readFile(join(targetRoot, "modules/scripts/controller.lua"), "utf8")).toBe("updated imported body");
    if (outputDirectory) {
      expect(await readFile(join(directory, "modules/scripts/controller.lua"), "utf8")).toBe("old imported body");
    }
  });

  it("removes a sidecar only from its owning imported document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "storm-mcl-sync-imported-remove-"));
    const fixture = await importedLuaProject(directory, false);
    const plan = emptyPlan(fixture.source.project);
    plan.lua.remove = [{ documentPath: fixture.imported.documentId, path: "scripts/controller.lua" }];

    await applySynchronizationPlanToDisk(fixture.resolved, plan, {
      projectJsonPath: fixture.projectJsonPath,
      definitions: await loadBundledNodeDefinitions(),
    });

    expect(await readFile(join(directory, "scripts/controller.lua"), "utf8")).toBe("entry body");
    await expect(readFile(join(directory, "modules/scripts/controller.lua"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains one physical sidecar while another document still references it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "storm-mcl-sync-shared-physical-lua-"));
    const fixture = await importedLuaProject(directory, false, true);
    const plan = emptyPlan(fixture.source.project);
    plan.lua.remove = [{ documentPath: fixture.imported.documentId, path: "scripts/controller.lua" }];

    await applySynchronizationPlanToDisk(fixture.resolved, plan, {
      projectJsonPath: fixture.projectJsonPath,
      definitions: await loadBundledNodeDefinitions(),
    });

    expect(await readFile(join(directory, "scripts/controller.lua"), "utf8")).toBe("shared physical body");
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

async function importedLuaProject(directory: string, importedHasLua = true, sameDirectory = false): Promise<{
  source: StormworksProjectSource;
  imported: StormworksProjectSource["entryDocument"];
  resolved: NonNullable<Awaited<ReturnType<typeof resolveProjectSource>>["value"]>;
  projectJsonPath: string;
}> {
  const mainPath = join(directory, "main.sw-net");
  const importedPath = join(directory, sameDirectory ? "sub.sw-net" : "modules/sub.sw-net");
  const main = parseSourceDocumentTexts({
    documentId: mainPath,
    swNetText: `import helper from "./${sameDirectory ? "sub.sw-net" : "modules/sub.sw-net"}"\nmodule main\n  use helper.main child : ->\nend\n`,
    scripts: { "scripts/controller.lua": sameDirectory ? "shared physical body" : "entry body" },
  }).value!;
  const imported = parseSourceDocumentTexts({
    documentId: importedPath,
    swNetText: importedHasLua
      ? 'module main\n  inst LUA controller (script_ref="scripts/controller.lua") : ->\nend\n'
      : "module main\nend\n",
    scripts: { "scripts/controller.lua": sameDirectory ? "shared physical body" : "old imported body" },
  }).value!;
  const source: StormworksProjectSource = {
    project: {
      formatVersion: "stormworks-project-json-v11", name: "imported", description: null,
      width: null, length: null, icon: null, nodes: [],
      submodule: { name: "main", relativePath: "main.sw-net" }, warnings: [],
    },
    entryDocument: main,
    entryModuleId: "main",
    warnings: [],
  };
  const resolved = await resolveProjectSource(source, { loadImportedDocument: async () => imported });
  if (!resolved.value) throw new Error("imported fixture did not resolve");
  await mkdir(join(directory, "scripts"), { recursive: true });
  if (!sameDirectory) await mkdir(join(directory, "modules/scripts"), { recursive: true });
  await writeFile(mainPath, main.swNetSource!.text, "utf8");
  await writeFile(importedPath, imported.swNetSource!.text, "utf8");
  await writeFile(join(directory, "scripts/controller.lua"), sameDirectory ? "shared physical body" : "entry body", "utf8");
  if (!sameDirectory) await writeFile(join(directory, "modules/scripts/controller.lua"), "old imported body", "utf8");
  const projectJsonPath = join(directory, "project.json");
  await writeFile(projectJsonPath, JSON.stringify(source.project), "utf8");
  return { source, imported, resolved: resolved.value, projectJsonPath };
}

function emptyPlan(projectDocument: SynchronizationPlan["project"]): SynchronizationPlan {
  return {
    applicable: true, changes: [], warnings: [], conflicts: [], sourceEdits: [],
    project: projectDocument, layouts: [], lua: { create: [], update: [], remove: [] },
    summary: { added: 0, removed: 0, updated: 0, rewired: 0, conflicts: 0 }, proposedPositions: {},
  };
}
