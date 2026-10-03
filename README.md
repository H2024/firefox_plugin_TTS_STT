# Moonshine Voice — local dictation and read-aloud for Firefox

Push-to-talk speech-to-text **and** text-to-speech for Firefox. Dictation is
[Moonshine](https://github.com/moonshine-ai/moonshine) (Moonshine AI's fast ASR
model) running through [transformers.js](https://github.com/huggingface/transformers.js)
+ onnxruntime-web; reading aloud uses your system voices or a local neural voice.

**Nothing is sent to a server.** The model weights are downloaded once from
Hugging Face and cached by the browser; after that the add-on works offline, and
your audio never leaves the machine.

## Why this exists

As of today there is no Moonshine add-on on addons.mozilla.org — searching AMO
for "moonshine" only returns a German school-lunch form filler and an unrelated
theme panel. The existing browser dictation add-ons either use the Web Speech
API (which in Firefox is unimplemented or routes audio to a remote service) or
send audio to a cloud API. This one runs the model in the extension itself.

## Install

The add-on is unsigned, so pick one of these:

**Temporary (any Firefox, gone when you restart):**

1. Go to `about:debugging#/runtime/this-firefox`
2. If an older Moonshine Voice is listed there, **Remove** it first — loading a
   newer file does not replace a temporary add-on already in the list
3. *Load Temporary Add-on…* → select the `.xpi` (or `ext/manifest.json` if you
   cloned the source), and check the version shown next to it

**Permanent (Firefox Developer Edition, Nightly or ESR):**

1. In `about:config` set `xpinstall.signatures.required` to `false`
2. Open the `.xpi` file with Firefox (`about:addons` → gear → *Install Add-on From File…*)

**Permanent on release Firefox:** the package has to be signed by Mozilla first.
With a free [AMO API key](https://addons.mozilla.org/developers/addon/api/key/):

```bash
npx web-ext sign --source-dir=ext --channel=unlisted \
  --api-key=user:XXXX --api-secret=YYYY
```

That returns a signed `.xpi` you can install permanently without touching
`about:config`.

## First run

1. After installing, the settings page opens. Click **Enable on all sites** —
   Firefox MV3 does not grant host access at install time, and without it the
   hotkey cannot reach the page you're typing into.
2. Open the panel: toolbar button, or `Ctrl+Shift+U`. The panel owns the
   microphone and the model, so it needs to be open (sidebar or the small
   floating window) while you dictate. If it's closed when you press the hotkey,
   the add-on opens the floating window for you.
3. The first load downloads the model (~150 MB for Base, ~50 MB for Tiny) with a
   progress bar. Allow the microphone when Firefox asks.

## Use

- **Hold `Ctrl+Shift+Space`** on any web page and speak; let go and the text is
  typed into the field you had focused. `Esc` cancels.
- **Select text and press `Alt+Shift+R`** to have it read back to you.
- `Ctrl+Shift+Y` is a start/stop toggle that also works from the toolbar (handy
  if you prefer clicking, or on pages where content scripts are blocked).
- If no text field is focused, the transcript is copied to the clipboard
  instead. The panel keeps the last 30 transcripts; click one to copy it.
- Everything is configurable in the settings page: model size, CPU vs WebGPU,
  hold vs toggle, the hotkey itself, trailing space, capitalisation, tones,
  whether the mic stays open between utterances.

## Read aloud

Select text on any page and press **`Alt+Shift+R`** (or right-click it →
*Read aloud with Moonshine Voice*, or use the panel's **Speak selection**
button). `Esc`, a second press of the hotkey, or **Stop** in the panel stops it,
and starting dictation stops it too.

Three voice engines, switchable in settings:

| Engine | Download | Notes |
| --- | --- | --- |
| **System voices** (default) | none | Firefox's speech synthesis with your OS voices. Instant, zero cost, quality depends on the platform. |
| **Kokoro 82M** | ~90 MB once | Neural voices running locally in the add-on, 24 kHz, 24 voices (US/UK, male/female). Same stack as the dictation model. |
| **Moonshine TTS** | — | Moonshine's own synthesizer. Needs a single-threaded build; see below. |

### Why Moonshine's own TTS isn't the default

Moonshine AI does ship browser TTS — `@moonshine-ai/moonshine-wasm` exposes
`TextToSpeech` with `say()`, streaming and zero-shot voice cloning. It cannot
run inside a Firefox add-on today, and the reason is on Firefox's side, not
Moonshine's:

- The published build is multi-threaded, so it needs `SharedArrayBuffer`.
- `SharedArrayBuffer` requires a **cross-origin-isolated** page (COOP + COEP).
- Firefox cannot isolate extension pages —
  [bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477) is still
  open, blocked on COEP/COOP support for extensions (bug 1750654) and on running
  each extension in its own process (bug 1827085). Chrome has the
  `cross_origin_embedder_policy` manifest key for exactly this; Firefox does not.

Loading it in a non-isolated page hangs with
`Failed to execute 'postMessage' on 'Worker': SharedArrayBuffer transfer
requires self.crossOriginIsolated` — verified here, not guessed.

Two things soften this. Moonshine's TTS catalogue voices are *Kokoro* voices
(their ids are literally `kokoro_af_heart`, `kokoro_am_puck`, …), so the Kokoro
engine in this add-on gives you the same voices — what it doesn't give you is
Moonshine's ZipVoice cloning. And upstream supports a single-threaded build
(`-DMOONSHINE_WASM_SINGLE_THREAD=ON`), which needs no isolation.

**To switch it on** when you have such a build: put its `dist/` contents in
`ext/moonshine/` (so `ext/moonshine/index.js`, `moonshine.mjs`, `moonshine.wasm`
exist), rebuild the package, and choose *Moonshine TTS* as the voice engine.
`ext/moonshine-tts.js` already does the preflight, load, `say()` and `stop()`
against that API, and the manifest already allows `download.moonshine.ai` for
the voice assets. If the build is missing, the add-on says so and stays on the
engine you were using.

## Performance notes

- **Base on CPU** transcribes a 5-second utterance in roughly a second on a
  modern laptop; **Tiny** is ~3× faster with slightly more errors.
- If Firefox exposes WebGPU on your machine (`about:support` → Graphics), set
  *Compute device* to Automatic and it will use the GPU, which is several times
  faster again. It silently falls back to the CPU when WebGPU is unavailable.
- Moonshine is a short-form model built for utterances up to ~30 seconds; it
  processes audio proportionally to its length, which is what makes it quick on
  short phrases. It is English-only (the Base/Tiny checkpoints used here).

## How it's put together

```
ext/
  manifest.json         MV3, sidebar + toolbar action + content script
  common.js             shared settings/defaults/hotkey helpers
  background.js         routes hotkey → panel → transcript → tab
  content.js            hotkey capture, listening pill, text insertion
  recorder-worklet.js   AudioWorklet: 16 kHz mono frames + level meter
  sidebar/panel.*       the engine: microphone, model status, transcripts, voices
  options/*             settings page
  worker.js             bundled transformers.js + Moonshine ASR pipeline
  tts-worker.js         bundled Kokoro TTS pipeline
  moonshine-tts.js      adapter for Moonshine's own TTS (see above)
  wasm/                 onnxruntime-web binaries, shipped locally
src/worker.js           source for the ASR bundle
src/tts-worker.js       source for the TTS bundle
```

Two details that matter for MV3:

- Extension pages may not execute remote code, so onnxruntime-web's WASM ships
  inside the add-on. `env.backends.onnx.wasm.wasmPaths` is set to `{ wasm }`
  only — no `mjs` — which keeps onnxruntime-web on the loader embedded in its own
  bundle instead of importing one at runtime. `env.useWasmCache = false` stops
  transformers.js from rewriting that loader into a `blob:` URL, which the
  extension CSP would block.
- Only model *weights* are fetched at runtime (from `huggingface.co`, a declared
  host permission) — that's data, not code.

The worker tries several quantisations in order and falls back (WebGPU → CPU,
q4/q8 → fp32) so a missing variant or an unsupported GPU degrades instead of
failing.

## Rebuild

```bash
npm install --ignore-scripts   # onnxruntime-node's postinstall is not needed
npm run build                  # bundles src/worker.js → ext/worker.js, copies wasm
npm run lint                   # web-ext lint (0 errors expected)
npm run start                  # launches Firefox with the add-on loaded
npm run package                # → dist/moonshine_voice-<version>.zip
```

## Troubleshooting

**First: check which version is running.** The panel's footer line and the
settings page heading both show it, and `about:debugging` lists it next to the
add-on. A temporary add-on is *not* replaced by loading a newer file — remove
the old entry there first, then *Load Temporary Add-on…* on the new package.

**"no available backend found …"** — the onnxruntime-web runtime did not
start. Four separate causes produced this, all now fixed:

1. *Version mismatch* (1.0.0–1.1.0). The shipped WASM came from whichever
   onnxruntime-web npm hoisted, not the one transformers.js bundles.
2. *Dynamic import* (up to 1.1.2). Firefox will not run a dynamic `import()`
   inside an extension worker. Configuring a `mjs` path is what made
   onnxruntime-web use `import(url)` instead of its embedded loader.
3. *WASM in the worker* (up to 1.2.0). The manifest said `worker-src 'self'`
   without `'wasm-unsafe-eval'`, and the model runs in a worker.
4. *Large file reads* (up to 1.3.1). Firefox opens a big file inside a packed
   add-on happily — `200 application/wasm`, right `Content-Length` — and then
   fails while reading the body: `NetworkError when attempting to fetch
   resource`. onnxruntime-web saw an empty buffer, hence `CompileError: wasm
   validation error: at offset 0: failed to match magic number`. Files up to a
   couple of MB read back fine; the 23 MB runtime did not.

5. *Reading the add-on's own files at all* (up to 1.4.0). On some machines
   Firefox refuses to read any packaged file from script — a 47 KB loader fails
   with `The operation was aborted.` just as the 23 MB runtime does — while the
   very same files still load fine as `<script>` tags and the response headers
   come back `200`.

Since 1.5.0 the runtime ships as 23 chunks of ~1 MB, each in two forms: the raw
bytes, and a small script that assigns the chunk's base64 to a global. The panel
tries three routes in order — chunked `fetch`, chunked `XMLHttpRequest`, then
the chunks as `<script>` tags — verifies the `\0asm` header, and hands the bytes
to each worker, which passes them to onnxruntime-web as
`env.backends.onnx.wasm.wasmBinary` (a flag it prefers over any path, so it
never reads a file or imports a loader itself). The diagnostics name the route
that won, e.g. `panel read of runtime: 23 chunks via script tags (23567050
bytes)`.

Installing the add-on **unpacked** is worth trying if file reads misbehave:
extract the `.xpi` into a folder and load its `manifest.json` in
`about:debugging`. That serves files from disk rather than from the packed
archive, and is generally faster to load too.

**Why the model download stopped starting after 1.2.0.** Nothing about the
download broke — it stopped being reached. Up to 1.2.x the order was: build the
pipeline (which downloads the model from Hugging Face, with the progress bar you
saw), *then* create the inference session, which is where the WASM failure hit.
From 1.3.0 the runtime binary is read **before** the model, so a failure there
aborts the load before any download begins. Same underlying fault, earlier exit.

**Diagnostics.** The panel has a *Diagnostics* button next to *Clear* (it also
runs after a failure). It writes one entry into the transcript list; click it to
copy. Since 1.6.0 it is a full report:

- `[environment]` — user agent, page origin vs the add-on's base URL (and
  whether they match), install type, WebGPU, SharedArrayBuffer, storage quota.
- `[reading the add-on's own files]` — the 1 KB manifest, a 1 MB chunk and the
  47 KB loader, each read three ways (`fetch`, `XMLHttpRequest`, `<script>`
  tag), with byte counts, timings and exact error names. Headers are probed
  separately from bodies, because opening a file and reading it are what differ.
- `[network]` — a real request to Hugging Face and to jsDelivr, so a file-read
  problem is never confused with a connectivity one.
- `[cache api]` — a put/match round trip, since the model cache depends on it.
- `[webassembly runtime]` — compile check in the page and in the worker, which
  route produced the runtime bytes, and onnxruntime's own state.
- `[failures so far]` — every runtime error this session, in order.

Other things worth trying: set *Compute device* to **CPU only** in settings if
WebGPU on your machine is flaky, and check `about:support` → Graphics to see
whether Firefox exposes WebGPU at all.

## Known limitations

- The panel must stay open — Firefox has no `offscreen` API, so there is no
  hidden page that can hold a microphone stream.
- Content scripts can't run on `about:`, `addons.mozilla.org` or view-source
  pages, so the hold-hotkey doesn't work there; use the toolbar toggle and
  paste from the clipboard.
- Firefox may re-ask for microphone permission per session for extension pages;
  tick *Remember this decision* if the checkbox is offered.
- Reading aloud with Kokoro synthesizes a sentence at a time, so the first
  sentence starts within about a second while the rest are still being made;
  system voices start instantly.
- English only. Moonshine has community checkpoints for other languages
  (`onnx-community/moonshine-tiny-fr-ONNX`, `-ko-`, `-ar-`, …) — adding one is a
  one-line change to `MS.MODELS` in `common.js`.

## Licence

Extension code: MIT. Moonshine model weights: see the model card on Hugging Face
(`onnx-community/moonshine-base-ONNX`). transformers.js and onnxruntime-web are
Apache-2.0.

