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
): Diagnostic {
  return {
    severity,
    code,
    message,
    source,
    documentId,
    path,
  };
}

export function createWarningDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
): Diagnostic {
  return createDiagnostic("warning", code, message, source, documentId, path);
}

export function createInfoDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
): Diagnostic {
  return createDiagnostic("info", code, message, source, documentId, path);
}

export function createErrorDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
): Diagnostic {
  return createDiagnostic("error", code, message, source, documentId, path);
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
    return {
      diagnostics: [
        createErrorDiagnostic(
          code,
          error instanceof Error ? error.message : String(error),
          source,
          documentId,
          path,
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
    return {
      diagnostics: [
        createErrorDiagnostic(
          code,
          error instanceof Error ? error.message : String(error),
          source,
          documentId,
          path,
        ),
      ],
    };
  }
}

// Format diagnostics consistently for human-facing CLI/MCP output; include location only when present.
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = [diagnostic.documentId, diagnostic.path].filter((value): value is string => !!value).join(":");
  const suffix = location.length > 0 ? ` (${location})` : "";
  return `[${diagnostic.severity}] ${diagnostic.code}${suffix}: ${diagnostic.message}`;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("\n");
}
