const DEFAULTS = { enabledHosts: [], pauseHosts: [], intervalSec: 60 };

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch (e) {
    return null;
  }
}

// Injected into the page's MAIN world. Idempotent — safe to run every tick.
// 1) Spoofs tab focus/visibility so apps that pause or log out on blur keep
//    treating the tab as visible and focused while it's backgrounded.
// 2) Re-fires focus so any focus-gated logic re-applies.
// 3) Dispatches light synthetic activity: a small pointer/mouse move and a
//    harmless F15 keypress (F15 triggers nothing in apps or the OS). Together
//    these satisfy DOM-level idle/inactivity detectors without changing the page.
function keepAlive() {
  if (!window.__sessionSaver) {
    window.__sessionSaver = { installedAt: Date.now() };
    const def = (obj, prop, val) => {
      try {
        Object.defineProperty(obj, prop, { configurable: true, get: () => val });
      } catch (e) {}
    };
    def(Document.prototype, "hidden", false);
    def(Document.prototype, "visibilityState", "visible");
    def(Document.prototype, "webkitHidden", false);
    def(Document.prototype, "webkitVisibilityState", "visible");
    try {
      document.hasFocus = () => true;
    } catch (e) {}
  }

  try {
    window.dispatchEvent(new Event("focus"));
  } catch (e) {}

  try {
    const x = 1 + Math.floor(Math.random() * Math.max(1, window.innerWidth - 2));
    const y = 1 + Math.floor(Math.random() * Math.max(1, window.innerHeight - 2));
    const m = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    document.dispatchEvent(new PointerEvent("pointermove", m));
    document.dispatchEvent(new MouseEvent("mousemove", m));
    const k = { bubbles: true, cancelable: true, key: "F15", code: "F15", keyCode: 126, which: 126, location: 0 };
    document.dispatchEvent(new KeyboardEvent("keydown", k));
    document.dispatchEvent(new KeyboardEvent("keyup", k));
  } catch (e) {}

  return { active: true, since: window.__sessionSaver.installedAt };
}

// Injected into MAIN world. Pause: detach the source from every <video> so the
// browser stops decoding/compositing it, while the page keeps running. A guard
// re-detaches if the page reattaches a stream, keeping the latest source so
// resume can restore playback. Resume reattaches it. If a video doesn't come
// back on resume, reloading the tab always recovers.
function applyPause(paused) {
  const vids = Array.from(document.querySelectorAll("video"));
  if (!window.__ssPause) window.__ssPause = { active: false, guard: 0, saved: new WeakMap() };
  const P = window.__ssPause;

  const detach = (v) => {
    if (v.srcObject) {
      P.saved.set(v, { kind: "srcObject", val: v.srcObject });
      v.srcObject = null;
    } else if (v.currentSrc || v.src) {
      if (!P.saved.has(v)) P.saved.set(v, { kind: "src", val: v.src, paused: v.paused });
      try { v.pause(); } catch (e) {}
    }
  };
  const restore = (v) => {
    const s = P.saved.get(v);
    if (!s) return;
    if (s.kind === "srcObject") {
      v.srcObject = s.val;
      try { v.play(); } catch (e) {}
    } else if (s.kind === "src" && !s.paused) {
      try { v.play(); } catch (e) {}
    }
    P.saved.delete(v);
  };

  if (paused) {
    vids.forEach(detach);
    P.active = true;
    if (!P.guard) {
      P.guard = setInterval(() => {
        if (!P.active) return;
        document.querySelectorAll("video").forEach((v) => {
          if (v.srcObject) detach(v);
        });
      }, 1000);
    }
    return { ok: true, state: "paused", videos: vids.length };
  } else {
    P.active = false;
    if (P.guard) {
      clearInterval(P.guard);
      P.guard = 0;
    }
    vids.forEach(restore);
    return { ok: true, state: "playing", videos: vids.length };
  }
}

function iconSet(state) {
  const p = (n) => `icons/${state}-${n}.png`;
  return { 16: p(16), 32: p(32), 48: p(48), 128: p(128) };
}

async function updateIconForTab(tabId, url) {
  const h = hostOf(url || "");
  const { enabledHosts } = await chrome.storage.sync.get(DEFAULTS);
  const on = !!h && enabledHosts.includes(h);
  try {
    await chrome.action.setIcon({ tabId, path: iconSet(on ? "active" : "inactive") });
    await chrome.action.setTitle({
      tabId,
      title: on ? `Session Saver — active on ${h}` : "Session Saver — off",
    });
  } catch (e) {}
}

async function refreshAllIcons() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id != null) updateIconForTab(t.id, t.url);
}

async function pulseAll() {
  const { enabledHosts, pauseHosts } = await chrome.storage.sync.get(DEFAULTS);
  if (!enabledHosts.length) return;
  const enabled = new Set(enabledHosts);
  const paused = new Set(pauseHosts);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !tab.url) continue;
    const h = hostOf(tab.url);
    if (!h || !enabled.has(h)) continue;
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: keepAlive }).catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyPause, args: [paused.has(h)] })
      .catch(() => {});
  }
}

// Apply the pause state immediately to matching tabs (don't wait for a pulse).
async function applyPauseNow() {
  const { enabledHosts, pauseHosts } = await chrome.storage.sync.get(DEFAULTS);
  const enabled = new Set(enabledHosts);
  const paused = new Set(pauseHosts);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !tab.url) continue;
    const h = hostOf(tab.url);
    if (!h || !enabled.has(h)) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyPause, args: [paused.has(h)] })
      .catch(() => {});
  }
}

async function syncAlarm() {
  const { enabledHosts, intervalSec } = await chrome.storage.sync.get(DEFAULTS);
  await chrome.alarms.clear("pulse");
  if (enabledHosts.length) {
    chrome.alarms.create("pulse", { periodInMinutes: Math.max(0.5, intervalSec / 60) });
    pulseAll();
  }
}

function boot() {
  syncAlarm();
  refreshAllIcons();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pulse") pulseAll();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabledHosts || changes.intervalSec) syncAlarm();
  if (changes.enabledHosts) refreshAllIcons();
  if (changes.pauseHosts) applyPauseNow();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateIconForTab(tabId, tab.url);
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;
  updateIconForTab(tabId, tab.url);
  const h = hostOf(tab.url);
  if (!h) return;
  const { enabledHosts } = await chrome.storage.sync.get(DEFAULTS);
  if (enabledHosts.includes(h)) pulseAll();
});
