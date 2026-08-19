import { describe, expect, it } from "vitest";

import { enMessages, jaMessages } from "./messages.js";
import { createTranslator } from "./translator.js";

describe("message catalogs", () => {
  it("keep the English and Japanese key sets identical", () => {
    expect(Object.keys(jaMessages).sort()).toEqual(Object.keys(enMessages).sort());
  });

  it("compiles and formats every ICU message in both languages", () => {
    const numericNames = new Set([
      "count", "documents", "modules", "uses", "kept", "added", "overwritten", "matched",
      "differences", "occurrence", "definitions", "nodes", "links", "submodules",
    ]);

    for (const language of ["en", "ja"] as const) {
      const translator = createTranslator(language);
      for (const messageId of Object.keys(enMessages) as Array<keyof typeof enMessages>) {
        const pattern = language === "en" ? enMessages[messageId] : jaMessages[messageId];
        const names = [...pattern.matchAll(/\{([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]!);
        const sampleArgs = Object.fromEntries(names.map((name) => [name, numericNames.has(name) ? 2 : "value"]));
        expect(() => translator.format(messageId, sampleArgs as never)).not.toThrow();
      }
    }
  });

  it("formats plurals and Japanese messages", () => {
    expect(createTranslator("en").format("cli.resolved", { documents: 1, modules: 2, uses: 1 }))
      .toBe("Resolved 1 document, 2 modules, and 1 use statement.");
    expect(createTranslator("ja").format("cli.typecheckPassed"))
      .toBe("DSLの型チェックに成功しました。");
  });
});
