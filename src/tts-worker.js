/**
 * Moonshine Voice — text-to-speech worker (neural engine).
 *
 * Runs Kokoro-82M locally through the same transformers.js / onnxruntime-web
 * stack as the dictation worker: WASM ships with the add-on, only the model
 * weights and the voice embeddings are fetched (once) and then cached.
 *
 * Moonshine's own TTS is not used here — see `moonshine-tts.js` for why and for
 * the path that turns it on once a single-threaded build exists.
 */

import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import { env } from "@huggingface/transformers";
import { readRuntimeBinary, looksLikeWasm } from "./wasm-source.js";

env.allowLocalModels = false;
env.useWasmCache = false;

const WASM_BASE = new URL("./wasm/", self.location.href).href;

/**
 * How the WASM runtime reaches onnxruntime-web, best first. Two Firefox
 * behaviours shaped this: it will not run a dynamic `import()` inside an
 * extension worker, and it fails part-way through reading a large file from a
 * packed add-on. So the binary arrives as bytes we read ourselves (in ~1 MB
 * chunks) and is handed over via `wasmBinary`, which onnxruntime-web prefers
 * over any path.
 */
const WASM_VARIANTS = [
  // The runtime binary is read by the panel (or here, as a fallback) and handed
  // to onnxruntime-web as bytes. `wasmBinary` takes priority over every path it
  // knows, so it neither imports a loader nor fetches the binary itself — the
  // two things Firefox would not do from inside an extension.
  { name: "bytes", wasm: "ort-wasm-simd-threaded.asyncify.wasm", prefetch: true },
  // Same bytes, but with an explicit Emscripten loader, in case the copy
  // embedded in onnxruntime-web ever misbehaves.
  {
    name: "bytes+loader",
    wasm: "ort-wasm-simd-threaded.asyncify.wasm",
    mjs: "ort-wasm-simd-threaded.asyncify.js",
    prefetch: true,
  },
];

/** What the last binary read produced — surfaced in the panel's diagnostics. */
let wasmBinaryInfo = null;


/** Bytes handed over by the panel, if it managed to read the file itself. */
let suppliedBinary = null;

function acceptSuppliedBinary(buffer) {
  if (!buffer || !buffer.byteLength) return;
  suppliedBinary = buffer;
}

async function prepareBinary() {
  const variant = WASM_VARIANTS[variantIndex];
  if (!variant.prefetch) {
    delete env.backends.onnx.wasm.wasmBinary;
    return null;
  }
  if (wasmBinaryInfo && wasmBinaryInfo.file === variant.wasm && env.backends.onnx.wasm.wasmBinary) {
    return wasmBinaryInfo;
  }

  let bytes = suppliedBinary;
  let how = "panel";
  if (bytes && !looksLikeWasm(bytes)) {
    suppliedBinary = null;
    bytes = null;
  }
  if (!bytes) {
    const read = await readRuntimeBinary(WASM_BASE, variant.wasm);
    bytes = read.bytes;
    how = `worker, ${read.how}`;
  } else {
    how = "panel";
  }

  wasmBinaryInfo = { file: variant.wasm, bytes: bytes.byteLength, source: how, magic: "ok" };
  env.backends.onnx.wasm.wasmBinary = bytes;
  return wasmBinaryInfo;
}

let variantIndex = 0;

function useVariant(index) {
  variantIndex = Math.min(Math.max(index | 0, 0), WASM_VARIANTS.length - 1);
  const variant = WASM_VARIANTS[variantIndex];
  const paths = { wasm: WASM_BASE + variant.wasm };
  if (variant.mjs) paths.mjs = WASM_BASE + variant.mjs;
  env.backends.onnx.wasm.wasmPaths = paths;
  if (!variant.prefetch) delete env.backends.onnx.wasm.wasmBinary;
  return variant;
}

useVariant(0);
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE_CANDIDATES = { webgpu: ["fp32", "q8"], wasm: ["q8", "q4", "fp32"] };

let tts = null;
let loading = null;
let cancelled = false;
let speakingId = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

const isNetworkError = (err) =>
  /failed to fetch|networkerror|net::|load failed/i.test(String(err && err.message ? err.message : err));

async function pickDevice(requested) {
  if (requested === "wasm") return "wasm";
  const hasGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  if (requested === "webgpu") {
    if (!hasGPU) throw new Error("WebGPU is not available in this browser.");
    return "webgpu";
  }
  if (!hasGPU) return "wasm";
  try {
    return (await navigator.gpu.requestAdapter()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

const isRuntimeError = (err) =>
  /dynamically imported module|no available backend|backend not found|wasm|WebAssembly|Aborted/i.test(
    String(err && err.message ? err.message : err)
  );

async function load(requestedDevice, variant) {
  if (variant !== undefined) useVariant(variant);
  if (tts) return tts;
  if (loading) return loading;

  loading = (async () => {
    const device = await pickDevice(requestedDevice || "auto");
    await prepareBinary();
    post({ type: "status", state: "loading", device });

    const progress_callback = (p) => {
      if (p.status === "progress" && p.file && /\.onnx$/.test(p.file)) {
        post({
          type: "progress",
          file: p.file,
          percent: p.total ? Math.round((p.loaded / p.total) * 100) : 0,
          total: p.total,
        });
      }
    };

    let lastError = null;
    for (const dtype of DTYPE_CANDIDATES[device]) {
      try {
        tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device, progress_callback });
        post({ type: "ready", device, dtype, voices: Object.entries(tts.voices).map(([id, v]) => ({ id, ...v })) });
        return tts;
      } catch (err) {
        lastError = err;
        if (isNetworkError(err)) {
          throw new Error(
            "Could not download the voice model. Check your internet connection; it is only needed once."
          );
        }
        post({ type: "status", state: "retrying", detail: String(err && err.message ? err.message : err) });
      }
    }
    if (device === "webgpu") {
      loading = null;
      return load("wasm");
    }
    if (isRuntimeError(lastError) && variantIndex + 1 < WASM_VARIANTS.length) {
      post({
        type: "restart",
        variant: variantIndex + 1,
        detail: String(lastError && lastError.message ? lastError.message : lastError),
      });
      throw new Error("Switching WebAssembly build…");
    }
    const runtime = WASM_VARIANTS[variantIndex];
    const detail = lastError && lastError.message ? lastError.message : String(lastError);
    throw new Error(`${detail} [runtime: ${runtime.name}]`);
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function speak({ id, text, voice, speed, device, variant }) {
  await load(device, variant);
  cancelled = false;
  speakingId = id;

  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();

  let index = 0;
  for await (const chunk of tts.stream(splitter, { voice: voice || "af_heart", speed: speed || 1 })) {
    if (cancelled || speakingId !== id) break;
    const audio = chunk.audio.data ?? chunk.audio.audio;
    const copy = new Float32Array(audio); // detach from the model's buffer
    post(
      {
        type: "audio",
        id,
        index: index++,
        text: chunk.text,
        sampleRate: chunk.audio.sampling_rate,
        audio: copy,
      },
      [copy.buffer]
    );
  }

  post({ type: "spoken", id, cancelled: cancelled || speakingId !== id, chunks: index });
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (msg && msg.wasmBinary) acceptSuppliedBinary(msg.wasmBinary);
  try {
    switch (msg.type) {
      case "load":
        await load(msg.device, msg.variant);
        break;
      case "speak":
        await speak(msg);
        break;
      case "cancel":
        cancelled = true;
        speakingId = null;
        break;
      default:
        break;
    }
  } catch (err) {
    post({ type: "error", id: msg && msg.id, message: String(err && err.message ? err.message : err) });
  }
});

post({ type: "status", state: "worker-started" });
