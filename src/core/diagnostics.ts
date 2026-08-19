import {
  englishTranslator,
  type LocalizedMessage,
  type MessageArguments,
  type MessageId,
  type Translator,
} from "./i18n/index.js";

// Shared diagnostic helpers keep CLI, MCP, and library code on one public shape.
export type StormworksDiagnosticSeverity = "error" | "warning" | "info";
export type StormworksDiagnosticSource = string;

export interface Diagnostic {
  severity: StormworksDiagnosticSeverity;
  code: string;
  message: string;
  documentId?: string;
  path?: string;
  source: StormworksDiagnosticSource;
  /** Stable localization metadata. `message` remains the canonical English text. */
  messageId?: MessageId;
  messageArgs?: MessageArguments;
}

export interface StormworksLibraryResult<T> {
  value?: T;
  diagnostics: Diagnostic[];
}

// Keep error checks centralized so future severity additions cannot drift between callers.
export function hasErrorDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

// Factory helpers intentionally take source before optional location fields to avoid swapping
// documentId/path at call sites, which produces hard-to-debug misleading diagnostics.
export function createDiagnostic(
  severity: StormworksDiagnosticSeverity,
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
  localized?: LocalizedMessage,
): Diagnostic {
  return {
    severity,
    code,
    message,
    source,
    documentId,
    path,
    ...localized,
  };
}

export function createWarningDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
  localized?: LocalizedMessage,
): Diagnostic {
  return createDiagnostic("warning", code, message, source, documentId, path, localized);
}

export function createInfoDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
  localized?: LocalizedMessage,
): Diagnostic {
  return createDiagnostic("info", code, message, source, documentId, path, localized);
}

export function createErrorDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
  localized?: LocalizedMessage,
): Diagnostic {
  return createDiagnostic("error", code, message, source, documentId, path, localized);
}

// Wrap validator/parser calls that still throw into the library result shape at the boundary.
// This keeps throw-based code local to schema validators while public facades return diagnostics.
export function runToDiagnostics<T>(
  fn: () => T,
  source: StormworksDiagnosticSource,
  code = "OPERATION_FAILED",
  documentId?: string,
  path?: string,
): StormworksLibraryResult<T> {
  try {
    return { value: fn(), diagnostics: [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      diagnostics: [
        createErrorDiagnostic(
          code,
          detail,
          source,
          documentId,
          path,
          { messageId: "diagnostic.operationFailed", messageArgs: { detail } },
        ),
      ],
    };
  }
}

export async function runAsyncToDiagnostics<T>(
  fn: () => Promise<T>,
  source: StormworksDiagnosticSource,
  code = "OPERATION_FAILED",
  documentId?: string,
  path?: string,
): Promise<StormworksLibraryResult<T>> {
  try {
    return { value: await fn(), diagnostics: [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      diagnostics: [
        createErrorDiagnostic(
          code,
          detail,
          source,
          documentId,
          path,
          { messageId: "diagnostic.operationFailed", messageArgs: { detail } },
        ),
      ],
    };
  }
}

// Format diagnostics consistently for human-facing CLI/MCP output; include location only when present.
export function formatDiagnostic(diagnostic: Diagnostic, translator: Translator = englishTranslator): string {
  const location = [diagnostic.documentId, diagnostic.path].filter((value): value is string => !!value).join(":");
  const suffix = location.length > 0 ? ` (${location})` : "";
  const severity = translator.format(`diagnostic.severity.${diagnostic.severity}`);
  const message = diagnostic.messageId
    ? translator.format(diagnostic.messageId, diagnostic.messageArgs as never)
    : diagnostic.message;
  return `[${severity}] ${diagnostic.code}${suffix}: ${message}`;
}

export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  translator: Translator = englishTranslator,
): string {
  return diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, translator)).join("\n");
}
