/// <reference types="node" />
// The Solana swap build (markets paper T2.1, row M1.1): the /swap/v2/build query, the helper call with its one capped
// retry, the hostile-answer parse, the device's own blockhash, and the v0 assembly, on real builds read through
// HELPER_HOST (test/fixtures/solana-builds.json, recorded by scripts/live-checks/solana-jupiter-build.mjs --record on
// 2026-11-02: a pump.fun token's four shapes, and a real uncapped sell route that assembles to 1,244 bytes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { noneWritten } from "./solana-writes.ts";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_JUPITER_BUILD_PROXY_PATH,
  SOLANA_JUPITER_MAX_ACCOUNTS,
  SOLANA_JUPITER_RETRY_MAX_ACCOUNTS,
  SolanaBuildError,
  assembleSolanaSwap,
  fetchSolanaJupiterBuild,
  parseSolanaJupiterBuild,
  readSolanaBlockhash,
  solanaJupiterBuildQuery,
  type SolanaBuildRequest,
  type SolanaJupiterBuild,
} from "../src/trade/solana/build.ts";
import {
  SOLANA_ATA_PROGRAM,
  SOLANA_MAX_TX_BYTES,
  solanaAta,
  solanaDecodeLookupTable,
  solanaDecodeTransaction,
  solanaResolveKeys,
  type SolanaLookupTable,
} from "../src/checks/solana/message.ts";
import {
  SOLANA_CU_LIMIT,
  SOLANA_JITO_TIP_ACCOUNTS,
  SOLANA_SENDER_TIP_ACCOUNTS,
  SOLANA_SOL_MINT,
  SOLANA_TOKEN_2022_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  checkSolanaQuote,
  type SolanaAccountRead,
} from "../src/checks/solana/checks.ts";
import type { SolanaFetch, SolanaRpc } from "../src/trade/solana/send.ts";

type Acc = { owner: string; data: string } | null;
type Shape = { name: string; query: string; status: number; body: string; ms: number };
const F = JSON.parse(readFileSync(new URL("./fixtures/solana-builds.json", import.meta.url), "utf8")) as {
  good: { mint: string; wallet: string; amounts: { buy: string; sell: string }; shapes: Shape[]; reads: { accounts: Record<string, [Acc, Acc]> }; blockhash: { blockhash: string; lastValidBlockHeight: number } };
  oversize: { wallet: string; mint: string; amount: string; query: string; status: number; body: string; accounts: Record<string, [Acc, Acc]>; blockhash: { blockhash: string; lastValidBlockHeight: number } };
};
const G = F.good;
const ORIGIN = "https://api.confidential.unrealized.trade";
const read = (a: Acc): SolanaAccountRead | null => (a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, "base64")) } : null);
const tablesOf = (accounts: Record<string, [Acc, Acc]>, names: readonly string[]): Record<string, SolanaLookupTable> =>
  Object.fromEntries(names.flatMap((t) => (accounts[t]?.[0] ? [[t, solanaDecodeLookupTable(read(accounts[t][0]!)!.data)]] : [])));
const reqOf = (i: number): SolanaBuildRequest => {
  const side = i < 2 ? "buy" : "sell";
  return { side, wallet: G.wallet, token: G.mint, amount: BigInt(side === "buy" ? G.amounts.buy : G.amounts.sell), slippageBps: 1000 };
};
const chainOf = (build: SolanaJupiterBuild) => ({
  blockhash: G.blockhash.blockhash,
  lastValidBlockHeight: G.blockhash.lastValidBlockHeight,
  tables: tablesOf(G.reads.accounts, build.tables),
  tokenProgram: G.reads.accounts[G.mint]![0]!.owner,
});
const goodBuild = (i: number) => parseSolanaJupiterBuild(JSON.parse(G.shapes[i]!.body));
const FRAME = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S13"];
const verdict = (wire: Uint8Array, req: SolanaBuildRequest, tables: readonly string[]) =>
  checkSolanaQuote(wire, { ...req, spendable: req.amount, minOut: 1n, otherWallets: [] }, {
    tables: Object.fromEntries(tables.map((t) => [t, [read(G.reads.accounts[t]![0]), read(G.reads.accounts[t]![1])] as const])),
    mint: [read(G.reads.accounts[G.mint]![0]), read(G.reads.accounts[G.mint]![1])],
    rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
    simulations: [null, null],
    writable: noneWritten(wire, tablesOf(G.reads.accounts, tables)),
    reference: null,
  });
const frameOk = (v: ReturnType<typeof verdict>) => v.results.filter((r) => FRAME.includes(r.id) && !r.ok).map((r) => `${r.id} ${r.detail}`);

// ---- the query

test("the query: the paper's parameters, maxAccounts=40 first; maxAccounts is always asked, 1 to 64", () => {
  const r: SolanaBuildRequest = { side: "buy", wallet: G.wallet, token: G.mint, amount: 10_000_000n, slippageBps: 950 };
  assert.equal(
    solanaJupiterBuildQuery(r),
    `inputMint=${SOLANA_SOL_MINT}&outputMint=${G.mint}&amount=10000000&slippageBps=950&computeUnitPricePercentile=veryHigh&maxAccounts=40&taker=${G.wallet}`,
  );
  assert.equal(SOLANA_JUPITER_MAX_ACCOUNTS, 40);
  const sell = solanaJupiterBuildQuery({ ...r, side: "sell", amount: 5n }, SOLANA_JUPITER_RETRY_MAX_ACCOUNTS);
  assert.equal(sell, `inputMint=${G.mint}&outputMint=${SOLANA_SOL_MINT}&amount=5&slippageBps=950&computeUnitPricePercentile=veryHigh&maxAccounts=${SOLANA_JUPITER_RETRY_MAX_ACCOUNTS}&taker=${G.wallet}`);
  // a zero, fractional or past-64 cap is refused before any call
  for (const cap of [0, 65, 40.5, Number.NaN]) assert.throws(() => solanaJupiterBuildQuery(r, cap), /maxAccounts must be 1 to 64/, String(cap));
  // kit-v1.4's null (deprecated) still leaves maxAccounts out; none of the kit's own builds asks it
  assert.ok(!solanaJupiterBuildQuery(r, null).includes("maxAccounts"));
  for (const bad of [{ ...r, amount: 0n }, { ...r, amount: 1n << 64n }, { ...r, slippageBps: 10_001 }, { ...r, slippageBps: 1.5 }, { ...r, wallet: "x" }, { ...r, token: SOLANA_SOL_MINT }]) {
    assert.throws(() => solanaJupiterBuildQuery(bad));
  }
});

// ---- the helper call and its one retry

type Answer = { status: number; body: string } | Error;
function stub(answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: SolanaFetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { f, calls };
}
const NO_ROUTE = { status: 400, body: '{"error":"No routes found"}' };
const OK = { status: 200, body: G.shapes[0]!.body };
const R0 = reqOf(0);

test("the build goes to the helper's Jupiter proxy at maxAccounts=40, POST, no credentials, no referrer", async () => {
  const s = stub([OK]);
  const got = await fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: s.f });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.url, `${ORIGIN}${SOLANA_JUPITER_BUILD_PROXY_PATH}?${solanaJupiterBuildQuery(R0)}`);
  assert.equal(SOLANA_JUPITER_BUILD_PROXY_PATH, "/v1/proxy/jupiter/swap/v2/build");
  assert.equal(s.calls[0]!.init.method, "POST");
  assert.equal(s.calls[0]!.init.credentials, "omit");
  assert.equal(s.calls[0]!.init.referrerPolicy, "no-referrer");
  assert.equal(s.calls[0]!.init.body, undefined);
  assert.equal(got.retried, false);
  assert.deepEqual(got.calls.map((c) => [c.maxAccounts, c.status]), [[40, 200]]);
});

// ---- the cap steps: 40, then the one retry at the measured cap, then no route; never a call without maxAccounts
const capOf = (url: string): string | null => new URL(url).searchParams.get("maxAccounts");

test("cap step 1: the first build asks maxAccounts=40 and a route there is used, no retry", async () => {
  const s = stub([OK, OK]);
  const got = await fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: s.f });
  assert.deepEqual(s.calls.map((c) => capOf(c.url)), ["40"]);
  assert.equal(got.retried, false);
});

test("cap step 2: no route at 40, one retry at the measured cap, never without maxAccounts", async () => {
  assert.ok(SOLANA_JUPITER_RETRY_MAX_ACCOUNTS > SOLANA_JUPITER_MAX_ACCOUNTS && SOLANA_JUPITER_RETRY_MAX_ACCOUNTS < 64, `retry cap ${SOLANA_JUPITER_RETRY_MAX_ACCOUNTS}`);
  const s = stub([NO_ROUTE, OK]);
  const got = await fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: s.f });
  assert.equal(got.retried, true);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1]!.url, `${ORIGIN}${SOLANA_JUPITER_BUILD_PROXY_PATH}?${solanaJupiterBuildQuery(R0, SOLANA_JUPITER_RETRY_MAX_ACCOUNTS)}`);
  assert.deepEqual(s.calls.map((c) => capOf(c.url)), ["40", String(SOLANA_JUPITER_RETRY_MAX_ACCOUNTS)]);
  assert.deepEqual(got.calls.map((c) => [c.maxAccounts, c.status]), [[40, 400], [SOLANA_JUPITER_RETRY_MAX_ACCOUNTS, 200]]);
});

test("cap step 3: no route at the retry cap either is no_route, after two calls, with no third and no uncapped one", async () => {
  const twice = stub([NO_ROUTE, NO_ROUTE, OK]);
  await assert.rejects(
    fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: twice.f }),
    (e: unknown) => e instanceof SolanaBuildError && e.code === "no_route" && e.message === `no_route: no route at maxAccounts=40 or ${SOLANA_JUPITER_RETRY_MAX_ACCOUNTS}`,
  );
  assert.deepEqual(twice.calls.map((c) => capOf(c.url)), ["40", String(SOLANA_JUPITER_RETRY_MAX_ACCOUNTS)]);
});

test("every other answer is never retried: the helper's 503, another 400, a dropped connection", async () => {
  for (const [a, code] of [
    [{ status: 503, body: '{"error":{"code":"upstream"}}' }, "upstream"],
    [{ status: 400, body: '{"error":"Invalid taker"}' }, "upstream"],
    [{ status: 429, body: '{"error":{"code":"rate_limited"}}' }, "upstream"],
    [new TypeError("fetch failed"), "upstream"],
    [{ status: 200, body: "<html>" }, "bad_answer"],
    [{ status: 200, body: '{"swapInstruction":null}' }, "bad_answer"],
    [{ status: 200, body: `"${"x".repeat(300 * 1024)}"` }, "bad_answer"],
  ] as const) {
    const s = stub([a, OK]);
    await assert.rejects(fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: s.f }), (e: unknown) => e instanceof SolanaBuildError && e.code === code, JSON.stringify(a));
    assert.equal(s.calls.length, 1, JSON.stringify(a));
  }
});

test("the helper origin is an origin only", async () => {
  for (const o of ["http://api.confidential.unrealized.trade", `${ORIGIN}/v1`, `${ORIGIN}?x=1`, "https://u:p@api.confidential.unrealized.trade", "not a url"]) {
    await assert.rejects(fetchSolanaJupiterBuild(o, R0, { fetch: stub([OK]).f }), o);
  }
});

// ---- the hostile-answer parse

test("a malformed build is refused before anything is assembled", () => {
  const base = JSON.parse(G.shapes[0]!.body) as Record<string, unknown>;
  const swap = base.swapInstruction as { accounts: { pubkey: string }[] };
  const cases: [string, Record<string, unknown>][] = [
    ["no swap", { ...base, swapInstruction: undefined }],
    ["a program that is not an address", { ...base, swapInstruction: { ...swap, programId: "JUP" } }],
    ["an account flag that is not a boolean", { ...base, swapInstruction: { ...swap, accounts: [{ ...swap.accounts[0], isSigner: "true" }] } }],
    ["data that is not base64", { ...base, swapInstruction: { ...swap, data: "***" } }],
    ["17 setup instructions", { ...base, setupInstructions: Array(17).fill((base.setupInstructions as unknown[])[0]) }],
    ["no compute unit price", { ...base, computeBudgetInstructions: [] }],
    ["two compute unit prices", { ...base, computeBudgetInstructions: [...(base.computeBudgetInstructions as unknown[]), ...(base.computeBudgetInstructions as unknown[])] }],
    ["a lookup table that is not an address", { ...base, addressesByLookupTableAddress: { nope: [] } }],
    ["nine lookup tables", { ...base, addressesByLookupTableAddress: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [base58.encode(new Uint8Array(32).fill(i + 1)), []])) }],
  ];
  for (const [what, b] of cases) assert.throws(() => parseSolanaJupiterBuild(b), (e: unknown) => e instanceof SolanaBuildError && e.code === "bad_answer", what);
  // a price above the cap is capped, never refused
  const high = { ...base, computeBudgetInstructions: [{ programId: "ComputeBudget111111111111111111111111111111", accounts: [], data: base64.encode(Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0, 1])) }] };
  assert.equal(parseSolanaJupiterBuild(high).cuPrice, 1_000_000n);
});

// ---- the device's own blockhash

test("the blockhash is the device's own getLatestBlockhash at finalized", async () => {
  const asked: unknown[] = [];
  const rpc = (async (m: string, p: readonly unknown[]) => {
    asked.push([m, p]);
    return { context: { slot: 464370931 }, value: { blockhash: G.blockhash.blockhash, lastValidBlockHeight: 442392460 } };
  }) as SolanaRpc;
  assert.deepEqual(await readSolanaBlockhash(rpc), { blockhash: G.blockhash.blockhash, lastValidBlockHeight: 442392460, slot: 464370931 });
  assert.deepEqual(asked, [["getLatestBlockhash", [{ commitment: "finalized" }]]]);
  for (const v of [{ blockhash: "x", lastValidBlockHeight: 1 }, { blockhash: G.blockhash.blockhash, lastValidBlockHeight: -1 }, { blockhash: G.blockhash.blockhash, lastValidBlockHeight: 1.5 }]) {
    await assert.rejects(readSolanaBlockhash((async () => ({ context: { slot: 1 }, value: v })) as SolanaRpc));
  }
});

// ---- the assembly

test("the four recorded shapes assemble within 1,232 bytes on the device's blockhash and pass the frame checks", () => {
  for (let i = 0; i < 4; i++) {
    const req = reqOf(i);
    const build = goodBuild(i);
    const jupHash = base58.encode(Uint8Array.from((JSON.parse(G.shapes[i]!.body) as { blockhashWithMetadata: { blockhash: number[] } }).blockhashWithMetadata.blockhash));
    const tx = assembleSolanaSwap(req, build, chainOf(build), { pick: () => 0 });
    assert.ok(tx.size <= SOLANA_MAX_TX_BYTES, `${G.shapes[i]!.name}: ${tx.size}`);
    const dec = solanaDecodeTransaction(tx.wire);
    assert.equal(dec.size, tx.size);
    assert.equal(dec.message.blockhash, G.blockhash.blockhash);
    assert.notEqual(dec.message.blockhash, jupHash, "never the build's blockhash");
    assert.equal(tx.lastValidBlockHeight, G.blockhash.lastValidBlockHeight);
    assert.equal(dec.message.requiredSignatures, 1);
    assert.equal(dec.message.staticKeys[0], G.wallet);
    assert.deepEqual([...tx.wire.subarray(1, 65)], Array(64).fill(0));
    assert.deepEqual(frameOk(verdict(tx.wire, req, build.tables)), [], G.shapes[i]!.name);
    // round trip: every instruction of the frame, in order, with its accounts and data
    const keys = solanaResolveKeys(dec.message, chainOf(build).tables);
    const ixs = dec.message.instructions.map((x) => ({ program: keys[x.programIndex]!.key, accounts: x.accounts.map((a) => keys[a]!.key), data: [...x.data] }));
    const want = [
      { program: "ComputeBudget111111111111111111111111111111", data: [2, ...new Uint8Array(new Uint32Array([tx.cuLimit]).buffer)] },
      { program: "ComputeBudget111111111111111111111111111111", data: [3, ...new Uint8Array(new BigUint64Array([tx.cuPrice]).buffer)] },
      ...build.setup,
      build.swap,
      ...(build.cleanup ? [build.cleanup] : []),
      ...build.other,
    ];
    for (const [k, w] of want.entries()) {
      assert.equal(ixs[k]!.program, w.program, `${G.shapes[i]!.name} ix ${k}`);
      if ("accounts" in w) assert.deepEqual(ixs[k]!.accounts, w.accounts.map((a) => a.key), `${G.shapes[i]!.name} ix ${k}`);
      assert.deepEqual(ixs[k]!.data, [...w.data], `${G.shapes[i]!.name} ix ${k}`);
    }
    const tips = ixs.slice(-2);
    assert.deepEqual(tips.map((t) => t.accounts), [[G.wallet, SOLANA_SENDER_TIP_ACCOUNTS[0]], [G.wallet, SOLANA_JITO_TIP_ACCOUNTS[0]]]);
    assert.equal(ixs.length, want.length + 2);
    // signer and writable flags as the instructions asked
    for (const x of build.swap.accounts) {
      const k = keys.find((y) => y.key === x.key)!;
      if (x.writable) assert.ok(k.writable, x.key);
      assert.equal(k.signer, x.key === G.wallet);
    }
  }
});

test("the CU limit is the route cap S8 applies", () => {
  for (let i = 0; i < 4; i++) {
    const build = goodBuild(i);
    const tx = assembleSolanaSwap(reqOf(i), build, chainOf(build));
    assert.ok(([SOLANA_CU_LIMIT.pumpBuy, SOLANA_CU_LIMIT.pumpSell, SOLANA_CU_LIMIT.other] as number[]).includes(tx.cuLimit));
    assert.ok(tx.cuPrice <= 1_000_000n);
  }
});

test("a real uncapped route over 1,232 bytes is refused", () => {
  const o = F.oversize;
  const build = parseSolanaJupiterBuild(JSON.parse(o.body));
  const req: SolanaBuildRequest = { side: "sell", wallet: o.wallet, token: o.mint, amount: BigInt(o.amount), slippageBps: 1000 };
  const chain = { blockhash: o.blockhash.blockhash, lastValidBlockHeight: o.blockhash.lastValidBlockHeight, tables: tablesOf(o.accounts, build.tables), tokenProgram: o.accounts[o.mint]![0]!.owner };
  assert.throws(() => assembleSolanaSwap(req, build, chain), (e: unknown) => e instanceof SolanaBuildError && e.code === "too_large" && /1244 bytes > 1232/.test(e.message));
});

test("a table the device did not read, or read as deactivated, is not used: every key stays static", () => {
  const build = goodBuild(0);
  const chain = chainOf(build);
  const withTables = assembleSolanaSwap(reqOf(0), build, chain);
  assert.equal(withTables.tablesUsed.length, 1);
  const dead = Object.fromEntries(Object.entries(chain.tables).map(([k, t]) => [k, { ...t, deactivationSlot: 1n }]));
  for (const tables of [{}, dead]) {
    const tx = assembleSolanaSwap(reqOf(0), build, { ...chain, tables });
    assert.deepEqual(tx.tablesUsed, []);
    assert.equal(solanaDecodeTransaction(tx.wire).message.lookups.length, 0);
    assert.ok(tx.size > withTables.size);
  }
  // the real oversize route without its tables is far over
  const o = F.oversize;
  const big = parseSolanaJupiterBuild(JSON.parse(o.body));
  const req: SolanaBuildRequest = { side: "sell", wallet: o.wallet, token: o.mint, amount: BigInt(o.amount), slippageBps: 1000 };
  assert.throws(
    () => assembleSolanaSwap(req, big, { blockhash: o.blockhash.blockhash, lastValidBlockHeight: o.blockhash.lastValidBlockHeight, tables: {}, tokenProgram: o.accounts[o.mint]![0]!.owner }),
    (e: unknown) => e instanceof SolanaBuildError && e.code === "too_large",
  );
});

const ATA = (w: string, mint: string, tp: string) => ({
  program: SOLANA_ATA_PROGRAM,
  accounts: [
    { key: w, signer: true, writable: true },
    { key: solanaAta(w, mint, tp), signer: false, writable: true },
    { key: w, signer: false, writable: false },
    { key: mint, signer: false, writable: false },
    { key: "11111111111111111111111111111111", signer: false, writable: false },
    { key: tp, signer: false, writable: false },
  ],
  data: Uint8Array.of(1),
});

test("a buy whose setup has no create of the wallet's output account gets one before the swap", () => {
  const build = goodBuild(0);
  const tp = chainOf(build).tokenProgram;
  const out = solanaAta(G.wallet, G.mint, tp);
  const without = { ...build, setup: build.setup.filter((x) => !(x.program === SOLANA_ATA_PROGRAM && x.accounts[1]?.key === out)) };
  assert.equal(without.setup.length, build.setup.length - 1);
  const tx = assembleSolanaSwap(reqOf(0), without, chainOf(build), { pick: () => 0 });
  const dec = solanaDecodeTransaction(tx.wire);
  const keys = solanaResolveKeys(dec.message, chainOf(build).tables);
  const progs = dec.message.instructions.map((x) => keys[x.programIndex]!.key);
  const at = progs.indexOf("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const create = dec.message.instructions[at - 1]!;
  assert.equal(progs[at - 1], SOLANA_ATA_PROGRAM);
  assert.equal(keys[create.accounts[1]!]!.key, out);
  assert.deepEqual(frameOk(verdict(tx.wire, reqOf(0), build.tables)), []);
});

test("an account the setup creates for a middle mint is closed to the wallet after the swap, harvested first when it holds a transfer fee", () => {
  const build = goodBuild(2); // a sell: setup creates the wSOL account, cleanup closes it
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"; // a Token-2022 mint
  const mid = { ...build, setup: [...build.setup, ATA(G.wallet, USDC, SOLANA_TOKEN_PROGRAM), ATA(G.wallet, PYUSD, SOLANA_TOKEN_2022_PROGRAM)] };
  const tx = assembleSolanaSwap(reqOf(2), mid, chainOf(build), { transferFeeMints: [PYUSD], pick: () => 0 });
  const dec = solanaDecodeTransaction(tx.wire);
  const keys = solanaResolveKeys(dec.message, chainOf(build).tables);
  const ixs = dec.message.instructions.map((x) => ({ program: keys[x.programIndex]!.key, accounts: x.accounts.map((a) => keys[a]!.key), data: [...x.data] }));
  const at = ixs.findIndex((x) => x.program === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  assert.deepEqual(ixs.slice(at + 1, at + 4), [
    { program: SOLANA_TOKEN_PROGRAM, accounts: [solanaAta(G.wallet, USDC, SOLANA_TOKEN_PROGRAM), G.wallet, G.wallet], data: [9] },
    { program: SOLANA_TOKEN_2022_PROGRAM, accounts: [PYUSD, solanaAta(G.wallet, PYUSD, SOLANA_TOKEN_2022_PROGRAM)], data: [26, 4] },
    { program: SOLANA_TOKEN_2022_PROGRAM, accounts: [solanaAta(G.wallet, PYUSD, SOLANA_TOKEN_2022_PROGRAM), G.wallet, G.wallet], data: [9] },
  ]);
  // the wSOL account Jupiter's cleanup closes is not closed twice
  const wsol = solanaAta(G.wallet, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
  assert.equal(ixs.filter((x) => x.data.length === 1 && x.data[0] === 9 && x.accounts[0] === wsol).length, 1);
  const v = verdict(tx.wire, reqOf(2), build.tables);
  assert.deepEqual(frameOk(v).filter((x) => x.startsWith("S13") || x.startsWith("S5") || x.startsWith("S3")), []);
});

test("an instruction that asks another account to sign is refused", () => {
  const build = goodBuild(0);
  const other = base58.encode(new Uint8Array(32).fill(7));
  const evil = { ...build, swap: { ...build.swap, accounts: [...build.swap.accounts, { key: other, signer: true, writable: false }] } };
  assert.throws(() => assembleSolanaSwap(reqOf(0), evil, chainOf(build)), (e: unknown) => e instanceof SolanaBuildError && e.code === "bad_answer");
});

test("the assembly refuses a blockhash or token program the device did not read", () => {
  const build = goodBuild(0);
  assert.throws(() => assembleSolanaSwap(reqOf(0), build, { ...chainOf(build), blockhash: "" }));
  assert.throws(() => assembleSolanaSwap(reqOf(0), build, { ...chainOf(build), lastValidBlockHeight: 0 }));
  assert.throws(() => assembleSolanaSwap(reqOf(0), build, { ...chainOf(build), tokenProgram: SOLANA_ATA_PROGRAM }));
});

// ---- the compiler against @solana/web3.js, the pump curve caps, Token-2022 (review of 4c4991e)

type TwoTable = { name: string; side: "buy" | "sell"; wallet: string; mint: string; amount: string; body: string; accounts: Record<string, [Acc, Acc]>; blockhash: { blockhash: string; lastValidBlockHeight: number }; web3js: { version: string; message: string; flags: [string, boolean, boolean][] } };
type Run = { wallet: string; mint: string; amount: string; body: string; accounts: Record<string, [Acc, Acc]>; blockhash: { blockhash: string; lastValidBlockHeight: number } };
const X = JSON.parse(readFileSync(new URL("./fixtures/solana-builds.json", import.meta.url), "utf8")) as { twoTable: TwoTable[]; token2022buy: Run };
const assembleRun = (r: Run, side: "buy" | "sell", build = parseSolanaJupiterBuild(JSON.parse(r.body))) => {
  const req: SolanaBuildRequest = { side, wallet: r.wallet, token: r.mint, amount: BigInt(r.amount), slippageBps: 1000 };
  const tables = tablesOf(r.accounts, build.tables);
  const tx = assembleSolanaSwap(req, build, { blockhash: r.blockhash.blockhash, lastValidBlockHeight: r.blockhash.lastValidBlockHeight, tables, tokenProgram: r.accounts[r.mint]![0]!.owner }, { pick: () => 0 });
  const v = checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut: 1n, otherWallets: [] }, {
    tables: Object.fromEntries(build.tables.map((t) => [t, [read(r.accounts[t]![0]), read(r.accounts[t]![1])] as const])),
    mint: [read(r.accounts[r.mint]![0]), read(r.accounts[r.mint]![1])],
    rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
    simulations: [null, null],
    writable: noneWritten(tx.wire, tables),
    reference: null,
  });
  return { req, build, tables, tx, v };
};

test("two recorded two-table builds compile to the exact bytes @solana/web3.js 1.98.4 made, with its signer and writable flag on every key", () => {
  assert.equal(X.twoTable.length, 2);
  for (const c of X.twoTable) {
    const { tx, tables } = assembleRun(c, c.side);
    assert.ok(tx.size <= SOLANA_MAX_TX_BYTES, c.name);
    assert.equal(tx.tablesUsed.length, 2, c.name);
    assert.equal(base64.encode(tx.message), c.web3js.message, c.name);
    const dec = solanaDecodeTransaction(tx.wire);
    const keys = solanaResolveKeys(dec.message, tables);
    assert.deepEqual(keys.map((k) => [k.key, k.signer, k.writable]), c.web3js.flags, c.name);
  }
});

test("a one-step pump.fun curve route gets the pump cap: 200,000 on a buy step, 150,000 on a sell step, and S8 passes", () => {
  // the recorded buy's route_v2 data with its route plan set to one step of the given Swap variant (49 a pump buy, 50 a pump sell)
  const withStep = (b: SolanaJupiterBuild, step: number): SolanaJupiterBuild => {
    const d = Uint8Array.from(b.swap.data);
    new DataView(d.buffer).setUint32(30, 1, true);
    d[34] = step;
    return { ...b, swap: { ...b.swap, data: d } };
  };
  for (const [i, step, cap] of [[0, 49, SOLANA_CU_LIMIT.pumpBuy], [2, 50, SOLANA_CU_LIMIT.pumpSell], [0, 7, SOLANA_CU_LIMIT.other]] as const) {
    const build = withStep(goodBuild(i), step);
    const tx = assembleSolanaSwap(reqOf(i), build, chainOf(build), { pick: () => 0 });
    assert.equal(tx.cuLimit, cap, `step ${step}`);
    const dec = solanaDecodeTransaction(tx.wire);
    const keys = solanaResolveKeys(dec.message, chainOf(build).tables);
    const limit = dec.message.instructions.find((x) => keys[x.programIndex]!.key === "ComputeBudget111111111111111111111111111111" && x.data[0] === 2)!;
    assert.equal(new DataView(limit.data.buffer, limit.data.byteOffset).getUint32(1, true), cap);
    const s8 = verdict(tx.wire, reqOf(i), build.tables).results.find((r) => r.id === "S8")!;
    assert.ok(s8.ok, s8.detail);
    assert.ok(s8.detail.includes(`cap ${cap}`), s8.detail);
  }
  assert.equal(SOLANA_CU_LIMIT.pumpBuy, 200_000);
  assert.equal(SOLANA_CU_LIMIT.pumpSell, 150_000);
});

test("a Token-2022 token's buy keeps its output account under Token-2022, from Jupiter's setup or the device's own create", () => {
  const r = X.token2022buy;
  assert.equal(r.accounts[r.mint]![0]!.owner, SOLANA_TOKEN_2022_PROGRAM);
  const out = solanaAta(r.wallet, r.mint, SOLANA_TOKEN_2022_PROGRAM);
  const asIs = assembleRun(r, "buy");
  const fails = asIs.v.results.filter((x) => FRAME.includes(x.id) && !x.ok).map((x) => `${x.id} ${x.detail}`);
  assert.deepEqual(fails, []);
  const built = parseSolanaJupiterBuild(JSON.parse(r.body));
  const without = { ...built, setup: built.setup.filter((x) => !(x.program === SOLANA_ATA_PROGRAM && x.accounts[1]?.key === out)) };
  assert.equal(without.setup.length, built.setup.length - 1);
  const added = assembleRun(r, "buy", without);
  assert.deepEqual(added.v.results.filter((x) => FRAME.includes(x.id) && !x.ok).map((x) => `${x.id} ${x.detail}`), []);
  const dec = solanaDecodeTransaction(added.tx.wire);
  const keys = solanaResolveKeys(dec.message, added.tables);
  const creates = dec.message.instructions.filter((x) => keys[x.programIndex]!.key === SOLANA_ATA_PROGRAM).map((x) => [keys[x.accounts[1]!]!.key, keys[x.accounts[5]!]!.key]);
  assert.ok(creates.some(([a, tp]) => a === out && tp === SOLANA_TOKEN_2022_PROGRAM), JSON.stringify(creates));
  assert.ok(!creates.some(([a]) => a === solanaAta(r.wallet, r.mint, SOLANA_TOKEN_PROGRAM)));
});

test("at the retry cap from the start (the live check's retry shapes): one call at the retry cap, never retried", async () => {
  const s = stub([OK]);
  const got = await fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: s.f, atRetryCap: true });
  assert.equal(got.retried, true);
  assert.equal(got.uncapped, true); // kit-v1.4's name, kept as an alias
  assert.deepEqual(s.calls.map((c) => c.url), [`${ORIGIN}${SOLANA_JUPITER_BUILD_PROXY_PATH}?${solanaJupiterBuildQuery(R0, SOLANA_JUPITER_RETRY_MAX_ACCOUNTS)}`]);
  // kit-v1.4's `uncapped: true` option: the same one call, now at the retry's cap, never without maxAccounts
  const old = stub([OK]);
  const v14 = await fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: old.f, uncapped: true });
  assert.deepEqual(old.calls.map((c) => capOf(c.url)), [String(SOLANA_JUPITER_RETRY_MAX_ACCOUNTS)]);
  assert.equal(v14.uncapped, true);
  const none = stub([NO_ROUTE, OK]);
  await assert.rejects(fetchSolanaJupiterBuild(ORIGIN, R0, { fetch: none.f, atRetryCap: true }), (e: unknown) => e instanceof SolanaBuildError && e.code === "no_route");
  assert.equal(none.calls.length, 1);
});
