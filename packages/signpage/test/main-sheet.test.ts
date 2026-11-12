// src/main.ts's wiring of the sheet (src/shell.ts), booted top-level on a minimal DOM as test/main-mainnet-pools.test.ts
// boots it: each rule the review of 7a21ffcd removed with every test still passing has its own step here, which fails
// on that mutant (card signing-views-open-over-the-app):
// - decide's sheetShown: a signin.open the frame sent before the choose sheet opened, decided once it shows (its request
//   hash held until then; the shell's listen and busy both let it by), is refused, and the sheet is not redrawn (takes()
//   alone would take it there: choose is not signed in);
// - show()'s seal: a typed screen drawn on a sheet already shown (I already have one, Recovery code) takes the frame out,
//   and it is out when the screen's field enters the page (the seal dropped from show(), or moved after the draw, fails);
// - openLayer's open(typed): a sheet opened straight on a typed screen (signin.open {way: words}) takes the frame out,
//   and its field enters the page only once the frame is out (drawn before, while the frame waits FRAME_LEAVE_MS for the
//   open's answer, it fails);
// - onDismiss: the user's Esc on a screen Cancel is drawn on goes back to the app;
// - dismissible(cancellable): Esc on the backup a new account lands on (no Cancel drawn) does nothing;
// - the clipboard: Copy on the backup puts the 12 words there, and Saved, in its own tap, writes it empty (a write that
//   fails is let go, and the words are saved).
// The seal and open(typed) steps fail together when both seals go. openPoolWithdraw's sheetShown has no step: no shown
// sheet holds the signed-in state takes("withdraw.open") needs (show("signed-in") closes the layer in the same call,
// src/main.ts show), so that mutant is the same program on every reachable state.
// The passkey sheet is a stand-in on navigator.credentials: Create answers a credential with no PRF, the no-PRF path.
//   node --test test/main-sheet.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { APP_ORIGIN } from "../src/api.ts";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { SIGN_HOST } from "../../wallet/src/derive/constants.ts";
import { PROTECT_MS } from "../src/guard.ts";

const wrap = (src: string, name: string, body: string): string => {
  const anchor = `export function ${name}(`;
  if (!src.includes(anchor)) throw new Error(`${name}: its line moved; update this test's hook`);
  return `${src.replace(anchor, `function ${name}__real(`)}\n${body}\n`;
};
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/pool-testnet.ts"))
      return { ...r, source: wrap(String(r.source), "testnetPool", "export function testnetPool(page, over) { return { ...testnetPool__real(page, over), readyWith: async (read) => ({ ready: globalThis.__ctReady, value: await read() }) }; }") };
    if (url.endsWith("/signpage/src/pool-price.ts"))
      return { ...r, source: wrap(String(r.source), "poolPrices", "export function poolPrices(deps) { return poolPrices__real({ ...deps, read: globalThis.__ctPriceRead, after: (ms, fn) => void setTimeout(fn, ms).unref() }); }") };
    return r;
  },
});
const gl = globalThis as Record<string, unknown>;
gl.__ctReady = [];
gl.__ctPriceRead = async () => null;

// ---- a minimal DOM: what main.ts, src/shell.ts and src/backdrop.ts touch ----
class El extends EventTarget {
  id = "";
  hidden = false;
  textContent = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
  attrs: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  append(...c: El[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: El[]) {
    this.children = c;
  }
  insertBefore(n: El, ref: El) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, n);
  }
  remove() {
    const i = doc.body.children.indexOf(this);
    if (i >= 0) doc.body.children.splice(i, 1);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  /** Each listener by type, so a test can call a button's click listener with a trusted event. */
  ls: Record<string, ((e: unknown) => void)[]> = {};
  override addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opt?: boolean | AddEventListenerOptions) {
    if (typeof fn === "function") (this.ls[type] ??= []).push(fn as (e: unknown) => void);
    super.addEventListener(type, fn, opt);
  }
}
const posted: { v: number; id?: string; ok?: boolean; error?: { code: string } }[] = [];
const frameWindow = { postMessage: (m: (typeof posted)[number]) => void posted.push(m) };
class Frame extends El {
  src = "";
  contentWindow = frameWindow;
}
const win = new EventTarget();
/** The window's keydown listeners (the shell's Esc and main.ts's activation guard), called with a trusted key below. */
const keydowns: ((e: unknown) => void)[] = [];
const doc = Object.assign(new EventTarget(), {
  body: new El("body"),
  visibilityState: "visible",
  defaultView: globalThis,
  createElement: (t: string) => (t === "iframe" ? new Frame(t) : new El(t)),
});
const g = globalThis as Record<string, unknown>;
Object.assign(g, {
  window: globalThis,
  top: globalThis,
  document: doc,
  addEventListener: (type: string, fn: (e: unknown) => void, opt?: unknown) => {
    if (type === "keydown") keydowns.push(fn);
    else win.addEventListener(type, fn as EventListener, opt as boolean);
  },
  removeEventListener: win.removeEventListener.bind(win),
  location: { origin: `https://${SIGN_HOST}`, hostname: SIGN_HOST, pathname: "/", search: "", href: `https://${SIGN_HOST}/`, reload() {} },
  history: { replaceState() {} },
  matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  KeyboardEvent: class extends Event {},
});
// main.ts's channels live as long as the page: let the test's process end with them open
const BC = globalThis.BroadcastChannel;
g.BroadcastChannel = class extends BC {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref?: () => void }).unref?.();
  }
};


// the request hash the page awaits before it decides a kind (src/api.ts handle): held while digestHold is set at the call
let digestHold: Promise<void> | null = null;
const realDigest = crypto.subtle.digest.bind(crypto.subtle);
(crypto.subtle as { digest: unknown }).digest = async (...a: Parameters<typeof realDigest>) => {
  const held = digestHold;
  const r = await realDigest(...a);
  if (held) await held;
  return r;
};
// no RPC in these steps answers: every fetch is refused
g.fetch = async () => new Response("{}", { status: 503 });
// the passkey sheet: Create answers a public-key credential whose PRF is not enabled
g.PublicKeyCredential = class {};
// on Node's own navigator, whose Web Locks the seed's write takes
Object.defineProperty(globalThis.navigator, "credentials", {
  configurable: true,
  value: { create: async () => ({ type: "public-key", rawId: new Uint8Array(16).fill(7).buffer, getClientExtensionResults: () => ({ prf: { enabled: false } }) }), get: async () => null },
});

const frameIn = () => doc.body.children.some((c) => c.tagName === "iframe");
const find = (el: El, f: (x: El) => boolean): El | undefined => (f(el) ? el : el.children.map((c) => find(c, f)).find((x) => x !== undefined));
const root = () => find(doc.body, (x) => x.id === "signin")!;
const layer = () => find(doc.body, (x) => x.id === "screen")!;
const shown = () => layer().hidden === false;
const tap = (action: string) => {
  const b = find(root(), (x) => x.dataset.action === action);
  assert.ok(b, `no ${action} button on ${root().dataset.signin}`);
  b.dispatchEvent(new Event("click"));
};
// the user's own tap on a button: its click listener with a trusted click, later than any key or tap before it
let tapAt = performance.now() + 10 * PROTECT_MS;
const press = (action: string) => {
  const b = find(root(), (x) => x.dataset.action === action);
  assert.ok(b, `no ${action} button on ${root().dataset.signin}`);
  tapAt += 2 * PROTECT_MS;
  for (const fn of b.ls.click ?? []) fn({ isTrusted: true, timeStamp: tapAt });
};
// each time a field enters the sign-in screen: the screen, and whether the frame was in the page then
const fieldDrawn: { state: string; frame: boolean }[] = [];
// a field: what can be typed or pasted into, and the 12 words' Copy
const hasField = (el: El): boolean => el.tagName === "textarea" || el.tagName === "input" || el.dataset.action === "copy" || el.children.some(hasField);
// the clipboard: every write, in order
const clip: string[] = [];
let clipFails = false;
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  // the 12 words' write lands 50 ms after the tap (a tap that leaves inside that gap must still clear them); the clear's
  // write is refused while clipFails is set
  value: {
    writeText: (t: string) => (clip.push(t), t !== "" ? new Promise<void>((ok) => setTimeout(ok, 50)) : clipFails ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve()),
  },
});
const esc = () => {
  for (const fn of keydowns) fn({ type: "keydown", key: "Escape", isTrusted: true, repeat: false, timeStamp: performance.now() + PROTECT_MS + 1 });
};
async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what} (state ${root()?.dataset.signin}, layer ${shown() ? "shown" : "hidden"}, frame ${frameIn() ? "in" : "out"})`);
}
const settle = () => new Promise((r) => setTimeout(r, 200)); // past FRAME_LEAVE_MS (100) of any seal
function send(data: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, ...data } } });
  win.dispatchEvent(e);
  return id;
}
async function answer(id: string): Promise<{ ok?: boolean; error?: { code: string } } | undefined> {
  for (let t = 0; t < 200; t++) {
    const a = posted.find((m) => m.id === id);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
}

test("main.ts's sheet: a kind under a shown sheet refused, the frame out under a typed screen drawn or opened, Esc back to the app only where Cancel is drawn", async () => {
  await import("../src/main.ts");
  const r = root();
  const draw = r.replaceChildren.bind(r);
  r.replaceChildren = (...c: El[]) => {
    if (c.some(hasField)) fieldDrawn.push({ state: r.dataset.signin ?? "", frame: frameIn() });
    draw(...c);
  };
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  send({ type: "hello", kit: SIGNPAGE_KIT_VERSION });
  await until("the page signed out", () => root()?.dataset.signin === "signed-out");

  // decide's sheetShown: a signin.open the frame sent before the choose sheet opened (the shell's listen took it, the
  // layer hidden) but decided once it shows, the first kind's run done (busy no longer refuses it), is refused and the
  // sheet is not redrawn. The second's request hash is held until then: the page awaits that hash before it decides.
  const firstId = send({ type: "signin.open", way: "wallet", return_key: "portfolio" });
  let release!: () => void;
  digestHold = new Promise<void>((ok) => (release = ok));
  const secondId = send({ type: "signin.open", way: "words", return_key: "portfolio" });
  digestHold = null;
  const first = await answer(firstId);
  assert.equal(first?.ok, true, JSON.stringify(first));
  await until("the choose sheet", () => shown() && root().dataset.signin === "choose");
  await settle();
  assert.equal(frameIn(), true, "the frame stays under the choose sheet");
  release();
  const again = await answer(secondId);
  assert.deepEqual(again?.error, { code: "not_allowed" }, `a signin.open decided while the sheet shows is refused: ${JSON.stringify(again)}`);
  await settle();
  assert.equal(root().dataset.signin, "choose", "the shown sheet is not redrawn");

  // show()'s seal: Recovery code on the sheet already shown draws the 12 words' field, and the frame leaves
  tap("have-one");
  await until("I already have one", () => root().dataset.signin === "existing");
  await settle();
  assert.equal(frameIn(), true, "the frame stays under I already have one");
  tap("recovery");
  await until("the words field", () => root().dataset.signin === "words");
  await until("the frame out under the words field drawn on a shown sheet", () => !frameIn(), 1000);
  assert.deepEqual(fieldDrawn, [{ state: "words", frame: false }], "the frame was out when the field entered the page");

  // onDismiss: Esc on a screen with Cancel goes back to the app, a new frame under it
  esc();
  await until("Esc back to the app", () => !shown());
  await until("a new frame", frameIn);

  // openLayer's open(typed): a sheet opened straight on the words field takes the frame out
  assert.equal((await answer(send({ type: "signin.open", way: "words", return_key: "portfolio" })))?.ok, true);
  await until("the words sheet", () => shown() && root().dataset.signin === "words");
  await until("the frame out under the words field it opened on", () => !frameIn(), 1000);
  await until("the words field drawn", () => fieldDrawn.length === 2);
  assert.deepEqual(fieldDrawn[1], { state: "words", frame: false }, "on an open straight onto the words, the field entered the page with the frame out");
  esc();
  await until("Esc back to the app", () => !shown());
  await until("a new frame", frameIn);

  // dismissible(cancellable): the backup a new account lands on draws no Cancel, and Esc there does nothing
  assert.equal((await answer(send({ type: "signin.open", way: "passkey", return_key: "portfolio" })))?.ok, true);
  await until("the passkey sheet", () => shown() && root().dataset.signin === "signed-out");
  tap("create");
  await until("the backup of the new account", () => root().dataset.signin === "backup");
  assert.equal(find(root(), (x) => x.dataset.action === "cancel"), undefined, "no Cancel on that backup");
  await until("the frame out under the 12 words", () => !frameIn(), 1000);
  esc();
  await settle();
  assert.equal(shown(), true, "Esc on a screen with no Cancel leaves the sheet shown");
  assert.equal(root().dataset.signin, "backup");

  // the clipboard: Copy puts the 12 words there; Saved, tapped before that write has landed, writes it empty in its own
  // tap, and a refused clear is let go
  const words = find(root(), (x) => x.dataset.words === "12")!.children.map((li) => li.textContent).join(" ");
  assert.equal(words.split(" ").length, 12);
  press("copy");
  assert.deepEqual(clip, [words]);
  clipFails = true;
  press("saved");
  assert.deepEqual(clip, [words, ""], "Saved writes the clipboard empty in its own tap, the copy's write not yet landed");
  await until("the words saved though the clear was refused", () => root().dataset.signin === "signed-in");
  clipFails = false;

  // Esc on a backup whose words are copied leaves it shown and writes nothing (a key gives no activation for the clear on
  // Firefox and Safari); the x, a tap, clears in its own tap and goes back to the app
  await until("a new frame after Saved", frameIn);
  await settle();
  const bo = await answer(send({ type: "backup.open", return_key: "portfolio" }));
  assert.equal(bo?.ok, true, `backup.open: ${JSON.stringify(bo)} on ${root().dataset.signin}, layer ${shown() ? "shown" : "hidden"}`);
  await until("the backup again, with Cancel", () => shown() && root().dataset.signin === "backup" && !!find(root(), (x) => x.dataset.action === "cancel"));
  await until("the frame out under the 12 words", () => !frameIn(), 1000);
  press("copy");
  assert.deepEqual(clip.slice(2), [words]);
  esc();
  await settle();
  assert.ok(shown() && root().dataset.signin === "backup", "Esc with the words copied leaves the backup shown");
  assert.deepEqual(clip.slice(2), [words], "Esc writes nothing");
  const x = find(doc.body, (e) => e.dataset.sheet === "close")!;
  tapAt += 2 * PROTECT_MS;
  for (const fn of x.ls.click ?? []) fn({ type: "click", isTrusted: true, timeStamp: tapAt });
  assert.deepEqual(clip.slice(2), [words, ""], "the x clears in its own tap");
  await until("back to the app", () => !shown());
  await until("a new frame", frameIn);

  // a withdraw form opened straight: its fields enter the page with the frame out
  const before = fieldDrawn.length;
  assert.equal((await answer(send({ type: "withdraw.open", return_key: "portfolio" })))?.ok, true);
  await until("the withdraw form", () => shown() && root().dataset.signin === "withdraw");
  await until("its fields drawn", () => fieldDrawn.length > before, 1000);
  assert.deepEqual(fieldDrawn[before], { state: "withdraw", frame: false }, "the withdraw form's fields entered the page with the frame out");
  assert.ok(fieldDrawn.every((f) => !f.frame), `no field in the page with the frame: ${JSON.stringify(fieldDrawn)}`);
});
