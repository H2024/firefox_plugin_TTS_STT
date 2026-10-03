import * as ort from 'onnxruntime-web';
const base = new URL('./wasm/', location.href).href;
const MODES = {
  embedded: { wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm' },
  explicit: { wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm', mjs: base + 'ort-wasm-simd-threaded.asyncify.js' },
};
window.ortCheck = async (mode) => {
  ort.env.wasm.wasmPaths = MODES[mode];
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  try {
    await ort.InferenceSession.create(new Uint8Array([0, 1, 2, 3]));
    return 'created-unexpectedly';
  } catch (e) {
    return String(e.message || e);
  }
};
