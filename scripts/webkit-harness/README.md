# WebKit harness

Runs pages on the Mac's own WebKit.framework (Safari's engine, a WKWebView with default preferences and a
non-persistent data store), with SIGN_HOST and APP_HOST served by your `serve` function, not the live sites.

- Needs macOS 14 or later, `swiftc` (Xcode command line tools) and `openssl` on the PATH.
- Run the self-test on the Mac queue:
  `HEAVY_REMOTE=0 scripts/heavy.sh wk-harness -- node scripts/webkit-harness/self-test.mjs`
- Use it from a live check: `const d = await launchWebKit({ serve })`, then `d.goto`, `d.evaluate`, `d.click`,
  `d.messages`, `d.evaluateFrame`, `d.close` (see the top of `index.mjs`).
- Pages report with `window.webkit.messageHandlers.harness.postMessage(JSON.stringify(...))`.
- Each run makes a certificate for the two hosts in a fresh temp dir and deletes it on close. A CONNECT proxy on
  127.0.0.1 tunnels only those two hosts and refuses and logs every other one (`d.refused()`).
