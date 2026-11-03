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
import { APP_ORIGIN, RELEASE, signedOutState, type IncomingMessage } from "../src/api.ts";
import { appSrc, FRAME_LEAVE_MS, FRAME_SANDBOX, mountShell, navUrl, SERVED_FILES, wireShell } from "../src/shell.ts";
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
  for (const origin of ["https://sign.confidential.unrealized.trade", "https://example.com", "http://confidential.unrealized.trade", "null", ""]) s.send(ask(), { origin });
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
const SIGN_ORIGIN = "https://sign.confidential.unrealized.trade";
type FakeEl = {
  tagName: string; id: string; hidden: boolean; style: Record<string, string>; src: string;
  contentWindow: { postMessage(m: unknown, o: string): void } | null;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; attributes(): string[];
  addEventListener(t: string, fn: () => void): void; fire(t: string): void; remove(): void;
};
function fakeDom(href = `${SIGN_ORIGIN}/token/solana/So111?tab=trades`) {
  const loc = new URL(href);
  const calls = { replace: [] as string[], reload: 0, assign: 0 };
  const posted: { msg: unknown; to: string; win: unknown }[] = [];
  const listeners: ((e: IncomingMessage) => void)[] = [];
  const children: FakeEl[] = [];
  const createElement = (tag: string): FakeEl => {
    const attrs = new Map<string, string>();
    const on = new Map<string, () => void>();
    const e: FakeEl = {
      tagName: tag, id: "", hidden: false, style: {}, src: "", contentWindow: null,
      setAttribute: (k, v) => void attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k) ?? null,
      attributes: () => [...attrs.keys()].sort(),
      addEventListener: (t, fn) => void on.set(t, fn),
      fire: (t) => on.get(t)?.(),
      remove: () => void (children.includes(e) && children.splice(children.indexOf(e), 1)),
    };
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
    addEventListener: (t: string, fn: (e: IncomingMessage) => void) => void (t === "message" && listeners.push(fn)),
  };
  const body = {
    style: {},
    append: (...xs: FakeEl[]) => void children.push(...xs),
    insertBefore: (x: FakeEl, ref: FakeEl) => void children.splice(children.indexOf(ref), 0, x),
  };
  const doc = { defaultView: view, createElement, body } as unknown as Document;
  const frames = () => children.filter((c) => c.tagName === "iframe");
  const send = (data: unknown, source: unknown) => {
    for (const fn of listeners) fn({ origin: APP_ORIGIN, source, data });
  };
  return { doc, loc, calls, posted, children, frames, send };
}
const flush = () => new Promise((ok) => setTimeout(ok, 10));

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

test("open takes the frame out of the document and nothing reaches the old window; close puts a new one in at the address now, and only its load posts ready", async () => {
  const d = fakeDom();
  const sh = mountShell(d.doc, { state: () => signedOutState() });
  const old = d.frames()[0]!;
  old.fire("load");
  sh.open();
  assert.equal(sh.layer.hidden, false);
  assert.equal(d.frames().length, 1, "the frame stays FRAME_LEAVE_MS, for the answer that opened the layer");
  assert.equal((old as unknown as { inert?: boolean }).inert, true, "inert in the same task as the layer shows");
  await new Promise((ok) => setTimeout(ok, FRAME_LEAVE_MS + 20));
  assert.equal(d.frames().length, 0);
  const before = d.posted.length;
  // the removed frame's window asks: dropped; a late load of it posts nothing
  d.send(ask(), old.contentWindow);
  old.fire("load");
  await flush();
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
  await flush();
  const after = d.posted.slice(before);
  assert.deepEqual(after.map((p) => p.msg), [READY, { v: 1, id: q.id, ok: true, result: signedOutState() }]);
  assert.ok(after.every((p) => p.win === f.contentWindow && p.to === APP_ORIGIN));
  // close twice: one frame; open then close at once: the frame stays, and stays the only one
  sh.close();
  assert.equal(d.frames().length, 1);
  sh.open();
  sh.close();
  await new Promise((ok) => setTimeout(ok, FRAME_LEAVE_MS + 20));
  assert.equal(d.frames().length, 1);
  assert.equal((d.frames()[0] as unknown as { inert?: boolean }).inert, false, "a frame kept by a quick close is live again");
});

test("nav: the top window's address becomes APP_HOST's path and query, by replaceState only; another origin, // and an over-long path are refused", async () => {
  const d = fakeDom();
  mountShell(d.doc, { state: () => signedOutState() });
  const win = d.frames()[0]!.contentWindow;
  const nav = (path: unknown) => ({ v: 1, id: crypto.randomUUID(), type: "nav", path });
  const ok = nav("/token/base/0xabc?tab=holders");
  d.send(ok, win);
  await flush();
  assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: ok.id, ok: true, result: {} });
  assert.deepEqual(d.calls.replace, [`${SIGN_ORIGIN}/token/base/0xabc?tab=holders`]);
  for (const path of ["//evil.example/x", "https://evil.example/x", "/\\evil.example", "x", `/${"a".repeat(2_048)}`, "/a\nb"]) {
    const m = nav(path);
    d.send(m, win);
    await flush();
    assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: m.id, ok: false, error: { code: "not_allowed" } }, path);
  }
  const extra = { ...nav("/x"), extra: 1 };
  d.send(extra, win);
  await flush();
  assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: extra.id, ok: false, error: { code: "not_allowed" } });
  assert.equal(d.calls.replace.length, 1);
  assert.equal(d.calls.assign + d.calls.reload, 0, "never a navigation");
});

test("open: the frame is out of the document within 100 ms, whatever FRAME_LEAVE_MS says, since inert alone keeps no focus thief out", () => {
  assert.ok(FRAME_LEAVE_MS > 0 && FRAME_LEAVE_MS <= 100, `FRAME_LEAVE_MS ${FRAME_LEAVE_MS}`);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const d = fakeDom();
    const sh = mountShell(d.doc, { state: () => signedOutState() });
    sh.open();
    assert.equal(d.frames().length, 1);
    mock.timers.tick(100);
    assert.equal(d.frames().length, 0, "the frame is gone 100 ms after open");
  } finally {
    mock.timers.reset();
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
  await flush();
  assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: m.id, ok: true, result: {} });
  assert.equal(atReload, d.posted.length, "the answer was posted before the reload");
  const bad = { v: 1, id: crypto.randomUUID(), type: "reload", x: 1 };
  d.send(bad, win);
  await flush();
  assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: bad.id, ok: false, error: { code: "not_allowed" } });
});

test("reload waits for a running trade to settle (the review's reload finding): answered first, reloaded only after", async () => {
  const d = fakeDom();
  let settle!: () => void;
  const running = new Promise<void>((r) => (settle = r));
  mountShell(d.doc, { state: () => signedOutState(), settle: () => running });
  const win = d.frames()[0]!.contentWindow;
  const m = { v: 1, id: crypto.randomUUID(), type: "reload" };
  d.send(m, win);
  await flush();
  assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: m.id, ok: true, result: {} });
  assert.equal(d.calls.reload, 0, "no reload while the trade runs");
  settle();
  await flush();
  assert.equal(d.calls.reload, 1);
});

test("a kind the host answers (signin.open): its answer goes to the frame before its then() opens the layer", async () => {
  const d = fakeDom();
  let sh: ReturnType<typeof mountShell> | null = null;
  const order: string[] = [];
  sh = mountShell(d.doc, {
    state: () => signedOutState(),
    kinds: { "signin.open": (p) => (p.way === "wallet" ? null : { result: { pending: true }, then: () => (order.push(`open after ${d.posted.length} posts`), sh!.open()) }) },
  });
  const win = d.frames()[0]!.contentWindow;
  const m = { v: 1, id: crypto.randomUUID(), type: "signin.open", return_key: "deposit", way: "words" };
  d.send(m, win);
  await flush();
  assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: m.id, ok: true, result: { pending: true } });
  assert.deepEqual(order, [`open after ${d.posted.length} posts`]);
  await new Promise((ok) => setTimeout(ok, FRAME_LEAVE_MS + 20));
  assert.equal(d.frames().length, 0);
  // backup.open has no handler: refused, and so is a signin.open the handler refuses (a new frame first)
  sh.close();
  const w2 = d.frames()[0]!.contentWindow;
  for (const r of [{ type: "backup.open", return_key: "settings" }, { type: "signin.open", return_key: "deposit", way: "wallet" }]) {
    const q = { v: 1, id: crypto.randomUUID(), ...r };
    d.send(q, w2);
    await flush();
    assert.deepEqual(d.posted.at(-1)!.msg, { v: 1, id: q.id, ok: false, error: { code: "not_allowed" } }, r.type);
  }
});
