/**
 * Prepares ext/wasm/ from the onnxruntime-web build that transformers.js
 * bundles (the JS layer and the Emscripten glue are versioned together; mixing
 * them breaks at load time).
 *
 * The runtime binary is written as ~1 MB chunks rather than one 23 MB file.
 * Firefox opens a large file inside a packed add-on — status 200, correct
 * Content-Type — and then fails while reading the body ("NetworkError when
 * attempting to fetch resource"), which reached onnxruntime-web as an empty
 * buffer and a "failed to match magic number" compile error. Small files read
 * back fine, so the add-on stitches the runtime together from chunks.
 */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let pkgPath = null;
for (const candidate of [
  "@huggingface/transformers/node_modules/onnxruntime-web/package.json",
  "onnxruntime-web/package.json",
]) {
  try {
    pkgPath = require.resolve(candidate, { paths: [process.cwd()] });
    break;
  } catch {
    /* try the next one */
  }
}
if (!pkgPath) {
  const nested = join(
    process.cwd(),
    "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/package.json"
  );
  readFileSync(nested); // throws with a clear ENOENT if it really isn't there
  pkgPath = nested;
}

const dist = join(dirname(pkgPath), "dist");
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
const out = join(process.cwd(), "ext", "wasm");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "parts"), { recursive: true });

// The Emscripten loaders, under both names. Small files, so they are copied
// whole; `.js` is what the add-on asks for, `.mjs` is onnxruntime-web's own
// canonical name.
for (const [from, to] of [
  ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.js"],
  ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.mjs"],
  ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.js"],
  ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
]) {
  copyFileSync(join(dist, from), join(out, to));
}

const CHUNK_SIZE = 1024 * 1024;

/**
 * Also emits each chunk as a plain script that assigns its base64 to a global.
 * On some machines Firefox refuses to read the add-on's own files with fetch()
 * or XHR ("The operation was aborted") while still loading scripts normally —
 * so a <script> tag is the one delivery mechanism known to work everywhere.
 */
function writeScriptChunk(name, index, slice) {
  const key = String(index).padStart(3, "0");
  const body =
    `self.__MS_WASM__=self.__MS_WASM__||{};self.__MS_WASM__[${JSON.stringify(key)}]=` +
    JSON.stringify(slice.toString("base64")) + ";\n";
  writeFileSync(join(out, "parts", `${name}.${key}.js`), body);
}

function split(name) {
  const bytes = readFileSync(join(dist, name));
  const parts = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_SIZE, index++) {
    const part = `${name}.${String(index).padStart(3, "0")}`;
    const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
    writeFileSync(join(out, "parts", part), slice);
    writeScriptChunk(name, index, Buffer.from(slice));
    parts.push(part);
  }
  writeFileSync(
    join(out, "parts", `${name}.json`),
    JSON.stringify(
      { file: name, total: bytes.length, chunkSize: CHUNK_SIZE, parts, scripts: parts.map((p) => `${p}.js`) },
      null,
      1
    )
  );
  console.log(`  ${name} → ${parts.length} chunks (${(bytes.length / 1048576).toFixed(1)} MB)`);
  return parts.length;
}

const chunkCount = split("ort-wasm-simd-threaded.asyncify.wasm");

// A script copy of the manifest, for the same reason the chunks have one.
writeFileSync(
  join(out, "parts", "manifest.js"),
  `self.__MS_WASM_MANIFEST__=${JSON.stringify({
    file: "ort-wasm-simd-threaded.asyncify.wasm",
    chunks: chunkCount,
  })};\n`
);

// Keep the version used by the CDN fallback in step with what we ship.
const commonPath = join(process.cwd(), "ext", "common.js");
const common = readFileSync(commonPath, "utf8");
const updated = common.replace(/MS\.ORT_VERSION = "[^"]*";/, `MS.ORT_VERSION = "${version}";`);
if (updated !== common) {
  writeFileSync(commonPath, updated);
  console.log(`  common.js: MS.ORT_VERSION → ${version}`);
}

console.log(`onnxruntime-web ${version} prepared in ext/wasm/`);
