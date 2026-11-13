// The minimal DOM src/main.ts boots top-level on, as test/main-sheet.test.ts's (card signing-layer-says-when-it-closes):
// one frame window for every frame the shell makes, each post to it kept with that frame's inert at the time, the top
// window's reloads counted. Imported first by a test that then imports ../src/main.ts.
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { APP_ORIGIN } from "../src/api.ts";
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
/** The top window's reloads (a sign out's, here or in another tab). */
let reloads = 0;
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
const posted: { v: number; id?: string; ok?: boolean; type?: string; result?: unknown; error?: { code: string } }[] = [];
/** The page's frame (the one in the page now) and its inert at each post, by the post's index in `posted`. */
const inertAt: (boolean | undefined)[] = [];
const frameNow = (): { inert?: boolean } | undefined => doc.body.children.find((c) => c.tagName === "iframe") as { inert?: boolean } | undefined;
const frameWindow = { postMessage: (m: (typeof posted)[number]) => void (posted.push(structuredClone(m)), inertAt.push(frameNow()?.inert)) };
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
  location: { origin: `https://${SIGN_HOST}`, hostname: SIGN_HOST, pathname: "/", search: "", href: `https://${SIGN_HOST}/`, reload: () => void reloads++ },
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
// the user's own tap on the sheet's x or its scrim
const tapSheet = (part: "close" | "scrim") => {
  const el = find(doc.body, (e) => e.dataset.sheet === part)!;
  tapAt += 2 * PROTECT_MS;
  for (const fn of el.ls.click ?? []) fn({ type: "click", isTrusted: true, timeStamp: tapAt });
};
// the 12 words' field, anywhere in the page
// the sealed screens' ground: shown (not hidden) or not
const groundShown = () => find(doc.body, (e) => e.id === "ground")?.hidden === false;
const wordsBox = () => find(doc.body, (e) => e.dataset.input === "words");
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
export const settle = () => new Promise((r) => setTimeout(r, 200)); // past any step the page runs
function send(data: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, ...data } } });
  win.dispatchEvent(e);
  return id;
}
async function answer(id: string): Promise<{ ok?: boolean; result?: unknown; error?: { code: string } } | undefined> {
  for (let t = 0; t < 200; t++) {
    const a = posted.find((m) => m.id === id);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  return undefined;
}


/** A message from the app's frame with no id (the kit's hello). */
function sendRaw(data: Record<string, unknown>): void {
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: data } });
  win.dispatchEvent(e);
}
const notices = (id?: string) => posted.filter((m) => m.type === "closed" && (id === undefined || m.id === id));
/** Opens `kind` and waits for its sheet; gives its id. */
async function opened(kind: Record<string, unknown>, state: string): Promise<string> {
  const id = send(kind);
  const a = await answer(id);
  assert.equal(a?.ok, true, `${JSON.stringify(kind)}: ${JSON.stringify(a)}`);
  await until(`the ${state} sheet`, () => shown() && root().dataset.signin === state);
  return id;
}
/** Waits out PROTECT_MS past a close with a margin, then checks `id`'s notices: `n` of them, each with the frame live. */
async function told(id: string, n: number, what: string): Promise<void> {
  await new Promise((r) => setTimeout(r, PROTECT_MS + 250));
  const at = posted.flatMap((m, i) => (m.type === "closed" && m.id === id ? [i] : []));
  assert.equal(at.length, n, `${what}: ${n} notice(s) for its id`);
  for (const i of at) {
    assert.deepEqual(posted[i], { v: 1, type: "closed", id }, `${what}: the type and the id only`);
    assert.equal(inertAt[i], false, `${what}: the frame was live again when the notice went`);
  }
}


/** The top window's reloads so far. */
export const reloadCount = (): number => reloads;
/** Holds the next request's hash (src/api.ts handle) until the promise settles: set before the send, cleared after. */
export const holdDigest = (p: Promise<void> | null): void => void (digestHold = p);
export { answer, doc, esc, find, frameIn, inertAt, opened, posted, press, root, send, sendRaw, shown, tap, tapSheet, told, notices, until };
