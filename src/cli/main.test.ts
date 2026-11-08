import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("warns, but still writes and succeeds, when dsl2xml's output file name has a hyphen or non-ASCII character", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storm-mcl-file-name-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await writeFile(
        join(dir, "project.json"),
        JSON.stringify({
          formatVersion: "stormworks-project-json-v11",
          name: "Probe",
          description: null,
          width: 1,
          length: 1,
          icon: null,
          nodes: [],
          submodule: { name: "main", relativePath: "main.sw-net" },
          warnings: [],
        }),
      );
      await writeFile(join(dir, "main.sw-net"), "module main\nend\n");

      for (const [fileName, expectedWarning] of [
        ["ecu-v01.xml", true],
        ["マイコン.xml", true],
        ["ecu_v01.xml", false],
      ] as const) {
        error.mockClear();
        const outPath = join(dir, fileName);

        expect(await main(["dsl2xml", join(dir, "project.json"), "--out", outPath, "--lang", "en"])).toBe(0);
        expect((await readFile(outPath, "utf8")).startsWith("<?xml")).toBe(true);

        const lines = error.mock.calls.map(([line]) => String(line));
        expect(lines.filter((line) => line.startsWith("[warning] File name ")).length).toBe(expectedWarning ? 1 : 0);
      }

      error.mockClear();
      await main(["dsl2xml", join(dir, "project.json"), "--out", join(dir, "ecu-v01.xml"), "--lang", "ja"]);
      expect(error.mock.calls.map(([line]) => String(line))).toContain(
        '[警告] ファイル名 "ecu-v01.xml" に、ファイル名として推奨されない文字が含まれています: "-"。ファイルはそのまま書き込みました。',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects --dry-run unless xml2dsl synchronization is selected", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["xml2dsl", "input.xml", "--dry-run", "--lang", "en"])).toBe(1);
    expect(log).toHaveBeenCalledWith("Usage:");
  });
});
