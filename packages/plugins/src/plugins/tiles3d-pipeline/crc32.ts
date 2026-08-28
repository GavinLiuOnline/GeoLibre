/**
 * CRC-32 (ISO 3309 / ZIP) of a byte range. Used by the STORE-method zip writer
 * so an exported tileset can be opened by any unzip without extra dependencies.
 */

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[i] = c >>> 0;
}

/** CRC-32 of `bytes`, matching the ZIP / PNG polynomial. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
