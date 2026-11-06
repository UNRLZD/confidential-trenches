// node --test apps/helper/src/withdraw/fee.test.ts (card relayer-withdraw-fee): the relayer's quote and POST's fee_min.
// - The recorded reads (fixtures/withdraw-fee-reads.json, test/record-withdraw-fee.ts, mainnet and testnet on the
//   device's release pairs) replay to the recorded answers, in the kit's frozen shape; their figures against the
//   device's fee_max at the same reads (P1, M:3010; packages/wallet/test/withdraw-fee-helper.test.ts recomputes it
//   with the device's own withdrawFeeMax).
// - Each refusal planted: a stale final, an old agreed block, a pool under its floor, providers that differ (hash, gas
//   price, pool bytes, the token's bounds), a pool that is not the one, a provider down.
// - The window: within FEE_QUOTE_WINDOW_BLOCKS the relayer holds to its quote, past it the price now decides; checked
//   through checkWithdraw (H3.4 check 3) on the real Withdraw(32) proof of fixtures/withdraw-request.json.
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HELPER_V1_PATHS, VAULT_CONSTANTS } from "@blindfill/kit";
import type { Rpc } from "../near/pages.ts";
import { checkWithdraw, type WithdrawConfig } from "./checks.ts";
import {
  createFeeQuoter,
  FEE_A_FUND,
  FEE_G_W,
  FEE_POOL_MIN_TOKEN,
  FEE_QUOTE_WINDOW_BLOCKS,
  FeeReadRefused,
  feeQuoterFromEnv,
  HEIGHT_SPREAD_MAX,
  pxOf,
  TESTNET_TOKEN,
  withdrawFeeMin,
  type FeeQuoter,
} from "./fee.ts";
import { MAX_FINAL_AGE_MS } from "./index.ts";
import { openDurableDir, type DurableDir } from "../store/durable.ts";

const USDC = VAULT_CONSTANTS.TOKEN;
const ROOT = join(import.meta.dirname, "../../../..");
type Call = { url: string; method: string; params: unknown; result: unknown };
type Rec = { now_ms: number; relayer: { relayer_account: string; fee_recipient: string }; pairs: Record<"mainnet" | "testnet", [string, string]>; answers: Record<"mainnet" | "testnet", Record<string, unknown>>; calls: Call[] };
const REC = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/withdraw-fee-reads.json"), "utf8").replaceAll("$USDC", USDC)) as Rec;
const FIELDS = ["relayer_account", "fee_recipient", "relay_fee", "gp", "px", "g_w", "valid_until_block"];

/** The recorded calls, answered in their order per (url, method, params); a call not recorded throws. */
function replay(rec: Rec) {
  const left = new Map<string, unknown[]>();
  for (const c of rec.calls) {
    const k = `${c.url} ${c.method} ${JSON.stringify(c.params)}`;
    left.set(k, [...(left.get(k) ?? []), c.result]);
  }
  // check 7b's two views of the fee recipient (card vault-review-fixes-1) were not recorded on 2026-11-02: they are
  // answered ready, at the block asked, with the hash that block's recorded header gave
  const hashes = new Map<number, string>();
  const rpc = (url: string): Rpc => async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === "query" && (p.method_name === "storage_balance_of" || p.method_name === "is_blocklisted")) {
      const v = p.method_name === "is_blocklisted" ? false : { total: "1250000000000000000000", available: "0" };
      return { block_height: p.block_id, block_hash: hashes.get(p.block_id as number), result: [...Buffer.from(JSON.stringify(v))], logs: [] };
    }
    const q = left.get(`${url} ${method} ${JSON.stringify(params)}`);
    if (!q || q.length === 0) throw new Error(`not recorded: ${url} ${method} ${JSON.stringify(params)}`);
    const r = structuredClone(q.shift()) as { header?: { height: number; hash: string } };
    if (method === "block" && r.header) hashes.set(r.header.height, r.header.hash);
    return r;
  };
  const pair = (n: "mainnet" | "testnet") => [rpc(rec.pairs[n][0]), rpc(rec.pairs[n][1])] as const;
  return { pair };
}
const recorded = (rec: Rec = REC): FeeQuoter => {
  const { pair } = replay(rec);
  const mainnet = pair("mainnet");
  return createFeeQuoter({ priceRpcs: mainnet, networks: { mainnet: { rpcs: mainnet, relayer: rec.relayer }, testnet: { rpcs: pair("testnet"), relayer: rec.relayer } }, now: () => rec.now_ms });
};
const poolOf = (rec: Rec) => {
  const r = rec.calls.find((c) => (c.params as { method_name?: string }).method_name === "get_pool")!.result as { result: number[] };
  return JSON.parse(Buffer.from(r.result).toString()) as { amounts: [string, string] };
};

// ---- The recorded reads ----

test("recorded reads (mainnet and testnet, 2026-11-02): the quote is the recorded answer, the kit's 7 fields, a whole relay_fee, under 1 KB", async () => {
  const q = recorded();
  const m = await q.quote(USDC);
  const t = await q.quote(TESTNET_TOKEN);
  assert.deepEqual(m, REC.answers.mainnet);
  assert.deepEqual(t, REC.answers.testnet);
  for (const a of [m, t]) {
    assert.deepEqual(Object.keys(a), FIELDS);
    assert.match(a.relay_fee, /^(0|[1-9][0-9]*)$/, "an absolute fee in base units, never a rate");
    assert.equal(a.relayer_account, REC.relayer.relayer_account);
    assert.equal(a.fee_recipient, REC.relayer.fee_recipient);
    assert.equal(a.g_w, FEE_G_W.toString());
    assert.ok(Buffer.byteLength(JSON.stringify(a)) <= HELPER_V1_PATHS.find((p) => p.path === "/v1/withdraw/fee")!.limitBytes!);
  }
  assert.equal(m.relay_fee, "207609");
  assert.equal(m.px, "4.135781763845");
  assert.equal(m.valid_until_block, 222699486 + FEE_QUOTE_WINDOW_BLOCKS);
  assert.equal(t.relay_fee, "207609", "testnet is priced as the mainnet USDC its token copies, at the same gas price");
  assert.equal(t.valid_until_block, 275879066 + FEE_QUOTE_WINDOW_BLOCKS);
});

test("P1 at the recorded reads: fee_min 207,609 (0.207609 USDC) is 0.4738 of the device's fee_max 438,172, at most half", () => {
  const { amounts } = poolOf(REC);
  const i = { gasPrice: 100_000_000n, poolToken: BigInt(amounts[0]), poolNear: BigInt(amounts[1]), registerDeposit: 1_250_000_000_000_000_000_000n };
  assert.deepEqual(amounts, ["1023068829135", "247370119496778966130420997292"]);
  const feeMin = withdrawFeeMin(i);
  assert.equal(feeMin, 207_609n);
  // the device's withdrawFeeMax at these inputs (packages/wallet/src/withdraw/feemax.ts), recomputed there by
  // packages/wallet/test/withdraw-fee-helper.test.ts from this same fixture
  const deviceFeeMax = 438_172n;
  assert.ok(2n * feeMin <= deviceFeeMax);
});

// The P1 table: fee_min at 200 seeded inputs over gp 1e8-1e10, the pool's USDC side 250k-50M USDC and px 0.5-50 USDC
// per NEAR, register_deposit 0 or 0.00125 N. The wallet's test checks each row against the device's fee_max; this test
// holds the table to withdrawFeeMin, so neither side can drift. WRITE_FEE_TABLE=1 rewrites it.
const TABLE = join(import.meta.dirname, "fixtures/withdraw-fee-table.json");
function tableRows() {
  let s = 0x2545f491n;
  const next = (lo: bigint, hi: bigint) => {
    s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    return lo + (s % (hi - lo + 1n));
  };
  return Array.from({ length: 200 }, () => {
    const gasPrice = next(100_000_000n, 10_000_000_000n);
    const poolToken = next(FEE_POOL_MIN_TOKEN, 50_000_000_000_000n);
    const pxMilli = next(500n, 50_000n); // USDC per NEAR × 1000
    const poolNear = (poolToken * 10n ** 18n * 1000n) / pxMilli;
    const registerDeposit = next(0n, 1n) === 0n ? 0n : 1_250_000_000_000_000_000_000n;
    const i = { gasPrice, poolToken, poolNear, registerDeposit };
    return { gp: gasPrice.toString(), pool_token: poolToken.toString(), pool_near: poolNear.toString(), register_deposit: registerDeposit.toString(), fee_min: withdrawFeeMin(i).toString() };
  });
}
test("the P1 table: 200 seeded rows, each fee_min equal to withdrawFeeMin of its inputs", () => {
  const rows = tableRows();
  if (process.env.WRITE_FEE_TABLE === "1") writeFileSync(TABLE, `${JSON.stringify({ note: "fee.test.ts tableRows(): fee_min per row; packages/wallet/test/withdraw-fee-helper.test.ts checks 2 x fee_min <= the device's fee_max", rows }, null, 1)}\n`);
  const held = JSON.parse(readFileSync(TABLE, "utf8")) as { rows: typeof rows };
  assert.deepEqual(held.rows, rows);
  for (const r of held.rows) assert.equal(withdrawFeeMin({ gasPrice: BigInt(r.gp), poolToken: BigInt(r.pool_token), poolNear: BigInt(r.pool_near), registerDeposit: BigInt(r.register_deposit) }).toString(), r.fee_min);
});

test("the formula: G_w at 1.2, every S_w term once, rounded up; px shown in whole tokens per NEAR", () => {
  // 1 USDC per NEAR: poolToken 1e6 base units per 1e24 yocto
  const i = { gasPrice: 100_000_000n, poolToken: 1_000_000_000_000n, poolNear: 1_000_000n * 10n ** 24n, registerDeposit: 0n };
  const yocto = (FEE_G_W * 100_000_000n * 12n) / 10n + 858n * 10n ** 19n + 104_475_000_000_000n * 100_000_000n + FEE_A_FUND + 100_000_000_000_000n * 100_000_000n;
  assert.equal(withdrawFeeMin(i), (yocto + 10n ** 18n - 1n) / 10n ** 18n);
  assert.equal(pxOf(1_000_000_000_000n, 1_000_000n * 10n ** 24n), "1");
  assert.equal(pxOf(1n, 3n * 10n ** 24n), "0.000000333333");
  for (const bad of [{ ...i, gasPrice: 0n }, { ...i, poolNear: 0n }, { ...i, poolToken: -1n }, { ...i, registerDeposit: 1n << 128n }]) assert.throws(() => withdrawFeeMin(bad), FeeReadRefused);
});

test("a fee_min that would not fit the contract's u128 is refused: an absurd pool read quotes nothing", () => {
  // every input a u128, the answer 53 digits: the vault's relay_fee is a u128, so no such quote is given
  const absurd = { gasPrice: (1n << 128n) - 1n, poolToken: (1n << 128n) - 1n, poolNear: 1n, registerDeposit: 0n };
  assert.throws(() => withdrawFeeMin(absurd), (e: Error) => e instanceof FeeReadRefused && /fee_min: over the u128/.test(e.message));
  // the edge: with poolNear 1, fee_min = ceil(K × poolToken / 5), K the yocto cost; the largest poolToken whose answer
  // fits is given, the next one is refused
  const i = { gasPrice: 100_000_000n, poolToken: 5n, poolNear: 1n, registerDeposit: 0n };
  const k = withdrawFeeMin(i);
  const fits = (((1n << 128n) - 1n) * 5n) / k;
  assert.ok(withdrawFeeMin({ ...i, poolToken: fits }) < 1n << 128n);
  assert.throws(() => withdrawFeeMin({ ...i, poolToken: fits + 1n }), FeeReadRefused);
});

// ---- A world the planted cases change ----

type World = {
  height: number;
  ms: bigint;
  gp: string;
  pool: [string, string];
  /** Changes one provider's answer (1 = the second). */
  plant?: (who: 0 | 1, method: string, params: Record<string, unknown>, result: Record<string, unknown>) => Record<string, unknown> | Error;
  poolJson?: Record<string, unknown>;
  /** The fee recipient's storage_balance_of (set unless false) and is_blocklisted answer (false unless given). */
  feeRegistered?: boolean;
  feeListed?: unknown;
};
const hashOf = (h: number) => `${"H".repeat(32)}${h.toString().padStart(9, "1").replace(/0/g, "z")}`;
/** RPC calls the world answered, all providers together. */
const calls = { n: 0 };
function worldPair(w: () => World): [Rpc, Rpc] {
  const one = (who: 0 | 1): Rpc => async (method, p) => {
    calls.n++;
    const x = w();
    const params = p as Record<string, unknown>;
    let result: Record<string, unknown>;
    if (method === "block") {
      const height = params.finality === "final" ? x.height : (params.block_id as number);
      result = { header: { height, hash: hashOf(height), gas_price: x.gp, timestamp_nanosec: (x.ms * 1_000_000n).toString() } };
    } else if (method === "query" && params.method_name === "get_pool") {
      const pool = x.poolJson ?? { pool_kind: "SIMPLE_POOL", token_account_ids: [USDC, "wrap.near"], amounts: x.pool, total_fee: 30, shares_total_supply: "1" };
      result = { block_height: params.block_id, block_hash: hashOf(params.block_id as number), result: [...Buffer.from(JSON.stringify(pool))] };
    } else if (method === "query" && params.method_name === "storage_balance_bounds") {
      result = { block_height: params.block_id, block_hash: hashOf(params.block_id as number), result: [...Buffer.from('{"min":"1250000000000000000000","max":"1250000000000000000000"}')] };
    } else if (method === "query" && (params.method_name === "storage_balance_of" || params.method_name === "is_blocklisted")) {
      // the release's fee recipient, as the quote's hold reads it (card vault-review-fixes-1)
      const v = params.method_name === "is_blocklisted" ? (x.feeListed ?? false) : x.feeRegistered === false ? null : { total: "1250000000000000000000", available: "0" };
      result = { block_height: params.block_id, block_hash: hashOf(params.block_id as number), result: [...Buffer.from(JSON.stringify(v))] };
    } else throw new Error(`unexpected ${method}`);
    const out = x.plant ? x.plant(who, method, params, result) : result;
    if (out instanceof Error) throw out;
    return out;
  };
  return [one(0), one(1)];
}
const NOW = 1_793_611_131_848;
const base = (): World => ({ height: 222_699_486, ms: BigInt(NOW - 1_000), gp: "100000000", pool: ["1023068829135", "247370119496778966130420997292"] });
// two accounts, so an answer that swaps them is caught
const RELAYER = { relayer_account: "relayer.confidential.unrlzd.near", fee_recipient: "fees.confidential.unrlzd.near" };
const quoterOn = (w: () => World, now = () => NOW, store?: DurableDir) => {
  const pair = worldPair(w);
  return createFeeQuoter({ priceRpcs: pair, networks: { mainnet: { rpcs: pair, relayer: RELAYER } }, now, ...(store ? { store } : {}) });
};
const refused = async (world: World, why: RegExp) => {
  await assert.rejects(quoterOn(() => world).quote(USDC), (e: Error) => e instanceof FeeReadRefused && why.test(e.message));
};

test("the world as recorded quotes 207,609, naming the relayer and its fee recipient each in its own field", async () => {
  const a = await quoterOn(base).quote(USDC);
  assert.equal(a.relay_fee, "207609");
  assert.equal(a.relayer_account, RELAYER.relayer_account);
  assert.equal(a.fee_recipient, RELAYER.fee_recipient);
});

// The review of the fee check (card vault-review-fixes-1, finding 2): while POST holds for check 7b, the quote holds too,
// so a device never proves, reserves and resends against a relayer that cannot carry it. GET answers 503 upstream
// (the route's answer to FeeReadRefused) and the device stops before any proof (wallet withdraw/relay.ts askWithdrawFee).
test("the quote holds while the fee account is not ready: unregistered or blocklisted is refused, a blocklist answer that is no boolean is refused, ready quotes", async () => {
  await refused({ ...base(), feeRegistered: false }, /relayer fee account not ready/);
  await refused({ ...base(), feeListed: true }, /relayer fee account not ready/);
  await refused({ ...base(), feeListed: "false" }, /is_blocklisted\(fee_recipient\)/);
  await refused({ ...base(), plant: (who, m, p, r) => (who === 1 && p.method_name === "is_blocklisted" ? { ...r, result: [...Buffer.from("true")] } : r) }, /is_blocklisted at block \d+: the providers' bytes differ/);
  assert.equal((await quoterOn(base).quote(USDC)).relay_fee, "207609");
});

test("the relayer's accounts are checked when the quoter is made", () => {
  const pair = worldPair(base);
  for (const relayer of [{ ...RELAYER, relayer_account: "Relayer.near" }, { ...RELAYER, fee_recipient: "" }])
    assert.throws(() => createFeeQuoter({ priceRpcs: pair, networks: { mainnet: { rpcs: pair, relayer } } }), /must be NEAR account ids/);
});

test("the largest answer the quoter can give (64-character accounts, u128 fields) is under the route's 1 KB", () => {
  const max = (1n << 128n) - 1n;
  const a = { relayer_account: "a".repeat(64), fee_recipient: "b".repeat(64), relay_fee: max.toString(), gp: max.toString(), px: pxOf(max, 1n), g_w: FEE_G_W.toString(), valid_until_block: Number.MAX_SAFE_INTEGER };
  assert.ok(Buffer.byteLength(JSON.stringify(a)) <= HELPER_V1_PATHS.find((p) => p.path === "/v1/withdraw/fee")!.limitBytes!, `${Buffer.byteLength(JSON.stringify(a))} bytes`);
});

test("a stale final: one provider's final 31 blocks behind the other's is refused; 30 is taken", async () => {
  const lag = (n: number): World => ({ ...base(), plant: (who, method, params, r) => (who === 1 && method === "block" && params.finality === "final" ? { header: { ...(r.header as object), height: base().height - n, hash: hashOf(base().height - n) } } : r) });
  await refused(lag(Number(HEIGHT_SPREAD_MAX) + 1), /finals stand 31 blocks apart, over 30/);
  const ok = await quoterOn(() => lag(Number(HEIGHT_SPREAD_MAX))).quote(USDC);
  assert.equal(ok.valid_until_block, base().height - 30 + FEE_QUOTE_WINDOW_BLOCKS, "the lower final is the one both hold");
});

test("an old agreed block: two providers frozen 30.001 s behind the helper's clock are refused; 30 s is taken", async () => {
  await refused({ ...base(), ms: BigInt(NOW) - MAX_FINAL_AGE_MS - 1n }, /behind the helper's clock/);
  assert.equal((await quoterOn(() => ({ ...base(), ms: BigInt(NOW) - MAX_FINAL_AGE_MS })).quote(USDC)).relay_fee.length > 0, true);
});

test("a pool under its floor: 249,999.999999 USDC is refused; 250,000 is taken", async () => {
  await refused({ ...base(), pool: [(FEE_POOL_MIN_TOKEN - 1n).toString(), "60000000000000000000000000000"] }, /under the floor 250000000000/);
  assert.ok(await quoterOn(() => ({ ...base(), pool: [FEE_POOL_MIN_TOKEN.toString(), "60000000000000000000000000000"] })).quote(USDC));
});

test("providers that differ: the block hash, the gas price, the pool's bytes, the token's bounds: each refused", async () => {
  const on1 = (f: (method: string, params: Record<string, unknown>, r: Record<string, unknown>) => Record<string, unknown>): World => ({ ...base(), plant: (who, m, p, r) => (who === 1 ? f(m, p, r) : r) });
  await refused(on1((m, p, r) => (m === "block" ? { header: { ...(r.header as object), hash: hashOf(1) } } : r)), /name different blocks/);
  await refused(on1((m, p, r) => (m === "block" ? { header: { ...(r.header as object), gas_price: "100000001" } } : r)), /gas prices differ/);
  // finals at two heights: the header at the lower one is read on both, and must agree there too
  const apart = (f: (r: Record<string, unknown>) => Record<string, unknown>): World => ({
    ...base(),
    plant: (who, m, p, r) => (who === 1 && m === "block" ? (p.finality === "final" ? { header: { ...(r.header as object), height: base().height + 2, hash: hashOf(base().height + 2) } } : f(r)) : r),
  });
  await refused(apart((r) => ({ header: { ...(r.header as object), hash: hashOf(1) } })), /name different blocks/);
  await refused(apart((r) => ({ header: { ...(r.header as object), gas_price: "100000001" } })), /gas prices differ/);
  await refused(apart((r) => ({ header: { ...(r.header as object), height: base().height + 1 } })), /another height in the answer/);
  assert.ok(await quoterOn(() => apart((r) => r)).quote(USDC), "finals 2 apart that agree at the lower one are taken");
  const otherPool = [...Buffer.from(JSON.stringify({ pool_kind: "SIMPLE_POOL", token_account_ids: [USDC, "wrap.near"], amounts: ["2046137658270", "247370119496778966130420997292"], total_fee: 30, shares_total_supply: "1" }))];
  await refused(on1((m, p, r) => (p.method_name === "get_pool" ? { ...r, result: otherPool } : r)), /get_pool at block \d+: the providers' bytes differ/);
  await refused(on1((m, p, r) => (p.method_name === "storage_balance_bounds" ? { ...r, result: [...Buffer.from('{"min":"0","max":"0"}')] } : r)), /storage_balance_bounds at block \d+: the providers' bytes differ/);
  await refused(on1((m, p, r) => (p.method_name === "get_pool" ? { ...r, block_height: (p.block_id as number) - 1 } : r)), /get_pool not answered at block/);
});

test("not the pool, or a provider down: each refused", async () => {
  await refused({ ...base(), poolJson: { pool_kind: "STABLE_SWAP", token_account_ids: [USDC, "wrap.near"], amounts: base().pool } }, /not a SIMPLE_POOL/);
  await refused({ ...base(), poolJson: { pool_kind: "SIMPLE_POOL", token_account_ids: ["wrap.near", USDC], amounts: base().pool } }, /not the USDC \/ wNEAR pool/);
  await refused({ ...base(), poolJson: { pool_kind: "SIMPLE_POOL", token_account_ids: [USDC, "wrap.near"], amounts: ["1e12", "1"] } }, /not two u128 decimals/);
  await refused({ ...base(), plant: (who, m, p, r) => (who === 0 && m === "query" ? new Error("HTTP 429") : r) }, /did not answer/);
});

test("the token: only the release's USDC and the testnet token of a configured network are quoted", async () => {
  const q = quoterOn(base);
  assert.equal(q.networkOf(USDC), "mainnet");
  assert.equal(q.networkOf(TESTNET_TOKEN), null, "testnet not configured in this quoter");
  assert.equal(q.networkOf("usdt.tether-token.near"), null);
  await assert.rejects(q.quote("usdt.tether-token.near"), /not one this relayer carries/);
  const testnet = JSON.parse(readFileSync(join(ROOT, "contracts/vault/deployments/testnet-usdc.json"), "utf8")) as { account_id: string };
  assert.equal(TESTNET_TOKEN, testnet.account_id);
});

test("the host's environment: a network is quoted only with both relayer accounts, each a NEAR account id", () => {
  assert.equal(feeQuoterFromEnv({}).networkOf(USDC), null);
  const both = feeQuoterFromEnv({ WITHDRAW_RELAYER_MAINNET: "relayer.confidential.unrlzd.near", WITHDRAW_FEE_RECIPIENT_MAINNET: "fees.confidential.unrlzd.near" });
  assert.equal(both.networkOf(USDC), "mainnet");
  assert.equal(both.networkOf(TESTNET_TOKEN), null);
  assert.throws(() => feeQuoterFromEnv({ WITHDRAW_RELAYER_MAINNET: "relayer.confidential.unrlzd.near" }), /must both be NEAR account ids/);
  assert.throws(() => feeQuoterFromEnv({ WITHDRAW_RELAYER_TESTNET: "Relayer.testnet", WITHDRAW_FEE_RECIPIENT_TESTNET: "f.testnet" }), /must both be NEAR account ids/);
  assert.throws(() => feeQuoterFromEnv({ NEAR_TESTNET_RPC_URL: "https://near-testnet.drpc.org" }), /two different providers/);
});

// ---- The window, through H3.4 check 3 ----

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/withdraw-request.json"), "utf8")) as { vault: string; scope: string; fee_recipient: string; request: Record<string, unknown> };
fixture.request.token = USDC;
const CFG: WithdrawConfig = { vault: fixture.vault, token: USDC, scope: BigInt(fixture.scope), feeRecipient: fixture.fee_recipient };

test("POST at the recorded mainnet reads: the real Withdraw(32) request's relay_fee 30,000 is under fee_min 207,609: fee_too_low", async () => {
  const v = await checkWithdraw(structuredClone(fixture.request), CFG, recorded().reads("mainnet"));
  assert.deepEqual(v, { ok: false, code: "fee_too_low", why: "relay_fee: under fee_min" });
});

test("the window: a quote is held for FEE_QUOTE_WINDOW_BLOCKS after its block, then the price now decides", async () => {
  // NEAR at 0.5 USDC (300,000 USDC / 600,000 NEAR): the quote is under the request's 30,000; at 1 USDC fee_min is over it
  let w: World = { ...base(), pool: ["300000000000", "600000000000000000000000000000"] };
  let clock = NOW;
  const q = quoterOn(() => w, () => clock);
  const quote = await q.quote(USDC);
  assert.equal(quote.relay_fee, "25100");
  assert.equal(quote.valid_until_block, base().height + FEE_QUOTE_WINDOW_BLOCKS);
  const reads = q.reads("mainnet");
  const at = (height: number) => {
    clock += 2_000; // past the cache
    w = { ...base(), height, ms: BigInt(clock - 1_000), pool: ["300000000000", "300000000000000000000000000000"] };
  };

  at(base().height + 50); // the price doubled, the quote's window open
  assert.equal((await checkWithdraw(structuredClone(fixture.request), CFG, reads)).ok, true, "30,000 >= the held 25,100");
  at(base().height + FEE_QUOTE_WINDOW_BLOCKS); // its last block
  assert.equal((await checkWithdraw(structuredClone(fixture.request), CFG, reads)).ok, true);
  at(base().height + FEE_QUOTE_WINDOW_BLOCKS + 1); // past it: fee_min now is 50,199
  assert.deepEqual(await checkWithdraw(structuredClone(fixture.request), CFG, reads), { ok: false, code: "fee_too_low", why: "relay_fee: under fee_min" });
  assert.equal(await reads.feeMin({ register_deposit: 1_250_000_000_000_000_000_000n } as never), 50_199n);
});

test("the window: a quote no longer counts once past, and a lower price now wins over a held quote", async () => {
  let w: World = base();
  let clock = NOW;
  const q = quoterOn(() => w, () => clock);
  const quoted = BigInt((await q.quote(USDC)).relay_fee);
  const reads = q.reads("mainnet");
  const rd = { register_deposit: 1_250_000_000_000_000_000_000n } as never;
  clock += 2_000;
  w = { ...base(), height: base().height + 10, ms: BigInt(clock - 1_000), pool: ["1023068829135", "494740238993557932260841994584"] }; // NEAR at half
  const fresh = await reads.feeMin(rd);
  assert.ok(fresh < quoted, "the price now is lower than the quote: the relayer asks the lower");
  clock += 2_000;
  w = { ...base(), height: base().height + FEE_QUOTE_WINDOW_BLOCKS + 1, ms: BigInt(clock - 1_000), pool: ["2046137658270", "247370119496778966130420997292"] }; // NEAR at double, quote past
  assert.ok((await reads.feeMin(rd)) > quoted);
});

test("POST's reads fail closed: providers that disagree throw, so the call is held (never a fee_min of 0)", async () => {
  const q = quoterOn(() => ({ ...base(), plant: (who, m, p, r) => (who === 1 && m === "block" ? { header: { ...(r.header as object), gas_price: "1" } } : r) }));
  await assert.rejects(checkWithdraw(structuredClone(fixture.request), CFG, q.reads("mainnet")), FeeReadRefused);
});

// ---- The review's folds (FIX on f4e3444) ----

const RD_MIN = 1_250_000_000_000_000_000_000n;
const body = (rd: bigint) => ({ register_deposit: rd }) as never;
const LOW: [string, string] = ["300000000000", "600000000000000000000000000000"]; // NEAR at 0.5 USDC

test("a held quote covers only a body whose register_deposit it was priced at or under: 4 N under an open 25,100 quote is priced now", async () => {
  let w: World = { ...base(), pool: LOW };
  let clock = NOW;
  const q = quoterOn(() => w, () => clock);
  assert.equal((await q.quote(USDC)).relay_fee, "25100");
  clock += 2_000;
  w = { ...base(), height: base().height + 10, ms: BigInt(clock - 1_000), pool: ["300000000000", "300000000000000000000000000000"] }; // NEAR at 1 USDC
  const reads = q.reads("mainnet");
  const fourN = 4n * 10n ** 24n;
  const fresh = withdrawFeeMin({ gasPrice: 100_000_000n, poolToken: 300_000_000_000n, poolNear: 300_000n * 10n ** 24n, registerDeposit: fourN });
  assert.equal(await reads.feeMin(body(fourN)), fresh);
  assert.ok(fresh > 4_000_000n, "4 N at 1 USDC is over 4 USDC");
  assert.equal(await reads.feeMin(body(RD_MIN)), 25_100n, "at the minimum it priced, the quote holds");
  assert.equal(await reads.feeMin(body(0n)), 25_100n);
});

test("POST prices the body's own register_deposit: 0 and the minimum give two fee_mins", async () => {
  const reads = quoterOn(base).reads("mainnet");
  assert.equal(await reads.feeMin(body(RD_MIN)), 207_609n);
  assert.ok((await reads.feeMin(body(0n))) < 207_609n);
});

test("two quotes in one block keep the lower: a higher quote after it never raises the held fee", async () => {
  let w: World = { ...base(), pool: LOW };
  let clock = NOW;
  const q = quoterOn(() => w, () => clock);
  assert.equal((await q.quote(USDC)).relay_fee, "25100");
  clock += 2_000;
  w = { ...base(), ms: BigInt(clock - 1_000), pool: ["300000000000", "400000000000000000000000000000"] }; // same block, NEAR at 0.75
  const higher = BigInt((await q.quote(USDC)).relay_fee);
  assert.ok(higher > 25_100n);
  clock += 2_000;
  w = { ...base(), height: base().height + 5, ms: BigInt(clock - 1_000), pool: ["300000000000", "300000000000000000000000000000"] };
  assert.equal(await q.reads("mainnet").feeMin(body(RD_MIN)), 25_100n);
});

test("one read per network at a time, its answer served for FEE_CACHE_MS: concurrent and repeated quotes share it", async () => {
  let clock = NOW;
  const q = quoterOn(base, () => clock);
  calls.n = 0;
  await Promise.all([q.quote(USDC), q.quote(USDC), q.quote(USDC)]);
  const one = calls.n;
  assert.equal(one, 10, "two finals, then the pool and the minimum on both providers, then check 7b's two views of the fee account on both");
  clock += 999;
  await q.quote(USDC);
  await q.reads("mainnet").feeMin(body(RD_MIN));
  assert.equal(calls.n, one, "within FEE_CACHE_MS of the read: no new read");
  clock += 2;
  await q.quote(USDC);
  assert.equal(calls.n, one + 6, "past it: one new priced read; the fee account at the same final block is not read again");
});

test("a pending read is shared however long it takes; a refusal is served as a refusal for FEE_CACHE_MS, then read again", async () => {
  let clock = NOW;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let failing = true;
  const pair = worldPair(() => ({ ...base(), ms: BigInt(clock - 1_000), ...(failing ? { plant: (who, m, p, r) => (who === 1 && m === "block" ? { header: { ...(r.header as object), gas_price: "1" } } : r) } : {}) }) as World);
  const slow: Rpc = async (m, p) => (await gate, pair[0](m, p));
  const q = createFeeQuoter({ priceRpcs: [slow, pair[1]], networks: { mainnet: { rpcs: [slow, pair[1]], relayer: RELAYER } }, now: () => clock });
  calls.n = 0;
  const first = q.quote(USDC);
  clock += 5_000; // the read is still pending
  const second = q.quote(USDC);
  release();
  await assert.rejects(first, FeeReadRefused);
  await assert.rejects(second, FeeReadRefused);
  const one = calls.n;
  assert.equal(one, 2, "one pair of finals, shared");
  failing = false;
  clock += 500;
  await assert.rejects(q.quote(USDC), FeeReadRefused, "the refusal is served within FEE_CACHE_MS");
  assert.equal(calls.n, one);
  clock += 501;
  assert.equal((await q.quote(USDC)).relay_fee, "207609", "then read again");
});

test("the open quotes outlive a restart in the durable store, and are pruned once past", async (t) => {
  const dir = tempDir(t);
  let w: World = { ...base(), pool: LOW };
  let clock = NOW;
  const first = openDurableDir(dir, nodeFs, (d) => d);
  assert.equal((await quoterOn(() => w, () => clock, first).quote(USDC)).relay_fee, "25100");
  first.close(); // the restart
  const again = openDurableDir(dir, nodeFs, (d) => d);
  clock += 2_000;
  w = { ...base(), height: base().height + 50, ms: BigInt(clock - 1_000), pool: ["300000000000", "300000000000000000000000000000"] };
  const q = quoterOn(() => w, () => clock, again);
  assert.equal(await q.reads("mainnet").feeMin(body(RD_MIN)), 25_100n, "the restarted relayer holds to its quote");
  // and only for a register_deposit it was priced at: 4 N is priced now, as before the restart
  const fourN = 4n * 10n ** 24n;
  assert.equal(await q.reads("mainnet").feeMin(body(fourN)), withdrawFeeMin({ gasPrice: 100_000_000n, poolToken: 300_000_000_000n, poolNear: 300_000n * 10n ** 24n, registerDeposit: fourN }));
  // 300 blocks of quotes: the file never holds more than the open window
  for (let h = 1; h <= 300; h++) {
    clock += 2_000;
    w = { ...base(), height: base().height + 50 + h, ms: BigInt(clock - 1_000), pool: LOW };
    await q.quote(USDC);
  }
  const rows = JSON.parse(again.text("fee-quotes-mainnet.json")!) as unknown[];
  assert.ok(rows.length <= FEE_QUOTE_WINDOW_BLOCKS + 1, `${rows.length} rows`);
  again.close();
  const torn = openDurableDir(dir, nodeFs, (d) => d);
  torn.replace("fee-quotes-mainnet.json", "{not json");
  clock += 2_000;
  w = { ...base(), height: base().height + 400, ms: BigInt(clock - 1_000), pool: ["300000000000", "300000000000000000000000000000"] };
  assert.ok((await quoterOn(() => w, () => clock, torn).reads("mainnet").feeMin(body(RD_MIN))) > 25_100n, "an unreadable file holds no quote");
  torn.close();
});

test("a loaded quote further ahead than any window can reach is pruned (a testnet reset): height + 131 is held, + 132 is not", async (t) => {
  // a quote's valid_until_block is its agreed height + FEE_QUOTE_WINDOW_BLOCKS, and an agreed height at POST stands at
  // most HEIGHT_SPREAD_MAX under one at the quote: until <= height + 130, + 1 of slack
  const h = base().height;
  for (const [ahead, held] of [[131, true], [132, false]] as const) {
    const store = openDurableDir(tempDir(t), nodeFs, (d) => d);
    store.replace("fee-quotes-mainnet.json", JSON.stringify([{ until: String(h + ahead), fee: "1", register_min: RD_MIN.toString() }]));
    const fee = await quoterOn(base, () => NOW, store).reads("mainnet").feeMin(body(RD_MIN));
    assert.equal(fee, held ? 1n : 207_609n, `until = height + ${ahead}`);
    store.close();
  }
});

test("the host's store: its own folder and lock under HELPER_STORE_DIR, opened only when a relayer network is set", (t) => {
  const accounts = { WITHDRAW_RELAYER_MAINNET: RELAYER.relayer_account, WITHDRAW_FEE_RECIPIENT_MAINNET: RELAYER.fee_recipient };
  const dir = tempDir(t);
  feeQuoterFromEnv({ HELPER_STORE_DIR: dir, ...accounts });
  assert.ok(existsSync(join(dir, "withdraw-fee", "lock")), "the store's lock in its own folder");
  assert.equal(existsSync(join(dir, "lock")), false, "never HELPER_STORE_DIR itself, which the other relayers' stores share");
  // a store that cannot open (a path under a file) takes no route down when no relayer network is set, and refuses
  // the start when one is
  const file = join(tempDir(t), "a-file");
  writeFileSync(file, "");
  assert.equal(feeQuoterFromEnv({ HELPER_STORE_DIR: join(file, "store") }).networkOf(USDC), null);
  assert.throws(() => feeQuoterFromEnv({ HELPER_STORE_DIR: join(file, "store"), ...accounts }), /ENOTDIR/);
});

/** A temp folder removed when the test ends. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "fee-quotes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
