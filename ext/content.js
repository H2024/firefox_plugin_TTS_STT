/* Content script: watches for the push-to-talk hotkey, shows the listening
   indicator, and drops the finished transcript into whatever field you were
   typing in. */
"use strict";

(() => {
  const api = MS.api;
  let settings = Object.assign({}, MS.DEFAULTS);
  let recording = false;
  let target = null; // the editable element that had focus when we started
  let indicator = null;
  let indicatorText = null;

  MS.getSettings().then((s) => (settings = s));
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settings = Object.assign({}, MS.DEFAULTS, changes.settings.newValue);
    }
  });

  /* --- indicator -------------------------------------------------------- */

  function ensureIndicator() {
    if (indicator || !settings.showIndicator) return;
    const host = document.createElement("div");
    host.id = "moonshine-voice-indicator";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        .pill{display:flex;align-items:center;gap:8px;font:500 13px/1.2 system-ui,sans-serif;
          color:#fff;background:#1c1b22;border:1px solid rgba(255,255,255,.18);
          border-radius:999px;padding:8px 14px;box-shadow:0 4px 16px rgba(0,0,0,.35);}
        .dot{width:9px;height:9px;border-radius:50%;background:#ff4d4d;
          animation:pulse 1.2s ease-in-out infinite;}
        .dot.busy{background:#f0b429;animation:none;}
        .dot.err{background:#8a8a8a;animation:none;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
      </style>
      <div class="pill"><span class="dot"></span><span class="label">Listening…</span></div>`;
    (document.body || document.documentElement).appendChild(host);
    indicator = { host, dot: shadow.querySelector(".dot"), label: shadow.querySelector(".label") };
    indicatorText = indicator.label;
  }

  function showIndicator(text, kind) {
    if (!settings.showIndicator) return;
    ensureIndicator();
    if (!indicator) return;
    indicator.host.style.display = "block";
    indicator.dot.className = "dot" + (kind ? " " + kind : "");
    indicatorText.textContent = text;
  }

  function hideIndicator(delay = 0) {
    if (!indicator) return;
    const hide = () => indicator && (indicator.host.style.display = "none");
    delay ? setTimeout(hide, delay) : hide();
  }

  /* --- target tracking -------------------------------------------------- */

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return (
        !el.disabled &&
        !el.readOnly &&
        ["text", "search", "url", "email", "tel", "password", "number", ""].includes(t)
      );
    }
    return el.isContentEditable === true;
  }

  function captureTarget() {
    const active = document.activeElement;
    target = isEditable(active) ? active : null;
  }

  /* --- insertion -------------------------------------------------------- */

  function formatText(raw) {
    let text = (raw || "").trim();
    if (!text) return "";
    if (settings.capitalize) text = text.charAt(0).toUpperCase() + text.slice(1);
    if (settings.trailingSpace) text += " ";
    return text;
  }

  function insertText(raw) {
    const text = formatText(raw);
    if (!text) {
      showIndicator("Nothing heard", "err");
      hideIndicator(1500);
      return;
    }

    if (settings.insertMode === "clipboard") {
      copy(text);
      showIndicator("Copied to clipboard", "busy");
      hideIndicator(1800);
      return;
    }

    const el = isEditable(document.activeElement) ? document.activeElement : target;
    if (!el) {
      copy(text);
      showIndicator("No text field — copied instead", "busy");
      hideIndicator(2200);
      return;
    }

    el.focus();

    // execCommand keeps the browser's own undo stack and fires the input events
    // that frameworks like React listen for.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }

    if (!ok) {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
          "value"
        ).set;
        setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
        el.selectionStart = el.selectionEnd = start + text.length;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.setEndAfter(node);
          sel.removeAllRanges();
          sel.addRange(range);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        }
      }
    }

    hideIndicator();
  }

  function copy(text) {
    try {
      navigator.clipboard.writeText(text);
    } catch {
      /* clipboard can be blocked; the panel keeps a copy of the transcript */
    }
  }

  /* --- hotkey ----------------------------------------------------------- */

  function start() {
    if (recording) return;
    if (speaking && settings.ttsStopOnDictate) stopSpeaking();
    recording = true;
    captureTarget();
    showIndicator("Listening…");
    api.runtime.sendMessage({ type: "ptt-start" }).catch(() => {});
  }

  function stop() {
    if (!recording) return;
    recording = false;
    showIndicator("Transcribing…", "busy");
    api.runtime.sendMessage({ type: "ptt-stop" }).catch(() => {});
  }

  function cancel() {
    if (!recording) return;
    recording = false;
    hideIndicator();
    api.runtime.sendMessage({ type: "ptt-cancel" }).catch(() => {});
  }

  /* --- reading aloud ---------------------------------------------------- */

  let speaking = false;

  function selectedText() {
    const active = document.activeElement;
    // A selection inside an <input>/<textarea> isn't visible to getSelection().
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      const { selectionStart: start, selectionEnd: end } = active;
      if (start !== null && end !== null && end > start) return active.value.slice(start, end);
    }
    const selection = String(window.getSelection() || "").trim();
    return selection;
  }

  function speakSelection() {
    const text = selectedText();
    if (!text) {
      showIndicator("Select some text first", "err");
      hideIndicator(1800);
      return;
    }
    speaking = true;
    showIndicator("Reading aloud…", "busy");
    api.runtime.sendMessage({ type: "speak", text }).catch(() => {});
  }

  function stopSpeaking() {
    if (!speaking) return;
    speaking = false;
    hideIndicator();
    api.runtime.sendMessage({ type: "stop-speaking" }).catch(() => {});
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat) return;
      if (event.key === "Escape") {
        if (recording) cancel();
        if (speaking) stopSpeaking();
        if (recording || speaking) return;
      }
      if (MS.matchesHotkey(event, settings.ttsHotkey)) {
        event.preventDefault();
        event.stopPropagation();
        speaking ? stopSpeaking() : speakSelection();
        return;
      }
      if (!MS.matchesHotkey(event, settings.hotkey)) return;
      event.preventDefault();
      event.stopPropagation();
      if (settings.mode === "toggle") {
        recording ? stop() : start();
      } else {
        start();
      }
    },
    true
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (settings.mode !== "ptt" || !recording) return;
      const hk = settings.hotkey || {};
      const released =
        event.code === hk.code ||
        (hk.ctrl && (event.key === "Control" || event.code.startsWith("Control"))) ||
        (hk.shift && (event.key === "Shift" || event.code.startsWith("Shift"))) ||
        (hk.alt && (event.key === "Alt" || event.code.startsWith("Alt"))) ||
        (hk.meta && (event.key === "Meta" || event.code.startsWith("Meta")));
      if (released) {
        event.preventDefault();
        stop();
      }
    },
    true
  );

  window.addEventListener("blur", () => {
    if (recording && settings.mode === "ptt") stop();
  });

  /* --- messages from the engine ----------------------------------------- */

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "insert") {
      insertText(msg.text);
    } else if (msg.type === "speak-selection") {
      speakSelection();
    } else if (msg.type === "speaking-done") {
      speaking = false;
      hideIndicator(300);
    } else if (msg.type === "state") {
      if (msg.state === "speaking") showIndicator("Reading aloud…", "busy");
      else if (msg.state === "loading") showIndicator("Loading model…", "busy");
      else if (msg.state === "recording") showIndicator("Listening…");
      else if (msg.state === "transcribing") showIndicator("Transcribing…", "busy");
      else if (msg.state === "error") {
        recording = false;
        speaking = false;
        showIndicator(msg.detail || "Error", "err");
        hideIndicator(3000);
      } else if (msg.state === "idle") {
        hideIndicator(400);
      }
    }
  });
})();
