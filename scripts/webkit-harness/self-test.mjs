// Card signpage-shell: the harness's own checks on the Mac's WebKit. One line per check, then PASS or FAIL.
//   node scripts/webkit-harness/self-test.mjs
import { launchWebKit, SIGN_HOST, APP_HOST } from './index.mjs';

const THIRD = 'third.unrealized.test';
const HARNESS = `<script>const say = (m) => window.webkit.messageHandlers.harness.postMessage(JSON.stringify(m));</script>`;
const html = (s, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: `<!doctype html><meta charset="utf-8">${HARNESS}${s}` });

const pages = {
  [`${SIGN_HOST} /x?q=1`]: () => html(`<button id="b" style="position:absolute;left:40px;top:40px;width:120px;height:40px">go</button>
    <iframe src="https://${APP_HOST}/y" style="position:absolute;left:40px;top:120px;width:300px;height:100px"></iframe>
    <script>for (const t of ['pointerdown', 'mousedown', 'click']) document.getElementById('b').addEventListener(t, (e) => say({ ev: t, trusted: e.isTrusted }));
    say({ top: 'x', href: location.href });</script>`),
  [`${APP_HOST} /y`]: () => html(`<script>say({ frame: 'y', href: location.href, top: window.top !== window ? 'framed' : 'top' });</script>`),
  [`${SIGN_HOST} /idb`]: () => html(`<script>say({ top: 'idb' });</script>`),
  [`${APP_HOST} /frames-sign`]: () => html(`<iframe src="https://${SIGN_HOST}/framed"></iframe>`),
  [`${SIGN_HOST} /framed`]: () => html(`<script>say({ framed: window.top !== window });</script>`),
  [`${SIGN_HOST} /csp`]: () => html(`<script>document.addEventListener('securitypolicyviolation', (e) => say({ csp: e.violatedDirective, blocked: e.blockedURI }));</script>
    <iframe src="https://${APP_HOST}/y"></iframe><iframe src="https://${THIRD}/z"></iframe>`,
    { 'content-security-policy': `frame-src https://${APP_HOST}` }),
};

const IDB = `const open = () => new Promise((ok, no) => { const r = indexedDB.open('wk-harness', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });`;
const WRITE = `${IDB} const db = await open(); await new Promise((ok, no) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put('from-top', 'k'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); db.close(); return 'written';`;
const READ = `${IDB} const db = await open(); const v = await new Promise((ok, no) => { const r = db.transaction('s').objectStore('s').get('k'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); db.close(); return v ?? '(none)';`;

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); };
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return f(); };

const seen = [];
let d;
try {
  d = await launchWebKit({
    serve(host, path, method) {
      seen.push(`${method} ${host}${path}`);
      const p = pages[`${host} ${path}`];
      return p ? p() : null;
    },
    width: 390,
    height: 844,
  });
  console.log(`webkit: ${d.version}`);
  check('version from the framework', /^system WebKit \d+\.[\d.]+ \(macOS \d+\.\d+(\.\d+)? \w+\)$/.test(d.version), d.version);

  // 1. Top-level SIGN_HOST served by serve(), framing APP_HOST, whose harness message arrives.
  await d.goto(`https://${SIGN_HOST}/x?q=1`);
  check('top-level SIGN_HOST from serve', seen.includes(`GET ${SIGN_HOST}/x?q=1`), seen.filter((s) => s.includes('/x')).join(', '));
  const href = await d.evaluate('return location.href');
  check('top document is SIGN_HOST', href === `https://${SIGN_HOST}/x?q=1`, href);
  const fm = await until(() => d.messages().find((m) => m.data?.frame === 'y'));
  check('APP_HOST frame message', !!fm && fm.frame.host === APP_HOST && fm.frame.main === false && fm.data.top === 'framed' && seen.includes(`GET ${APP_HOST}/y`), JSON.stringify(fm));
  const inFrame = await d.evaluateFrame(APP_HOST, 'return [location.host, window.top !== window]');
  check('evaluateFrame runs in the APP_HOST frame', JSON.stringify(inFrame) === JSON.stringify([APP_HOST, true]), JSON.stringify(inFrame));
  let jsErr = '';
  try { await d.evaluate("throw new Error('boom-42')"); } catch (e) { jsErr = e.message; }
  check('evaluate rejects with the JS error text', jsErr.includes('boom-42'), jsErr);

  // 2. A trusted click.
  await d.click('#b');
  const evs = await until(() => { const e = d.messages().filter((m) => m.data?.ev); return e.length >= 3 && e; });
  const by = Object.fromEntries((evs || []).map((m) => [m.data.ev, m.data.trusted]));
  check('click is trusted', by.pointerdown === true && by.mousedown === true && by.click === true, JSON.stringify(by));

  // 3. The partition cell.
  await d.goto(`https://${SIGN_HOST}/idb`);
  check('top SIGN_HOST writes IndexedDB', (await d.evaluate(WRITE)) === 'written', 'written');
  await d.goto(`https://${APP_HOST}/frames-sign`);
  await until(() => d.messages().find((m) => m.data?.framed === true && m.frame.host === SIGN_HOST && !m.frame.main));
  const framedRead = await d.evaluateFrame(SIGN_HOST, READ);
  check('SIGN_HOST framed in APP_HOST reads none', framedRead === '(none)', String(framedRead));
  await d.goto(`https://${SIGN_HOST}/idb`);
  await d.reload();
  const topRead = await d.evaluate(READ);
  check('top-level SIGN_HOST reads it back after reload', topRead === 'from-top', String(topRead));

  // 4. A response header from serve() is enforced: CSP frame-src blocks a third host's frame.
  await d.goto(`https://${SIGN_HOST}/csp`);
  const v = await until(() => d.messages().find((m) => m.data?.csp));
  const appFramed = await until(() => d.messages().filter((m) => m.data?.frame === 'y').length >= 2);
  check('CSP frame-src blocks the third host', !!v && v.data.blocked.includes(THIRD) && !!appFramed && !seen.some((s) => s.includes(THIRD)), JSON.stringify(v?.data));

  // 5. The view is the width asked for, and a CryptoKey kept in IndexedDB is saved without the login keychain: WebKit
  // wraps it with its WebCrypto master key, which the driver holds in memory. Kept in the keychain, the key is bound
  // to the build that made it, and a rebuilt driver waits on a keychain prompt here until the command times out.
  await d.goto(`https://${SIGN_HOST}/idb`);
  const wide = await d.evaluate('return window.innerWidth');
  check('the view is 390 px wide', wide === 390, String(wide));
  const keyKept = await d.evaluate(`${IDB} const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const db = await open(); await new Promise((ok, no) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(k, 'ck'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    const back = await new Promise((ok, no) => { const r = db.transaction('s').objectStore('s').get('ck'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    db.close(); return back instanceof CryptoKey && back.extractable === false ? 'kept' : 'lost';`);
  check('a non-extractable CryptoKey is kept in IndexedDB', keyKept === 'kept', String(keyKept));

  // 6. No request reaches the network: other hosts are refused at the proxy and logged.
  const fetchOut = await d.evaluate(`try { await fetch('https://example.com/', { mode: 'no-cors' }); return 'reached'; } catch (e) { return 'refused: ' + e.message; }`);
  const ref = await until(() => d.refused().find((r) => r.target.startsWith('example.com:')));
  check('proxy refuses and logs another host', fetchOut.startsWith('refused') && !!ref, `${fetchOut}; log ${JSON.stringify(d.refused())}`);
  const tunnelled = [...new Set(d.tunnels().map((t) => t.target))].sort();
  const others = d.refused().filter((r) => !r.target.startsWith('example.com:'));
  check('only the two hosts were tunnelled, no other host asked', tunnelled.every((t) => t === `${SIGN_HOST}:443` || t === `${APP_HOST}:443`) && others.length === 0 && d.trustRefused().length === 0,
    `tunnels ${tunnelled.join(' ')}; other refusals ${JSON.stringify(others)}; trust refusals ${JSON.stringify(d.trustRefused())}`);
} catch (e) {
  check('harness run', false, e?.stack ?? String(e));
} finally {
  await d?.close();
}
const pass = results.length > 0 && results.every(Boolean);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
