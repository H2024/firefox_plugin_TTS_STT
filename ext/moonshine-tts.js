/**
 * Optional engine: Moonshine's own TextToSpeech, from
 * @moonshine-ai/moonshine-wasm.
 *
 * It is not enabled by default because the published build of that package is
 * multi-threaded and therefore needs SharedArrayBuffer, which needs a
 * cross-origin-isolated page. Firefox cannot isolate extension pages yet
 * (bugzilla 1673477 — blocked on COEP/COOP support for extensions and on
 * per-extension processes), so the threaded build stalls the moment it tries to
 * hand a SharedArrayBuffer to its worker.
 *
 * The moment a single-threaded build exists — the upstream project builds one
 * with -DMOONSHINE_WASM_SINGLE_THREAD=ON — drop its `dist/` into
 * `ext/moonshine/` and pick "Moonshine" as the voice engine: everything below
 * is already wired up. The README has the details.
 */
"use strict";

const MS_TTS = (globalThis.MS_TTS = {});

MS_TTS.BUILD_PATH = "moonshine/index.js";

/** Returns null when the engine can run, or a human-readable reason it can't. */
MS_TTS.preflight = async function preflight(api) {
  const url = api.runtime.getURL(MS_TTS.BUILD_PATH);
  let present = false;
  try {
    const response = await fetch(url, { method: "GET" });
    present = response.ok;
  } catch {
    present = false;
  }
  if (!present) {
    return "No Moonshine TTS build found in the add-on (ext/moonshine/). See the README for how to add one.";
  }
  const threadedOk = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
  MS_TTS.threaded = threadedOk;
  return null;
};

MS_TTS.create = async function create({ api, language, voice, audioContext, onProgress }) {
  const mod = await import(api.runtime.getURL(MS_TTS.BUILD_PATH));
  const TextToSpeech = mod.TextToSpeech;
  if (!TextToSpeech) throw new Error("The Moonshine build has no TextToSpeech export.");

  let tts = new TextToSpeech().language(language || "en_us");
  if (voice) tts = tts.voice(voice);
  if (audioContext) tts = tts.audioContext(audioContext);
  if (onProgress) tts = tts.onProgress(onProgress);
  await tts.load();
  return {
    say: (text) => tts.say(text),
    stop: () => tts.stop(),
    close: () => (tts.close ? tts.close() : undefined),
    voices: async () => {
      try {
        const list = await TextToSpeech.voices({ language: language || "en_us" });
        return list.filter((v) => v.state === "found").map((v) => v.id);
      } catch {
        return [];
      }
    },
  };
};
