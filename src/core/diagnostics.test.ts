import { describe, expect, it } from "vitest";

import { createTranslator } from "./i18n/index.js";
import { createErrorDiagnostic, formatDiagnostic } from "./diagnostics.js";

describe("localized diagnostics", () => {
  it("keeps the canonical English message while localizing CLI rendering", () => {
    const diagnostic = createErrorDiagnostic(
      "FILE_NOT_FOUND",
      "File not found: project.json",
      "cli",
      "project.json",
      undefined,
      { messageId: "diagnostic.fileNotFound", messageArgs: { path: "project.json" } },
    );

    expect(diagnostic.message).toBe("File not found: project.json");
    expect(formatDiagnostic(diagnostic, createTranslator("ja")))
      .toContain("[エラー] FILE_NOT_FOUND (project.json): ファイルが見つかりません: project.json");
    expect(formatDiagnostic(diagnostic)).toContain("[error] FILE_NOT_FOUND");
  });
});

