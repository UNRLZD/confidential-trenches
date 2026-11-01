// SIGN_HOST's shell (src/shell.ts), card signpage-shell: SIGN_HOST is the top window and frames APP_HOST.
//   node --test test/shell.test.ts      (from packages/signpage)
// The frame's src is APP_HOST with this page's path and query and never another origin; the kit's API is answered to
// the framed APP_HOST's window only (its source and origin both), posted only to it with targetOrigin APP_HOST, and
// `ready` goes out again on each load of the frame. The browser half (frame-src, sandbox, a real APP_HOST page) is the
// live check's (scripts/live-checks/signpage-shell.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_ORIGIN, RELEASE, signedOutState, type IncomingMessage } from "../src/api.ts";
import { appSrc, FRAME_SANDBOX, wireShell } from "../src/shell.ts";

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

test("the frame's sandbox is exactly the four tokens", () => {
  assert.equal(FRAME_SANDBOX, "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
});

/** A shell wired to a fake frame window: what it posted, a way to send it a message, a frame load. */
function shell() {
  const posted: { msg: unknown; to: string }[] = [];
  const frame = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  let onLoad: (() => void) | null = null;
  const api = wireShell(
    { window: frame, onLoad: (fn) => (onLoad = fn) },
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
