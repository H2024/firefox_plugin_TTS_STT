/**
 * Reads the onnxruntime-web runtime binary out of the add-on.
 *
 * Firefox can fail to read a large file from a packed extension: the request
 * succeeds (200, `application/wasm`) and then the body read throws
 * "NetworkError when attempting to fetch resource", which onnxruntime-web sees
 * as an empty buffer. So the binary ships as ~1 MB chunks and is stitched back
 * together here; a whole-file copy is used when one is present.
 */

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

export function looksLikeWasm(buffer) {
  if (!buffer || buffer.byteLength < 4) return false;
  const head = new Uint8Array(buffer.slice(0, 4));
  return MAGIC.every((byte, index) => head[index] === byte);
}

/**
 * @returns {Promise<{bytes: ArrayBuffer, how: string}>}
 */
export async function readRuntimeBinary(base, file) {
  // A whole-file copy, if this build ships one.
  try {
    const response = await fetch(base + file);
    if (response.ok) {
      const bytes = await response.arrayBuffer();
      if (looksLikeWasm(bytes)) return { bytes, how: `whole file (${bytes.byteLength} bytes)` };
    }
  } catch {
    /* expected on Firefox for a large entry — fall through to the chunks */
  }

  const manifestResponse = await fetch(`${base}parts/${file}.json`);
  if (!manifestResponse.ok) {
    throw new Error(`${file} could not be read and has no chunk manifest (HTTP ${manifestResponse.status}).`);
  }
  const manifest = await manifestResponse.json();

  const assembled = new Uint8Array(manifest.total);
  let offset = 0;
  for (const part of manifest.parts) {
    const response = await fetch(`${base}parts/${part}`);
    if (!response.ok) throw new Error(`Chunk ${part} could not be read (HTTP ${response.status}).`);
    const chunk = new Uint8Array(await response.arrayBuffer());
    if (offset + chunk.byteLength > assembled.length) {
      throw new Error(`Chunk ${part} overflows the expected ${manifest.total} bytes.`);
    }
    assembled.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (offset !== manifest.total) {
    throw new Error(`Runtime chunks totalled ${offset} bytes, expected ${manifest.total}.`);
  }
  if (!looksLikeWasm(assembled.buffer)) {
    throw new Error("The reassembled runtime is not a WebAssembly module.");
  }

  return { bytes: assembled.buffer, how: `${manifest.parts.length} chunks (${offset} bytes)` };
}
