// Encodes/decodes the microprocessor root's sym0..sym15 attributes as a 16x16 "#"/"." icon.
//
// Confirmed against real Stormworks data (see issue #10): the 16 attributes together form one
// square icon bitmap for the whole project, not a per-pin icon. Row order is visual, top-to-bottom:
// array index 0 is symN's row, index 15 is sym0's row. Within a row, column 0 (leftmost) is
// bit 0 (LSB) and column 15 (rightmost) is bit 15 (MSB) — this left/right assignment is the
// opposite of how a binary number normally reads, but it is what makes the decoded bitmap match
// the icon actually drawn in Stormworks.
export const MICROPROCESSOR_ICON_SIZE = 16;

const BLANK_ICON_ROW = ".".repeat(MICROPROCESSOR_ICON_SIZE);

// Decode one symN integer into a 16-char "#"/"." row (column 0 = bit 0/LSB .. column 15 = bit 15/MSB).
export function decodeMicroprocessorIconRow(value: number): string {
  let row = "";

  for (let bit = 0; bit < MICROPROCESSOR_ICON_SIZE; bit += 1) {
    row += (value >> bit) & 1 ? "#" : ".";
  }

  return row;
}

// Encode a 16-char "#"/"." row back into the symN integer it came from.
export function encodeMicroprocessorIconRow(row: string): number {
  let value = 0;

  for (let bit = 0; bit < MICROPROCESSOR_ICON_SIZE; bit += 1) {
    if (row[bit] === "#") {
      value |= 1 << bit;
    }
  }

  return value;
}

// Build the full 16-row visual icon from sym0..sym15 values (index 15 in the input = sym15,
// which becomes row 0/top of the output). Missing entries (attribute omitted in XML) decode as blank.
export function buildMicroprocessorIconFromSymValues(symValuesByIndex: (number | undefined)[]): string[] {
  const icon: string[] = [];

  for (let rowIndex = 0; rowIndex < MICROPROCESSOR_ICON_SIZE; rowIndex += 1) {
    const symIndex = MICROPROCESSOR_ICON_SIZE - 1 - rowIndex;
    const value = symValuesByIndex[symIndex];
    icon.push(value === undefined ? BLANK_ICON_ROW : decodeMicroprocessorIconRow(value));
  }

  return icon;
}

// Convert the 16-row visual icon back into sym0..sym15 values, indexed by symN (result[N] = symN).
export function microprocessorIconToSymValues(icon: string[]): number[] {
  const symValuesByIndex = new Array<number>(MICROPROCESSOR_ICON_SIZE).fill(0);

  for (let rowIndex = 0; rowIndex < MICROPROCESSOR_ICON_SIZE; rowIndex += 1) {
    const symIndex = MICROPROCESSOR_ICON_SIZE - 1 - rowIndex;
    symValuesByIndex[symIndex] = encodeMicroprocessorIconRow(icon[rowIndex] ?? BLANK_ICON_ROW);
  }

  return symValuesByIndex;
}

// Validate that a value is a well-formed 16x16 icon (16 rows, each 16 chars of only "#"/".").
export function isValidMicroprocessorIconShape(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length !== MICROPROCESSOR_ICON_SIZE) {
    return false;
  }

  return value.every((row) => typeof row === "string" && /^[#.]{16}$/.test(row));
}
