import { type IrVector2 } from "../ir.js";

// These small guards intentionally centralize only JSON-shape checks, not domain-specific
// enum decisions. Keeping enum checks local makes the valid values visible where the schema
// type is defined, while preventing copy/paste drift in the boring object/array/scalar guards.
export function expectRecordWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected object",
): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new ErrorCtor(message, path);
}

export function expectArrayWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected array",
): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }

  throw new ErrorCtor(message, path);
}

export function expectStringWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected string",
): string {
  if (typeof input === "string") {
    return input;
  }

  throw new ErrorCtor(message, path);
}

export function optionalStringWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected string",
): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return expectStringWith(input, path, ErrorCtor, message);
}

export function expectBooleanWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected boolean",
): boolean {
  if (typeof input === "boolean") {
    return input;
  }

  throw new ErrorCtor(message, path);
}

export function expectFiniteNumberWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected finite number",
): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  throw new ErrorCtor(message, path);
}

export function expectIntegerWith<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
  message = "Expected integer",
): number {
  if (typeof input === "number" && Number.isInteger(input)) {
    return input;
  }

  throw new ErrorCtor(message, path);
}

export function parseVector2With<E extends Error>(
  input: unknown,
  path: string,
  ErrorCtor: new (message: string, path: string) => E,
): IrVector2 {
  const record = expectRecordWith(input, path, ErrorCtor);

  return {
    x: expectFiniteNumberWith(record.x, `${path}.x`, ErrorCtor),
    y: expectFiniteNumberWith(record.y, `${path}.y`, ErrorCtor),
  };
}
