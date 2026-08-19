import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "./main.js";

describe("localized CLI shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints Japanese help when explicitly selected", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await main(["--lang", "ja"])).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toContain("使用方法:");
    expect(log.mock.calls.map(([line]) => line)).toContain("specコマンドの出力は常に英語です。");
  });

  it("reports invalid explicit languages in fixed English", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await main(["check-dsl", "project.json", "--lang", "fr"])).toBe(1);
    expect(error).toHaveBeenCalledWith("Invalid --lang value: fr. Expected auto, en, or ja.");
  });
});

