// Small vector helpers used to move between absolute IR coordinates and module-local layout coordinates.
import { type IrVector2 } from "../ir.js";

// Translate one module-local vector back into absolute coordinates by adding the chosen origin.
export function addVector(
  value: IrVector2,
  origin: IrVector2 | null,
): IrVector2 {
  if (!origin) {
    return value;
  }

  return {
    x: value.x + origin.x,
    y: value.y + origin.y,
  };
}
