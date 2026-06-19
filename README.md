# Session Saver

A small Chrome extension (Manifest V3) that keeps a website from going idle,
timing out, or logging you out while you're away from the tab — useful when a
web app drops your session the moment it thinks you stopped paying attention.

You enable it **per-site** from the toolbar, so it only acts on pages you choose.

## What it does

When enabled for a site, a background alarm runs every *interval* seconds
(default 60) and, in that site's tabs:

1. **Spoofs focus/visibility** — overrides `document.hidden`,
   `document.visibilityState`, and `document.hasFocus()` and re-fires the
   `focus` event, so apps that pause or sign you out when the tab loses focus
   keep treating it as visible and active.
2. **Sends light synthetic activity** — a small `pointermove`/`mousemove` and a
   harmless **F15** keypress (F15 does nothing in apps or the OS). This is what
   most DOM-level idle detectors look for. It never clicks, types text, or
   changes anything on the page.
3. **Prevents tab discarding** — marks the tab `autoDiscardable: false` so the
   browser won't freeze it. The pulse is driven by `chrome.alarms`, not a page
   timer, so it keeps firing even when a backgrounded tab is throttled.

The toolbar icon is **green** when the current site is active and **gray** when
it isn't.

## Pause video/audio (optional)

If a site streams video or audio you don't need to watch or listen to while it's in the background,
turn on **Pause video/audio to save resources**. It detaches the source from every
`<video>` and `<audio>` on the page so the browser stops decoding/compositing it, while the
page keeps running. When you return, uncheck it to reattach the source and resume
playback; if media doesn't come back, reloading the tab always recovers.

## Block mouse input (optional)

For remote-desktop or in-browser **VM** consoles, an accidental click or stray
cursor movement over the tab can be forwarded straight to the guest. Turn on
**Block mouse input** to swallow your real mouse, pointer, and wheel events in
capture phase before the page sees them, so they can't reach the VM. Keyboard
input is left alone. Only genuine (`isTrusted`) events are blocked — the
keep-alive's own synthetic activity still gets through — and un-checking it (or
turning the site off) restores normal input immediately.

## Alert me when a captcha appears (optional)

Some sites pop a **verification / "are you still there?" captcha** (often a small
math sum) to confirm a human is present. Session Saver does **not** solve or
bypass these — the point of the challenge is that a person answers it. What this
option does is make sure you *notice* it in time:

Turn on **Alert me when a captcha appears** and, while the site is enabled, a
watcher looks for a challenge on the page (known captcha widgets, "verify / not a
robot / still there" prompts, or a visible math sum). The moment one shows up it:

- drops a **red banner** across the top of the page,
- plays a **repeating beep**,
- **flashes the tab title** (`⚠ CAPTCHA — SOLVE NOW`), and
- raises a **desktop notification** and a `!` badge on the toolbar icon, so it
  reaches you even through a remote-desktop session or when the tab is in the
  background.

You still solve the challenge yourself. The alert clears automatically once the
challenge is gone, and **Dismiss** silences it for the current one.

> This is detection-and-notify only. It never reads, answers, or submits the
> challenge — keeping a human in the loop is the whole idea.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** → select this folder.
3. Open a site, click the Session Saver icon, and turn on **Keep this site
   awake**. The setting is per-hostname and persists.

## Permissions

- `storage`, `alarms` — save your per-site settings and run the periodic pulse.
- `tabs`, `scripting`, `<all_urls>` — read the current tab's host and inject the
  keep-alive into sites you've enabled. The extension does nothing on a site
  until you explicitly turn it on there.

## Notes

- Synthetic events are untrusted (`isTrusted === false`). Most idle detectors
  don't care, but a few strict ones do; for those, the focus/visibility spoof
  often keeps the session alive on its own.
- This is a personal-utility tool. Use it on services where keeping your own
  session alive is permitted.

## Changelog

- **1.3.0** — Expand the optional pause feature to also disable incoming audio streams (now **Pause video/audio**).
- **1.2.0** — Add per-site **Alert me when a captcha appears** option: detects a
  verification/captcha on the page and alerts you (banner, beep, flashing title,
  desktop notification) so you can solve it yourself. It does not solve or bypass
  the challenge.
- **1.1.0** — Add per-site **Block mouse input** option: swallows your real
  mouse/pointer/wheel events in capture phase so a stray click or movement can't
  be forwarded to a remote-desktop/VM console. Synthetic keep-alive activity is
  unaffected.
- **1.0.0** — Initial release: per-site keep-alive (focus/visibility spoof, light
  synthetic activity, no tab discarding), optional pause-video, and fullscreen
  blocking during keep-alive.

## License

MIT — see [LICENSE](LICENSE).
