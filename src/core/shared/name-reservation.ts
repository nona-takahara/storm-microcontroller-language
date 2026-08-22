// Generic "pick a unique name" helper shared by the sw-net rewriters that invent new identifiers
// (split's synthesized ports, split/sync's synthesized import aliases): reuse the preferred name when
// free, otherwise suffix with _2, _3, ... until one is free.
export function reserveUniqueName(preferred: string, reserved: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;

  while (reserved.has(candidate)) {
    candidate = `${preferred}_${suffix}`;
    suffix += 1;
  }

  reserved.add(candidate);
  return candidate;
}
