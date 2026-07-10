import { type ProjectJsonDocument, type ProjectJsonSubmoduleDocument } from "../../core/serializers/project-json.js";

// Keep entry-module selection consistent for both project loading and layout generation.
export function selectEntrySubmodule(
  project: ProjectJsonDocument,
  preferredModuleId?: string,
): ProjectJsonSubmoduleDocument | undefined {
  if (preferredModuleId) {
    const preferred =
      project.submodules.find((submodule) => submodule.id === preferredModuleId) ??
      project.submodules.find((submodule) => submodule.name === preferredModuleId);

    if (preferred) {
      return preferred;
    }
  }

  return (
    project.submodules.find((submodule) => submodule.id === "main") ??
    project.submodules.find((submodule) => submodule.name === "main") ??
    (project.submodules.length === 1 ? project.submodules[0] : undefined)
  );
}

// Node exposes file-system failures as objects with code; avoid instanceof checks across runtimes.
export function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
