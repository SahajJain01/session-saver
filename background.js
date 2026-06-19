const DEFAULTS = { enabledHosts: [], pauseHosts: [], lockMouseHosts: [], alertHosts: [], intervalSec: 60 };

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
// 3) Blocks page-initiated fullscreen so keep-alive activity cannot leave the
//    enabled site stuck in fullscreen.
// 4) Dispatches light synthetic activity: a small pointer/mouse move and a
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

    const blockFullscreen = (proto, method) => {
      if (!proto || typeof proto[method] !== "function") return;
      try {
        Object.defineProperty(proto, method, {
          configurable: true,
          value: function () {
            return Promise.reject(new DOMException("Fullscreen blocked by Session Saver.", "NotAllowedError"));
          },
        });
      } catch (e) {}
    };
    blockFullscreen(Element.prototype, "requestFullscreen");
    blockFullscreen(Element.prototype, "webkitRequestFullscreen");
    blockFullscreen(Element.prototype, "webkitRequestFullScreen");
    blockFullscreen(Element.prototype, "mozRequestFullScreen");
    blockFullscreen(Element.prototype, "msRequestFullscreen");
  }

  try {
    window.dispatchEvent(new Event("focus"));
  } catch (e) {}

  try {
    const fullscreenElement =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement;
    if (fullscreenElement) {
      const exitFullscreen =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;
      if (typeof exitFullscreen === "function") exitFullscreen.call(document);
    }
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

// Injected into MAIN world. Pause: detach the source from every <video> and <audio> so the
// browser stops decoding/compositing it, while the page keeps running. A guard
// re-detaches if the page reattaches a stream, keeping the latest source so
// resume can restore playback. Resume reattaches it. If media doesn't come
// back on resume, reloading the tab always recovers.
function applyPause(paused) {
  const vids = Array.from(document.querySelectorAll("video, audio"));
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
        document.querySelectorAll("video, audio").forEach((v) => {
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

// Injected into MAIN world. Mouse lock: capture-phase listeners on window
// swallow the user's real mouse/pointer/wheel input before the page sees it, so
// an accidental click or drag isn't forwarded into a remote-desktop/VM canvas.
// Only trusted (real) events are blocked — the keep-alive's synthetic pointer
// activity still reaches the page's idle detectors. Idempotent.
function applyMouseLock(locked) {
  const TYPES = [
    "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu",
    "mousemove", "mouseover", "mouseout", "wheel",
    "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointercancel",
    "dragstart", "drag", "drop",
  ];
  if (!window.__ssMouseLock) {
    const handler = (e) => {
      if (!window.__ssMouseLock.active || !e.isTrusted) return;
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
    };
    window.__ssMouseLock = { active: false, handler, bound: false };
  }
  const L = window.__ssMouseLock;

  if (locked && !L.bound) {
    TYPES.forEach((t) => window.addEventListener(t, L.handler, { capture: true, passive: false }));
    L.bound = true;
  } else if (!locked && L.bound) {
    TYPES.forEach((t) => window.removeEventListener(t, L.handler, { capture: true }));
    L.bound = false;
  }
  L.active = locked;
  return { ok: true, state: locked ? "locked" : "unlocked" };
}

// Injected into MAIN world. Captcha / "are you still there" alert. This does NOT
// solve or bypass anything — it watches the page and, the moment a verification
// challenge appears, makes it impossible to miss (red banner, repeating beep,
// flashing tab title) so a human can answer it. The challenge still has to be
// solved by you. A MutationObserver catches the challenge being inserted even
// when the tab is backgrounded (the observer fires on DOM change, not on a
// throttled timer); a slow interval is the steady fallback. Idempotent.
function watchChallenge(enabled) {
  if (!window.__ssAlert) {
    window.__ssAlert = {
      enabled: false, present: false, reason: "", dismissed: false,
      timer: 0, observer: null, lastTick: 0,
      overlay: null, beepTimer: 0, audioCtx: null, origTitle: null, titleTimer: 0,
    };
  }
  const A = window.__ssAlert;

  const isVisible = (el) => {
    if (!el || el === A.overlay || (A.overlay && A.overlay.contains(el))) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity !== 0;
  };

  // Heuristic detection of a verification challenge currently on screen.
  const detect = () => {
    // 1) Known third-party captcha widgets.
    const providers =
      "iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='turnstile']," +
      "iframe[title*='captcha' i],.g-recaptcha,.h-captcha,.cf-turnstile";
    for (const el of document.querySelectorAll(providers)) {
      if (isVisible(el)) return { present: true, reason: "captcha widget" };
    }
    // 2) Text prompts: "are you human / still there", "verify", or a math sum.
    const KW = /(captcha|are you (still )?(there|human|watching)|still (there|watching)\??|verify (you|that you|your)|prove (you|that you)|not a robot|human verification|confirm (you|that you)|session (expired|verif)|security check)/i;
    const MATH = /\b\d{1,4}\s*[+\-x×✕*]\s*\d{1,4}\b/;
    const MATHCTX = /(solve|answer|enter|what\s+is|sum|verify|type|result|=|\?)/i;
    const nodes = document.querySelectorAll(
      "div,span,p,label,form,section,dialog,h1,h2,h3,h4,strong,b,td,li"
    );
    for (const el of nodes) {
      if (el.children.length > 10) continue; // skip large containers, find the prompt
      const t = (el.textContent || "").trim();
      if (t.length === 0 || t.length > 240) continue;
      if (!isVisible(el)) continue;
      if (KW.test(t)) return { present: true, reason: "verification prompt" };
      if (MATH.test(t) && MATHCTX.test(t)) return { present: true, reason: "math challenge" };
    }
    return { present: false, reason: "" };
  };

  const showOverlay = (reason) => {
    if (!A.overlay) {
      const o = document.createElement("div");
      o.id = "__ss_alert_overlay";
      o.style.cssText =
        "position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#b91c1c;" +
        "color:#fff;font:600 15px/1.4 system-ui,sans-serif;padding:12px 16px;" +
        "box-shadow:0 2px 14px rgba(0,0,0,.45);display:flex;align-items:center;" +
        "justify-content:space-between;gap:12px;";
      const msg = document.createElement("span");
      msg.id = "__ss_alert_msg";
      const btn = document.createElement("button");
      btn.textContent = "Dismiss";
      btn.style.cssText =
        "flex:0 0 auto;background:#fff;color:#b91c1c;border:0;border-radius:6px;" +
        "padding:6px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;";
      btn.addEventListener("click", () => { A.dismissed = true; stopAlert(); });
      o.appendChild(msg);
      o.appendChild(btn);
      (document.body || document.documentElement).appendChild(o);
      A.overlay = o;
    }
    A.overlay.style.display = "flex";
    const m = A.overlay.querySelector("#__ss_alert_msg");
    if (m) m.textContent = "⚠ Session Saver: verification detected (" + reason + ") — solve it now to stay signed in.";
  };

  const beep = () => {
    try {
      if (!A.audioCtx) A.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = A.audioCtx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.start(t);
      o.stop(t + 0.42);
    } catch (e) {}
  };

  const startAlert = (reason) => {
    showOverlay(reason);
    if (!A.titleTimer) {
      A.origTitle = document.title;
      let on = false;
      A.titleTimer = setInterval(() => {
        on = !on;
        document.title = on ? "⚠ CAPTCHA — SOLVE NOW" : (A.origTitle || "");
      }, 800);
    }
    if (!A.beepTimer) {
      beep();
      A.beepTimer = setInterval(beep, 1800);
    }
  };

  function stopAlert() {
    if (A.overlay) A.overlay.style.display = "none";
    if (A.titleTimer) {
      clearInterval(A.titleTimer);
      A.titleTimer = 0;
      if (A.origTitle != null) document.title = A.origTitle;
      A.origTitle = null;
    }
    if (A.beepTimer) {
      clearInterval(A.beepTimer);
      A.beepTimer = 0;
    }
  }

  const tick = () => {
    if (!A.enabled) return;
    const now = Date.now();
    if (now - A.lastTick < 400) return; // coalesce mutation bursts
    A.lastTick = now;
    const d = detect();
    A.present = d.present;
    A.reason = d.reason;
    if (d.present) {
      if (!A.dismissed) startAlert(d.reason);
    } else {
      A.dismissed = false; // reset so the next challenge re-alerts
      stopAlert();
    }
  };

  A.enabled = enabled;
  if (enabled) {
    if (!A.observer) {
      A.observer = new MutationObserver(tick);
      try {
        A.observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true,
        });
      } catch (e) {}
    }
    if (!A.timer) A.timer = setInterval(tick, 2000);
    A.lastTick = 0;
    tick();
  } else {
    if (A.observer) { A.observer.disconnect(); A.observer = null; }
    if (A.timer) { clearInterval(A.timer); A.timer = 0; }
    stopAlert();
    A.present = false;
    A.reason = "";
    A.dismissed = false;
  }
  return { ok: true, enabled, present: A.present, reason: A.reason };
}

// Injected into MAIN world. Cheap read of the watcher's current state so the
// background can mirror it to the toolbar badge and an OS notification.
function readChallenge() {
  const A = window.__ssAlert;
  return { present: !!(A && A.present), reason: A ? A.reason : "" };
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

// Tabs we've already raised an OS notification for, so we notify once per
// challenge rather than every pulse. Lives only as long as the service worker;
// if it's torn down and revived we may re-notify once, which is harmless.
const SS_NOTIFIED = new Set();

// Mirror the in-page watcher's state to the toolbar badge and a sticky OS
// notification, so the alert reaches you even if this tab isn't in front.
function updateAlertChannel(tabId, present, reason) {
  try {
    if (present) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#b91c1c" }).catch(() => {});
      chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
      if (!SS_NOTIFIED.has(tabId)) {
        SS_NOTIFIED.add(tabId);
        chrome.notifications.create("ss-captcha-" + tabId, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/active-128.png"),
          title: "Session Saver — action needed",
          message: "A verification appeared (" + (reason || "verification") + "). Solve it to stay signed in.",
          priority: 2,
          requireInteraction: true,
        }, () => void chrome.runtime.lastError);
      }
    } else {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      if (SS_NOTIFIED.has(tabId)) {
        SS_NOTIFIED.delete(tabId);
        chrome.notifications.clear("ss-captcha-" + tabId, () => void chrome.runtime.lastError);
      }
    }
  } catch (e) {}
}

async function pulseAll() {
  const { enabledHosts, pauseHosts, lockMouseHosts, alertHosts } = await chrome.storage.sync.get(DEFAULTS);
  if (!enabledHosts.length) return;
  const enabled = new Set(enabledHosts);
  const paused = new Set(pauseHosts);
  const locked = new Set(lockMouseHosts);
  const alerted = new Set(alertHosts);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !tab.url) continue;
    const h = hostOf(tab.url);
    if (!h || !enabled.has(h)) continue;
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: keepAlive }).catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyPause, args: [paused.has(h)] })
      .catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyMouseLock, args: [locked.has(h)] })
      .catch(() => {});
    if (alerted.has(h)) {
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: watchChallenge, args: [true] })
        .then((res) => {
          const r = res && res[0] && res[0].result;
          updateAlertChannel(tab.id, !!(r && r.present), r ? r.reason : "");
        })
        .catch(() => {});
    } else {
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: watchChallenge, args: [false] })
        .catch(() => {});
      updateAlertChannel(tab.id, false, "");
    }
  }
}

// Apply the pause / mouse-lock state immediately (don't wait for a pulse). We
// pass over every http(s) tab and compute the effective state — disabling a
// site (or unchecking an option) must release a lock/pause that's still active
// on the page, so we inject the "off" call too. Both injected functions are
// idempotent and safe on pages they were never applied to.
async function applyStateNow() {
  const { enabledHosts, pauseHosts, lockMouseHosts, alertHosts } = await chrome.storage.sync.get(DEFAULTS);
  const enabled = new Set(enabledHosts);
  const paused = new Set(pauseHosts);
  const locked = new Set(lockMouseHosts);
  const alerted = new Set(alertHosts);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !tab.url) continue;
    const h = hostOf(tab.url);
    if (!h) continue;
    const on = enabled.has(h);
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyPause, args: [on && paused.has(h)] })
      .catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: applyMouseLock, args: [on && locked.has(h)] })
      .catch(() => {});
    const alertOn = on && alerted.has(h);
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: watchChallenge, args: [alertOn] })
      .catch(() => {});
    if (!alertOn) updateAlertChannel(tab.id, false, "");
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
  if (changes.pauseHosts || changes.lockMouseHosts || changes.alertHosts) applyStateNow();
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
