"use strict";

(() => {
  const api = MS.api;
  const el = (id) => document.getElementById(id);
  let settings = Object.assign({}, MS.DEFAULTS);
  let listening = null;

  const CHECKBOXES = [
    "trailingSpace",
    "capitalize",
    "showIndicator",
    "sounds",
    "keepMicOpen",
    "autoOpenWindow",
    "ttsStopOnDictate",
  ];
  const SELECTS = ["model", "device", "mode", "insertMode", "maxSeconds", "ttsEngine", "ttsRate", "runtimeSource"];
  const NUMERIC = new Set(["maxSeconds", "ttsRate"]);

  const TTS_HELP = {
    system:
      "Uses the voices already installed in your operating system through Firefox's speech synthesis. Nothing to download, starts instantly, quality depends on your OS voices.",
    kokoro:
      "Kokoro 82M runs locally in the add-on — the same voice family Moonshine's own TTS uses for its catalogue voices. About 90 MB, downloaded once, then offline.",
    moonshine:
      "Moonshine's own synthesizer. Firefox cannot give extension pages the cross-origin isolation that the published multi-threaded build needs (Mozilla bug 1673477), so this only works if you drop a single-threaded build into ext/moonshine/ — see the README.",
  };

  function fillModels() {
    const select = el("model");
    select.innerHTML = "";
    for (const m of MS.MODELS) {
      const option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.label;
      select.appendChild(option);
    }
  }

  function fillEngines() {
    const select = el("ttsEngine");
    select.innerHTML = "";
    for (const e of MS.TTS_ENGINES) {
      const option = document.createElement("option");
      option.value = e.id;
      option.textContent = e.label;
      select.appendChild(option);
    }
  }

  function systemVoices() {
    try {
      return speechSynthesis.getVoices() || [];
    } catch {
      return [];
    }
  }

  function ttsVoiceKey() {
    return settings.ttsEngine === "system"
      ? "ttsVoiceSystem"
      : settings.ttsEngine === "moonshine"
        ? "ttsVoiceMoonshine"
        : "ttsVoiceKokoro";
  }

  function fillVoices() {
    const select = el("ttsVoice");
    select.innerHTML = "";
    const add = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };

    if (settings.ttsEngine === "system") {
      const voices = systemVoices();
      add("", voices.length ? "Default system voice" : "Default system voice (list loading…)");
      for (const v of voices) add(v.voiceURI, `${v.name} — ${v.lang}`);
    } else {
      const prefix = settings.ttsEngine === "moonshine" ? "kokoro_" : "";
      for (const v of MS.KOKORO_VOICES) add(prefix + v.id, v.label);
    }
    select.value = settings[ttsVoiceKey()];
  }

  function render() {
    for (const id of SELECTS) el(id).value = String(settings[id]);
    for (const id of CHECKBOXES) el(id).checked = !!settings[id];
    el("ttsEngineHelp").textContent = TTS_HELP[settings.ttsEngine] || "";
    fillVoices();
    el("hotkey").textContent = MS.hotkeyLabel(settings.hotkey);
    el("ttsHotkey").textContent = MS.hotkeyLabel(settings.ttsHotkey);
    el("modelHelp").textContent =
      settings.model.includes("tiny")
        ? "Tiny: about 50 MB, fastest, a little less accurate on noisy audio."
        : "Base: about 150 MB, the best accuracy Moonshine offers. English only.";
  }

  let savedTimer = null;
  async function save(patch) {
    settings = await MS.setSettings(patch);
    render();
    el("saved").hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (el("saved").hidden = true), 1200);
  }

  for (const id of SELECTS) {
    el(id).addEventListener("change", (e) => {
      const value = NUMERIC.has(id) ? Number(e.target.value) : e.target.value;
      save({ [id]: value });
    });
  }

  el("ttsVoice").addEventListener("change", (e) => save({ [ttsVoiceKey()]: e.target.value }));

  try {
    speechSynthesis.addEventListener("voiceschanged", () => {
      if (settings.ttsEngine === "system") fillVoices();
    });
  } catch {
    /* no speech synthesis here */
  }

  for (const id of CHECKBOXES) {
    el(id).addEventListener("change", (e) => save({ [id]: e.target.checked }));
  }

  for (const [buttonId, settingKey] of [
    ["hotkey", "hotkey"],
    ["ttsHotkey", "ttsHotkey"],
  ]) {
    el(buttonId).addEventListener("click", () => {
      listening = { buttonId, settingKey };
      el(buttonId).classList.add("listening");
      el(buttonId).textContent = "Press a key combination…";
    });
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (!listening) return;
      event.preventDefault();
      if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
      const { buttonId, settingKey } = listening;
      listening = null;
      el(buttonId).classList.remove("listening");
      if (event.key === "Escape") return render();
      save({
        [settingKey]: {
          code: event.code,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          meta: event.metaKey,
        },
      });
    },
    true
  );

  async function checkPermissions() {
    try {
      const granted = await api.permissions.contains({ origins: ["<all_urls>"] });
      el("permission").hidden = granted;
    } catch {
      el("permission").hidden = true;
    }
  }

  el("grant").addEventListener("click", async () => {
    try {
      await api.permissions.request({ origins: ["<all_urls>"] });
    } catch {
      /* declined */
    }
    checkPermissions();
  });

  (async function init() {
    try {
      document.querySelector("h1").textContent += ` ${api.runtime.getManifest().version}`;
    } catch {
      /* version is cosmetic */
    }
    fillModels();
    fillEngines();
    settings = await MS.getSettings();
    render();
    checkPermissions();
  })();
})();
