// File names that storm-mcl writes are discouraged (not forbidden) from containing a hyphen or any
// non-ASCII character. Writing still succeeds; callers only warn.

export interface OutputFileNameInspection {
  fileName: string;
  // Distinct discouraged characters in order of first appearance; empty when the name is fine.
  discouragedCharacters: string[];
}

// Only the last path segment is inspected: directory names are not the subject of the recommendation.
export function inspectOutputFileName(filePath: string): OutputFileNameInspection {
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  const discouraged = new Set<string>();

  for (const character of fileName) {
    if (character === "-" || character.codePointAt(0)! > 0x7f) {
      discouraged.add(character);
    }
  }

  return { fileName, discouragedCharacters: [...discouraged] };
}
