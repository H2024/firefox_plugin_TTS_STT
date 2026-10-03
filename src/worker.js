/**
 * Moonshine Voice — ASR worker.
 *
 * Runs entirely inside the extension: transformers.js is bundled into this file
 * and the onnxruntime-web WASM binaries are shipped in ../wasm/, so no remote
 * code is ever executed (a hard requirement for MV3 extension pages).
 *
 * The only network access is downloading the model weights from Hugging Face on
 * first use; they are then cached by the browser for offline use.
 */

import { pipeline, env } from "@huggingface/transformers";
// Same module instance transformers.js uses, so a probe here exercises the very
// runtime the pipeline will use.
import * as ort from "onnxruntime-web/webgpu";
import { readRuntimeBinary, looksLikeWasm } from "./wasm-source.js";

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

// Never look for models on a local filesystem path (there isn't one here).
env.allowLocalModels = false;

// transformers.js otherwise fetches the WASM factory and rewrites it into a
// blob: URL, which the extension CSP forbids. Disabling the cache makes it load
// our local files directly.
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
// Extension pages are not cross-origin isolated, so SharedArrayBuffer (and with
// it multi-threading) is unavailable. Be explicit instead of relying on probing.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

const SAMPLE_RATE = 16000;

// dtype combinations to try, best first. Not every repo publishes every
// quantisation, so we fall back rather than fail.
const DTYPE_CANDIDATES = {
  webgpu: [
    { encoder_model: "fp32", decoder_model_merged: "q4" },
    { encoder_model: "fp32", decoder_model_merged: "fp32" },
    "fp32",
  ],
  wasm: [
    { encoder_model: "q8", decoder_model_merged: "q8" },
    "q8",
    { encoder_model: "fp32", decoder_model_merged: "q8" },
    "fp32",
  ],
};

let transcriber = null;
let loadedKey = null;
let loading = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function pickDevice(requested) {
  if (requested === "wasm") return "wasm";
  const hasGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  if (requested === "webgpu") {
    if (!hasGPU) throw new Error("WebGPU is not available in this browser.");
    return "webgpu";
  }
  // auto
  if (!hasGPU) return "wasm";
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/** True for failures that mean the WASM runtime itself never came up. */
const isRuntimeError = (err) => {
  const message = String(err && err.message ? err.message : err);
  return /dynamically imported module|no available backend|backend not found|wasm|WebAssembly|Aborted/i.test(
    message
  );
};

async function load({ model, device: requestedDevice, variant }) {
  if (variant !== undefined) useVariant(variant);
  const key = `${model}|${requestedDevice}`;
  if (loadedKey === key && transcriber) return transcriber;
  if (loading) await loading.catch(() => {});
  if (loadedKey === key && transcriber) return transcriber;

  loading = (async () => {
    transcriber = null;
    loadedKey = null;

    const device = await pickDevice(requestedDevice || "auto");
    await prepareBinary();
    post({ type: "status", state: "loading", device, model });

    const progress_callback = (p) => {
      if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) {
        post({
          type: "progress",
          file: p.file,
          loaded: p.loaded,
          total: p.total,
          percent: p.total ? Math.round((p.loaded / p.total) * 100) : 0,
        });
      } else if (p.status === "initiate" || p.status === "done") {
        post({ type: "progress", file: p.file, status: p.status });
      }
    };

    const isNetworkError = (err) =>
      /failed to fetch|networkerror|net::|err_internet|load failed/i.test(
        String(err && err.message ? err.message : err)
      );

    let lastError = null;
    for (const dtype of DTYPE_CANDIDATES[device]) {
      try {
        transcriber = await pipeline("automatic-speech-recognition", model, {
          device,
          dtype,
          progress_callback,
        });
        loadedKey = key;
        post({
          type: "ready",
          device,
          model,
          dtype: typeof dtype === "string" ? dtype : JSON.stringify(dtype),
        });
        // Warm up the graph with 0.5 s of silence so the first real utterance
        // isn't paying for lazy allocation.
        try {
          await transcriber(new Float32Array(SAMPLE_RATE / 2));
        } catch {
          /* warm-up failures are not fatal */
        }
        return transcriber;
      } catch (err) {
        lastError = err;
        if (isNetworkError(err)) {
          // No point trying another quantisation — the download itself failed.
          throw new Error(
            "Could not download the model. Check your internet connection; after the first successful download Moonshine works offline."
          );
        }
        post({ type: "status", state: "retrying", detail: String(err && err.message ? err.message : err) });
      }
    }

    if (device === "webgpu") {
      // GPU path failed outright — try again on the CPU before giving up.
      post({ type: "status", state: "retrying", detail: "WebGPU failed, falling back to CPU" });
      loading = null;
      return load({ model, device: "wasm" });
    }

    if (isRuntimeError(lastError) && variantIndex + 1 < WASM_VARIANTS.length) {
      // The runtime never started. A fresh worker with the next WASM build has
      // a real chance; onnxruntime-web cannot re-initialise in place.
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

async function transcribe({ id, audio, language }) {
  if (!transcriber) throw new Error("Model is not loaded yet.");
  const started = performance.now();
  const options = {};
  // Moonshine is a short-form model: cap generation relative to audio length
  // (~6 tokens per second of speech is the documented rule of thumb).
  const seconds = audio.length / SAMPLE_RATE;
  options.max_new_tokens = Math.max(8, Math.min(512, Math.round(seconds * 6.5) + 8));
  if (language) options.language = language;

  const output = await transcriber(audio, options);
  const text = (Array.isArray(output) ? output[0]?.text : output?.text) || "";
  post({
    type: "result",
    id,
    text: text.trim(),
    ms: Math.round(performance.now() - started),
    seconds: Number(seconds.toFixed(2)),
  });
}

/** The 8-byte empty module: enough to prove WebAssembly compilation is allowed. */
const MINI_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * Checks the runtime without touching the network: can this context compile
 * WebAssembly at all (i.e. does the CSP allow it), and does onnxruntime-web
 * initialise? A healthy runtime rejects garbage model bytes with a protobuf
 * parsing error — which means everything up to the model itself works.
 */
async function selfTest() {
  const result = { type: "selftest-result", variant: WASM_VARIANTS[variantIndex].name };

  try {
    const info = await prepareBinary();
    result.binary = info
      ? `${info.bytes} bytes via ${info.source}, magic ${info.magic}`
      : "not pre-read (URL mode)";
  } catch (err) {
    result.binary = String(err && err.message ? err.message : err);
  }

  try {
    new WebAssembly.Module(MINI_WASM);
    result.compile = "ok";
  } catch (err) {
    result.compile = String(err && err.message ? err.message : err);
  }

  try {
    await ort.InferenceSession.create(new Uint8Array([0, 1, 2, 3]));
    result.runtime = "unexpectedly created a session";
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    result.runtime = /protobuf/i.test(message) ? "ok (runtime started)" : message;
  }

  post(result);
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (msg && msg.wasmBinary) acceptSuppliedBinary(msg.wasmBinary);
  try {
    switch (msg.type) {
      case "selftest":
        await selfTest();
        break;
      case "load":
        await load(msg);
        break;
      case "transcribe":
        await load(msg);
        await transcribe(msg);
        break;
      case "unload":
        transcriber = null;
        loadedKey = null;
        post({ type: "status", state: "unloaded" });
        break;
      default:
        break;
    }
  } catch (err) {
    post({
      type: "error",
      id: msg && msg.id,
      message: String(err && err.message ? err.message : err),
    });
  }
});

post({ type: "status", state: "worker-started" });
