// Verify's pool rows (card verify-pools) on recorded reads: test/verify/pool-reads.json is each mainnet pool read on its
// pair as release.ts names it, by test/verify/record-pools.ts. Every bad case is that recording with one answer
// planted: an upgrade authority, an owner, a proxy slot or another code turns its row red; two RPCs that disagree, or
// one that did not answer, turn the check amber (neither ok nor danger).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EIP1967, forgetPoolWalks, livePools, poolExplorers, poolRow, readPool, unverifiedPoolRow, type PoolPin, type PoolReads, type PoolRow } from "../src/screens/verify/pools.ts";
import { VERIFY_RELEASES } from "../src/screens/verify/release.ts";
import { evmPoolVenues, evmReadProvidersOf } from "@blindfill/kit";

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
    // a block read answers a block (a seat with no block at the height asked is walked past)
    const result = method === "eth_blockNumber" ? (url.includes("publicnode") ? "0x64" : "0x65") : method === "getMultipleAccounts" ? { context: { slot: 1 }, value: [null, null] } : method === "eth_getBlockByNumber" ? { number: params[0], hash: `0x${"ab".repeat(32)}` } : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "verify", result }), { status: 200 });
  }) as typeof fetch;
  const v = await livePools(PINS, fetchFn);
  assert.equal(v.state, "read");
  const base = calls.filter((c) => c.url.includes("base"));
  // two operators of the list, the first two, both answering: no other asked
  assert.deepEqual(new Set(base.map((c) => c.url)), new Set(PINS.base!.rpcs.slice(0, 2)));
  for (const c of base.filter((x) => x.method !== "eth_blockNumber")) assert.equal(c.method === "eth_getBlockByNumber" ? c.params[0] : c.params.at(-1), "0x64", `${c.method} at the lower head`);
  assert.deepEqual(base.filter((c) => c.method === "eth_getStorageAt").map((c) => c.params[1]).sort(), [EIP1967.admin, EIP1967.beacon, EIP1967.implementation, EIP1967.admin, EIP1967.beacon, EIP1967.implementation].sort());
  const sol = calls.filter((c) => c.method === "getMultipleAccounts");
  // two operators of Solana's list too, the first two, both answering: the spare not asked
  assert.deepEqual(new Set(sol.map((c) => c.url)), new Set(PINS.solana!.rpcs.slice(0, 2)));
  assert.deepEqual(sol[0]!.params, [[(PINS.solana!.pin as any).program, (PINS.solana!.pin as any).programdata], { encoding: "base64", commitment: "finalized" }]);
  // no pool is read through anything but its pair: no helper, no other host
  const hosts = new Set(calls.map((c) => new URL(c.url).host));
  assert.deepEqual([...hosts].sort(), [...new Set(Object.values(PINS).flatMap((p) => p!.rpcs.slice(0, 2).map((u) => new URL(u).host)))].sort());
  await assert.rejects(readPool(pin("base"), async () => ({ error: "down" })), /no head/);
});

// An RPC that does not answer is a screen state, as on the NEAR pair (live.ts, readVerify): one RPC of a pair down
// draws its checks Unverified and our code logs nothing; only a pool with no head on either RPC logs its reason, once,
// as the NEAR pair logs "no final height on either RPC".
test("one RPC of each pair down: every row amber, nothing logged; both of an EVM pair down: Unverified, its reason logged once", async () => {
  const ids: Record<string, string> = { getMultipleAccounts: "accounts", eth_getBlockByNumber: "block", eth_getCode: "code", eth_call: "owner" };
  const slot = (p: unknown[]) => (Object.keys(EIP1967) as (keyof typeof EIP1967)[]).find((k) => EIP1967[k] === p[1])!;
  const replay = (down: (url: string) => boolean) =>
    (async (url: string, init: RequestInit) => {
      if (down(url)) throw new TypeError("Failed to fetch");
      const { method, params } = JSON.parse(String(init.body));
      // every seat of a chain's list answers that chain's recording (its two recorded seats agree)
      const c = (Object.keys(PINS) as (keyof typeof REC)[]).find((k) => PINS[k]!.rpcs.includes(url))!;
      const rec = REC[c].rpcs.find((x) => x.name === url) ?? REC[c].rpcs[0]!;
      const answer = method === "eth_blockNumber" ? { jsonrpc: "2.0", id: "verify", result: `0x${REC[c].height!.toString(16)}` } : (rec.answers as any)[ids[method] ?? slot(params)];
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
  const logged: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    // card device-evm-fee-read-walks-operators: an EVM row walks its list to two other operators and stays ok, naming
    // them; since card verify-row-survives-one-provider Solana's list has a spare and does the same
    for (const side of [0, 1]) {
      forgetPoolWalks();
      const firsts = new Set(Object.values(PINS).map((p) => p!.rpcs[side]));
      const v = await livePools(PINS, replay((u) => firsts.has(u)));
      assert.ok(v.state === "read");
      assert.deepEqual(v.rows.map((r) => r.status), ["ok", "ok", "ok"], `side ${side} down`);
      for (const r of v.rows) assert.ok(r.rpcs.length === 2 && !r.rpcs.some((x) => firsts.has(x)) && r.rpcs[0] !== r.rpcs[1], `side ${side} down: ${r.rpcs}`);
      assert.deepEqual(logged, [], `side ${side} down: nothing logged`);
    }
    const base = new Set(PINS.base!.rpcs);
    const v = await livePools(PINS, replay((u) => base.has(u)));
    assert.ok(v.state === "read");
    assert.deepEqual(v.rows.map((r) => r.status), ["ok", "warn", "ok"]);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /^Verify read no head on two of mainnet\.base\.org, base-rpc\.publicnode\.com, base\.api\.pocket\.network, base\.gateway\.tenderly\.co$/);
  } finally {
    console.error = was;
  }
});

// card device-evm-fee-read-walks-operators: robinhood.drpc.org answered every Verify read HTTP 400 code 27 "Unknown
// state" on 10 Nov (app live run 42895457692), and the row was Unverified; an operator that refuses every read is
// walked past, and the row is read on two others
test("the list's first operator answers HTTP 400 \"Unknown state\" to every read: each EVM row is ok on two other operators", async () => {
  const blind = new Set(["base", "robinhood"].map((c) => PINS[c as "base"]!.rpcs[0]!));
  const ids: Record<string, string> = { eth_getBlockByNumber: "block", eth_getCode: "code", eth_call: "owner", getMultipleAccounts: "accounts" };
  const slot = (p: unknown[]) => (Object.keys(EIP1967) as (keyof typeof EIP1967)[]).find((k) => EIP1967[k] === p[1])!;
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (blind.has(url)) return new Response(JSON.stringify({ error: { message: "Unknown state. First available state is 1", code: 27 } }), { status: 400 });
    const { method, params } = JSON.parse(String(init.body));
    const c = (Object.keys(PINS) as (keyof typeof REC)[]).find((k) => PINS[k]!.rpcs.includes(url))!;
    const answer = method === "eth_blockNumber" ? { jsonrpc: "2.0", id: "verify", result: `0x${REC[c].height!.toString(16)}` } : (REC[c].rpcs[0]!.answers as any)[ids[method] ?? slot(params)];
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  const v = await livePools(PINS, fetchFn);
  assert.ok(v.state === "read");
  for (const r of v.rows.filter((x) => x.chain !== "solana")) {
    assert.equal(r.status, "ok", `${r.chain}: ${JSON.stringify(r.checks)}`);
    assert.ok(r.rpcs.length === 2 && r.rpcs.every((x) => !blind.has(x)), `${r.chain}: ${r.rpcs}`);
  }
});

// independent review of the walk (P3-2, P3-4, P3-6): the live refusals were HTTP 200 carrying an error object; a seat with
// no block at the height, a revert on any read but owner(), and one operator's far-off head are walked past too
const recorded = (url: string, init: RequestInit, over?: (method: string, params: unknown[]) => unknown) => {
  const ids: Record<string, string> = { eth_getBlockByNumber: "block", eth_getCode: "code", eth_call: "owner" };
  const slot = (p: unknown[]) => (Object.keys(EIP1967) as (keyof typeof EIP1967)[]).find((k) => EIP1967[k] === p[1])!;
  const { method, params } = JSON.parse(String(init.body));
  const o = over?.(method, params);
  if (o !== undefined) return new Response(JSON.stringify(o), { status: 200 });
  const c = (Object.keys(PINS) as (keyof typeof REC)[]).find((k) => PINS[k]!.rpcs.includes(url))!;
  const answer = method === "eth_blockNumber" ? { jsonrpc: "2.0", id: "verify", result: `0x${REC[c].height!.toString(16)}` } : (REC[c].rpcs[0]!.answers as any)[ids[method] ?? slot(params)];
  return new Response(JSON.stringify(answer), { status: 200 });
};
for (const [name, bad] of [
  ["HTTP 200 with dRPC's code 27", (m: string) => (m === "eth_blockNumber" ? undefined : { jsonrpc: "2.0", id: "verify", error: { code: 27, message: "Unknown state. First available state is 1" } })],
  ["HTTP 200 with a pruned node's -32000", (m: string) => (m === "eth_getCode" ? { jsonrpc: "2.0", id: "verify", error: { code: -32000, message: "historical state 0xab is not available" } } : undefined)],
  ["no block at the height (null)", (m: string) => (m === "eth_getBlockByNumber" ? { jsonrpc: "2.0", id: "verify", result: null } : undefined)],
  ["a revert on eth_getCode", (m: string) => (m === "eth_getCode" ? { jsonrpc: "2.0", id: "verify", error: { code: 3, message: "execution reverted" } } : undefined)],
] as const) {
  test(`one operator answers ${name}: walked past, each EVM row ok on two others`, async () => {
    forgetPoolWalks();
    const blind = new Set(["base", "robinhood"].flatMap((c) => PINS[c as "base"]!.rpcs.slice(0, 2)));
    // every first-two seat is bad, so whichever two a rest put first, the row stands on the other two
    const v = await livePools(PINS, (async (url: string, init: RequestInit) => recorded(url, init, blind.has(url) ? bad : undefined)) as typeof fetch);
    assert.ok(v.state === "read");
    for (const r of v.rows.filter((x) => x.chain !== "solana")) {
      assert.equal(r.status, "ok", `${r.chain}: ${JSON.stringify(r.checks)}`);
      assert.ok(r.rpcs.every((x) => !blind.has(x)), `${r.chain}: ${r.rpcs}`);
    }
  });
}

test("owner()'s revert is the honest answer there: every seat reverting it, the row still reads ok", async () => {
  forgetPoolWalks();
  const v = await livePools(PINS, (async (url: string, init: RequestInit) => recorded(url, init, (m) => (m === "eth_call" ? { jsonrpc: "2.0", id: "verify", error: { code: 3, message: "execution reverted" } } : undefined))) as typeof fetch);
  assert.ok(v.state === "read");
  for (const r of v.rows.filter((x) => x.chain !== "solana")) assert.equal(r.status, "ok", `${r.chain}: ${JSON.stringify(r.checks)}`);
});

test("one operator names head 1: walked past, never the height; two heads still far apart: Unverified, never danger", async () => {
  forgetPoolWalks();
  const liar = new Set(["base", "robinhood"].map((c) => PINS[c as "base"]!.rpcs[0]!));
  const head1 = (m: string) => (m === "eth_blockNumber" ? { jsonrpc: "2.0", id: "verify", result: "0x1" } : undefined);
  const v = await livePools(PINS, (async (url: string, init: RequestInit) => recorded(url, init, liar.has(url) ? head1 : undefined)) as typeof fetch);
  assert.ok(v.state === "read");
  for (const r of v.rows.filter((x) => x.chain !== "solana")) {
    assert.equal(r.status, "ok", `${r.chain}: ${JSON.stringify(r.checks)}`);
    assert.notEqual(r.height, 1);
  }
  // every seat but one names head 1: no two close heads, so Unverified with no danger
  const all = new Set(["base", "robinhood"].flatMap((c) => PINS[c as "base"]!.rpcs.slice(1)));
  forgetPoolWalks();
  const w = await livePools(PINS, (async (url: string, init: RequestInit) => recorded(url, init, all.has(url) ? head1 : undefined)) as typeof fetch);
  assert.ok(w.state === "read");
  for (const r of w.rows.filter((x) => x.chain !== "solana")) {
    assert.equal(r.status, "warn", `${r.chain}: ${r.status}`);
    assert.ok(r.checks.every((c) => c.status !== "danger" && c.word === "unverified"));
    assert.equal(r.rpcs.length, 2);
  }
});

test("each EVM row's list is the kit's read list", () => {
  const v = evmPoolVenues();
  assert.deepEqual(PINS.base!.rpcs, evmReadProvidersOf(v.base!));
  assert.deepEqual(PINS.robinhood!.rpcs, evmReadProvidersOf(v.robinhood!));
});

test("the testnet build names no pool: every row Unverified, nothing asked", async () => {
  let asked = 0;
  const v = await livePools(VERIFY_RELEASES.testnet.pools, (async () => (asked++, new Response("{}"))) as unknown as typeof fetch);
  assert.equal(asked, 0);
  assert.ok(v.state === "read" && v.rows.every((r) => r.status === "warn" && r.rpcs.length === 0 && r.checks.every((c) => c.word === "unverified")));
});

// card verify-row-survives-one-provider: solana.api.pocket.network answered the page's getMultipleAccounts HTTP 400 in
// two app live runs in a row (12 Nov, run 43314363472, from GitHub's runners; the same request answered 200 from the
// Mac), and the Solana row read Unverified, a fixed pair with no spare. Solana's list now walks as the EVM lists do: a
// refusing operator is walked past to the spare, and the row is still read on two operators' agreeing answers.
test("Solana: one provider answers HTTP 400 to the accounts read: the row is ok on the two others, nothing logged", async () => {
  forgetPoolWalks();
  const sol = PINS.solana!.rpcs;
  assert.ok(sol.length >= 3, `Solana's list names a spare: ${sol}`);
  for (const refused of sol.slice(0, 2)) {
    forgetPoolWalks();
    const asked: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      if (method !== "getMultipleAccounts") return new Response("{}", { status: 503 });
      asked.push(url);
      if (url === refused) return new Response("", { status: 400 });
      return new Response(JSON.stringify(REC.solana.rpcs[0]!.answers.accounts), { status: 200 });
    }) as typeof fetch;
    const logged: string[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    let r: PoolRow;
    try {
      r = (await livePools({ solana: PINS.solana, base: null, robinhood: null }, fetchFn)).rows[0]!;
    } finally {
      console.error = was;
    }
    assert.deepEqual(status(r), ["ok", { authority: "ok", poolCode: "ok" }], `${refused} refused`);
    assert.ok(r.rpcs.length === 2 && !r.rpcs.includes(refused) && r.rpcs[0] !== r.rpcs[1], `${refused} refused: read on ${r.rpcs}`);
    assert.ok(asked.includes(sol[2]!), `${refused} refused: the spare was asked`);
    assert.deepEqual(logged, []);
  }
});

test("Solana: two providers that disagree are never turned into agreement by the spare", async () => {
  forgetPoolWalks();
  const sol = PINS.solana!.rpcs;
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(url);
    const a = JSON.parse(JSON.stringify(REC.solana.rpcs[0]!.answers.accounts));
    if (url === sol[1]) {
      const v = a.result.value[1];
      const b = Buffer.from(v.data[0], "base64");
      b[12] = 1;
      v.data[0] = b.toString("base64");
    }
    return new Response(JSON.stringify(a), { status: 200 });
  }) as typeof fetch;
  const r = (await livePools({ solana: PINS.solana, base: null, robinhood: null }, fetchFn)).rows[0]!;
  assert.equal(r.status, "warn");
  assert.equal(r.checks.find((c) => c.id === "authority")!.word, "disagree");
  assert.ok(!asked.includes(sol[2]!), "no third operator asked once two answered");
});

test("Solana: one provider left: Unverified, never ok on one answer", async () => {
  forgetPoolWalks();
  const sol = PINS.solana!.rpcs;
  const fetchFn = (async (url: string) => (url === sol[0] ? new Response(JSON.stringify(REC.solana.rpcs[0]!.answers.accounts), { status: 200 }) : new Response("", { status: 400 }))) as typeof fetch;
  const was = console.error;
  console.error = () => {};
  try {
    const r = (await livePools({ solana: PINS.solana, base: null, robinhood: null }, fetchFn)).rows[0]!;
    assert.equal(r.status, "warn");
    assert.ok(r.checks.every((c) => c.status === "warn"));
  } finally {
    console.error = was;
  }
});

test("the deploy check allows exactly Solana's list in connect-src", async () => {
  const { SOLANA_RPCS } = await import("../scripts/check-deploy.ts");
  assert.deepEqual(SOLANA_RPCS, [...PINS.solana!.rpcs]);
});
