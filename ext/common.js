/* Shared constants + settings helpers. Loaded by the background page, the
   content script, the panel and the options page. */
"use strict";

const MS = (globalThis.MS = globalThis.MS || {});

MS.api = globalThis.browser || globalThis.chrome;

/* Kept in sync by scripts/copy-wasm.mjs — the onnxruntime-web build whose
   loader is compiled into the workers. The CDN copy must match it exactly. */
MS.ORT_VERSION = "1.26.0-dev.20260416-b7804b056c";
MS.ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@";
MS.RUNTIME_FILE = "ort-wasm-simd-threaded.asyncify.wasm";

/** Where the runtime is fetched from when the copy inside the add-on can't be
    read. `runtimeCdnUrl` lets you point it at your own host instead. */
MS.ortCdnUrl = function ortCdnUrl(settings) {
  if (settings && settings.runtimeCdnUrl) return settings.runtimeCdnUrl;
  return `${MS.ORT_CDN}${MS.ORT_VERSION}/dist/${MS.RUNTIME_FILE}`;
};

MS.MODELS = [
  { id: "onnx-community/moonshine-base-ONNX", label: "Moonshine Base — English (~150 MB, best accuracy)" },
  { id: "onnx-community/moonshine-tiny-ONNX", label: "Moonshine Tiny — English (~50 MB, fastest)" },
];

MS.TTS_ENGINES = [
  { id: "system", label: "System voices — instant, no download (Firefox built-in)" },
  { id: "kokoro", label: "Kokoro 82M — local neural voices (~90 MB, downloaded once)" },
  { id: "moonshine", label: "Moonshine TTS — needs a single-threaded build (see README)" },
];

/* Kokoro's catalogue, so the voice list can be shown before the 90 MB model is
   downloaded. Grades are the upstream quality ratings. */
MS.KOKORO_VOICES = [
  { id: "af_heart", label: "Heart — US female (A)" },
  { id: "af_bella", label: "Bella — US female (A-)" },
  { id: "af_nicole", label: "Nicole — US female (B-)" },
  { id: "af_aoede", label: "Aoede — US female (C+)" },
  { id: "af_kore", label: "Kore — US female (C+)" },
  { id: "af_sarah", label: "Sarah — US female (C+)" },
  { id: "af_nova", label: "Nova — US female (C)" },
  { id: "af_sky", label: "Sky — US female (C-)" },
  { id: "af_alloy", label: "Alloy — US female (C)" },
  { id: "am_fenrir", label: "Fenrir — US male (C+)" },
  { id: "am_michael", label: "Michael — US male (C+)" },
  { id: "am_puck", label: "Puck — US male (C+)" },
  { id: "am_echo", label: "Echo — US male (D)" },
  { id: "am_eric", label: "Eric — US male (D)" },
  { id: "am_liam", label: "Liam — US male (D)" },
  { id: "am_onyx", label: "Onyx — US male (D)" },
  { id: "bf_emma", label: "Emma — UK female (B-)" },
  { id: "bf_isabella", label: "Isabella — UK female (C)" },
  { id: "bf_alice", label: "Alice — UK female (D)" },
  { id: "bf_lily", label: "Lily — UK female (D)" },
  { id: "bm_fable", label: "Fable — UK male (C)" },
  { id: "bm_george", label: "George — UK male (C)" },
  { id: "bm_daniel", label: "Daniel — UK male (D)" },
  { id: "bm_lewis", label: "Lewis — UK male (D+)" },
];

MS.DEFAULTS = {
  model: "onnx-community/moonshine-base-ONNX",
  device: "auto", // auto | webgpu | wasm
  mode: "ptt", // ptt (hold to talk) | toggle
  hotkey: { code: "Space", ctrl: true, shift: true, alt: false, meta: false },
  insertMode: "insert", // insert | clipboard
  trailingSpace: true,
  capitalize: false,
  keepMicOpen: true,
  micIdleReleaseMs: 60000,
  sounds: true,
  showIndicator: true,
  maxSeconds: 60,
  autoOpenWindow: true, // open a floating engine window when the sidebar is closed

  // --- reading aloud ---
  ttsEngine: "system", // system | kokoro | moonshine
  ttsHotkey: { code: "KeyR", ctrl: false, shift: true, alt: true, meta: false },
  ttsVoiceSystem: "", // empty = the browser's default voice
  ttsVoiceKokoro: "af_heart",
  ttsVoiceMoonshine: "kokoro_af_heart",
  ttsRate: 1,
  ttsStopOnDictate: true, // speaking stops the moment you start dictating
  ttsMaxChars: 20000,

  // Where the WebAssembly runtime comes from. "auto" reads the copy inside the
  // add-on and falls back to the CDN only if every local route fails.
  runtimeSource: "auto", // auto | local | cdn
  runtimeCdnUrl: "", // override the CDN URL (self-hosting)
};

MS.getSettings = async function getSettings() {
  const stored = await MS.api.storage.local.get("settings");
  return Object.assign({}, MS.DEFAULTS, stored && stored.settings);
};

MS.setSettings = async function setSettings(patch) {
  const current = await MS.getSettings();
  const next = Object.assign({}, current, patch);
  await MS.api.storage.local.set({ settings: next });
  return next;
};

MS.hotkeyLabel = function hotkeyLabel(hk) {
  if (!hk || !hk.code) return "(none)";
  const parts = [];
  if (hk.ctrl) parts.push("Ctrl");
  if (hk.alt) parts.push("Alt");
  if (hk.shift) parts.push("Shift");
  if (hk.meta) parts.push("Meta");
  parts.push(hk.code.replace(/^Key|^Digit/, "").replace(/^Space$/, "Space"));
  return parts.join(" + ");
};

MS.matchesHotkey = function matchesHotkey(event, hk) {
  if (!hk || !hk.code) return false;
  return (
    event.code === hk.code &&
    event.ctrlKey === !!hk.ctrl &&
    event.altKey === !!hk.alt &&
    event.shiftKey === !!hk.shift &&
    event.metaKey === !!hk.meta
  );
};
