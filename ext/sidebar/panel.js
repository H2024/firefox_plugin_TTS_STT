/* The engine. This page owns the microphone and the Moonshine model; the
   background page only routes messages to and from it. It runs either as the
   sidebar or as a small floating window (?host=window). */
"use strict";

(() => {
  const api = MS.api;
  const SAMPLE_RATE = 16000;
  const MIN_SECONDS = 0.25;

  const el = (id) => document.getElementById(id);
  const ui = {
    status: el("status"),
    statusText: el("statusText"),
    progressWrap: el("progressWrap"),
    progressBar: el("progressBar"),
    progressText: el("progressText"),
    record: el("record"),
    recordLabel: el("recordLabel"),
    meterBar: el("meterBar"),
    hotkeyHint: el("hotkeyHint"),
    transcripts: el("transcripts"),
    ttsVoice: el("ttsVoice"),
    speak: el("speak"),
    stopSpeak: el("stopSpeak"),
    ttsEngineInfo: el("ttsEngineInfo"),
    ttsHotkeyHint: el("ttsHotkeyHint"),
    ttsProgressWrap: el("ttsProgressWrap"),
    ttsProgressBar: el("ttsProgressBar"),
    ttsProgressText: el("ttsProgressText"),
    permissionBox: el("permissionBox"),
    grant: el("grant"),
    clear: el("clear"),
    diag: el("diag"),
    settings: el("settings"),
    engineInfo: el("engineInfo"),
  };

  let settings = Object.assign({}, MS.DEFAULTS);
  let port = null;
  let worker = null;
  let asrVariant = 0; // which shipped onnxruntime-web build the worker is using
  const attemptLog = []; // every runtime failure so far, for the diagnostics dump
  let ready = false;
  let recording = false;
  let busy = false;
  let requestId = 0;

  let stream = null;
  let audioCtx = null;
  let workletNode = null;
  let sourceNode = null;
  let sinkNode = null;
  let chunks = [];
  let chunkLength = 0;
  let micIdleTimer = null;
  let maxLengthTimer = null;

  /* --- UI helpers ------------------------------------------------------- */

  function setStatus(text, kind) {
    ui.status.className = "status" + (kind ? " " + kind : "");
    ui.statusText.textContent = text;
  }

  function setProgress(percent, label) {
    if (percent === null) {
      ui.progressWrap.hidden = true;
      return;
    }
    ui.progressWrap.hidden = false;
    ui.progressBar.style.width = `${percent}%`;
    ui.progressText.textContent = label;
  }

  function addTranscript(text, meta) {
    const li = document.createElement("li");
    li.textContent = text;
    const small = document.createElement("span");
    small.className = "meta";
    small.textContent = meta;
    li.appendChild(small);
    li.title = "Click to copy";
    li.addEventListener("click", () => navigator.clipboard.writeText(text).catch(() => {}));
    ui.transcripts.prepend(li);
    while (ui.transcripts.children.length > 30) ui.transcripts.lastChild.remove();
  }

  function beep(frequency, duration = 0.07) {
    if (!settings.sounds || !audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration + 0.02);
    } catch {
      /* audio feedback is optional */
    }
  }

  function report(state, detail) {
    if (port) {
      try {
        port.postMessage({ type: "engine-state", state, detail });
      } catch {
        /* the background page may be asleep */
      }
    }
  }

  /* --- microphone ------------------------------------------------------- */

  async function ensureMic() {
    clearTimeout(micIdleTimer);
    if (stream && audioCtx && workletNode && audioCtx.state !== "closed") {
      if (audioCtx.state === "suspended") await audioCtx.resume();
      return;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    try {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") await audioCtx.resume();

    await audioCtx.audioWorklet.addModule(api.runtime.getURL("recorder-worklet.js"));
    sourceNode = audioCtx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(audioCtx, "moonshine-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // A muted sink keeps the graph pulling audio without playing it back.
    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;
    sourceNode.connect(workletNode).connect(sinkNode).connect(audioCtx.destination);

    workletNode.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "audio") {
        chunks.push(msg.data);
        chunkLength += msg.data.length;
      }
      const level = Math.min(1, (msg.rms || 0) * 6);
      ui.meterBar.style.width = `${Math.round(level * 100)}%`;
    };
  }

  function scheduleMicRelease() {
    clearTimeout(micIdleTimer);
    if (!settings.keepMicOpen) return releaseMic();
    micIdleTimer = setTimeout(releaseMic, settings.micIdleReleaseMs);
  }

  function releaseMic() {
    clearTimeout(micIdleTimer);
    try {
      if (workletNode) workletNode.port.postMessage({ type: "active", value: false });
      if (sourceNode) sourceNode.disconnect();
      if (workletNode) workletNode.disconnect();
      if (sinkNode) sinkNode.disconnect();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
    } catch {
      /* nothing to do */
    }
    stream = null;
    audioCtx = null;
    workletNode = null;
    sourceNode = null;
    sinkNode = null;
    ui.meterBar.style.width = "0%";
  }

  async function resampleIfNeeded(audio, fromRate) {
    if (fromRate === SAMPLE_RATE) return audio;
    const frames = Math.round((audio.length * SAMPLE_RATE) / fromRate);
    const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
    const buffer = offline.createBuffer(1, audio.length, fromRate);
    buffer.copyToChannel(audio, 0);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  /* --- recording -------------------------------------------------------- */

  async function startRecording() {
    if (recording || busy) return;
    if (tts.speaking && settings.ttsStopOnDictate) stopSpeaking();
    try {
      await ensureMic();
    } catch (err) {
      const message =
        err && err.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it for this panel and try again."
          : `Microphone error: ${err && err.message ? err.message : err}`;
      setStatus(message, "error");
      report("error", message);
      if (port) port.postMessage({ type: "engine-error", message });
      return;
    }

    chunks = [];
    chunkLength = 0;
    recording = true;
    workletNode.port.postMessage({ type: "active", value: true });
    beep(660);
    setStatus("Listening…", "recording");
    ui.record.classList.add("recording");
    ui.recordLabel.textContent = "Stop";
    report("recording");

    clearTimeout(maxLengthTimer);
    maxLengthTimer = setTimeout(() => {
      if (recording) stopRecording();
    }, settings.maxSeconds * 1000);
  }

  async function stopRecording({ discard = false } = {}) {
    if (!recording) return;
    recording = false;
    clearTimeout(maxLengthTimer);
    if (workletNode) workletNode.port.postMessage({ type: "active", value: false });
    ui.record.classList.remove("recording");
    ui.recordLabel.textContent = "Hold to talk";
    scheduleMicRelease();

    if (discard) {
      chunks = [];
      chunkLength = 0;
      setStatus("Cancelled", "ready");
      report("idle");
      return;
    }

    beep(440);

    const rate = audioCtx ? audioCtx.sampleRate : SAMPLE_RATE;
    const merged = new Float32Array(chunkLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    chunks = [];
    chunkLength = 0;

    if (merged.length / rate < MIN_SECONDS) {
      setStatus("Too short — hold the key while you speak", "error");
      report("idle");
      return;
    }

    const audio = await resampleIfNeeded(merged, rate);

    busy = true;
    setStatus("Transcribing…", "busy");
    report("transcribing");
    const id = ++requestId;
    worker.postMessage(
      {
        type: "transcribe",
        id,
        audio,
        model: settings.model,
        device: settings.device,
      },
      [audio.buffer]
    );
  }

  /* --- worker ----------------------------------------------------------- */

  function startWorker() {
    worker = new Worker(api.runtime.getURL("worker.js"), { type: "module" });
    worker.addEventListener("message", onWorkerMessage);
    worker.addEventListener("error", (e) => {
      setStatus(`Worker error: ${e.message}`, "error");
    });
    setStatus("Loading model…", "busy");
    runtimeBinary().then((buffer) => {
      const message = {
        type: "load",
        model: settings.model,
        device: settings.device,
        variant: asrVariant,
      };
      // Send a copy: transferring would detach the page's cached buffer.
      if (buffer) message.wasmBinary = buffer.slice(0);
      worker.postMessage(message, message.wasmBinary ? [message.wasmBinary] : []);
    });
  }

  function version() {
    try {
      return api.runtime.getManifest().version;
    } catch {
      return "?";
    }
  }

  /**
   * Reads the runtime binary in this page, once. A page and a worker do not
   * necessarily get the same result when reading a moz-extension: URL, so the
   * page's copy is handed to the workers with every load message.
   */
  const RUNTIME_FILE = "ort-wasm-simd-threaded.asyncify.wasm";
  let wasmBytes = null;
  let wasmHow = "not read yet";
  let wasmBytesPromise = null;

  function isWasm(buffer) {
    if (!buffer || buffer.byteLength < 4) return false;
    const head = new Uint8Array(buffer.slice(0, 4));
    return head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
  }

  /** fetch() — the normal way, and the fast path when it works. */
  async function readVia(url, how) {
    if (how === "fetch") {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    }
    // XMLHttpRequest takes a different route through Firefox's internals than
    // fetch, and sometimes succeeds where fetch reports an aborted read.
    return await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", url);
      request.responseType = "arraybuffer";
      request.onload = () =>
        request.status === 200 || request.status === 0
          ? resolve(request.response)
          : reject(new Error(`HTTP ${request.status}`));
      request.onerror = () => reject(new Error("XHR failed"));
      request.send();
    });
  }

  /** Loads one script by tag and resolves when it has run. */
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const element = document.createElement("script");
      element.src = url;
      element.onload = () => {
        element.remove();
        resolve();
      };
      element.onerror = () => {
        element.remove();
        reject(new Error(`could not load ${url.split("/").pop()}`));
      };
      document.head.appendChild(element);
    });
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * Reads the runtime binary. Three routes, because reading the add-on's own
   * files is not dependable in Firefox: chunked fetch, chunked XHR, and finally
   * the chunks as <script> tags carrying base64 — scripts load even where file
   * reads are refused.
   */
  function runtimeBinary() {
    if (wasmBytes) return Promise.resolve(wasmBytes);
    if (wasmBytesPromise) return wasmBytesPromise;

    wasmBytesPromise = (async () => {
      const failures = [];

      if (settings.runtimeSource === "cdn") {
        try {
          const response = await fetch(MS.ortCdnUrl(settings));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          if (!isWasm(buffer)) throw new Error("not WebAssembly");
          wasmBytes = buffer;
          wasmHow = `CDN (${buffer.byteLength} bytes)`;
          return wasmBytes;
        } catch (err) {
          failures.push(`cdn: ${err && err.message ? err.message : err}`);
        }
      }

      for (const how of ["fetch", "xhr"]) {
        try {
          const manifestBuffer = await readVia(api.runtime.getURL(`wasm/parts/${RUNTIME_FILE}.json`), how);
          const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer));
          const assembled = new Uint8Array(manifest.total);
          let offset = 0;
          for (const part of manifest.parts) {
            const chunk = new Uint8Array(await readVia(api.runtime.getURL(`wasm/parts/${part}`), how));
            assembled.set(chunk, offset);
            offset += chunk.byteLength;
          }
          if (offset !== manifest.total) throw new Error(`got ${offset} of ${manifest.total} bytes`);
          if (!isWasm(assembled.buffer)) throw new Error("not WebAssembly");
          wasmBytes = assembled.buffer;
          wasmHow = `${manifest.parts.length} chunks via ${how} (${offset} bytes)`;
          return wasmBytes;
        } catch (err) {
          failures.push(`${how}: ${err && err.message ? err.message : err}`);
        }
      }

      // Last route: the chunks as scripts.
      try {
        await loadScript(api.runtime.getURL("wasm/parts/manifest.js"));
        const manifest = self.__MS_WASM_MANIFEST__;
        if (!manifest) throw new Error("manifest script did not run");
        const pieces = [];
        let total = 0;
        for (let index = 0; index < manifest.chunks; index++) {
          const key = String(index).padStart(3, "0");
          await loadScript(api.runtime.getURL(`wasm/parts/${manifest.file}.${key}.js`));
          const encoded = self.__MS_WASM__ && self.__MS_WASM__[key];
          if (!encoded) throw new Error(`chunk ${key} did not arrive`);
          const bytes = base64ToBytes(encoded);
          pieces.push(bytes);
          total += bytes.byteLength;
          delete self.__MS_WASM__[key]; // don't keep both copies in memory
        }
        const assembled = new Uint8Array(total);
        let offset = 0;
        for (const piece of pieces) {
          assembled.set(piece, offset);
          offset += piece.byteLength;
        }
        if (!isWasm(assembled.buffer)) throw new Error("not WebAssembly");
        wasmBytes = assembled.buffer;
        wasmHow = `${manifest.chunks} chunks via script tags (${total} bytes)`;
        return wasmBytes;
      } catch (err) {
        failures.push(`scripts: ${err && err.message ? err.message : err}`);
      }

      // Last resort: the identical build from the CDN. It is data, not code —
      // the bytes are handed to the runtime compiled into the add-on, so
      // nothing remote is ever executed.
      if (settings.runtimeSource !== "local") {
        try {
          const url = MS.ortCdnUrl(settings);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          if (!isWasm(buffer)) throw new Error("not WebAssembly");
          wasmBytes = buffer;
          wasmHow = `CDN (${buffer.byteLength} bytes)`;
          return wasmBytes;
        } catch (err) {
          failures.push(`cdn: ${err && err.message ? err.message : err}`);
        }
      }

      wasmHow = `failed — ${failures.join(" | ")}`;
      return null;
    })();

    return wasmBytesPromise;
  }

  /** Asks the worker whether WebAssembly and onnxruntime-web work at all. */
  function workerSelfTest(timeoutMs = 25000) {
    return new Promise((resolve) => {
      if (!worker) return resolve({ error: "worker not running" });
      const onMessage = (event) => {
        if (event.data && event.data.type === "selftest-result") {
          worker.removeEventListener("message", onMessage);
          clearTimeout(timer);
          resolve(event.data);
        }
      };
      const timer = setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        resolve({ error: "timed out" });
      }, timeoutMs);
      worker.addEventListener("message", onMessage);
      runtimeBinary().then((buffer) => {
        const message = { type: "selftest" };
        if (buffer) message.wasmBinary = buffer.slice(0);
        worker.postMessage(message, message.wasmBinary ? [message.wasmBinary] : []);
      });
    });
  }

  /* --- diagnostics ------------------------------------------------------ */

  const ms = (started) => `${Math.round(performance.now() - started)} ms`;
  const describe = (err) =>
    err && err.name ? `${err.name}: ${err.message || err}` : String(err && err.message ? err.message : err);

  /** Times one read and reports bytes or the exact failure. */
  async function probeRead(label, url, how, lines) {
    const started = performance.now();
    try {
      const buffer = await readVia(url, how);
      lines.push(`  ${label} via ${how}: ${buffer.byteLength} bytes in ${ms(started)}`);
      return true;
    } catch (err) {
      lines.push(`  ${label} via ${how}: ${describe(err)} after ${ms(started)}`);
      return false;
    }
  }

  /**
   * Everything we can establish without guessing: what this build is, whether
   * the add-on can read its own files (three ways, with timings), whether the
   * network works, whether storage works, and what the worker sees.
   */
  async function diagnose() {
    const lines = [`Moonshine Voice v${version()} — diagnostics`];

    // --- environment ---
    lines.push("", "[environment]");
    lines.push(`  user agent: ${navigator.userAgent}`);
    lines.push(`  page origin: ${location.origin}`);
    lines.push(`  runtime base: ${api.runtime.getURL("")}`);
    lines.push(`  origins match: ${api.runtime.getURL("").startsWith(location.origin) ? "yes" : "NO"}`);
    lines.push(`  webgpu: ${"gpu" in navigator ? "available" : "absent"}`);
    lines.push(`  SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined"} · crossOriginIsolated: ${self.crossOriginIsolated}`);
    lines.push(`  runtime source setting: ${settings.runtimeSource}`);
    try {
      const self_ = await api.management.getSelf();
      lines.push(`  install type: ${self_.installType} · version ${self_.version}`);
    } catch (err) {
      lines.push(`  install type: unavailable (${describe(err)})`);
    }
    try {
      const estimate = await navigator.storage.estimate();
      lines.push(
        `  storage: ${(estimate.usage / 1048576).toFixed(0)} MB used of ${(estimate.quota / 1048576).toFixed(0)} MB`
      );
    } catch (err) {
      lines.push(`  storage: unavailable (${describe(err)})`);
    }

    // --- can the add-on read its own files? ---
    lines.push("", "[reading the add-on's own files]");
    const manifestUrl = api.runtime.getURL(`wasm/parts/${RUNTIME_FILE}.json`);
    const chunkUrl = api.runtime.getURL(`wasm/parts/${RUNTIME_FILE}.000`);
    const loaderUrl = api.runtime.getURL("wasm/ort-wasm-simd-threaded.asyncify.js");

    // Headers only — this is what has always succeeded, so it isolates the
    // difference between opening a file and reading its contents.
    for (const [label, url] of [["manifest (1 KB)", manifestUrl], ["chunk (1 MB)", chunkUrl]]) {
      const started = performance.now();
      try {
        const response = await fetch(url);
        lines.push(
          `  ${label} headers: ${response.status} ${response.headers.get("content-type") || "?"}, ` +
            `length ${response.headers.get("content-length") || "?"} in ${ms(started)}`
        );
        if (response.body) response.body.cancel();
      } catch (err) {
        lines.push(`  ${label} headers: ${describe(err)} after ${ms(started)}`);
      }
    }

    for (const how of ["fetch", "xhr"]) {
      await probeRead("manifest (1 KB)", manifestUrl, how, lines);
      await probeRead("chunk (1 MB)", chunkUrl, how, lines);
      await probeRead("loader (47 KB)", loaderUrl, how, lines);
    }

    const scriptStarted = performance.now();
    try {
      await loadScript(api.runtime.getURL("wasm/parts/manifest.js"));
      lines.push(
        `  manifest via script tag: ${self.__MS_WASM_MANIFEST__ ? "loaded and ran" : "loaded but set nothing"} in ${ms(scriptStarted)}`
      );
    } catch (err) {
      lines.push(`  manifest via script tag: ${describe(err)} after ${ms(scriptStarted)}`);
    }

    // --- does the network work? ---
    lines.push("", "[network]");
    for (const [label, url] of [
      ["hugging face", "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/main/config.json"],
      ["jsdelivr cdn", MS.ortCdnUrl(settings).replace(/\/[^/]+$/, "/package.json")],
    ]) {
      const started = performance.now();
      try {
        const response = await fetch(url);
        const text = await response.text();
        lines.push(`  ${label}: ${response.status}, ${text.length} bytes in ${ms(started)}`);
      } catch (err) {
        lines.push(`  ${label}: ${describe(err)} after ${ms(started)}`);
      }
    }

    // --- storage the model cache depends on ---
    lines.push("", "[cache api]");
    try {
      const cache = await caches.open("moonshine-diagnostic");
      await cache.put("/probe", new Response("probe"));
      const hit = await cache.match("/probe");
      lines.push(`  cache put/match: ${hit ? "ok" : "miss"}`);
      await caches.delete("moonshine-diagnostic");
    } catch (err) {
      lines.push(`  cache put/match: ${describe(err)}`);
    }

    // --- the runtime itself ---
    lines.push("", "[webassembly runtime]");
    try {
      new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      lines.push("  panel compile: ok");
    } catch (err) {
      lines.push(`  panel compile: ${describe(err)}`);
    }
    await runtimeBinary();
    lines.push(`  panel read of runtime: ${wasmHow}`);

    const probe = await workerSelfTest();
    lines.push(`  worker compile: ${probe.compile || probe.error || "?"}`);
    lines.push(`  worker binary: ${probe.binary || probe.error || "?"}`);
    lines.push(`  worker onnxruntime: ${probe.runtime || probe.error || "?"}`);
    lines.push(`  asr variant: ${asrVariant} · tts variant: ${tts.variant}`);

    if (attemptLog.length) {
      lines.push("", "[failures so far]");
      for (const entry of attemptLog.slice(-8)) lines.push(`  ${entry}`);
    }

    return lines.join("\n");
  }

  function onWorkerMessage(event) {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        if (msg.state === "loading") {
          setStatus("Downloading model (first run only)…", "busy");
          report("loading");
        } else if (msg.state === "retrying") {
          setStatus("Adjusting model settings…", "busy");
        }
        break;

      case "progress":
        if (msg.percent !== undefined && msg.total) {
          const mb = (msg.total / 1048576).toFixed(0);
          setProgress(msg.percent, `${msg.file.split("/").pop()} — ${msg.percent}% of ${mb} MB`);
        }
        break;

      case "ready": {
        ready = true;
        setProgress(null);
        setStatus("Ready", "ready");
        ui.record.disabled = false;
        ui.recordLabel.textContent = settings.mode === "toggle" ? "Start dictation" : "Hold to talk";
        ui.engineInfo.textContent =
          `v${version()} · ${msg.model.split("/").pop()} · ${msg.device.toUpperCase()} · ${msg.dtype}`;
        report("ready");
        break;
      }

      case "result": {
        busy = false;
        setProgress(null);
        const speed = msg.seconds ? (msg.seconds / (msg.ms / 1000)).toFixed(1) : "—";
        if (msg.text) {
          addTranscript(msg.text, `${msg.ms} ms · ${speed}× real time`);
          if (port) port.postMessage({ type: "transcript", text: msg.text });
          setStatus("Ready", "ready");
        } else {
          setStatus("Nothing heard", "ready");
        }
        report("idle");
        break;
      }

      case "restart": {
        // The WASM runtime never came up; try the next build in a fresh worker.
        attemptLog.push(`variant ${asrVariant} → ${msg.detail}`);
        asrVariant = msg.variant;
        setStatus("Trying the CPU WebAssembly build…", "busy");
        if (worker) worker.terminate();
        startWorker();
        break;
      }

      case "error": {
        busy = false;
        setProgress(null);
        if (/Switching WebAssembly build/i.test(msg.message)) break; // handled by "restart"
        attemptLog.push(msg.message);
        setStatus(msg.message, "error");
        if (port) port.postMessage({ type: "engine-error", message: msg.message });
        diagnose().then((report) => addTranscript(report, "diagnostics — click to copy"));
        break;
      }

      default:
        break;
    }
  }

  /* --- reading aloud ---------------------------------------------------- */

  const tts = {
    worker: null, // Kokoro worker, created on first use
    variant: 0, // which shipped onnxruntime-web build it is using
    lastSpeak: null, // replayed if the runtime has to be swapped
    moonshine: null, // adapter instance, if that engine is selected
    playCtx: null,
    sources: [],
    tail: 0,
    speaking: false,
    seq: 0,
    pending: 0, // audio chunks still playing
    finished: false, // the engine has stopped producing audio
  };

  function ttsProgress(percent, label) {
    if (percent === null) {
      ui.ttsProgressWrap.hidden = true;
      return;
    }
    ui.ttsProgressWrap.hidden = false;
    ui.ttsProgressBar.style.width = `${percent}%`;
    ui.ttsProgressText.textContent = label;
  }

  function speakingUI(on) {
    tts.speaking = on;
    ui.stopSpeak.hidden = !on;
    ui.speak.disabled = on;
    if (on) {
      setStatus("Reading aloud…", "busy");
      report("speaking");
    } else {
      setStatus(ready ? "Ready" : "Loading model…", ready ? "ready" : "busy");
      if (port) {
        try {
          port.postMessage({ type: "speaking-done" });
        } catch {
          /* the background page may be asleep */
        }
      }
    }
  }

  function playbackContext() {
    if (!tts.playCtx || tts.playCtx.state === "closed") {
      tts.playCtx = new AudioContext();
      tts.tail = 0;
    }
    if (tts.playCtx.state === "suspended") tts.playCtx.resume();
    return tts.playCtx;
  }

  function enqueueAudio(samples, sampleRate) {
    const ctx = playbackContext();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.03, tts.tail);
    source.start(startAt);
    tts.tail = startAt + buffer.duration;
    tts.pending++;
    tts.sources.push(source);
    source.onended = () => {
      tts.sources = tts.sources.filter((s) => s !== source);
      tts.pending--;
      if (tts.finished && tts.pending <= 0) speakingUI(false);
    };
  }

  function stopSpeaking() {
    tts.seq++; // invalidate anything still in flight
    tts.finished = true;
    tts.pending = 0;
    for (const source of tts.sources) {
      try {
        source.stop();
      } catch {
        /* already finished */
      }
    }
    tts.sources = [];
    tts.tail = 0;
    if (tts.worker) tts.worker.postMessage({ type: "cancel" });
    if (tts.moonshine) tts.moonshine.stop();
    try {
      speechSynthesis.cancel();
    } catch {
      /* not every build exposes speechSynthesis */
    }
    ttsProgress(null);
    speakingUI(false);
  }

  function ensureTtsWorker() {
    if (tts.worker) return tts.worker;
    tts.worker = new Worker(api.runtime.getURL("tts-worker.js"), { type: "module" });
    tts.worker.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "status":
          if (msg.state === "loading") setStatus("Downloading voice model (first run only)…", "busy");
          break;
        case "progress":
          if (msg.total) {
            ttsProgress(msg.percent, `voice model — ${msg.percent}% of ${(msg.total / 1048576).toFixed(0)} MB`);
          }
          break;
        case "ready":
          ttsProgress(null);
          ui.ttsEngineInfo.textContent = `Kokoro · ${msg.device.toUpperCase()} · ${msg.dtype}`;
          break;
        case "audio":
          if (msg.id !== tts.seq) return; // stale, we were stopped
          enqueueAudio(msg.audio, msg.sampleRate);
          break;
        case "spoken":
          if (msg.id !== tts.seq) return;
          tts.finished = true;
          if (tts.pending <= 0) speakingUI(false);
          break;
        case "restart":
          tts.variant = msg.variant;
          setStatus("Trying the CPU WebAssembly build…", "busy");
          if (tts.worker) tts.worker.terminate();
          tts.worker = null;
          if (tts.lastSpeak) {
            const retry = Object.assign({}, tts.lastSpeak, { variant: tts.variant });
            ensureTtsWorker().postMessage(retry);
          }
          break;

        case "error":
          ttsProgress(null);
          if (/Switching WebAssembly build/i.test(msg.message)) break; // handled by "restart"
          setStatus(msg.message, "error");
          speakingUI(false);
          diagnose().then((report) => addTranscript(report, "diagnostics — click to copy"));
          break;
        default:
          break;
      }
    });
    tts.worker.addEventListener("error", (e) => {
      setStatus(`Voice worker error: ${e.message}`, "error");
      speakingUI(false);
    });
    return tts.worker;
  }

  function systemVoices() {
    try {
      return speechSynthesis.getVoices() || [];
    } catch {
      return [];
    }
  }

  async function speakSystem(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = systemVoices().find((v) => v.voiceURI === settings.ttsVoiceSystem);
    if (voice) utterance.voice = voice;
    utterance.rate = settings.ttsRate;
    utterance.onend = () => speakingUI(false);
    utterance.onerror = () => speakingUI(false);
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }

  async function speakMoonshine(text) {
    if (!tts.moonshine) {
      const reason = await MS_TTS.preflight(api);
      if (reason) throw new Error(reason);
      setStatus("Loading Moonshine voice…", "busy");
      tts.moonshine = await MS_TTS.create({
        api,
        language: "en_us",
        voice: settings.ttsVoiceMoonshine,
        audioContext: playbackContext(),
        onProgress: (fraction) => ttsProgress(Math.round((fraction || 0) * 100), "Moonshine voice model"),
      });
      ttsProgress(null);
      ui.ttsEngineInfo.textContent = "Moonshine TTS";
    }
    await tts.moonshine.say(text);
    speakingUI(false);
  }

  async function speak(text) {
    const trimmed = (text || "").trim().slice(0, settings.ttsMaxChars);
    if (!trimmed) return;
    stopSpeaking();
    const id = ++tts.seq;
    tts.finished = false;
    tts.pending = 0;
    speakingUI(true);

    try {
      if (settings.ttsEngine === "system") {
        await speakSystem(trimmed);
      } else if (settings.ttsEngine === "moonshine") {
        await speakMoonshine(trimmed);
      } else {
        const buffer = await runtimeBinary();
        tts.lastSpeak = {
          type: "speak",
          id,
          text: trimmed,
          voice: settings.ttsVoiceKokoro,
          speed: settings.ttsRate,
          device: settings.device,
          variant: tts.variant,
        };
        const message = Object.assign({}, tts.lastSpeak);
        if (buffer) message.wasmBinary = buffer.slice(0);
        ensureTtsWorker().postMessage(message, message.wasmBinary ? [message.wasmBinary] : []);
      }
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      setStatus(message, "error");
      speakingUI(false);
      if (port) port.postMessage({ type: "engine-error", message });
    }
  }

  function fillVoices() {
    const select = ui.ttsVoice;
    select.innerHTML = "";
    const add = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };

    if (settings.ttsEngine === "system") {
      const voices = systemVoices();
      add("", voices.length ? "Default system voice" : "System voices (loading…)");
      for (const v of voices) add(v.voiceURI, `${v.name} — ${v.lang}`);
      select.value = settings.ttsVoiceSystem;
      ui.ttsEngineInfo.textContent = "System voices";
    } else if (settings.ttsEngine === "moonshine") {
      for (const v of MS.KOKORO_VOICES) add(`kokoro_${v.id}`, v.label);
      select.value = settings.ttsVoiceMoonshine;
      ui.ttsEngineInfo.textContent = "Moonshine TTS";
    } else {
      for (const v of MS.KOKORO_VOICES) add(v.id, v.label);
      select.value = settings.ttsVoiceKokoro;
      ui.ttsEngineInfo.textContent = "Kokoro 82M";
    }
  }

  ui.ttsVoice.addEventListener("change", (e) => {
    const key =
      settings.ttsEngine === "system"
        ? "ttsVoiceSystem"
        : settings.ttsEngine === "moonshine"
          ? "ttsVoiceMoonshine"
          : "ttsVoiceKokoro";
    if (settings.ttsEngine === "moonshine" && tts.moonshine) {
      tts.moonshine.close();
      tts.moonshine = null; // rebuilt with the new voice on the next call
    }
    MS.setSettings({ [key]: e.target.value });
  });

  ui.speak.addEventListener("click", () => {
    if (port) port.postMessage({ type: "speak-active-selection" });
  });
  ui.stopSpeak.addEventListener("click", stopSpeaking);

  try {
    speechSynthesis.addEventListener("voiceschanged", () => {
      if (settings.ttsEngine === "system") fillVoices();
    });
  } catch {
    /* no speechSynthesis in this context */
  }

  /* --- wiring ----------------------------------------------------------- */

  function connect() {
    port = api.runtime.connect({ name: "moonshine-engine" });
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "start":
          startRecording();
          break;
        case "stop":
          stopRecording();
          break;
        case "cancel":
          stopRecording({ discard: true });
          break;
        case "toggle":
          recording ? stopRecording() : startRecording();
          break;
        case "speak":
          speak(msg.text);
          break;
        case "stop-speaking":
          stopSpeaking();
          break;
        default:
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
  }

  async function checkPermissions() {
    try {
      const granted = await api.permissions.contains({ origins: ["<all_urls>"] });
      ui.permissionBox.hidden = granted;
    } catch {
      ui.permissionBox.hidden = true;
    }
  }

  ui.record.addEventListener("mousedown", () => {
    if (settings.mode === "ptt") {
      if (port) port.postMessage({ type: "need-target" });
      startRecording();
    }
  });
  ui.record.addEventListener("mouseup", () => {
    if (settings.mode === "ptt") stopRecording();
  });
  ui.record.addEventListener("mouseleave", () => {
    if (settings.mode === "ptt" && recording) stopRecording();
  });
  ui.record.addEventListener("click", () => {
    if (settings.mode !== "ptt") {
      if (port) port.postMessage({ type: "need-target" });
      recording ? stopRecording() : startRecording();
    }
  });

  ui.grant.addEventListener("click", async () => {
    try {
      await api.permissions.request({ origins: ["<all_urls>"] });
    } catch {
      /* the user declined */
    }
    checkPermissions();
  });

  ui.clear.addEventListener("click", () => (ui.transcripts.innerHTML = ""));
  ui.diag.addEventListener("click", async () => {
    ui.diag.disabled = true;
    ui.diag.textContent = "Testing…";
    try {
      addTranscript(await diagnose(), "diagnostics — click to copy");
    } finally {
      ui.diag.disabled = false;
      ui.diag.textContent = "Diagnostics";
    }
  });
  ui.settings.addEventListener("click", () => api.runtime.openOptionsPage());

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const previous = settings;
    settings = Object.assign({}, MS.DEFAULTS, changes.settings.newValue);
    ui.hotkeyHint.textContent = MS.hotkeyLabel(settings.hotkey);
    ui.ttsHotkeyHint.textContent = MS.hotkeyLabel(settings.ttsHotkey);
    if (previous.ttsEngine !== settings.ttsEngine) {
      stopSpeaking();
      if (tts.moonshine) {
        tts.moonshine.close();
        tts.moonshine = null;
      }
      fillVoices();
    }
    if (previous.model !== settings.model || previous.device !== settings.device) {
      ready = false;
      ui.record.disabled = true;
      ui.recordLabel.textContent = "Loading model…";
      worker.postMessage({ type: "load", model: settings.model, device: settings.device });
    }
  });

  window.addEventListener("beforeunload", () => {
    releaseMic();
    stopSpeaking();
    if (worker) worker.terminate();
    if (tts.worker) tts.worker.terminate();
  });

  (async function init() {
    settings = await MS.getSettings();
    ui.engineInfo.textContent = `v${version()}`;
    ui.hotkeyHint.textContent = MS.hotkeyLabel(settings.hotkey);
    ui.ttsHotkeyHint.textContent = MS.hotkeyLabel(settings.ttsHotkey);
    fillVoices();
    connect();
    checkPermissions();
    startWorker();
  })();
})();
