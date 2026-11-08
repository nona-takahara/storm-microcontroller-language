import { describe, expect, it } from "vitest";

import { inspectOutputFileName } from "./output-file-name.js";

describe("inspectOutputFileName", () => {
  it.each([
    ["out.xml", []],
    ["My_Controller2.xml", []],
    ["ECU-v01.xml", ["-"]],
    ["マイコン.xml", ["マ", "イ", "コ", "ン"]],
    ["a-é-é.xml", ["-", "é"]],
    ["emoji😀.xml", ["😀"]],
  ])("reports the discouraged characters in %s", (path, expected) => {
    expect(inspectOutputFileName(path).discouragedCharacters).toEqual(expected);
  });

  it("inspects only the last path segment, for both separators", () => {
    expect(inspectOutputFileName("ECU-v01/ディレクトリ/out.xml")).toEqual({ fileName: "out.xml", discouragedCharacters: [] });
    expect(inspectOutputFileName("C:\\my-dir\\out-1.xml")).toEqual({ fileName: "out-1.xml", discouragedCharacters: ["-"] });
  });
});
