// SIGN_HOST's shell (src/shell.ts), card signpage-shell: SIGN_HOST is the top window and frames APP_HOST.
//   node --test test/shell.test.ts      (from packages/signpage)
// The frame's src is APP_HOST with this page's path and query and never another origin; the kit's API is answered to
// the framed APP_HOST's window only (its source and origin both), posted only to it with targetOrigin APP_HOST, and
// `ready` goes out again on each load of the frame. The browser half (frame-src, sandbox, a real APP_HOST page) is the
// live check's (scripts/live-checks/signpage-shell.mjs).
import assert from "node:assert/strict";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { PROTECT_MS } from "../src/guard.ts";
import { APP_ORIGIN, RELEASE, signedOutState, type IncomingMessage } from "../src/api.ts";
import { appSrc, VEIL_CAP_MS, FRAME_LEAVE_MS, FRAME_SANDBOX, mountShell, navUrl, SERVED_FILES, wireShell } from "../src/shell.ts";
// @ts-expect-error: the deploy script is plain JavaScript, with no types
import { build } from "../scripts/deploy.mjs";

test("appSrc: APP_HOST with this page's path and query; never another origin", () => {
  assert.equal(appSrc({ pathname: "/", search: "" }), `${APP_ORIGIN}/`);
  assert.equal(appSrc({ pathname: "/token/solana/So111", search: "?tab=trades&x=1" }), `${APP_ORIGIN}/token/solana/So111?tab=trades&x=1`);
  // a path that would read as another host if resolved as a URL reference stays a path on APP_HOST
  for (const pathname of ["//evil.com/x", "/@evil.com", "//evil.com:443", "/%2F%2Fevil.com"]) {
    const src = appSrc({ pathname, search: "" });
    assert.equal(new URL(src).origin, APP_ORIGIN, `${pathname} -> ${src}`);
  }
  // anything that does not parse to APP_HOST is APP_HOST's root
  assert.equal(appSrc({ pathname: "x", search: "" }), `${APP_ORIGIN}/`);
  assert.equal(appSrc({ pathname: ".evil.com/", search: "" }), `${APP_ORIGIN}/`);
});

test("the frame's sandbox is exactly the four tokens, none of them a top navigation", () => {
  assert.equal(FRAME_SANDBOX, "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  assert.ok(!/top-navigation|allow-modals|allow-downloads|allow-forms/.test(FRAME_SANDBOX));
});

/** A shell wired to a fake frame window: what it posted, a way to send it a message, a frame load. */
function shell() {
  const posted: { msg: unknown; to: string }[] = [];
  const frame = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let onLoad: (() => void) | null = null;
  const api = wireShell(
    { window: () => frame, onLoad: (fn) => (onLoad = fn) },
    { listen: (fn) => (listener = fn), state: () => signedOutState() },
  );
  const send = (data: unknown, from: { origin?: string; source?: unknown } = {}) =>
    listener!({ origin: from.origin ?? APP_ORIGIN, source: "source" in from ? from.source : frame, data });
  return { posted, send, frame, load: () => onLoad!(), idle: () => api.idle() };
}
const READY = { v: 1, type: "ready", release: RELEASE, api: 1 };
const ask = (id = crypto.randomUUID()) => ({ v: 1, id, type: "state" });

test("a state request from the framed APP_HOST's window is answered, to that window with targetOrigin APP_HOST", async () => {
  const s = shell();
  const q = ask();
  s.send(q);
  await s.idle();
  assert.deepEqual(s.posted.at(-1), { msg: { v: 1, id: q.id, ok: true, result: signedOutState() }, to: APP_ORIGIN });
  assert.ok(s.posted.every((p) => p.to === APP_ORIGIN));
});

test("a message from another window or another origin is dropped: no answer", async () => {
  const s = shell();
  const before = s.posted.length;
  const other = { postMessage: () => assert.fail("posted to another window") };
  s.send(ask(), { source: other });
  s.send(ask(), { source: null });
  s.send(ask(), { source: globalThis });
  for (const origin of ["https://confidential.unrealized.trade", "https://example.com", "http://ct-app.unrealized.trade", "null", ""]) s.send(ask(), { origin });
  await s.idle();
  assert.equal(s.posted.length, before);
});

test("ready goes to the frame's window once on each load of the frame, never before its first load", () => {
  // a ready posted before the frame holds its APP_HOST document can still reach that document: the target origin is
  // checked when the message is delivered (HTML, window post message steps), and Firefox delivered it once the
  // document came, so the frame got two readies for one load (signpage-shell's live check, Firefox 155)
  const s = shell();
  const readies = () => s.posted.filter((p) => JSON.stringify(p.msg) === JSON.stringify(READY));
  assert.equal(readies().length, 0);
  s.load();
  assert.equal(readies().length, 1);
  s.load();
  assert.equal(readies().length, 2);
  assert.ok(readies().every((p) => p.to === APP_ORIGIN));
});

// ------------------------------------------------------------------------------------------------ mountShell on a fake DOM
const SIGN_ORIGIN = "https://confidential.unrealized.trade";
type FakeEl = {
  tagName: string; id: string; hidden: boolean; style: Record<string, string>; src: string;
  contentWindow: { postMessage(m: unknown, o: string): void } | null;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; attributes(): string[];
  addEventListener(t: string, fn: (e?: unknown) => void): void; fire(t: string, e?: unknown): void; remove(): void;
  dataset: Record<string, string>; append(...xs: unknown[]): void; inert?: boolean; focus(): void;
};
function fakeDom(href = `${SIGN_ORIGIN}/token/solana/So111?tab=trades`) {
  const loc = new URL(href);
  const calls = { replace: [] as string[], reload: 0, assign: 0 };
  const posted: { msg: unknown; to: string; win: unknown }[] = [];
  const listeners: ((e: IncomingMessage) => void)[] = [];
  const keys: ((e: unknown) => void)[] = [];
  const blurs: (() => void)[] = [];
  const focused: FakeEl[] = [];
  const made: FakeEl[] = [];
  const children: FakeEl[] = [];
  const createElement = (tag: string): FakeEl => {
    const attrs = new Map<string, string>();
    const on = new Map<string, (e?: unknown) => void>();
    const e: FakeEl = {
      tagName: tag, id: "", hidden: false, style: {}, src: "", contentWindow: null,
      setAttribute: (k, v) => void attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k) ?? null,
      attributes: () => [...attrs.keys()].sort(),
      addEventListener: (t, fn) => void on.set(t, fn),
      fire: (t, ev) => on.get(t)?.(ev),
      dataset: {},
      append: () => {},
      focus: () => void focused.push(e),
      remove: () => void (children.includes(e) && children.splice(children.indexOf(e), 1)),
    };
    made.push(e);
    if (tag === "iframe") {
      const win = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to, win }) };
      e.contentWindow = win;
    }
    return e;
  };
  const view = {
    location: { get origin() { return loc.origin; }, get pathname() { return loc.pathname; }, get search() { return loc.search; }, reload: () => void calls.reload++, assign: () => void calls.assign++ },
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        const u = new URL(url, loc);
        if (u.origin !== loc.origin) throw new Error("SecurityError");
        loc.href = u.href;
        calls.replace.push(u.href);
      },
    },
    addEventListener: (t: string, fn: (e: IncomingMessage) => void) => void (t === "message" ? listeners.push(fn) : t === "keydown" ? keys.push(fn as unknown as (e: unknown) => void) : t === "blur" && blurs.push(fn as unknown as () => void)),
  };
  const body = {
    style: {},
    append: (...xs: FakeEl[]) => void children.push(...xs),
    insertBefore: (x: FakeEl, ref: FakeEl) => void children.splice(children.indexOf(ref), 0, x),
  };
  const doc = { defaultView: view, createElement, body, activeElement: null as unknown } as unknown as Document;
  const frames = () => children.filter((c) => c.tagName === "iframe");
  const send = (data: unknown, source: unknown) => {
    for (const fn of listeners) fn({ origin: APP_ORIGIN, source, data });
  };
  const key = (k: string, isTrusted = true, more: Record<string, unknown> = {}) => {
    for (const fn of keys) fn({ key: k, isTrusted, ...more });
  };
  const blur = () => {
    for (const fn of blurs) fn();
  };
  const part = (name: string) => made.find((x) => x.dataset.sheet === name)!;
  return { doc, loc, calls, posted, children, frames, send, key, blur, focused, made, part };
}
// The shell answers after an off-thread SHA-256 of each message (src/api.ts), so on a loaded runner an answer comes when
// it comes: every wait below waits until its condition holds, bounded at 2 s with a named failure, never for a set time.
// `quiet` is only for a check that nothing came: a wait there can let a late post through (a false pass), never fail.
async function until(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`not within ${ms} ms: ${what}`);
    await new Promise((ok) => setTimeout(ok, 1));
  }
}
/** Waits for the shell's answer to `id` in `d.posted`, and gives it. */
async function answerTo(d: { posted: { msg: unknown }[] }, id: string): Promise<unknown> {
  const find = () => d.posted.find((p) => (p.msg as { id?: unknown } | null)?.id === id);
  await until(() => find() !== undefined, `the answer to ${id}`);
  return find()!.msg;
}
const quiet = () => new Promise((ok) => setTimeout(ok, 50));

test("mountShell: one frame, sandboxed exactly, no allow, no referrer, at appSrc of the top window's path and query; the layer hidden", () => {
  for (const href of [`${SIGN_ORIGIN}/token/solana/So111?tab=trades`, `${SIGN_ORIGIN}//evil.com/x?y=1`, `${SIGN_ORIGIN}/@evil.com`, `${SIGN_ORIGIN}/`]) {
    const d = fakeDom(href);
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    const [f] = d.frames();
    assert.equal(d.frames().length, 1, href);
    assert.equal(f!.getAttribute("sandbox"), FRAME_SANDBOX);
    assert.deepEqual(f!.attributes(), ["referrerpolicy", "sandbox"], "no allow, nothing else");
    assert.equal(f!.getAttribute("referrerpolicy"), "no-referrer");
    const u = new URL(href);
    assert.equal(f!.src, appSrc({ pathname: u.pathname, search: u.search }), href);
    assert.equal(new URL(f!.src).origin, APP_ORIGIN, href);
    assert.equal(sh.layer.hidden, true);
  }
});

test("open(typed) takes the frame out of the document and nothing reaches the old window; close puts a new one in at the address now, and only its load posts ready", async () => {
  const d = fakeDom();
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  const old = d.frames()[0]!;
  old.fire("load");
  sh.open(true);
  assert.equal(sh.layer.hidden, false);
  assert.equal(d.frames().length, 1, "the frame stays FRAME_LEAVE_MS, for the answer that opened the layer");
  assert.equal((old as unknown as { inert?: boolean }).inert, true, "inert in the same task as the layer shows");
  await until(() => d.frames().length === 0, "the frame leaves after FRAME_LEAVE_MS");
  const before = d.posted.length;
  // the removed frame's window asks: dropped; a late load of it posts nothing
  d.send(ask(), old.contentWindow);
  old.fire("load");
  await quiet();
  assert.equal(d.posted.length, before);
  d.loc.href = `${SIGN_ORIGIN}/portfolio?x=1`;
  sh.close();
  assert.equal(sh.layer.hidden, true);
  const [f] = d.frames();
  assert.ok(f && f !== old);
  assert.equal(f.src, `${APP_ORIGIN}/portfolio?x=1`);
  f.fire("load");
  const q = ask();
  d.send(q, f.contentWindow);
  d.send(ask(), old.contentWindow);
  await answerTo(d, q.id);
  const after = d.posted.slice(before);
  assert.deepEqual(after.map((p) => p.msg), [READY, { v: 1, id: q.id, ok: true, result: signedOutState() }]);
  assert.ok(after.every((p) => p.win === f.contentWindow && p.to === APP_ORIGIN));
  // close twice: one frame; open then close at once: the frame stays, and stays the only one
  sh.close();
  assert.equal(d.frames().length, 1);
  sh.open(true);
  sh.close();
  // a check that nothing came: this timer is due after the shell's FRAME_LEAVE_MS timer, so that one has run
  await new Promise((ok) => setTimeout(ok, PROTECT_MS + 20));
  assert.equal(d.frames().length, 1);
  assert.equal((d.frames()[0] as unknown as { inert?: boolean }).inert, false, "a frame kept by a quick close is live again, PROTECT_MS after it");
});

test("nav: the top window's address becomes APP_HOST's path and query, by replaceState only; another origin, // and an over-long path are refused", async () => {
  const d = fakeDom();
  mountShell(d.doc, { state: () => signedOutState() });
  const win = d.frames()[0]!.contentWindow;
  const nav = (path: unknown) => ({ v: 1, id: crypto.randomUUID(), type: "nav", path });
  const ok = nav("/token/base/0xabc?tab=holders");
  d.send(ok, win);
  assert.deepEqual(await answerTo(d, ok.id), { v: 1, id: ok.id, ok: true, result: {} });
  assert.deepEqual(d.calls.replace, [`${SIGN_ORIGIN}/token/base/0xabc?tab=holders`]);
  for (const path of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "x", `/${"a".repeat(2_048)}`, "/a\nb"]) {
    const m = nav(path);
    d.send(m, win);
    assert.deepEqual(await answerTo(d, m.id), { v: 1, id: m.id, ok: false, error: { code: "not_allowed" } }, path);
  }
  const extra = { ...nav("/x"), extra: 1 };
  d.send(extra, win);
  assert.deepEqual(await answerTo(d, extra.id), { v: 1, id: extra.id, ok: false, error: { code: "not_allowed" } });
  assert.equal(d.calls.replace.length, 1);
  assert.equal(d.calls.assign + d.calls.reload, 0, "never a navigation");
});

test("open(typed): the frame is out of the document within 100 ms, whatever FRAME_LEAVE_MS says, since inert alone keeps no focus thief out", () => {
  assert.ok(FRAME_LEAVE_MS > 0 && FRAME_LEAVE_MS <= 100, `FRAME_LEAVE_MS ${FRAME_LEAVE_MS}`);
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    const d = fakeDom();
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    sh.open(true);
    assert.equal(d.frames().length, 1);
    mock.timers.tick(100);
    assert.equal(d.frames().length, 0, "the frame is gone 100 ms after open");
    // a typed screen drawn on a sheet opened untyped (Recovery code on the sign-in sheet): seal takes the frame out
    sh.close();
    sh.open();
    mock.timers.tick(1_000);
    assert.equal(d.frames().length, 1, "an untyped sheet keeps the frame");
    const view = d.doc.defaultView as unknown as { performance?: { now(): number } };
    let now = 0;
    view.performance = { now: () => now };
    sh.close();
    sh.open();
    now += FRAME_LEAVE_MS + 1;
    sh.seal();
    assert.equal(d.frames().length, 0, "seal on a sheet open longer than FRAME_LEAVE_MS takes it out in the same task");
  } finally {
    resetTimers(mock.timers);
  }
});

test("open: the sheet over the app keeps the frame in the page, inert, with its state; nothing it sends is read until close; close makes it live again, no new frame, no new ready", async () => {
  const d = fakeDom();
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  const f = d.frames()[0]!;
  f.fire("load");
  await until(() => d.posted.length === 1, "ready");
  sh.open();
  assert.equal(sh.layer.hidden, false);
  assert.equal(f.inert, true, "inert in the same task as the sheet shows");
  await new Promise((ok) => setTimeout(ok, FRAME_LEAVE_MS + 20));
  assert.deepEqual(d.frames(), [f], "the same frame, still in the page");
  // the frame asks while the sheet shows: a state read, a nav, a reload, an open kind; none is read
  const before = d.posted.length;
  for (const m of [ask(), { v: 1, id: crypto.randomUUID(), type: "nav", path: "/portfolio" }, { v: 1, id: crypto.randomUUID(), type: "reload" }, { v: 1, id: crypto.randomUUID(), type: "signin.open", return_key: "signin", way: "passkey" }]) d.send(m, f.contentWindow);
  await quiet();
  assert.equal(d.posted.length, before, "no answer while the sheet shows");
  assert.deepEqual(d.calls, { replace: [], reload: 0, assign: 0 }, "no address change, no reload");
  sh.close();
  assert.equal(sh.layer.hidden, true);
  assert.deepEqual(d.frames(), [f], "no new frame: the app kept its state");
  assert.equal(f.inert, true, "inert for PROTECT_MS after the close: a double tap's second tap lands on no app control");
  await new Promise((ok) => setTimeout(ok, PROTECT_MS + 20));
  assert.equal(f.inert, false);
  const q = ask();
  d.send(q, f.contentWindow);
  assert.deepEqual(await answerTo(d, q.id), { v: 1, id: q.id, ok: true, result: signedOutState() });
  assert.equal(d.posted.filter((p) => (p.msg as { type?: string }).type === "ready").length, 1, "one ready, for the frame's one load");
});

test("dismiss: the user's own Esc acts only on a sheet whose screen may be left, and never on an untrusted event", () => {
  const d = fakeDom();
  let now = 1_000;
  (d.doc.defaultView as unknown as { performance: { now(): number } }).performance = { now: () => now };
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  let n = 0;
  sh.onDismiss = () => void n++;
  d.key("Escape");
  assert.equal(n, 0, "no sheet shown");
  sh.open();
  now += PROTECT_MS;
  d.key("Escape");
  assert.equal(n, 0, "a screen that may not be left (the 12 words before Saved)");
  sh.dismissible(true);
  d.key("Escape", false);
  d.key("Enter");
  assert.equal(n, 0, "an untrusted Esc, another key");
  d.key("Escape");
  assert.equal(n, 1);
  // within the activation guard's window of the open (the second tap of the double tap that opened it): not a close
  sh.close();
  sh.open();
  now += PROTECT_MS - 1;
  d.key("Escape");
  assert.equal(n, 1, "an Esc within PROTECT_MS of the open");
  now += 1;
  d.key("Escape");
  assert.equal(n, 2);
});

test("a typed screen's close keeps the sheet's dim over the new frame until it has loaded and painted, then fades it", () => {
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    const d = fakeDom();
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    const veil = d.children.find((c) => c.dataset.sheet === "veil")!;
    assert.ok(veil && veil.hidden, "no veil before a close");
    sh.open(true);
    mock.timers.tick(FRAME_LEAVE_MS);
    assert.equal(d.frames().length, 0);
    sh.close();
    assert.equal(sh.layer.hidden, true);
    assert.equal(veil.hidden, false, "the dim stays as the sheet goes");
    assert.equal(veil.style.opacity, "1");
    assert.equal(veil.style.pointerEvents, "none", "it takes no tap");
    const f = d.frames()[0]!;
    assert.ok(d.children.indexOf(f) < d.children.indexOf(sh.layer as unknown as (typeof d.children)[number]));
    mock.timers.tick(VEIL_CAP_MS - 1);
    assert.equal(veil.style.opacity, "1", "kept until the new frame loads");
    f.fire("load");
    mock.timers.tick(1);
    assert.equal(veil.style.opacity, "0", "faded once the frame painted");
    mock.timers.tick(200);
    assert.equal(veil.hidden, true);
    // an untyped sheet's close: the same frame, no veil
    sh.open();
    sh.close();
    assert.equal(veil.hidden, true);
  } finally {
    resetTimers(mock.timers);
  }
});

test("focus the frame takes while a sheet shows over it comes back to the sheet; none is taken from the frame otherwise", () => {
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    const d = fakeDom();
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    const f = d.frames()[0]!;
    const doc = d.doc as unknown as { activeElement: unknown };
    const boxFocus = () => d.focused.filter((e) => e.tagName === "aside").length;
    // no sheet: the window's blur into the frame is the app's own focus
    doc.activeElement = f;
    d.blur();
    mock.timers.tick(1);
    assert.equal(boxFocus(), 0);
    sh.open();
    assert.equal(boxFocus(), 1, "the sheet takes the focus as it opens");
    // the window lost focus to something else (another app): left as it is
    doc.activeElement = null;
    d.blur();
    mock.timers.tick(1);
    assert.equal(boxFocus(), 1);
    // the frame took it under the sheet: back to the sheet
    doc.activeElement = f;
    d.blur();
    mock.timers.tick(1);
    assert.equal(boxFocus(), 2, "the focus the frame took came back to the sheet");
    sh.close();
    doc.activeElement = f;
    d.blur();
    mock.timers.tick(1);
    assert.equal(boxFocus(), 2, "after close the frame keeps its focus");
  } finally {
    resetTimers(mock.timers);
  }
});

test("nav refuses every file SIGN_HOST's build serves, in any spelling, and the list is the deploy build's own output", () => {
  const out: string = build();
  try {
    const served = readdirSync(out).map((n) => (statSync(join(out, n)).isDirectory() ? `/${n}/` : `/${n}`)).sort();
    assert.deepEqual([...SERVED_FILES].sort(), served, "SERVED_FILES is exactly the deploy build's top level");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  for (const f of SERVED_FILES) {
    const variants = [f, `${f}?x=1`, `${f}/`, f.toUpperCase(), f.replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`), `/x/..${f}`, `/.${f}`];
    for (const v of variants) assert.equal(navUrl(SIGN_ORIGIN, v), null, v);
  }
  assert.equal(navUrl(SIGN_ORIGIN, "/%E0%A4%A"), null, "a path that does not decode");
  // the app's own paths stay allowed, a NEAR account with dots in it included
  assert.equal(navUrl(SIGN_ORIGIN, "/token/near/usdt.tether-token.near?tab=holders"), `${SIGN_ORIGIN}/token/near/usdt.tether-token.near?tab=holders`);
  assert.equal(navUrl(SIGN_ORIGIN, "/"), `${SIGN_ORIGIN}/`);
  assert.equal(navUrl(SIGN_ORIGIN, "/token/app.js.near"), `${SIGN_ORIGIN}/token/app.js.near`);
});

test("navUrl: APP_HOST's own path and query on the top origin, or null", () => {
  assert.equal(navUrl(SIGN_ORIGIN, "/a/b?c=d#e"), `${SIGN_ORIGIN}/a/b?c=d`);
  assert.equal(navUrl(SIGN_ORIGIN, "/@evil.com"), `${SIGN_ORIGIN}/@evil.com`);
  for (const p of ["//evil.com", "/\\evil.com", "evil", "", `/${"é".repeat(1_024)}`]) assert.equal(navUrl(SIGN_ORIGIN, p), null, p);
});

test("reload: answered first, then the top window reloads", async () => {
  const d = fakeDom();
  mountShell(d.doc, { state: () => signedOutState() });
  const win = d.frames()[0]!.contentWindow;
  const m = { v: 1, id: crypto.randomUUID(), type: "reload" };
  let atReload = -1;
  const view = d.doc.defaultView as unknown as { location: { reload(): void } };
  view.location.reload = () => void (atReload = d.posted.length);
  d.send(m, win);
  assert.deepEqual(await answerTo(d, m.id), { v: 1, id: m.id, ok: true, result: {} });
  await until(() => atReload >= 0, "the reload");
  assert.equal(atReload, d.posted.length, "the answer was posted before the reload");
  const bad = { v: 1, id: crypto.randomUUID(), type: "reload", x: 1 };
  d.send(bad, win);
  assert.deepEqual(await answerTo(d, bad.id), { v: 1, id: bad.id, ok: false, error: { code: "not_allowed" } });
});

test("reload waits for a running trade to settle (the review's reload finding): answered first, reloaded only after", async () => {
  const d = fakeDom();
  let settle!: () => void;
  const running = new Promise<void>((r) => (settle = r));
  mountShell(d.doc, { state: () => signedOutState(), settle: () => running });
  const win = d.frames()[0]!.contentWindow;
  const m = { v: 1, id: crypto.randomUUID(), type: "reload" };
  d.send(m, win);
  assert.deepEqual(await answerTo(d, m.id), { v: 1, id: m.id, ok: true, result: {} });
  await quiet();
  assert.equal(d.calls.reload, 0, "no reload while the trade runs");
  settle();
  await until(() => d.calls.reload === 1, "the reload once the trade settled");
  assert.equal(d.calls.reload, 1);
});

test("a kind the host answers (signin.open): its answer goes to the frame before its then() opens the layer", async () => {
  const d = fakeDom();
  let sh: ReturnType<typeof mountShell> | null = null;
  const order: string[] = [];
  sh = mountShell(d.doc, {
    state: () => signedOutState(),
    kinds: { "signin.open": (p) => (p.way === "wallet" ? null : { result: { pending: true }, then: () => (order.push(`open after ${d.posted.length} posts`), sh!.open(true)) }) },
  });
  const win = d.frames()[0]!.contentWindow;
  const m = { v: 1, id: crypto.randomUUID(), type: "signin.open", return_key: "deposit", way: "words" };
  d.send(m, win);
  assert.deepEqual(await answerTo(d, m.id), { v: 1, id: m.id, ok: true, result: { pending: true } });
  await until(() => order.length > 0, "then() opens the layer");
  assert.deepEqual(order, [`open after ${d.posted.length} posts`]);
  await until(() => d.frames().length === 0, "the frame leaves after FRAME_LEAVE_MS");
  // backup.open has no handler: refused, and so is a signin.open the handler refuses (a new frame first)
  sh.close();
  const w2 = d.frames()[0]!.contentWindow;
  for (const r of [{ type: "backup.open", return_key: "settings" }, { type: "signin.open", return_key: "deposit", way: "wallet" }]) {
    const q = { v: 1, id: crypto.randomUUID(), ...r };
    d.send(q, w2);
    assert.deepEqual(await answerTo(d, q.id), { v: 1, id: q.id, ok: false, error: { code: "not_allowed" } }, r.type);
  }
});

test("the waits hold on a loaded runner: every answer read when the shell's SHA-256 comes 50 ms late (CI job 126429473907)", async (t) => {
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  Object.defineProperty(subtle, "digest", { configurable: true, value: async (...a: Parameters<SubtleCrypto["digest"]>) => (await new Promise((ok) => setTimeout(ok, 50)), digest(...a)) });
  t.after(() => delete (subtle as unknown as { digest?: unknown }).digest);
  const d = fakeDom();
  mountShell(d.doc, { state: () => signedOutState() });
  const win = d.frames()[0]!.contentWindow;
  const nav = { v: 1, id: crypto.randomUUID(), type: "nav", path: "/portfolio" };
  d.send(nav, win);
  assert.deepEqual(await answerTo(d, nav.id), { v: 1, id: nav.id, ok: true, result: {} });
  const q = ask();
  d.send(q, win);
  assert.deepEqual(await answerTo(d, q.id), { v: 1, id: q.id, ok: true, result: signedOutState() });
});

// ------------------------------------------------------------------------------------------------ each rule its own test
// (the review of 7a21ffcd removed each of these rules and every test still passed: each test below dies on its mutant)
const clocked = (d: ReturnType<typeof fakeDom>) => {
  const c = { now: 1_000 };
  (d.doc.defaultView as unknown as { performance: { now(): number } }).performance = { now: () => c.now };
  return c;
};

test("nav's own check: a nav the frame sent before the sheet opened, read after, changes no address", async () => {
  const d = fakeDom();
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  const f = d.frames()[0]!;
  const m = { v: 1, id: crypto.randomUUID(), type: "nav", path: "/portfolio" };
  d.send(m, f.contentWindow);
  sh.open();
  const a = await answerTo(d, m.id);
  assert.notEqual((a as { ok?: boolean }).ok, true);
  assert.deepEqual(d.calls.replace, []);
});

test("reload's own check: a reload the frame sent before the sheet opened, read after, is refused", async () => {
  const d = fakeDom();
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  const f = d.frames()[0]!;
  const m = { v: 1, id: crypto.randomUUID(), type: "reload" };
  d.send(m, f.contentWindow);
  sh.open();
  const a = await answerTo(d, m.id);
  assert.notEqual((a as { ok?: boolean }).ok, true);
  await quiet();
  assert.equal(d.calls.reload, 0);
});

test("a reload answered before the sheet opened does not fire under it; with no sheet it does", async () => {
  for (const opens of [true, false]) {
    const d = fakeDom();
    let settle = () => {};
    const sh = mountShell(d.doc, { state: () => signedOutState(), settle: () => new Promise<void>((ok) => (settle = ok)) });
    const f = d.frames()[0]!;
    const m = { v: 1, id: crypto.randomUUID(), type: "reload" };
    d.send(m, f.contentWindow);
    assert.equal((await answerTo(d, m.id) as { ok?: boolean }).ok, true);
    if (opens) sh.open();
    settle();
    await quiet();
    assert.equal(d.calls.reload, opens ? 0 : 1, opens ? "under a sheet" : "no sheet");
  }
});

for (const part of ["scrim", "close"] as const) {
  test(`the ${part === "close" ? "x" : "scrim"}'s click closes only when trusted, on a shown sheet that may be left, past PROTECT_MS of the open on the event's own clock`, () => {
    const d = fakeDom();
    const c = clocked(d);
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    let n = 0;
    sh.onDismiss = () => void n++;
    const click = (more: Record<string, unknown>) => d.part(part).fire("click", { isTrusted: true, timeStamp: c.now, ...more });
    sh.dismissible(true);
    click({});
    assert.equal(n, 0, "no sheet shown");
    sh.open();
    sh.dismissible(false);
    c.now += PROTECT_MS;
    click({});
    assert.equal(n, 0, "a screen that may not be left");
    sh.dismissible(true);
    click({ isTrusted: false });
    assert.equal(n, 0, "untrusted");
    click({ timeStamp: c.now - 1 });
    assert.equal(n, 0, "the event's own time within PROTECT_MS of the open, though the clock now is past it");
    click({});
    assert.equal(n, 1);
  });
}

test("Esc: refused while hidden though dismissible, on a repeat, and by the event's own early time", () => {
  const d = fakeDom();
  const c = clocked(d);
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  let n = 0;
  sh.onDismiss = () => void n++;
  sh.open();
  sh.dismissible(true);
  sh.close();
  c.now += PROTECT_MS * 2;
  d.key("Escape", true, { timeStamp: c.now });
  assert.equal(n, 0, "hidden");
  sh.open();
  sh.dismissible(true);
  c.now += PROTECT_MS;
  d.key("Escape", true, { timeStamp: c.now, repeat: true });
  assert.equal(n, 0, "a key held down");
  d.key("Escape", true, { timeStamp: c.now - PROTECT_MS + 1 });
  assert.equal(n, 0, "its own time within PROTECT_MS");
  d.key("Escape", true, { timeStamp: c.now });
  assert.equal(n, 1);
});

test("after a close the frame takes no tap for PROTECT_MS: a kept frame, and a new one after a typed screen", () => {
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    const d = fakeDom();
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    const kept = d.frames()[0]!;
    sh.open();
    sh.close();
    assert.equal(kept.inert, true);
    mock.timers.tick(PROTECT_MS - 1);
    assert.equal(kept.inert, true, "still inert just before PROTECT_MS");
    mock.timers.tick(1);
    assert.equal(kept.inert, false);
    // reopened inside the window: it stays inert under the new sheet
    sh.open();
    sh.close();
    sh.open();
    mock.timers.tick(PROTECT_MS * 2);
    assert.equal(kept.inert, true, "a sheet open again keeps it inert");
    sh.close();
    sh.open(true);
    mock.timers.tick(FRAME_LEAVE_MS);
    sh.close();
    const fresh = d.frames()[0]!;
    assert.notEqual(fresh, kept);
    assert.equal(fresh.inert, true, "the new frame too");
    mock.timers.tick(PROTECT_MS);
    assert.equal(fresh.inert, false);
  } finally {
    resetTimers(mock.timers);
  }
});

test("the dim over a new frame that never loads fades at VEIL_CAP_MS", () => {
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    const d = fakeDom();
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    const veil = d.part("veil");
    sh.open(true);
    mock.timers.tick(FRAME_LEAVE_MS);
    sh.close();
    mock.timers.tick(VEIL_CAP_MS - 1);
    assert.equal(veil.style.opacity, "1");
    mock.timers.tick(1);
    assert.equal(veil.style.opacity, "0");
    mock.timers.tick(200);
    assert.equal(veil.hidden, true);
  } finally {
    resetTimers(mock.timers);
  }
});
