/* Background event page: routes hotkeys from web pages to the engine (the
   panel, which owns the microphone and the model) and routes transcripts back
   to the tab that asked for them. */
"use strict";

const api = MS.api;

/** @type {Set<chrome.runtime.Port>} */
const enginePorts = new Set();
let engineWindowId = null;
let pendingEngine = null;
/** The page that started the current dictation, so the text lands back there. */
let requester = null;
/** Last tab active in a normal browser window (the engine window isn't one). */
let lastActiveTab = null;

api.tabs.onActivated.addListener(({ tabId }) => (lastActiveTab = tabId));

function engine() {
  // Most recently connected panel wins (the one the user just opened).
  let last = null;
  for (const p of enginePorts) last = p;
  return last;
}

function sendToEngine(msg) {
  const port = engine();
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (err) {
    enginePorts.delete(port);
    return false;
  }
}

async function ensureEngine({ userGesture = false } = {}) {
  if (enginePorts.size) return true;

  const settings = await MS.getSettings();

  if (userGesture && api.sidebarAction) {
    try {
      await api.sidebarAction.open();
      return await waitForEngine(4000);
    } catch (err) {
      /* fall through to the window fallback */
    }
  }

  if (!settings.autoOpenWindow) {
    notify("Open the Moonshine panel first (toolbar button or Ctrl+Shift+U).");
    return false;
  }

  if (engineWindowId !== null) {
    try {
      await api.windows.get(engineWindowId);
    } catch {
      engineWindowId = null;
    }
  }

  if (engineWindowId === null) {
    if (!pendingEngine) {
      pendingEngine = api.windows
        .create({
          url: api.runtime.getURL("sidebar/panel.html?host=window"),
          type: "popup",
          width: 420,
          height: 560,
        })
        .then((win) => {
          engineWindowId = win.id;
        })
        .catch(() => {})
        .finally(() => {
          pendingEngine = null;
        });
    }
    await pendingEngine;
  }

  return await waitForEngine(15000);
}

function waitForEngine(timeoutMs) {
  if (enginePorts.size) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (enginePorts.size) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function notify(message) {
  try {
    api.notifications.create({
      type: "basic",
      iconUrl: api.runtime.getURL("icons/mic-96.svg"),
      title: "Moonshine Voice",
      message,
    });
  } catch {
    /* notifications are a nicety, not a requirement */
  }
}

function toRequester(msg) {
  if (!requester) return;
  api.tabs
    .sendMessage(requester.tabId, msg, { frameId: requester.frameId })
    .catch(() => {});
}

/* --- the panel connects here ------------------------------------------- */

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "moonshine-engine") return;
  enginePorts.add(port);

  port.onDisconnect.addListener(() => enginePorts.delete(port));

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case "engine-state":
        toRequester({ type: "state", state: msg.state, detail: msg.detail });
        break;
      case "transcript":
        toRequester({ type: "insert", text: msg.text });
        break;
      case "speaking-done":
        toRequester({ type: "speaking-done" });
        break;
      case "engine-error":
        toRequester({ type: "state", state: "error", detail: msg.message });
        notify(msg.message);
        break;
      case "speak-active-selection": {
        const tabs = await api.tabs.query({ active: true, windowType: "normal" });
        const tab = tabs.find((t) => t.id === lastActiveTab) || tabs[0];
        if (!tab) return;
        requester = { tabId: tab.id, frameId: 0 };
        api.tabs.sendMessage(tab.id, { type: "speak-selection" }).catch(() => {
          notify("Can't read the selection on that page — try a normal web page.");
        });
        break;
      }
      case "need-target": {
        // Dictation started from the panel itself, so aim at the page the user
        // was last on — never at the panel's own popup window.
        const tabs = await api.tabs.query({ active: true, windowType: "normal" });
        const tab = tabs.find((t) => t.id === lastActiveTab) || tabs[0];
        if (tab) requester = { tabId: tab.id, frameId: 0 };
        break;
      }
      default:
        break;
    }
  });
});

/* --- content scripts talk to us ---------------------------------------- */

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === "ptt-start" || msg.type === "toggle") {
    if (sender.tab) requester = { tabId: sender.tab.id, frameId: sender.frameId || 0 };
    return (async () => {
      const ok = await ensureEngine({ userGesture: false });
      if (!ok) {
        toRequester({ type: "state", state: "error", detail: "Panel is not open" });
        return { ok: false };
      }
      sendToEngine({ type: msg.type === "toggle" ? "toggle" : "start" });
      return { ok: true };
    })();
  }

  if (msg.type === "speak") {
    if (sender.tab) requester = { tabId: sender.tab.id, frameId: sender.frameId || 0 };
    return (async () => {
      const ok = await ensureEngine({ userGesture: false });
      if (!ok) {
        toRequester({ type: "state", state: "error", detail: "Panel is not open" });
        return { ok: false };
      }
      sendToEngine({ type: "speak", text: msg.text });
      return { ok: true };
    })();
  }

  if (msg.type === "stop-speaking") {
    sendToEngine({ type: "stop-speaking" });
    return Promise.resolve({ ok: true });
  }

  if (msg.type === "ptt-stop") {
    sendToEngine({ type: "stop" });
    return Promise.resolve({ ok: true });
  }

  if (msg.type === "ptt-cancel") {
    sendToEngine({ type: "cancel" });
    return Promise.resolve({ ok: true });
  }

  if (msg.type === "open-options") {
    api.runtime.openOptionsPage();
    return Promise.resolve({ ok: true });
  }
});

/* --- toolbar button and keyboard command -------------------------------- */

api.action.onClicked.addListener(async () => {
  if (api.sidebarAction) {
    try {
      await api.sidebarAction.toggle();
      return;
    } catch {
      /* ignore */
    }
  }
  await ensureEngine({ userGesture: true });
});

api.commands.onCommand.addListener(async (command) => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) requester = { tabId: tab.id, frameId: 0 };

  if (command === "toggle-recording") {
    const ok = await ensureEngine({ userGesture: true });
    if (ok) sendToEngine({ type: "toggle" });
    return;
  }

  if (command === "read-selection" && tab) {
    // Ask the page for its selection; it messages us straight back.
    api.tabs.sendMessage(tab.id, { type: "speak-selection" }).catch(() => {});
  }
});

/* --- context menu ------------------------------------------------------- */

const MENU_ID = "moonshine-read-aloud";

function createMenu() {
  const menus = api.menus || api.contextMenus;
  if (!menus) return;
  try {
    menus.removeAll(() =>
      menus.create({
        id: MENU_ID,
        title: "Read aloud with Moonshine Voice",
        contexts: ["selection"],
      })
    );
  } catch {
    /* menus are optional */
  }
}

const menus = api.menus || api.contextMenus;
if (menus && menus.onClicked) {
  menus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    if (tab) requester = { tabId: tab.id, frameId: 0 };
    const text = (info.selectionText || "").trim();
    if (!text) return;
    const ok = await ensureEngine({ userGesture: true });
    if (ok) sendToEngine({ type: "speak", text });
  });
}

api.runtime.onInstalled.addListener((details) => {
  createMenu();
  if (details.reason === "install") api.runtime.openOptionsPage();
});
api.runtime.onStartup.addListener(createMenu);
