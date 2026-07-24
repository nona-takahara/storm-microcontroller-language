import { type ProjectJsonDocument, type ProjectJsonSubmoduleDocument } from "../../core/serializers/project-json.js";

// Keep entry-module selection consistent for both project loading and layout generation.
// project.json declares at most one submodule, so this just surfaces it, if any.
export function selectEntrySubmodule(project: ProjectJsonDocument): ProjectJsonSubmoduleDocument | undefined {
  return project.submodule ?? undefined;
}

// Node exposes file-system failures as objects with code; avoid instanceof checks across runtimes.
export function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
