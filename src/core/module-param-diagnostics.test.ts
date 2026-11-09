import { describe, expect, it } from "vitest";
import { type Diagnostic } from "./diagnostics.js";
import { validateModuleParams } from "./module-param-diagnostics.js";
import { parseSwNetDocument } from "./parsers/sw-net.js";
import { resolveSwNetDocumentGraph, type SwNetDocumentResolver } from "./resolvers/sw-net.js";

async function diagnose(text: string): Promise<Diagnostic[]> {
  const resolver: SwNetDocumentResolver = {
    resolveImportPath: (_from, imported) => imported,
    loadDocument: async () => {
      throw new Error("Unexpected import.");
    },
  };
  const resolution = await resolveSwNetDocumentGraph(
    { path: "/fixture/main.sw-net", document: parseSwNetDocument(text) },
    resolver,
  );
  const diagnostics: Diagnostic[] = [];
  validateModuleParams(resolution, diagnostics);
  return diagnostics;
}

const codes = (diagnostics: Diagnostic[]) => diagnostics.map((diagnostic) => diagnostic.code);

describe("validateModuleParams", () => {
  it("accepts declared parameters, overrides, and forwarded parent parameters", async () => {
    const diagnostics = await diagnose(`
      module leaf(lo=-1, mode="rise")
        port out "y" : number
        inst CLAMP gate (min=@lo, max=1) : value=0 -> out="y"
      end
      module main(base=3)
        port out "y" : number
        use leaf one (lo=@base, mode="fall") : -> y="y"
      end
    `);

    expect(diagnostics).toEqual([]);
  });

  it("reports duplicate and non-scalar parameter declarations", async () => {
    const diagnostics = await diagnose(`
      module main(a=1, a=2, b=[x=1])
        port out "y" : number
      end
    `);

    expect(codes(diagnostics)).toEqual(["PARAM_DUPLICATE", "PARAM_DEFAULT_INVALID"]);
  });

  it("reports references to undeclared parameters", async () => {
    const diagnostics = await diagnose(`
      module main(a=1)
        port out "y" : number
        inst CLAMP gate (min=@missing) : value=0 -> out="y"
      end
    `);

    expect(codes(diagnostics)).toEqual(["PARAM_UNDECLARED"]);
    expect(diagnostics[0]?.messageArgs).toMatchObject({ paramName: "missing", moduleId: "main" });
  });

  it("rejects parameter references in pin bindings", async () => {
    const diagnostics = await diagnose(`
      module main(a=1)
        port out "y" : number
        inst ABS gate : value=@a -> out="y"
      end
    `);

    expect(codes(diagnostics)).toEqual(["PARAM_REF_NOT_ALLOWED"]);
  });

  it("reports unknown use arguments and argument type mismatches", async () => {
    const diagnostics = await diagnose(`
      module leaf(lo=-1)
        port out "y" : number
      end
      module main
        port out "y" : number
        use leaf one (nope=1) : -> y="y"
        use leaf two (lo="text") : -> y="y"
      end
    `);

    expect(codes(diagnostics)).toEqual(["USE_ARG_UNKNOWN", "USE_ARG_TYPE_MISMATCH"]);
  });
});
