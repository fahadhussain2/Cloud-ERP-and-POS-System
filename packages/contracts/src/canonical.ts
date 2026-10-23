// Canonical JSON (platform spec §3, D-082): the exact bytes a device signs and the server verifies.
// Object keys sorted, no whitespace, UTF-8; arrays keep their order; undefined properties are dropped.

export function canonicalJson(value: unknown): string {
  const text = encode(value);
  if (text === undefined) throw new TypeError('canonicalJson: nothing to encode');
  return text;
}

function encode(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} has no JSON form`);
    return JSON.stringify(value);
  }
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return `[${value.map((v) => encode(v) ?? 'null').join(',')}]`;
  if (typeof value === 'object') {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const v = encode((value as Record<string, unknown>)[key]);
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${v}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}
