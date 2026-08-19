import { describe, expect, it } from "vitest";

import { extractLanguageOption, parseLocaleCandidate, resolveLanguage } from "./language.js";

describe("CLI language selection", () => {
  it("accepts --lang before or after the command", () => {
    expect(extractLanguageOption(["--lang", "ja", "check-dsl", "project.json"]))
      .toEqual({ ok: true, args: ["check-dsl", "project.json"], language: "ja" });
    expect(extractLanguageOption(["check-dsl", "project.json", "--lang", "en"]))
      .toEqual({ ok: true, args: ["check-dsl", "project.json"], language: "en" });
  });

  it("rejects missing, duplicate, and invalid explicit values", () => {
    expect(extractLanguageOption(["--lang"])).toEqual({ ok: false, error: "missing" });
    expect(extractLanguageOption(["--lang", "ja", "--lang", "en"]))
      .toEqual({ ok: false, error: "duplicate" });
    expect(extractLanguageOption(["--lang", "fr"]))
      .toEqual({ ok: false, error: "invalid", value: "fr" });
  });

  it.each([
    ["ja", "ja"],
    ["ja_JP", "ja"],
    ["ja_JP.UTF-8", "ja"],
    ["en_US.UTF-8", "en"],
    ["en-GB", "en"],
    ["C", "en"],
    ["POSIX", "en"],
  ] as const)("normalizes %s", (locale, expected) => {
    expect(parseLocaleCandidate(locale)).toEqual({ kind: "supported", language: expected });
  });

  it("uses the documented precedence and skips malformed candidates", () => {
    expect(resolveLanguage("auto", {
      STORM_MCL_LANG: "not_a_valid_locale!",
      LC_ALL: "ja_JP.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
    }, "en-US")).toBe("ja");
  });

  it("falls back to English for a well-formed unsupported locale", () => {
    expect(resolveLanguage("auto", { LC_ALL: "fr_FR.UTF-8", LANG: "ja_JP.UTF-8" }, "ja-JP"))
      .toBe("en");
  });
});

