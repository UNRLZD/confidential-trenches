// SIGN_HOST's postMessage API (src/api.ts), card signpage-postmessage.
//   node --test test/api.test.ts      (from packages/signpage)
// The page posts `ready` to APP_HOST only, answers `state` with exactly {v, id, type}, refuses every other kind as
// "not_allowed", and drops a wrong origin, a wrong source or a malformed envelope with no answer and no change. The
// last test checks that public/api.js and index.html's integrity are this source's build, byte for byte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APP_ORIGIN, REMEMBERED_IDS, RELEASE, signedOutState, startApi } from "../src/api.ts";
import type { IncomingMessage } from "../src/api.ts";
// @ts-expect-error: a plain .mjs build script with no types
import { apiJs, integrityOf } from "../scripts/api-build.mjs";

const KINDS = [
  "deposit.quote", "deposit.confirm", "arm", "buy", "hop", "orders.set", "orders.cancel", "return",
  "withdraw.open", "signin.open", "backup.open", "export.open", "signout", "restore",
];

/** A page started on a fake parent: what it posted, and a way to send it a message. */
function page() {
  const posted: { msg: unknown; to: string }[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  startApi({ parent, listen: (fn) => (listener = fn), state: signedOutState });
  const send = (data: unknown, from: { origin?: string; source?: unknown } = {}) =>
    listener!({ origin: from.origin ?? APP_ORIGIN, source: "source" in from ? from.source : parent, data });
  return { posted, send, parent };
}

const uuid = () => crypto.randomUUID();
const state = (id = uuid()) => ({ v: 1, id, type: "state" });
const notAllowed = (id: string) => ({ v: 1, id, ok: false, error: { code: "not_allowed" } });

test("ready: posted once at start, to the parent, with targetOrigin APP_HOST, in the frozen shape", () => {
  const p = page();
  assert.deepEqual(p.posted, [{ msg: { v: 1, type: "ready", release: RELEASE, api: 1 }, to: APP_ORIGIN }]);
});

test("state from APP_HOST's parent: answered with the state, to APP_HOST only", () => {
  const p = page();
  const id = uuid();
  p.send(state(id));
  assert.equal(p.posted.length, 2);
  assert.deepEqual(p.posted[1], { msg: { v: 1, id, ok: true, result: signedOutState() }, to: APP_ORIGIN });
  const s = signedOutState();
  assert.deepEqual(Object.keys(s).sort(), ["api", "code_saved", "held", "ops", "orders", "positions", "release", "signed_in", "vault_balance", "wallets"]);
  assert.equal(s.signed_in, false);
});

test("a wrong origin is dropped: no answer, and its id stays unanswered", () => {
  const p = page();
  const id = uuid();
  for (const origin of ["https://evil.ct.test", "https://app.other.test", "https://example.com", "https://confidential.unrealized.trade.evil.com", "http://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade", "null", ""]) {
    p.send(state(id), { origin });
  }
  assert.equal(p.posted.length, 1, "only ready");
  p.send(state(id));
  assert.equal((p.posted[1]!.msg as { ok: boolean }).ok, true, "the dropped messages left no first answer behind");
});

test("a wrong source from APP_HOST's origin is dropped: no answer, no change", () => {
  const p = page();
  const id = uuid();
  for (const source of [null, undefined, {}, { postMessage() {} }]) p.send(state(id), { source });
  assert.equal(p.posted.length, 1, "only ready");
  p.send(state(id));
  assert.equal((p.posted[1]!.msg as { ok: boolean }).ok, true);
});

test("a malformed envelope is dropped: not an object, no UUID id, a class instance", () => {
  const p = page();
  const id = uuid();
  const bad: unknown[] = [
    null, undefined, "state", 1, [], [state(id)], new Map([["v", 1]]), new Date(),
    { v: 1, type: "state" }, { v: 1, id: 7, type: "state" }, { v: 1, id: "", type: "state" },
    { v: 1, id: "not-a-uuid", type: "state" }, { v: 1, id: id.toUpperCase(), type: "state" }, { v: 1, id: `${id} `, type: "state" },
    Object.assign(Object.create({ v: 1, id }), { type: "state" }),
  ];
  for (const d of bad) p.send(d);
  assert.equal(p.posted.length, 1, "only ready");
});

test("every other kind, an unknown kind and an extra field: not_allowed", () => {
  const p = page();
  const cases: Record<string, unknown>[] = [
    ...KINDS.map((type) => ({ v: 1, id: uuid(), type })),
    { v: 1, id: uuid(), type: "buy", chain: "solana", token: "So11111111111111111111111111111111111111112", side: "buy", amount: "1", slippage_bps: 50 },
    { v: 1, id: uuid(), type: "sign" },
    { v: 1, id: uuid(), type: "eth_signTypedData_v4" },
    { v: 1, id: uuid() },
    { v: 1, id: uuid(), type: 5 },
    { v: 1, id: uuid(), type: "State" },
    { v: 1, id: uuid(), type: "state", extra: true },
    { v: 2, id: uuid(), type: "state" },
    { v: "1", id: uuid(), type: "state" },
    { id: uuid(), type: "state" },
    { v: 1, id: uuid(), type: "state", ["__proto__"]: { polluted: true } },
    JSON.parse(`{"v":1,"id":"${uuid()}","type":"state","__proto__":{"polluted":true}}`),
  ];
  for (const c of cases) p.send(c);
  assert.equal(p.posted.length, 1 + cases.length);
  cases.forEach((c, i) => assert.deepEqual(p.posted[1 + i], { msg: notAllowed(c.id as string), to: APP_ORIGIN }, JSON.stringify(c)));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a return_key is never looked up: constructor, __proto__, toString and an unknown name are refused", () => {
  const p = page();
  const cases: Record<string, unknown>[] = [];
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "no_such_screen", "deposit"]) {
    cases.push({ v: 1, id: uuid(), type: "signin.open", return_key: key, way: "passkey" });
    cases.push({ v: 1, id: uuid(), type: "backup.open", return_key: key });
    cases.push({ v: 1, id: uuid(), type: "withdraw.open", return_key: key });
  }
  for (const c of cases) assert.doesNotThrow(() => p.send(c));
  assert.equal(p.posted.length, 1 + cases.length);
  cases.forEach((c, i) => assert.deepEqual(p.posted[1 + i], { msg: notAllowed(c.id as string), to: APP_ORIGIN }, JSON.stringify(c)));
});

test("every message posted is at most 64 KiB of JSON, with plain arrays of index keys only (app.md:116-117)", () => {
  const p = page();
  p.send(state());
  p.send({ v: 1, id: uuid(), type: "buy" });
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      assert.equal(Object.getPrototypeOf(x), Array.prototype);
      assert.deepEqual(Reflect.ownKeys(x), [...x.keys()].map(String).concat("length"));
      x.forEach(walk);
    } else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
  };
  for (const { msg } of p.posted) {
    assert.ok(JSON.stringify(msg).length <= 65_536);
    walk(msg);
  }
  assert.equal(p.posted.length, 3);
});

test("a repeated id gets its first answer again, never a second run", () => {
  let reads = 0;
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  startApi({ parent, listen: (fn) => (listener = fn), state: () => (reads++, signedOutState()) });
  const id = uuid();
  listener!({ origin: APP_ORIGIN, source: parent, data: state(id) });
  listener!({ origin: APP_ORIGIN, source: parent, data: state(id) });
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: "buy" } });
  assert.equal(reads, 1);
  assert.deepEqual(posted[2], posted[1]);
  assert.deepEqual(posted[3], posted[1]);
  const refused = uuid();
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id: refused, type: "buy" } });
  listener!({ origin: APP_ORIGIN, source: parent, data: state(refused) });
  assert.deepEqual(posted[5], notAllowed(refused));
});

test("answered ids are kept up to REMEMBERED_IDS, the oldest dropped first", () => {
  let reads = 0;
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  startApi({ parent, listen: (fn) => (listener = fn), state: () => (reads++, signedOutState()) });
  const ids = Array.from({ length: REMEMBERED_IDS + 1 }, uuid);
  for (const id of ids) listener!({ origin: APP_ORIGIN, source: parent, data: state(id) });
  listener!({ origin: APP_ORIGIN, source: parent, data: state(ids[1]) });
  assert.equal(reads, REMEMBERED_IDS + 1, "ids[1] is still remembered");
  listener!({ origin: APP_ORIGIN, source: parent, data: state(ids[0]) });
  assert.equal(reads, REMEMBERED_IDS + 2, "ids[0] was the oldest and went");
});

test("public/api.js and index.html's integrity are src/api.ts's build, byte for byte", () => {
  const js = readFileSync(new URL("../public/api.js", import.meta.url), "utf8");
  assert.equal(js, apiJs(), "public/api.js is stale: run node packages/signpage/scripts/api-build.mjs");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(tags, [`<script type="module" src="/api.js" integrity="${integrityOf(js)}" crossorigin="anonymous">`]);
});
