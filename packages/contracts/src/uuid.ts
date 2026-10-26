// UUIDv7 made on a device (RFC 9562; CLAUDE.md rule 7): 48 bits of Unix milliseconds, then random bits, so ids sort
// by creation time and sync stays idempotent by id. Works in the browser, the worker and Node (WebCrypto).

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function uuidv7(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  const b = new Uint8Array(16);
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b.set(random.subarray(0, 10), 6);
  b[6] = 0x70 | (b[6]! & 0x0f); // version 7
  b[8] = 0x80 | (b[8]! & 0x3f); // variant 10
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
