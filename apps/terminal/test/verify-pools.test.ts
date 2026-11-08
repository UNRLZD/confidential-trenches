// Verify's pool rows (card verify-pools) on recorded reads: test/verify/pool-reads.json is each mainnet pool read on its
// pair as release.ts names it, by test/verify/record-pools.ts. Every bad case is that recording with one answer
// planted: an upgrade authority, an owner, a proxy slot or another code turns its row red; two RPCs that disagree, or
// one that did not answer, turn the check amber (neither ok nor danger).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EIP1967, livePools, poolExplorers, poolRow, readPool, unverifiedPoolRow, type PoolPin, type PoolReads, type PoolRow } from "../src/screens/verify/pools.ts";
import { VERIFY_RELEASES } from "../src/screens/verify/release.ts";

const REC = JSON.parse(readFileSync(new URL("./verify/pool-reads.json", import.meta.url), "utf8")) as Record<"solana" | "base" | "robinhood", PoolReads>;
const PINS = VERIFY_RELEASES.mainnet.pools;
const pin = <C extends "solana" | "base" | "robinhood">(c: C) => PINS[c] as PoolPin;
const clone = (c: keyof typeof REC): PoolReads => JSON.parse(JSON.stringify(REC[c]));
const status = (r: PoolRow) => [r.status, Object.fromEntries(r.checks.map((c) => [c.id, `${c.status}${c.word ? ` ${c.word}` : ""}`]))];
const row = (c: keyof typeof REC, plant?: (r: PoolReads) => void) => {
  const r = clone(c);
  plant?.(r);
  return poolRow(r, pin(c));
};
// the programdata's bytes on one RPC's answer, rewritten by `f`
function plantPd(r: PoolReads, f: (b: Buffer) => void, on = [0, 1]) {
  for (const i of on) {
    const v = (r.rpcs[i]!.answers.accounts as any).result.value[1];
    const b = Buffer.from(v.data[0], "base64");
    f(b);
    v.data[0] = b.toString("base64");
  }
}
const word = (w: string) => `0x${w.padStart(64, "0")}`;
const on2 = (r: PoolReads, id: string, f: (a: any) => void, on = [0, 1]) => on.forEach((i) => f((r.rpcs[i]!.answers as any)[id]));

test("the recorded mainnet reads: every pool row ok, each check ok", async () => {
  assert.deepEqual(status(await row("solana")), ["ok", { authority: "ok", poolCode: "ok" }]);
  for (const c of ["base", "robinhood"] as const) assert.deepEqual(status(await row(c)), ["ok", { owner: "ok", proxy: "ok", poolCode: "ok" }], c);
  const s = await row("solana");
  assert.deepEqual(s.checks[0]!.values, [{ k: "authority", v: "—" }]);
  assert.deepEqual(s.rpcs, ["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network"]);
  assert.match(s.height, /^\d{1,3}(,\d{3})+$/);
  assert.deepEqual(s.explorers.map((e) => e.href), ["https://solscan.io/account/EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", "https://explorer.solana.com/address/EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF"]);
  assert.deepEqual((await row("base")).explorers.map((e) => e.href), ["https://basescan.org/address/0xaa080e74ec99cf5c684548c77ca145edfcf899cf", "https://base.blockscout.com/address/0xaa080e74ec99cf5c684548c77ca145edfcf899cf"]);
  assert.deepEqual(poolExplorers("robinhood", "0x9306359433127c4f3be426f6faeb00a3c41f66db").map((e) => e.href), ["https://robinhoodchain.blockscout.com/address/0x9306359433127c4f3be426f6faeb00a3c41f66db", "https://hoodscan.co/address/0x9306359433127c4f3be426f6faeb00a3c41f66db"]);
});

test("Solana: a planted upgrade authority turns the row red, its key shown", async () => {
  const r = await row("solana", (x) => plantPd(x, (b) => { b[12] = 1; b.fill(7, 13, 45); }));
  assert.deepEqual(status(r), ["danger", { authority: "danger", poolCode: "ok" }]);
  assert.notEqual(r.checks[0]!.values[0]!.v, "—");
});

test("Solana: another code (a byte changed, a byte after the code, a program pointing elsewhere) turns the code check red", async () => {
  assert.deepEqual(status(await row("solana", (x) => plantPd(x, (b) => { b[45 + 100] ^= 1; }))), ["danger", { authority: "ok", poolCode: "danger" }]);
  assert.deepEqual(status(await row("solana", (x) => plantPd(x, (b) => { b[b.length - 1] = 1; }))), ["danger", { authority: "ok", poolCode: "danger" }]);
  const elsewhere = await row("solana", (x) => [0, 1].forEach((i) => {
    const v = (x.rpcs[i]!.answers.accounts as any).result.value[0];
    const b = Buffer.from(v.data[0], "base64");
    b[10] ^= 1;
    v.data[0] = b.toString("base64");
  }));
  assert.deepEqual(status(elsewhere), ["danger", { authority: "ok", poolCode: "danger" }]);
});

test("EVM: a planted owner, a proxy slot or another code hash each turns its row red", async () => {
  for (const c of ["base", "robinhood"] as const) {
    const owned = await row(c, (x) => on2(x, "owner", (a) => { delete a.error; a.result = word("1111111111111111111111111111111111111111"); }));
    assert.deepEqual(status(owned), ["danger", { owner: "danger", proxy: "ok", poolCode: "ok" }], `${c} owner`);
    assert.equal(owned.checks[0]!.values[0]!.v, "0x1111…111111");
    for (const slot of ["implementation", "admin", "beacon"] as const) {
      const proxied = await row(c, (x) => on2(x, slot, (a) => (a.result = word("22".repeat(20)))));
      assert.deepEqual(status(proxied), ["danger", { owner: "ok", proxy: "danger", poolCode: "ok" }], `${c} ${slot}`);
    }
    const other = await row(c, (x) => on2(x, "code", (a) => (a.result = `${a.result.slice(0, -2)}${a.result.slice(-2) === "00" ? "01" : "00"}`)));
    assert.deepEqual(status(other), ["danger", { owner: "ok", proxy: "ok", poolCode: "danger" }], `${c} code`);
    const none = await row(c, (x) => on2(x, "code", (a) => (a.result = "0x")));
    assert.deepEqual(status(none), ["danger", { owner: "ok", proxy: "ok", poolCode: "danger" }], `${c} no code`);
  }
});

test("an owner() of zero, or one that answers 0x, is no owner", async () => {
  assert.deepEqual(status(await row("base", (x) => on2(x, "owner", (a) => { delete a.error; a.result = word("0"); }))), ["ok", { owner: "ok", proxy: "ok", poolCode: "ok" }]);
  assert.deepEqual(status(await row("base", (x) => on2(x, "owner", (a) => { delete a.error; a.result = "0x"; }))), ["ok", { owner: "ok", proxy: "ok", poolCode: "ok" }]);
});

test("two RPCs that disagree: the check is neither ok nor danger but amber, RPCs disagree, each RPC's answer named", async () => {
  const owner = await row("base", (x) => on2(x, "owner", (a) => { delete a.error; a.result = word("33".repeat(20)); }, [1]));
  assert.deepEqual(status(owner), ["warn", { owner: "warn disagree", proxy: "ok", poolCode: "ok" }]);
  assert.deepEqual(owner.checks[0]!.values.map((v) => v.rpc), ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]);
  const auth = await row("solana", (x) => plantPd(x, (b) => { b[12] = 1; }, [0]));
  assert.deepEqual(status(auth), ["warn", { authority: "warn disagree", poolCode: "ok" }]);
  const code = await row("robinhood", (x) => on2(x, "code", (a) => (a.result = "0x00"), [0]));
  assert.deepEqual(status(code), ["warn", { owner: "ok", proxy: "ok", poolCode: "warn disagree" }]);
  // two block hashes at the one height: every check disagrees
  const fork = await row("base", (x) => on2(x, "block", (a) => (a.result.hash = word("44".repeat(32))), [1]));
  assert.deepEqual(status(fork), ["warn", { owner: "warn disagree", proxy: "warn disagree", poolCode: "warn disagree" }]);
});

test("one RPC that did not answer, or answered another block: Unverified on its checks, amber", async () => {
  const down = await row("robinhood", (x) => on2(x, "owner", (a) => { for (const k of Object.keys(a)) delete a[k]; a.error = "fetch failed"; }, [1]));
  assert.deepEqual(status(down), ["warn", { owner: "warn unverified", proxy: "ok", poolCode: "ok" }]);
  // a JSON-RPC error that is not a revert is no answer about owner()
  const odd = await row("base", (x) => on2(x, "owner", (a) => (a.error = { code: -32000, message: "header not found" }), [0]));
  assert.deepEqual(status(odd), ["warn", { owner: "warn unverified", proxy: "ok", poolCode: "ok" }]);
  const other = await row("base", (x) => on2(x, "block", (a) => (a.result.number = "0x1"), [0]));
  assert.deepEqual(status(other), ["warn", { owner: "warn unverified", proxy: "warn unverified", poolCode: "warn unverified" }]);
  const sol = await row("solana", (x) => ((x.rpcs[1]!.answers as any).accounts = { error: "HTTP 429" }));
  assert.deepEqual(status(sol), ["warn", { authority: "warn unverified", poolCode: "warn unverified" }]);
  assert.deepEqual(status(unverifiedPoolRow("base", null, [])), ["warn", { owner: "warn unverified", proxy: "warn unverified", poolCode: "warn unverified" }]);
});

test("readPool: an EVM pool is read at the lower head on both RPCs, every read at that block; Solana at finalized", async () => {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    calls.push({ url, method, params });
    const result = method === "eth_blockNumber" ? (url.includes("publicnode") ? "0x64" : "0x65") : method === "getMultipleAccounts" ? { context: { slot: 1 }, value: [null, null] } : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "verify", result }), { status: 200 });
  }) as typeof fetch;
  const v = await livePools(PINS, fetchFn);
  assert.equal(v.state, "read");
  const base = calls.filter((c) => c.url.includes("base"));
  assert.deepEqual(new Set(base.map((c) => c.url)), new Set(PINS.base!.rpcs));
  for (const c of base.filter((x) => x.method !== "eth_blockNumber")) assert.equal(c.method === "eth_getBlockByNumber" ? c.params[0] : c.params.at(-1), "0x64", `${c.method} at the lower head`);
  assert.deepEqual(base.filter((c) => c.method === "eth_getStorageAt").map((c) => c.params[1]).sort(), [EIP1967.admin, EIP1967.beacon, EIP1967.implementation, EIP1967.admin, EIP1967.beacon, EIP1967.implementation].sort());
  const sol = calls.filter((c) => c.method === "getMultipleAccounts");
  assert.deepEqual(sol.map((c) => c.url), [...PINS.solana!.rpcs]);
  assert.deepEqual(sol[0]!.params, [[(PINS.solana!.pin as any).program, (PINS.solana!.pin as any).programdata], { encoding: "base64", commitment: "finalized" }]);
  // no pool is read through anything but its pair: no helper, no other host
  const hosts = new Set(calls.map((c) => new URL(c.url).host));
  assert.deepEqual([...hosts].sort(), [...new Set(Object.values(PINS).flatMap((p) => p!.rpcs.map((u) => new URL(u).host)))].sort());
  await assert.rejects(readPool(pin("base"), async () => ({ error: "down" })), /no head/);
});

test("the testnet build names no pool: every row Unverified, nothing asked", async () => {
  let asked = 0;
  const v = await livePools(VERIFY_RELEASES.testnet.pools, (async () => (asked++, new Response("{}"))) as unknown as typeof fetch);
  assert.equal(asked, 0);
  assert.ok(v.state === "read" && v.rows.every((r) => r.status === "warn" && r.rpcs.length === 0 && r.checks.every((c) => c.word === "unverified")));
});
