const DEFAULTS = { enabledHosts: [], pauseHosts: [], lockMouseHosts: [], alertHosts: [], intervalSec: 60 };

async function currentHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  try {
    const u = new URL(tab.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch (e) {
    return null;
  }
}

async function init() {
  const hostEl = document.getElementById("host");
  const toggle = document.getElementById("toggle");
  const pause = document.getElementById("pause");
  const pauseLabel = document.getElementById("pauseLabel");
  const lockMouse = document.getElementById("lockMouse");
  const lockMouseLabel = document.getElementById("lockMouseLabel");
  const alert = document.getElementById("alert");
  const alertLabel = document.getElementById("alertLabel");
  const interval = document.getElementById("interval");
  const status = document.getElementById("status");

  const cfg = await chrome.storage.sync.get(DEFAULTS);
  interval.value = cfg.intervalSec;

  const host = await currentHost();
  if (!host) {
    hostEl.textContent = "Not a regular web page";
    toggle.disabled = true;
    pause.disabled = true;
    lockMouse.disabled = true;
    alert.disabled = true;
    status.innerHTML = '<span class="off">Open a website to use Session Saver.</span>';
    return;
  }

  hostEl.textContent = host;
  toggle.checked = cfg.enabledHosts.includes(host);
  pause.checked = cfg.pauseHosts.includes(host);
  lockMouse.checked = cfg.lockMouseHosts.includes(host);
  alert.checked = cfg.alertHosts.includes(host);

  function render() {
    pause.disabled = !toggle.checked;
    pauseLabel.className = toggle.checked ? "" : "muted";
    lockMouse.disabled = !toggle.checked;
    lockMouseLabel.className = toggle.checked ? "" : "muted";
    alert.disabled = !toggle.checked;
    alertLabel.className = toggle.checked ? "" : "muted";
    let html;
    if (toggle.checked) {
      html = '<span class="on">Active on this site.</span> Sending light activity and keeping the tab focused; you can background it.';
      if (pause.checked) {
        html += '<br><br><span class="on">Video/Audio paused.</span> Decoding stopped to save resources. If playback doesn\'t resume, reload the tab.';
      }
      if (lockMouse.checked) {
        html += '<br><br><span class="on">Mouse input blocked.</span> Your clicks and movement won\'t reach this page, so they can\'t be passed to the VM. Uncheck to use it.';
      }
      if (alert.checked) {
        html += '<br><br><span class="on">Captcha alert on.</span> If a verification appears, you\'ll get a red banner, a beep, and a notification — solve it yourself to stay signed in.';
      }
    } else {
      html = '<span class="off">Off for this site.</span> Turn on before leaving it idle.';
    }
    status.innerHTML = html;
  }

  toggle.addEventListener("change", async () => {
    const { enabledHosts, pauseHosts, lockMouseHosts, alertHosts } = await chrome.storage.sync.get(DEFAULTS);
    const nextEnabled = enabledHosts.filter((h) => h !== host);
    let nextPause = pauseHosts;
    let nextLock = lockMouseHosts;
    let nextAlert = alertHosts;
    if (toggle.checked) {
      nextEnabled.push(host);
    } else {
      // turning the site off also clears its pause, mouse-lock and alert state
      pause.checked = false;
      lockMouse.checked = false;
      alert.checked = false;
      nextPause = pauseHosts.filter((h) => h !== host);
      nextLock = lockMouseHosts.filter((h) => h !== host);
      nextAlert = alertHosts.filter((h) => h !== host);
    }
    await chrome.storage.sync.set({
      enabledHosts: nextEnabled,
      pauseHosts: nextPause,
      lockMouseHosts: nextLock,
      alertHosts: nextAlert,
    });
    render();
  });

  pause.addEventListener("change", async () => {
    const { pauseHosts } = await chrome.storage.sync.get(DEFAULTS);
    const next = pauseHosts.filter((h) => h !== host);
    if (pause.checked) next.push(host);
    await chrome.storage.sync.set({ pauseHosts: next });
    render();
  });

  lockMouse.addEventListener("change", async () => {
    const { lockMouseHosts } = await chrome.storage.sync.get(DEFAULTS);
    const next = lockMouseHosts.filter((h) => h !== host);
    if (lockMouse.checked) next.push(host);
    await chrome.storage.sync.set({ lockMouseHosts: next });
    render();
  });

  alert.addEventListener("change", async () => {
    const { alertHosts } = await chrome.storage.sync.get(DEFAULTS);
    const next = alertHosts.filter((h) => h !== host);
    if (alert.checked) next.push(host);
    await chrome.storage.sync.set({ alertHosts: next });
    render();
  });

  interval.addEventListener("change", async () => {
    const val = Math.min(300, Math.max(15, parseInt(interval.value, 10) || DEFAULTS.intervalSec));
    interval.value = val;
    await chrome.storage.sync.set({ intervalSec: val });
  });

  render();
}

init();
