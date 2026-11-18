// One NEAR quote's reads at its block, per provider (card near-quote-inside-the-kpi): nearQuote (src/trade/near/wallet.ts)
// on Rhea classic and Rhea DCL at one final height, on two fake providers of one fake chain. A NEAR buy box's quote sat
// on Quoting 7 to 40 s on the live hosts (18 Nov 00:0xZ): about 40 reads of the helper's NEAR seat a quote, at 5 a
// second. Here the world of a coin with two DCL pools of its own with wrapped NEAR and USDC's four: at 11c636a6a one quote
// asked each provider 22 reads (the final 1, classic 4, DCL 17: its metadata, frozen list, 6 pools, the token's account
// a second time, and 8 quote views, one a two-hop path); now the token's account once for both venues and the two-hop
// path picked per hop (4 first hops, 2 second hops, the chosen path), and the quote is the same.
//   node --test test/near-quote-reads.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEAR_NETWORKS } from "../src/near/networks.ts";
import { nearFinal } from "../src/near/rhea.ts";
import { dclPoolOf } from "../src/near/dcl.ts";
import { isDclQuote, nearQuote } from "../src/trade/near/wallet.ts";

const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
const DRPC = NEAR_NETWORKS.mainnet.drpc;
const USDC = NEAR_NETWORKS.mainnet.usdc;
const WRAP = "wrap.near";
const TOKEN = "tok.near";
const EX = "v2.ref-finance.near";
const DCLX = "dclv2.ref-labs.near";
const H = 224_000_000;
const id = (a: string, b: string, fee: number) => `${a < b ? a : b}|${a < b ? b : a}|${fee}`;
const USDC_WRAP = [100, 400, 2000, 10000].map((f) => id(USDC, WRAP, f));
const TOKEN_WRAP = [100, 2000].map((f) => id(TOKEN, WRAP, f));
/** Each DCL pool's pay per unit in, as a fraction: USDC→wNEAR, then wNEAR→token (the reverse its inverse). */
const RATE: Record<string, [bigint, bigint]> = {
  [USDC_WRAP[0]!]: [3n, 10n],
  [USDC_WRAP[1]!]: [5n, 10n], // the first hop that pays most
  [USDC_WRAP[2]!]: [4n, 10n],
  [USDC_WRAP[3]!]: [2n, 10n],
  [TOKEN_WRAP[0]!]: [70n, 1n],
  [TOKEN_WRAP[1]!]: [90n, 1n], // the second hop that pays most
};
const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
const argsOf = (p: Record<string, unknown>) => JSON.parse(atob(String(p.args_base64)));

/** DCL's quote view of `amount` from `from` to `to` on `path`: each pool's rate in turn; 0 for a path that does not join. */
function dclPays(path: string[], from: string, to: string, amount: bigint): bigint {
  let t = from;
  let x = amount;
  for (const p of path) {
    const pool = dclPoolOf(p)!;
    const other = pool.x === t ? pool.y : pool.y === t ? pool.x : null;
    if (other === null) return 0n;
    const [n, d] = RATE[p]!;
    // USDC→wNEAR and wNEAR→token at the rate, the other way at its inverse
    x = t === USDC || other === TOKEN ? (x * n) / d : (x * d) / n;
    t = other;
  }
  return t === to ? x : 0n;
}

type Asked = Record<string, string[]>;
function world(o: { frozenDcl?: string[]; notRunning?: string[] } = {}) {
  const asked: Asked = { [FAST]: [], [DRPC]: [] };
  const rpcs = [FAST, DRPC].map((name) => ({
    name,
    async query(p: Record<string, unknown>) {
      const what = p.request_type === "view_account" ? `view_account ${String(p.account_id)}` : `${String(p.account_id)} ${String(p.method_name)}`;
      asked[name]!.push(what);
      const result = { block_height: H, block_hash: `B${H}` };
      if (p.request_type === "view_account") return { jsonrpc: "2.0", id: "1", result: { ...result, amount: "1", code_hash: "11111111111111111111111111111111" } };
      const args = argsOf(p);
      let v: unknown;
      if (what === `${EX} metadata`) v = { state: "Running" };
      else if (what === `${EX} get_frozenlist_tokens`) v = [];
      else if (what === `${EX} get_pool_by_ids`) v = (args.pool_ids as number[]).map(() => ({ pool_kind: "SIMPLE_POOL", token_account_ids: [USDC, TOKEN], amounts: ["1000000000", "1000000"], total_fee: 30 }));
      else if (what === `${DCLX} get_metadata`) v = { state: "Running" };
      else if (what === `${DCLX} get_frozenlist_tokens`) v = o.frozenDcl ?? [];
      else if (what === `${DCLX} get_pool`) {
        const pid = String(args.pool_id);
        const pool = dclPoolOf(pid)!;
        v = pid in RATE ? { pool_id: pid, token_x: pool.x, token_y: pool.y, fee: pool.fee, state: o.notRunning?.includes(pid) ? "Paused" : "Running", whitelist: null, tax: null } : null;
      } else if (what === `${DCLX} quote`) v = { amount: String(dclPays(args.pool_ids, args.input_token, args.output_token, BigInt(args.input_amount))), tag: null };
      else throw new Error(`not made: ${what}`);
      return { jsonrpc: "2.0", id: "1", result: { ...result, result: enc(v), logs: [] } };
    },
  })) as unknown as readonly [Parameters<typeof nearFinal>[1][0], Parameters<typeof nearFinal>[1][1]];
  return { asked, rpcs };
}
const buy = async (rpcs: ReturnType<typeof world>["rpcs"], asked: Asked) => {
  const final = await nearFinal("mainnet", rpcs);
  for (const k of Object.keys(asked)) asked[k] = [];
  return nearQuote({ network: "mainnet", rpcs, side: "buy", token: TOKEN, amountIn: 1_000_000n, pools: [9], dclPools: [...TOKEN_WRAP, ...USDC_WRAP], final });
};

test("one quote's reads at its block, per provider: the token's account once, DCL's two-hop path picked per hop", async () => {
  const { asked, rpcs } = world();
  const q = await buy(rpcs, asked);
  // the best path: the first hop that pays most (USDC_WRAP[1]) then the second that pays most for it (TOKEN_WRAP[1])
  assert.ok(isDclQuote(q));
  if (!isDclQuote(q)) return;
  assert.deepEqual(q.poolIds, [USDC_WRAP[1], TOKEN_WRAP[1]]);
  // the best of every two-hop path, as quoting all eight would find
  const all = USDC_WRAP.flatMap((p) => TOKEN_WRAP.map((r) => dclPays([p, r], USDC, TOKEN, 1_000_000n)));
  assert.equal(q.venueOut, all.reduce((a, b) => (b > a ? b : a)));
  for (const name of [FAST, DRPC]) {
    const a = asked[name]!;
    // red at 11c636a6a: 21 (view_account twice, 8 quote views)
    assert.equal(a.filter((x) => x === `view_account ${TOKEN}`).length, 1, `${name}: the token's account once for both venues`);
    assert.equal(a.filter((x) => x === `${DCLX} quote`).length, 4 + 2 + 1, `${name}: 4 first hops, 2 second hops, the chosen path`);
    assert.equal(a.length, 4 + (2 + 6 + 7), `${name}: classic 4, DCL 15: ${a.join(", ")}`);
  }
});

test("a DCL pool not Running at the block, or a token frozen there, is never quoted", async () => {
  const paused = world({ notRunning: [USDC_WRAP[1]!] });
  const q = await buy(paused.rpcs, paused.asked);
  assert.ok(isDclQuote(q) && !q.poolIds.includes(USDC_WRAP[1]!), "the paused pool is in no path");
  // the token frozen on DCL: DCL is skipped, the quote is classic's
  const frozen = world({ frozenDcl: [TOKEN] });
  const c = await buy(frozen.rpcs, frozen.asked);
  assert.ok(!isDclQuote(c));
  // every DCL pool paused: no DCL path; classic's quote
  const none = world({ notRunning: [...USDC_WRAP, ...TOKEN_WRAP] });
  assert.ok(!isDclQuote(await buy(none.rpcs, none.asked)));
});
