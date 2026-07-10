// Shared diagnostic helpers keep CLI, MCP, and library code on one public shape.
export type StormworksDiagnosticSeverity = "error" | "warning" | "info";
export type StormworksDiagnosticSource = "project" | "sw-net" | "sw-mcl" | "script" | "xml" | "library";

export interface StormworksLibraryDiagnostic {
  severity: StormworksDiagnosticSeverity;
  code: string;
  message: string;
  documentId?: string;
  path?: string;
  source: StormworksDiagnosticSource;
}

export interface StormworksLibraryResult<T> {
  value?: T;
  diagnostics: StormworksLibraryDiagnostic[];
}

// Keep error checks centralized so future severity additions cannot drift between callers.
export function hasErrorDiagnostics(diagnostics: readonly StormworksLibraryDiagnostic[]): boolean {
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
): StormworksLibraryDiagnostic {
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
): StormworksLibraryDiagnostic {
  return createDiagnostic("warning", code, message, source, documentId, path);
}

export function createInfoDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
): StormworksLibraryDiagnostic {
  return createDiagnostic("info", code, message, source, documentId, path);
}

export function createErrorDiagnostic(
  code: string,
  message: string,
  source: StormworksDiagnosticSource,
  documentId?: string,
  path?: string,
): StormworksLibraryDiagnostic {
  return createDiagnostic("error", code, message, source, documentId, path);
}

// Format diagnostics consistently for human-facing CLI/MCP output; include location only when present.
export function formatDiagnostic(diagnostic: StormworksLibraryDiagnostic): string {
  const location = [diagnostic.documentId, diagnostic.path].filter((value): value is string => !!value).join(":");
  const suffix = location.length > 0 ? ` (${location})` : "";
  return `[${diagnostic.severity}] ${diagnostic.code}${suffix}: ${diagnostic.message}`;
}

export function formatDiagnostics(diagnostics: readonly StormworksLibraryDiagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("\n");
}
