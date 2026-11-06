// deposit.quote through the postMessage API (src/deposit-wire.ts on src/api.ts; card signpage-deposit-quote-wire): each
// answer code as the app gets it, from U's public record, on the H-1c-shaped 1Click mock (./oneclick-mock.ts).
//   node --test test/deposit-wire.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DepositRecord } from "@blindfill/wallet/store";
import { APP_ORIGIN, startApi, signedOutState, type IncomingMessage } from "../src/api.ts";
import { depositQuoteHost, type DepositPublic, type DepositWireDeps } from "../src/deposit-wire.ts";
import { ADDRESS, H72, h1c, NOW, SOL_USDC, U, type Mock } from "./oneclick-mock.ts";

const SCOPE = 7n;
const RECORD: DepositRecord = { v: 1, scope: "7", index: 3, id: U };
const SAVED: DepositPublic = { status: { source: "code", code_saved: true }, deposit: RECORD };
const GOOD = { deposit_address: ADDRESS, origin_asset: SOL_USDC, amount_in: "25", min_amount_out: "24.74208", deadline: new Date(NOW + 30 * 60_000 + H72).toISOString(), time_estimate_s: 20 };

/** A page whose deposit.quote reads `reads` in turn (the last one again once they run out) and asks the mock `mocks` in turn. */
function page(o: { reads?: (DepositPublic | null)[]; mocks?: Mock[]; scope?: bigint | null; named?: () => Promise<unknown> } = {}) {
  const reads = o.reads ?? [SAVED];
  let r = 0;
  const mocks = (o.mocks ?? [{}]).map((m) => h1c(m));
  let f = 0;
  const sent: unknown[] = [];
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    const m = mocks[Math.min(f++, mocks.length - 1)]!;
    sent.push(JSON.parse(String(init?.body)));
    return m.fetch(url, init);
  }) as typeof fetch;
  const deps: DepositWireDeps = {
    scope: () => (o.scope === undefined ? SCOPE : o.scope),
    read: async () => reads[Math.min(r++, reads.length - 1)] ?? null,
    named: o.named,
    fetch: fetchFn,
    now: () => NOW,
    checked: async () => {}, // the follow's op write (src/deposit-follow.ts quoted): ./deposit-follow.test.ts
  };
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => signedOutState(), kinds: { "deposit.quote": depositQuoteHost(deps) } });
  const send = (data: unknown) => listener!({ origin: APP_ORIGIN, source: parent, data });
  return { posted, sent, send, idle: () => api.idle(), reads: () => r };
}

const quote = (id = crypto.randomUUID(), amount = "25") => ({ v: 1, id, type: "deposit.quote", origin_asset: SOL_USDC, amount });
const refused = (id: string, code: string) => ({ v: 1, id, ok: false, error: { code } });

test("ok: the checked address, to U from the public record, as recipient and refundTo", async () => {
  const p = page();
  const q = quote();
  p.send(q);
  await p.idle();
  assert.deepEqual(p.posted.at(-1), { v: 1, id: q.id, ok: true, result: GOOD });
  assert.equal(p.sent.length, 1);
  const req = p.sent[0] as Record<string, unknown>;
  assert.equal(req.recipient, U);
  assert.equal(req.refundTo, U);
  // the same request again: its first answer, no second quote
  p.send(q);
  await p.idle();
  assert.deepEqual(p.posted.at(-1), p.posted.at(-2));
  assert.equal(p.sent.length, 1);
});

test("above_max: over the beta cap, refused before anything is sent", async () => {
  const p = page();
  const q = quote(undefined, "1000.000001");
  p.send(q);
  await p.idle();
  assert.deepEqual(p.posted.at(-1), refused(q.id, "above_max"));
  assert.equal(p.sent.length, 0);
});

test("busy (429) and down (no answer, 503): not kept, so the same request again runs again", async () => {
  for (const [first, code] of [[{ status: 429 }, "busy"], [{ throws: true }, "down"], [{ status: 503 }, "down"]] as const) {
    const p = page({ mocks: [first, {}] });
    const q = quote();
    p.send(q);
    await p.idle();
    assert.deepEqual(p.posted.at(-1), refused(q.id, code), code);
    p.send(q);
    await p.idle();
    assert.deepEqual(p.posted.at(-1), { v: 1, id: q.id, ok: true, result: GOOD }, `${code}: the retry ran`);
    assert.equal(p.sent.length, 2);
  }
});

test("quote_check_failed: an answer that fails a check shows nothing, and is kept for the id", async () => {
  const p = page({ mocks: [{ after: (a) => void (a.quote.depositAddress = "attacker") }, {}] });
  const q = quote();
  p.send(q);
  await p.idle();
  assert.deepEqual(p.posted.at(-1), refused(q.id, "quote_check_failed"));
  p.send(q);
  await p.idle();
  assert.deepEqual(p.posted.at(-1), refused(q.id, "quote_check_failed"));
  assert.equal(p.sent.length, 1, "a refusal that is a no is not run again");
});

test("not_allowed before anything is sent: signed out, no U named, another scope, no vault, the backup gate", async () => {
  const cases: [string, Parameters<typeof page>[0]][] = [
    ["signed out", { reads: [null] }],
    ["no U named yet", { reads: [{ ...SAVED, deposit: undefined }] }],
    ["a record of another scope", { reads: [{ ...SAVED, deposit: { ...RECORD, scope: "8" } }] }],
    ["no vault named on the page's network", { scope: null }],
    ["no status", { reads: [{ ...SAVED, status: undefined }] }],
    ["the 12 words are the only copy", { reads: [{ ...SAVED, status: { source: "random", code_saved: false } }] }],
  ];
  for (const [name, o] of cases) {
    const p = page(o);
    const q = quote();
    p.send(q);
    await p.idle();
    assert.deepEqual(p.posted.at(-1), refused(q.id, "not_allowed"), name);
    assert.equal(p.sent.length, 0, name);
  }
  // a PRF seed needs no backup
  const p = page({ reads: [{ ...SAVED, status: { source: "prf", code_saved: false } }] });
  p.send(quote());
  await p.idle();
  assert.equal((p.posted.at(-1) as { ok: boolean }).ok, true);
});

test("an answer is dropped when the records changed during the wait: signed out, another U, the index moved", async () => {
  for (const [name, after] of [
    ["signed out", null],
    ["another seed's U", { ...SAVED, deposit: { ...RECORD, id: "ab".repeat(32) } }],
    ["the index moved", { ...SAVED, deposit: { ...RECORD, index: 11 } }],
    ["the gate closed (another account)", { ...SAVED, status: { source: "random", code_saved: false } }],
  ] as const) {
    const p = page({ reads: [SAVED, after] });
    const q = quote();
    p.send(q);
    await p.idle();
    assert.deepEqual(p.posted.at(-1), refused(q.id, "not_allowed"), name);
    assert.ok(!JSON.stringify(p.posted).includes(ADDRESS), name);
    assert.equal(p.sent.length, 1, name);
    assert.equal(p.reads(), 2, name);
  }
});

test("the top-level page's naming of U in flight is waited for before the records are read", async () => {
  let done!: () => void;
  const naming = new Promise<void>((ok) => (done = ok));
  const p = page({ named: () => naming });
  const q = quote();
  p.send(q);
  await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(p.reads(), 0, "no read while U is being named");
  done();
  await p.idle();
  assert.deepEqual(p.posted.at(-1), { v: 1, id: q.id, ok: true, result: GOOD });
});

test("params the kit's schema does not allow never reach the handler: not_allowed, no read", async () => {
  const p = page();
  for (const bad of [{ ...quote(), extra: 1 }, { v: 1, id: crypto.randomUUID(), type: "deposit.quote", origin_asset: SOL_USDC }, { ...quote(), amount: 25 }]) p.send(bad);
  await p.idle();
  assert.equal(p.reads(), 0);
  assert.ok(p.posted.slice(1).every((m) => (m as { error?: { code: string } }).error?.code === "not_allowed"));
});

// Card pool-read-down: not_allowed comes only from a rule. A read of the page's records that throws (the store not
// answering) is "down", which api.ts RETRY_CODES does not keep, so the same request again runs again; nothing is asked
// of the helper on it.
test("card pool-read-down: a records read that throws answers down, not kept for its id, and no quote is asked", async () => {
  let throws = true;
  let reads = 0;
  const deps: DepositWireDeps = {
    checked: async () => {},
    scope: () => SCOPE,
    read: async () => {
      reads++;
      if (throws) throw new Error("the store did not answer");
      return SAVED;
    },
    fetch: (() => Promise.reject(new Error("no quote is asked"))) as typeof fetch,
    now: () => NOW,
  };
  const posted: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  let listener: ((e: IncomingMessage) => void) | null = null;
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => signedOutState(), kinds: { "deposit.quote": depositQuoteHost(deps) } });
  const q = quote();
  listener!({ origin: APP_ORIGIN, source: parent, data: q });
  await api.idle();
  assert.deepEqual(posted.at(-1), refused(q.id, "down"));
  assert.equal(reads, 1);
  // asked again: it runs again (a kept answer would be posted again with no read); the helper is down here too (the
  // fetch rejects), so it answers down once more, from the rule
  throws = false;
  listener!({ origin: APP_ORIGIN, source: parent, data: q });
  await api.idle();
  assert.ok(reads >= 2, "read again");
  assert.deepEqual(posted.at(-1), refused(q.id, "down"));
});
