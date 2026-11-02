// index.ts, H3.4 checks 5 and 6 on the nullifier: the spends index read on two providers (fixtures/spends-page.json,
// the vault's SpendView rows, served by fake providers that answer `block` and call_function as nearcore does) and the
// send records in a real store directory. Each test names the rule it holds; the U9 sending cases it covers are s1-s7
// and s8's row rule.
//   node --test apps/helper/src/withdraw/index.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { HELPER_WITHDRAW_CODES, VAULT_FIELD_P } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { RpcError, type Rpc } from "../bind/send.ts";
import {
  INDEX_WAIT_MS,
  MAX_FINAL_AGE_MS,
  MAX_FINAL_GAP,
  SPENDS_PAGE,
  checkNullifier,
  createSpendsIndex,
  createWithdrawSendStore,
  nullifierKey,
  type NullifierDeps,
  type SendClaim,
  type WithdrawSend,
  type WithdrawSendStore,
} from "./index.ts";

type Row = Record<string, unknown> & { index: number; nullifier_hash: string };
const PAGE = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/spends-page.json"), "utf8")) as { spends: Row[] }).spends;
const REQUEST = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/withdraw-request.json"), "utf8")) as { request: { public_signals: string[] } };
/** The fixture request's nullifier (public signal 1): row 1 of the recorded page. */
const NF = BigInt(REQUEST.request.public_signals[1]!);
const OTHER = 99n;
const VAULT = "vault.blindfill.near";
const KEY = "relayer.blindfill.near/ed25519:3tVGPDaZ8ZRqVRdcAh6X5sKfQ2WNSYvvUUzcjZoWm8J3";

const hashOf = (h: number, fork = "") => base58(createHash("sha256").update(`block ${h}${fork}`).digest());

/**
 * One provider over a chain whose spends rows each land at a height (`landed[i]` for row i). It answers `block` at its
 * own final (height, hash and timestamp_nanosec, `ageMs` behind the clock) and `spends` at any height up to it, as
 * nearcore's call_function does: result bytes, block_height, block_hash. `edit` changes a page's rows (a lying or
 * broken provider); `fork` changes its block hashes; `atHeight` the block it answers at.
 */
type Prov = {
  final: number;
  rows: Row[];
  landed: number[];
  edit?: (rows: unknown[], h: number) => unknown[];
  fork?: string;
  atHeight?: (h: number) => number;
  ageMs?: number;
  down?: boolean;
  calls: number;
};
const provider = (p: Prov): Rpc => async (method, params) => {
  p.calls++;
  if (p.down) throw new Error("fetch failed");
  if (method === "block") return { header: { height: p.final, hash: hashOf(p.final, p.fork), timestamp: 0, timestamp_nanosec: (BigInt(Date.now() - (p.ageMs ?? 1_000)) * 1_000_000n).toString() } };
  const q = params as { request_type: string; block_id: number; account_id: string; method_name: string; args_base64: string };
  assert.equal(q.request_type, "call_function");
  assert.equal(q.account_id, VAULT);
  assert.equal(q.method_name, "spends");
  if (q.block_id > p.final) throw new RpcError("query", { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK", info: {} } });
  const { from, limit } = JSON.parse(Buffer.from(q.args_base64, "base64").toString("utf8")) as { from: number; limit: number };
  let rows: unknown[] = p.rows.filter((_, i) => p.landed[i]! <= q.block_id).slice(from, from + Math.min(limit, 1000));
  if (p.edit) rows = p.edit(rows, q.block_id);
  const at = p.atHeight ? p.atHeight(q.block_id) : q.block_id;
  return { result: [...Buffer.from(JSON.stringify(rows))], logs: [], block_height: at, block_hash: hashOf(at, p.fork) };
};
const prov = (final: number, landed: number[] = PAGE.map(() => 10), rows: Row[] = PAGE): Prov => ({ final, rows, landed, calls: 0 });

/** The relayer's nonce counters, as bind's store keeps them: KEY's counter past every nonce these tests sign with. */
const counters = new Map<string, bigint>([[KEY, 1_000n]]);
const keys = { nonceNext: (k: string) => counters.get(k) ?? null };
const tmp = () => mkdtempSync(join(tmpdir(), "withdraw-index-"));
const open = (dir = tmp(), release = 4) => createWithdrawSendStore(dir, { release, keys });
const send = (nf: bigint, over: Partial<SendClaim> = {}): SendClaim => ({
  nullifier: nullifierKey(nf),
  tx_hash: hashOf(1000 + Number(nf % 1000n), over.signed_tx ?? ""),
  nonce: "41",
  height: "100",
  block_hash: hashOf(100),
  signed_tx: "AAAA",
  key: KEY,
  deadline_ms: 1_800_000_000_000,
  ...over,
});
/** The row claim() writes for `c` under `release`. */
const row = (c: SendClaim, release = 4): WithdrawSend => ({ ...c, release, outcome: "open", error: null });
const deps = (provs: [Prov, Prov], store: WithdrawSendStore, waitMs = INDEX_WAIT_MS): NullifierDeps => ({
  index: createSpendsIndex([provider(provs[0]), provider(provs[1])], VAULT, waitMs),
  store,
});
const code = async (nf: bigint, d: NullifierDeps) => {
  const v = await checkNullifier(nf, d);
  return v.ok ? "ok" : v.code;
};

test("the recorded page is the vault's SpendView rows, its row 1 the fixture request's nullifier; every code here is the kit's", () => {
  assert.equal(PAGE[1]!.nullifier_hash, NF.toString());
  assert.equal(BigInt(PAGE[2]!.nullifier_hash), VAULT_FIELD_P - 1n);
  for (const c of ["spent", "index_behind", "in_flight", "withdraw_failed"]) assert.ok((HELPER_WITHDRAW_CODES as readonly string[]).includes(c), c);
  assert.equal(nullifierKey(NF).length, 64);
  assert.equal(nullifierKey(7n), "0".repeat(63) + "7");
  assert.throws(() => nullifierKey(VAULT_FIELD_P), /not a field element/);
});

test("spent: a nullifier the index's pages hold is refused, with no send record; one they do not hold passes", async () => {
  const store = open();
  const d = deps([prov(12), prov(12)], store);
  assert.equal(await code(NF, d), "spent");
  assert.equal(await code(VAULT_FIELD_P - 1n, d), "spent", "the page's last row, p - 1");
  assert.equal(await code(OTHER, d), "ok");
  assert.equal(d.index.at(), 12n);
  store.close();
});

test("spent on a later page: SPENDS_PAGE + 5 rows read page by page, the nullifier on page 2 is found, and the cursor resumes after the last row", async () => {
  const many: Row[] = Array.from({ length: SPENDS_PAGE + 5 }, (_, i) => ({ ...PAGE[0]!, index: i, nullifier_hash: String(1000 + i) }));
  many[SPENDS_PAGE + 2] = { ...many[SPENDS_PAGE + 2]!, nullifier_hash: NF.toString() };
  const a = prov(12, many.map(() => 10), many);
  const b = prov(12, many.map(() => 10), many);
  const store = open();
  const d = deps([a, b], store);
  assert.equal(await code(NF, d), "spent", "on page 2");
  assert.equal(await code(1000n, d), "spent", "on page 1");
  assert.equal(await code(OTHER, d), "ok");
  // one more spend lands at 13: the next read starts at row SPENDS_PAGE + 5, not at 0 and not at the last page's length
  many.push({ ...PAGE[0]!, index: SPENDS_PAGE + 5, nullifier_hash: OTHER.toString() });
  a.landed.push(13);
  b.landed.push(13);
  a.final = b.final = 13;
  const calls = a.calls + b.calls;
  assert.equal(await code(OTHER, d), "spent");
  assert.equal(a.calls + b.calls - calls, 4, "two finals and one page from row SPENDS_PAGE + 5 on each provider");
  assert.equal(d.index.at(), 13n);
  store.close();
});

test("in_flight: an open send record refuses the nullifier while the index does not hold it; a second claim writes nothing", async () => {
  const store = open();
  const d = deps([prov(12), prov(12)], store);
  const first = send(OTHER, { signed_tx: "Zmlyc3Q=" });
  assert.deepEqual(store.claim(first), { ok: true, replaced: null });
  assert.equal(await code(OTHER, d), "in_flight");
  assert.equal(d.index.holds(OTHER), false);
  assert.deepEqual(store.claim(send(OTHER, { signed_tx: "c2Vjb25k" })), { ok: false, code: "in_flight" });
  assert.deepEqual(store.get(OTHER), row(first), "the first bytes stay, the second are dropped");
  store.close();
});

test("the index one block behind the chain while the record is open: in_flight, never a second send (H3.4 check 5's note above H)", async () => {
  // The send landed at 13, final on one provider only; H is the lower final, 12, so the pages read at H lack it.
  const rows = [...PAGE, { ...PAGE[0]!, index: 3, nullifier_hash: OTHER.toString() }];
  const landed = [10, 10, 10, 13];
  const store = open();
  assert.equal(store.claim(send(OTHER)).ok, true);
  const d = deps([prov(13, landed, rows), prov(12, landed, rows)], store);
  assert.equal(await code(OTHER, d), "in_flight");
  assert.equal(d.index.at(), 12n);
  assert.equal(d.index.holds(OTHER), false, "the index is one block behind the spend");
  assert.equal(store.claim(send(OTHER, { signed_tx: "c2Vjb25k" })).ok, false, "no second send");
  store.close();
});

test("s4: the send's success read marks the nullifier spent at once, while the pages are still one block behind; the row is kept", async () => {
  const dir = tmp();
  const store = open(dir);
  const s = send(OTHER);
  store.claim(s);
  const d = deps([prov(12), prov(12)], store);
  assert.equal(await code(OTHER, d), "in_flight", "receipt pending at F: still in flight");
  store.settle(OTHER, s.tx_hash, { kind: "succeeded" });
  assert.equal(d.index.holds(OTHER), false);
  assert.equal(await code(OTHER, d), "spent");
  assert.deepEqual(store.open(), []);
  assert.deepEqual(store.claim(send(OTHER)), { ok: false, code: "spent" }, "a succeeded row is never replaced");
  const down = prov(12);
  down.down = true;
  assert.equal(await code(OTHER, deps([prov(12), down], store)), "spent", "known from the row, with no page read");
  store.close();
  const again = open(dir, 9);
  assert.equal(await code(OTHER, deps([prov(12), prov(12)], again)), "spent", "kept across a restart, whatever the release");
  assert.deepEqual(again.claim(send(OTHER)), { ok: false, code: "spent" });
  again.close();
});

test("settle changes only an open row: on a succeeded or a failed row it throws and keeps the row, so a stale outcome can never free a note", async () => {
  const store = open();
  const d = deps([prov(12), prov(12)], store);
  for (const [nf, first] of [[OTHER, { kind: "succeeded" }], [98n, { kind: "failed", error: "row 11" }]] as const) {
    const s = send(nf);
    store.claim(s);
    store.settle(nf, s.tx_hash, first);
    const kept = store.get(nf);
    for (const later of [{ kind: "never_applied" }, { kind: "deadline" }, { kind: "succeeded" }, { kind: "failed", error: "x" }] as const) {
      assert.throws(() => store.settle(nf, s.tx_hash, later), /no open send record/, `${first.kind} then ${later.kind}`);
      assert.deepEqual(store.get(nf), kept);
    }
    assert.notEqual(await code(nf, d), "ok");
    assert.equal(store.claim(send(nf, { signed_tx: "c2Vjb25k" })).ok, false, "no second send");
  }
  store.close();
});

test("s1, s2: a restart with an open record: it is listed with its stored bytes, the nullifier is in_flight, a resend is refused", async () => {
  const dir = tmp();
  const store = open(dir);
  const s = send(OTHER, { signed_tx: "c3RvcmVk" });
  store.claim(s);
  assert.equal(await code(OTHER, deps([prov(12), prov(12)], store)), "in_flight", "before the restart");
  store.close();
  const after = open(dir);
  assert.deepEqual(after.open(), [OTHER], "the restart's rebroadcast list");
  assert.deepEqual(after.get(OTHER), row(s), "the stored bytes, hash equal");
  assert.equal(await code(OTHER, deps([prov(12), prov(12)], after)), "in_flight", "after the restart");
  assert.deepEqual(after.claim(send(OTHER, { signed_tx: "cmVzZW50" })), { ok: false, code: "in_flight" });
  assert.throws(() => open(dir), /is held by another process/, "one process holds the records");
  after.close();
});

test("s3: two requests for one nullifier at once: both pass the checks (advice), one record write wins, the other writes nothing", async () => {
  const store = open();
  const d = deps([prov(12), prov(12)], store);
  const [a, b] = await Promise.all([code(OTHER, d), code(OTHER, d)]);
  assert.deepEqual([a, b], ["ok", "ok"]);
  const tries = [send(OTHER, { signed_tx: "YQ==" }), send(OTHER, { signed_tx: "Yg==" })];
  const results = await Promise.all(tries.map(async (t) => store.claim(t)));
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  const won = tries[results.findIndex((r) => r.ok)]!;
  assert.deepEqual(store.get(OTHER), row(won));
  assert.deepEqual(results.find((r) => !r.ok), { ok: false, code: "in_flight" });
  assert.equal(await code(OTHER, d), "in_flight");
  store.close();
});

test("the two providers disagreeing on a page decide nothing: index_behind, no row counted, until they agree", async () => {
  const store = open();
  const cases: [string, (b: Prov) => void][] = [
    ["a row missing on one", (b) => (b.edit = (rows) => rows.slice(0, 1))],
    ["a nullifier changed on one", (b) => (b.edit = (rows) => rows.map((r, i) => (i === 1 ? { ...(r as Row), nullifier_hash: "8" } : r)))],
    ["another block hash at the same height", (b) => (b.fork = "x")],
    ["one provider down", (b) => (b.down = true)],
  ];
  for (const [why, spoil] of cases) {
    const b = prov(12);
    spoil(b);
    const d = deps([prov(12), b], store, 300);
    assert.equal(await code(NF, d), "index_behind", why);
    assert.equal(d.index.holds(NF), false, why);
    assert.equal(d.index.at(), null, why);
    assert.equal(await code(OTHER, d), "index_behind", `${why}: not ok either`);
  }
  const b = prov(12);
  b.edit = (rows) => rows.slice(0, 1);
  const d = deps([prov(12), b], store, 300);
  assert.equal(await code(NF, d), "index_behind");
  delete b.edit;
  assert.equal(await code(NF, d), "spent", "once they agree");
  store.close();
});

test("a page answered at another block than the one asked decides nothing, though both providers answer alike", async () => {
  const store = open();
  const a = prov(12);
  const b = prov(12);
  a.atHeight = b.atHeight = (h) => h - 1;
  const d = deps([a, b], store, 300);
  assert.equal(await code(OTHER, d), "index_behind");
  assert.equal(d.index.at(), null);
  store.close();
});

test("a malformed page decides nothing, even when both providers answer it alike (every external input is hostile)", async () => {
  const store = open();
  const bad: [string, (rows: unknown[]) => unknown[]][] = [
    ["a leading zero", (rows) => rows.map((r, i) => (i === 1 ? { ...(r as Row), nullifier_hash: "0" + (r as Row).nullifier_hash } : r))],
    ["a nullifier at p", (rows) => rows.map((r, i) => (i === 2 ? { ...(r as Row), nullifier_hash: VAULT_FIELD_P.toString() } : r))],
    ["a number, not a string", (rows) => rows.map((r, i) => (i === 0 ? { ...(r as Row), nullifier_hash: 7 } : r))],
    ["a row out of its index", (rows) => [rows[1], rows[0], rows[2]]],
    ["more rows than asked", (rows) => [...rows, ...Array.from({ length: SPENDS_PAGE }, (_, i) => ({ ...(rows[0] as Row), index: 3 + i }))]],
    ["not a list", () => ({ spends: [] }) as unknown as unknown[]],
  ];
  for (const [why, edit] of bad) {
    const a = prov(12);
    const b = prov(12);
    a.edit = edit;
    b.edit = edit;
    const d = deps([a, b], store, 300);
    assert.equal(await code(OTHER, d), "index_behind", why);
    assert.equal(d.index.at(), null, why);
  }
  store.close();
});

test("s5, s6: one provider's final 5 blocks ahead of the other's; the index takes the lower: one block behind it reaches it in the wait, at it sends with no wait, 0 index_behind", async () => {
  const store = open();
  const a = prov(17);
  const b = prov(12);
  const d = deps([a, b], store);
  // the index at 11, one block behind the lower final
  b.final = 11;
  a.final = 16;
  assert.equal(await code(OTHER, d), "ok");
  assert.equal(d.index.at(), 11n);
  b.final = 12;
  a.final = 17;
  const t0 = Date.now();
  assert.equal(await code(OTHER, d), "ok", "s5: reaches 12 within the wait");
  assert.ok(Date.now() - t0 < INDEX_WAIT_MS);
  assert.equal(d.index.at(), 12n);
  // s6: at the lower final already: no page read, every request ok
  const calls = a.calls + b.calls;
  const codes = await Promise.all(Array.from({ length: 10 }, () => code(OTHER, d)));
  assert.deepEqual(new Set(codes), new Set(["ok"]));
  assert.equal(a.calls + b.calls - calls, 20, "only the two finals per request");
  store.close();
});

test("a final that stopped freezes no H: finals more than MAX_FINAL_GAP blocks apart, or H's block older than MAX_FINAL_AGE_MS, answer index_behind", async () => {
  assert.equal(MAX_FINAL_GAP, 10n);
  assert.equal(MAX_FINAL_AGE_MS, 30_000n);
  const store = open();
  const run = async (finals: [number, number], ageMs: number) => {
    const a = prov(finals[0]);
    const b = prov(finals[1]);
    a.ageMs = b.ageMs = ageMs;
    return code(OTHER, deps([a, b], store, 300));
  };
  assert.equal(await run([22, 12], 1_000), "ok", "10 apart");
  assert.equal(await run([23, 12], 1_000), "index_behind", "11 apart");
  assert.equal(await run([12, 23], 1_000), "index_behind", "11 apart, the other way");
  assert.equal(await run([12, 12], 29_000), "ok", "29 s old");
  assert.equal(await run([12, 12], 31_000), "index_behind", "31 s old");
  const noTime = prov(12);
  const rpc = provider(noTime);
  const strip: Rpc = async (m, p) => {
    const x = (await rpc(m, p)) as { header?: Record<string, unknown> };
    if (m === "block") delete x.header!.timestamp_nanosec;
    return x;
  };
  const d: NullifierDeps = { index: createSpendsIndex([strip, provider(prov(12))], VAULT, 300), store };
  assert.equal(await code(OTHER, d), "index_behind", "a final with no time");
  store.close();
});

test("s7: a failure under a lower release is carried once by a new record that replaces it; its failure refuses for the rest of that release; one under a higher release is never replaced", async () => {
  const dir = tmp();
  const r3 = open(dir, 3);
  const old = send(OTHER);
  r3.claim(old);
  r3.settle(OTHER, old.tx_hash, { kind: "failed", error: "Smart contract panicked: row 14" });
  assert.equal(await code(OTHER, deps([prov(12), prov(12)], r3)), "withdraw_failed", "under the same release");
  assert.deepEqual(r3.claim(send(OTHER, { signed_tx: "c2FtZQ==" })), { ok: false, code: "withdraw_failed" });
  r3.close();

  const r4 = open(dir, 4); // the old helper stopped, the next release started
  const d4 = deps([prov(12), prov(12)], r4);
  assert.equal(await code(OTHER, d4), "ok", "the next release carries it");
  const carried = send(OTHER, { signed_tx: "bmV3" });
  const r = r4.claim(carried);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.replaced, { ...row(old, 3), outcome: "failed", error: "Smart contract panicked: row 14" });
  assert.deepEqual(r4.get(OTHER), row(carried, 4), "stamped with the running release");
  assert.deepEqual(r4.open(), [OTHER], "the replacing row is open for the rounds");
  assert.equal(await code(OTHER, d4), "in_flight");
  assert.deepEqual(r4.claim(send(OTHER, { signed_tx: "dGhpcmQ=" })), { ok: false, code: "in_flight" }, "carried once");
  r4.settle(OTHER, carried.tx_hash, { kind: "failed", error: "again" });
  assert.equal(await code(OTHER, d4), "withdraw_failed");
  assert.deepEqual(r4.claim(send(OTHER)), { ok: false, code: "withdraw_failed" });

  const OLDER = 98n;
  r4.close();
  const r5 = open(dir, 5);
  const high = send(OLDER);
  r5.claim(high);
  r5.settle(OLDER, high.tx_hash, { kind: "failed", error: "x" });
  r5.close();
  const back = open(dir, 4); // an older build run again
  assert.equal(await code(OLDER, deps([prov(12), prov(12)], back)), "withdraw_failed");
  assert.deepEqual(back.claim(send(OLDER)), { ok: false, code: "withdraw_failed" }, "not replaced");
  assert.equal((back.get(OLDER) as WithdrawSend).release, 5);
  back.close();
});

test("s8's row rule: a deadline failure or a send never applied deletes the row and frees the note; a stale outcome changes nothing", async () => {
  const store = open();
  const d = deps([prov(12), prov(12)], store);
  for (const kind of ["deadline", "never_applied"] as const) {
    const s = send(OTHER, { signed_tx: kind === "deadline" ? "ZA==" : "bg==" });
    assert.equal(store.claim(s).ok, true, kind);
    assert.throws(() => store.settle(OTHER, hashOf(5), { kind: "succeeded" }), /no open send record/, "another hash");
    assert.equal(await code(OTHER, d), "in_flight");
    store.settle(OTHER, s.tx_hash, { kind });
    assert.equal(store.get(OTHER), null, kind);
    assert.deepEqual(store.open(), []);
    assert.equal(await code(OTHER, d), "ok", kind);
    assert.throws(() => store.settle(OTHER, s.tx_hash, { kind: "succeeded" }), /no open send record/, "settled once");
  }
  store.close();
});

test("an unreadable send record is held as open: in_flight, never replaced, listed for the rounds, also after a restart", async () => {
  const dir = tmp();
  const store = open(dir);
  writeFileSync(join(dir, `w-${nullifierKey(OTHER)}.json`), '{"nullifier":');
  assert.equal(store.get(OTHER), "unreadable");
  assert.equal(await code(OTHER, deps([prov(12), prov(12)], store)), "in_flight");
  store.close();
  const after = open(dir, 99);
  assert.deepEqual(after.claim(send(OTHER)), { ok: false, code: "in_flight" }, "not even by a higher release");
  assert.deepEqual(after.open(), [OTHER]);
  // a row naming another nullifier than its file's name is unreadable too
  writeFileSync(join(dir, `w-${nullifierKey(OTHER + 1n)}.json`), JSON.stringify(row(send(OTHER))));
  assert.equal(after.get(OTHER + 1n), "unreadable");
  after.close();
});

test("claim stamps the store's release, an open outcome and no error, whatever the signer passes; the nullifier is keyed by its value", () => {
  const store = open(tmp(), 4);
  const forged = { ...send(OTHER), release: 99, outcome: "succeeded", error: "x" } as unknown as SendClaim;
  assert.equal(store.claim(forged).ok, true);
  const got = store.get(OTHER) as WithdrawSend;
  assert.deepEqual([got.release, got.outcome, got.error], [4, "open", null]);
  assert.equal(store.release, 4);
  assert.throws(() => store.claim({ ...send(0xabn), nullifier: nullifierKey(0xabn).toUpperCase() }), /not an open send record/);
  assert.equal(store.get(BigInt(`0x${"0".repeat(62)}63`)) !== null, true, "99 by any route is one row");
  assert.throws(() => open(tmp(), 0), /release/);
  assert.throws(() => open(tmp(), 1.5), /release/);
  store.close();
});

test("claim refuses unless the key's nonce counter is past the record's nonce, writing nothing (a record never holds a nonce another signer can still take)", () => {
  const store = open();
  const other = "relayer.blindfill.near/ed25519:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  assert.throws(() => store.claim(send(OTHER, { key: other })), /nonce counter/, "no counter for the key");
  counters.set(other, 41n);
  assert.throws(() => store.claim(send(OTHER, { key: other, nonce: "41" })), /nonce counter/, "the counter at n: n is not taken yet");
  assert.throws(() => store.claim(send(OTHER, { key: other, nonce: "45" })), /nonce counter/, "the counter below n");
  assert.equal(store.get(OTHER), null);
  assert.deepEqual(store.open(), []);
  counters.set(other, 42n);
  assert.equal(store.claim(send(OTHER, { key: other, nonce: "41" })).ok, true, "the counter at n + 1");
  store.close();
});

test("the settle record: kept on a succeeded row across restarts until done; refused on an open row, for a second open settle, and unless the key's counter is past its nonce; a malformed one reads unreadable", () => {
  const dir = tmp();
  let store = open(dir);
  const c = send(NF);
  assert.deepEqual(store.claim(c), { ok: true, replaced: null });
  const tx = { tx_hash: hashOf(7001), nonce: "42", height: "101", block_hash: hashOf(101), signed_tx: "BBBB", key: KEY };
  assert.throws(() => store.setSettle(NF, { tx, done: false }), /no succeeded send record/, "an open row takes no settle");
  store.settle(NF, c.tx_hash, { kind: "succeeded" });
  assert.deepEqual(store.toSettle(), [NF]);
  assert.throws(() => store.setSettle(NF, { tx: { ...tx, nonce: "1000" }, done: false }), /nonce counter/);
  store.setSettle(NF, { tx, done: false });
  assert.throws(() => store.setSettle(NF, { tx: { ...tx, tx_hash: hashOf(7002) }, done: false }), /still open/);
  store.close();
  store = open(dir); // a restart: the open settle is read back and still to do
  assert.deepEqual(store.toSettle(), [NF]);
  assert.deepEqual((store.get(NF) as WithdrawSend).settle, { tx, done: false });
  store.setSettle(NF, null); // never landed: cleared, signed again next round
  store.setSettle(NF, { tx: null, done: true }); // another caller settled it
  assert.deepEqual(store.toSettle(), []);
  assert.throws(() => store.setSettle(NF, null), /already settled/);
  store.close();
  store = open(dir);
  assert.deepEqual(store.toSettle(), []);
  assert.equal(store.get(NF) === "unreadable", false);
  store.close();
  // a settle field of any other form makes the row unreadable (held as open), never a settled one
  const bad = tmp();
  writeFileSync(join(bad, `w-${nullifierKey(OTHER)}.json`), JSON.stringify({ ...row(send(OTHER)), outcome: "succeeded", settle: { tx: null, done: false } }));
  store = open(bad);
  assert.equal(store.get(OTHER), "unreadable");
  assert.deepEqual(store.open(), [OTHER]);
  store.close();
});

test("the spends index keeps each nullifier's row in the vault's list", async () => {
  const store = open();
  const d = deps([prov(12), prov(12)], store);
  assert.equal(d.index.indexOf(NF), null, "nothing read yet");
  assert.equal(await code(OTHER, d), "ok");
  assert.equal(d.index.indexOf(NF), 1);
  assert.equal(d.index.indexOf(VAULT_FIELD_P - 1n), 2);
  assert.equal(d.index.indexOf(OTHER), null);
  store.close();
});
