// Small vector helpers used to move between absolute IR coordinates and module-local layout coordinates.
import { type IrNode, type IrSubmodule, type IrVector2 } from "../ir.js";

// Derive a representative origin for one submodule canvas from the positions of its visible nodes.
export function deriveSubmoduleCanvasOrigin(
  submodule: IrSubmodule,
  nodeById: Map<string, IrNode>,
): IrVector2 | null {
  const positions = [
    ...submodule.portNodeIds.map((nodeId) => nodeById.get(nodeId)?.position),
    ...submodule.logicNodeIds.map((nodeId) => nodeById.get(nodeId)?.position),
  ].filter((position): position is IrVector2 => position !== undefined);

  if (positions.length === 0) {
    return null;
  }

  const total = positions.reduce(
    (sum, position) => ({
      x: sum.x + position.x,
      y: sum.y + position.y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: total.x / positions.length,
    y: total.y / positions.length,
  };
}

// Translate one vector into module-local coordinates by subtracting a chosen origin.
export function subtractVector(
  value: IrVector2,
  origin: IrVector2 | null,
): IrVector2 {
  if (!origin) {
    return value;
  }

  return {
    x: value.x - origin.x,
    y: value.y - origin.y,
  };
}

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
