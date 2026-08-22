import { describe, expect, it } from "vitest";

import { createBundledNodeDefinitions } from "../definitions/bundled.js";
import { hasErrorDiagnostics } from "../diagnostics.js";
import { applySwNetTextEdits, createSwNetImportInsertionEdit, parseSwNetSourceDocument } from "../parsers/sw-net-source.js";
import { parseSwNetDocument } from "../parsers/sw-net.js";
import { serializeSwNetDocument } from "../serializers/sw-net-document.js";
import { buildSplitModulePlan } from "./engine.js";

const definitions = createBundledNodeDefinitions();

describe("buildSplitModulePlan", () => {
  it("reports an error when the module does not exist", () => {
    const source = parseSwNetSourceDocument("module main\nend\n");
    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "missing",
      gateInstanceIds: ["a"],
      newModuleId: "extracted",
      newInstanceId: "extracted_1",
      newImportAlias: "extracted_module",
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("reports an error for an empty gate selection", () => {
    const source = parseSwNetSourceDocument("module main\n  inst ABS a : a=1 -> out=r\nend\n");
    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "main",
      gateInstanceIds: [],
      newModuleId: "extracted",
      newInstanceId: "extracted_1",
      newImportAlias: "extracted_module",
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
  });

  it("reports an error for an unknown gate instance id", () => {
    const source = parseSwNetSourceDocument("module main\n  inst ABS a : a=1 -> out=r\nend\n");
    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "main",
      gateInstanceIds: ["nope"],
      newModuleId: "extracted",
      newInstanceId: "extracted_1",
      newImportAlias: "extracted_module",
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
  });

  it("reports an error when the replacement instance id collides with a remaining statement", () => {
    const source = parseSwNetSourceDocument(
      "module main\n  inst ABS a : a=1 -> out=r1\n  inst ABS b : a=r1 -> out=r2\nend\n",
    );
    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "main",
      gateInstanceIds: ["a"],
      newModuleId: "extracted",
      newInstanceId: "b",
      newImportAlias: "extracted_module",
    });

    expect(hasErrorDiagnostics(result.diagnostics)).toBe(true);
  });

  it("defaults the replacement instance id to the new module id, deduping on collision", () => {
    const source = parseSwNetSourceDocument(
      "module main\n  inst ABS a : a=1 -> out=r1\n  inst ABS extracted : a=r1 -> out=r2\nend\n",
    );
    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "main",
      gateInstanceIds: ["a"],
      newModuleId: "extracted",
      newImportAlias: "extracted_module",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.value!.sourceEdits.some((edit) => edit.newText.includes("extracted_2"))).toBe(true);
  });

  it("splits local nets, module-port passthroughs, fan-out, and fully-internal nets correctly", () => {
    const text = [
      'import helper from "./helper.sw-net"',
      "",
      "module main",
      '  port in "extIn" : number',
      '  port out "extOut" : number',
      "",
      "  inst ADD outside_producer : a=1, b=2 -> out=shared_value",
      '  inst ABS gate_in : a=shared_value -> out="extOut"',
      '  inst ABS gate_boundary_in : a="extIn" -> out=fed_forward',
      "  inst ABS gate_internal_chain : a=fed_forward -> out=chain_result",
      "  inst ABS gate_producer : a=2 -> out=fanout_net",
      "  inst ABS gate_consumer : a=fanout_net -> out=consumed_internally",
      "  inst ABS outside_consumer : a=fanout_net -> out=outside_result",
      "  use helper.compute gate_use : a=shared_value -> out=use_result",
      "  inst ABS keep_a : a=1 -> out=keep_net",
      "  inst ABS keep_b : a=keep_net -> out=keep_result",
      "end",
      "",
    ].join("\n");
    const source = parseSwNetSourceDocument(text);

    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "main",
      gateInstanceIds: [
        "gate_in",
        "gate_boundary_in",
        "gate_internal_chain",
        "gate_producer",
        "gate_consumer",
        "gate_use",
      ],
      newModuleId: "extracted",
      newInstanceId: "extracted_1",
      newImportAlias: "extracted_module",
    });

    expect(result.diagnostics).toEqual([]);
    const plan = result.value!;

    expect(plan.movedInstanceIds).toEqual([
      "gate_in",
      "gate_boundary_in",
      "gate_internal_chain",
      "gate_producer",
      "gate_consumer",
      "gate_use",
    ]);

    // Ports: local-in ("shared_value"), boundary-out passthrough ("extOut"), boundary-in passthrough
    // ("extIn"), local-out fan-out ("fanout_net"). Fully-internal nets (fed_forward, chain_result,
    // consumed_internally, use_result) never become ports.
    expect(plan.newModule.ports).toEqual([
      { direction: "in", name: "shared_value", signal: "number" },
      { direction: "out", name: "extOut", signal: "number" },
      { direction: "in", name: "extIn", signal: "number" },
      { direction: "out", name: "fanout_net", signal: "number" },
    ]);

    const statementsById = new Map(plan.newModule.statements.map((statement) => [statement.instanceId, statement]));

    // Local-in crossing net: both extracted readers of "shared_value" now read the new module's own
    // in-port via a string, not the local identifier that no longer reaches its outside producer.
    expect(statementsById.get("gate_in")!.inputs).toEqual([{ key: "a", value: { kind: "string", value: "shared_value" } }]);
    expect(statementsById.get("gate_use")!.inputs).toEqual([{ key: "a", value: { kind: "string", value: "shared_value" } }]);

    // Boundary-in/out passthroughs keep referencing the same bare port name, now the new module's own.
    expect(statementsById.get("gate_boundary_in")!.inputs).toEqual([{ key: "a", value: { kind: "string", value: "extIn" } }]);
    expect(statementsById.get("gate_in")!.outputs).toEqual([{ key: "out", value: { kind: "string", value: "extOut" } }]);

    // Fan-out: the internal producer AND the internal (moved) consumer both redirect through the new
    // out-port -- not just the producer -- because the local identifier no longer exists once the
    // producer stops writing it directly.
    expect(statementsById.get("gate_producer")!.outputs).toEqual([{ key: "out", value: { kind: "string", value: "fanout_net" } }]);
    expect(statementsById.get("gate_consumer")!.inputs).toEqual([{ key: "a", value: { kind: "string", value: "fanout_net" } }]);

    // Fully-internal nets moved together keep their plain identifiers, untouched.
    expect(statementsById.get("gate_boundary_in")!.outputs).toEqual([{ key: "out", value: { kind: "identifier", value: "fed_forward" } }]);
    expect(statementsById.get("gate_internal_chain")!.inputs).toEqual([{ key: "a", value: { kind: "identifier", value: "fed_forward" } }]);
    expect(statementsById.get("gate_internal_chain")!.outputs).toEqual([{ key: "out", value: { kind: "identifier", value: "chain_result" } }]);
    expect(statementsById.get("gate_consumer")!.outputs).toEqual([{ key: "out", value: { kind: "identifier", value: "consumed_internally" } }]);

    // A moved `use` statement keeps its module reference and its own non-crossing output untouched.
    const movedUse = statementsById.get("gate_use")!;
    expect(movedUse.kind).toBe("use");
    if (movedUse.kind === "use") {
      expect(movedUse.moduleRef).toEqual({ kind: "imported", alias: "helper", moduleId: "compute" });
    }
    expect(movedUse.outputs).toEqual([{ key: "out", value: { kind: "identifier", value: "use_result" } }]);

    // The replacement `use` statement forwards every crossing net under the same bare name.
    expect(plan.sourceEdits.length).toBe(7); // 6 removed statements + 1 inserted use statement

    const rewritten = applySwNetTextEdits(source.text, plan.sourceEdits);
    const rewrittenAst = parseSwNetDocument(rewritten);
    const rewrittenMain = rewrittenAst.modules.find((module) => module.id === "main")!;

    // Untouched statements survive byte-for-byte in the rewritten document.
    expect(rewritten).toContain("inst ADD outside_producer : a=1, b=2 -> out=shared_value");
    expect(rewritten).toContain("inst ABS outside_consumer : a=fanout_net -> out=outside_result");
    expect(rewritten).toContain("inst ABS keep_a : a=1 -> out=keep_net");
    expect(rewritten).toContain("inst ABS keep_b : a=keep_net -> out=keep_result");

    const replacementUse = rewrittenMain.statements.find((statement) => statement.instanceId === "extracted_1");
    expect(replacementUse?.kind).toBe("use");
    if (replacementUse?.kind === "use") {
      expect(replacementUse.moduleRef).toEqual({ kind: "imported", alias: "extracted_module", moduleId: "extracted" });
      expect(replacementUse.inputs).toEqual([
        { key: "shared_value", value: { kind: "identifier", value: "shared_value" } },
        { key: "extIn", value: { kind: "string", value: "extIn" } },
      ]);
      expect(replacementUse.outputs).toEqual([
        { key: "extOut", value: { kind: "string", value: "extOut" } },
        { key: "fanout_net", value: { kind: "identifier", value: "fanout_net" } },
      ]);
    }

    // The new module's own document must also parse and serialize back losslessly through the AST
    // (round-trip via the AST-level serializer, since it is a brand-new file, not an edited one).
    const newDocumentText = serializeSwNetDocument({
      imports: [{ alias: "helper", path: "./helper.sw-net" }],
      modules: [plan.newModule],
    });
    expect(() => parseSwNetDocument(newDocumentText)).not.toThrow();

    // The original document, after inserting its own import for the new file, still parses cleanly.
    const withImport = applySwNetTextEdits(
      rewritten,
      [createSwNetImportInsertionEdit(parseSwNetSourceDocument(rewritten), 'import extracted_module from "./extracted.sw-net"')],
    );
    expect(() => parseSwNetDocument(withImport)).not.toThrow();
  });

  it("dedupes a synthesized port name against a same-direction port from a different namespace", () => {
    const text = [
      "module m2",
      '  port in "x" : boolean',
      '  inst ABS reader1 : a="x" -> out=r1',
      "  inst ADD outside_writer : a=1, b=2 -> out=x",
      "  inst ABS reader2 : a=x -> out=r2",
      "end",
      "",
    ].join("\n");
    const source = parseSwNetSourceDocument(text);

    const result = buildSplitModulePlan({
      definitions,
      source,
      moduleId: "m2",
      gateInstanceIds: ["reader1", "reader2"],
      newModuleId: "extracted",
      newInstanceId: "extracted_1",
      newImportAlias: "extracted_module",
    });

    expect(result.diagnostics).toEqual([]);
    const plan = result.value!;

    expect(plan.newModule.ports).toEqual([
      { direction: "in", name: "x", signal: "boolean" },
      { direction: "in", name: "x_2", signal: "number" },
    ]);

    const statementsById = new Map(plan.newModule.statements.map((statement) => [statement.instanceId, statement]));
    expect(statementsById.get("reader1")!.inputs).toEqual([{ key: "a", value: { kind: "string", value: "x" } }]);
    expect(statementsById.get("reader2")!.inputs).toEqual([{ key: "a", value: { kind: "string", value: "x_2" } }]);
  });
});
