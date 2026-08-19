import { type SupportedLanguage } from "../core/i18n/messages.js";

export type LanguageOption = SupportedLanguage | "auto";

export type ExtractLanguageResult =
  | { ok: true; args: string[]; language: LanguageOption }
  | { ok: false; error: "missing" | "duplicate" | "invalid"; value?: string };

export function extractLanguageOption(argv: readonly string[]): ExtractLanguageResult {
  const args: string[] = [];
  let language: LanguageOption | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--lang") {
      args.push(arg!);
      continue;
    }

    if (language !== undefined) {
      return { ok: false, error: "duplicate" };
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: "missing" };
    }
    if (value !== "auto" && value !== "en" && value !== "ja") {
      return { ok: false, error: "invalid", value };
    }

    language = value;
    index += 1;
  }

  return { ok: true, args, language: language ?? "auto" };
}

export function resolveLanguage(
  requested: LanguageOption,
  environment: Readonly<Record<string, string | undefined>>,
  intlLocale: string | undefined,
): SupportedLanguage {
  if (requested !== "auto") {
    return requested;
  }

  for (const candidate of [
    environment.STORM_MCL_LANG,
    environment.LC_ALL,
    environment.LC_MESSAGES,
    environment.LANG,
    intlLocale,
  ]) {
    const parsed = parseLocaleCandidate(candidate);
    if (parsed.kind === "supported" || parsed.kind === "unsupported") {
      return parsed.kind === "supported" ? parsed.language : "en";
    }
  }

  return "en";
}

type ParsedLocale =
  | { kind: "invalid" }
  | { kind: "unsupported" }
  | { kind: "supported"; language: SupportedLanguage };

export function parseLocaleCandidate(value: string | undefined): ParsedLocale {
  if (!value || !value.trim()) {
    return { kind: "invalid" };
  }

  const trimmed = value.trim();
  if (/^(C|POSIX)(?:\..*)?$/i.test(trimmed)) {
    return { kind: "supported", language: "en" };
  }
  if (trimmed === "auto") {
    return { kind: "invalid" };
  }

  const normalized = trimmed.split(".", 1)[0]!.split("@", 1)[0]!.replaceAll("_", "-");
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(normalized)) {
    return { kind: "invalid" };
  }

  const language = normalized.split("-", 1)[0]!.toLowerCase();
  if (language === "en" || language === "ja") {
    return { kind: "supported", language };
  }
  return { kind: "unsupported" };
}

