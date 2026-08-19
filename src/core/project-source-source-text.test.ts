import { describe, expect, it } from "vitest";

import { parseSourceDocumentTexts } from "./project-source.js";

describe("parseSourceDocumentTexts source retention", () => {
  it("retains the exact sw-net text on the project source document", () => {
    const swNetText = "# retained\r\nmodule main\r\nend\r\n";
    const result = parseSourceDocumentTexts({ documentId: "main.sw-net", swNetText });

    expect(result.value?.swNetSource?.text).toBe(swNetText);
    expect(result.value?.swNet).toBe(result.value?.swNetSource?.ast);
  });
});
