/// <reference types="node" />
// Row M1.3's dry proof of the joined trade (markets paper §6.1 M1.1-M1.3): runSolanaTrade over a set of 3 on a live pump
// token, a buy and then a sell of each holder's whole balance, through the whole path: the device's reads and E(A) on
// two providers, the helper's Jupiter build, the assembly, S1-S13, and dryRunSolanaSet (simulateTransaction on both
// providers, sigVerify off; nothing is sent). No key signs anything: the dry flow fills each signature slot with random
// bytes.
//
// The wallets are stand-ins, read live and refused unless system-owned and funded: on the buy, large system accounts
// (the set send's dry run's stand-ins, test/solana-send-dry.ts); on the sell, the token's largest holders whose
// account is their own associated account. They are not this device's wallets, so their arm is marked as the
// device's own here only to run the path; the refusal of any other arm is proven by test/solana-flow.test.ts.
//
//   node packages/kit/test/solana-flow-dry.ts --dry [--token <pump mint>] [--out <file>]
import { writeFileSync } from "node:fs";
import { base58 } from "@scure/base";
import {
  SOLANA_SYSTEM_PROGRAM,
  readSolanaReference,
  runSolanaTrade,
  solanaAta,
  solanaHelperRpc,
  solanaJsonRpc,
  solanaSendPaths,
  type SolanaRpc,
  type SolanaTradeRecord,
} from "../src/index.ts";

if (!process.argv.includes("--dry")) {
  console.error("this script runs only with --dry: it simulates and never sends");
  process.exit(2);
}
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TOKEN = arg("--token") ?? "7G36iB8rmCjtik3X68siSPxXXnsypXqzxdbJoajQpump";
const HELPER = "https://api.confidential.unrealized.trade";
// LD1 (markets paper §2.0): two providers, one reached device-direct; the second may go through the helper's /v1/rpc.
// Provider A is PublicNode's keyless Solana RPC, provider B the helper's /v1/rpc/solana.
const PROVIDER_A = "https://solana-rpc.publicnode.com";
const PROVIDER_B = `${HELPER}/v1/rpc/solana`;
// Two of them; the third (9WzDX...) holds more lamports than a JSON number keeps exact, which the flow refuses to read.
const STAND_INS = ["H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"];
const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL a wallet
const SLIPPAGE_BPS = 500;

// The keyless provider answers HTTP 429 under a set's burst of reads, the helper's upstream an odd 503; this harness waits and asks again (up to 6
// times), which a device on its own providers' keys does not need. Every answer still goes through the kit's checks.
const waits: { at: string; method: string; ms: number }[] = [];
const patient = (rpc: SolanaRpc, at: string): SolanaRpc => async (method, params) => {
  for (let i = 0; ; i++) {
    try {
      return await rpc(method, params);
    } catch (e) {
      if (i >= 5 || !/HTTP (429|503)/.test(String((e as Error)?.message))) throw e;
      waits.push({ at, method, ms: 300 * 2 ** i });
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
};
const a = patient(solanaJsonRpc(PROVIDER_A, { timeoutMs: 15_000 }), "A");
const b = patient(solanaHelperRpc(HELPER, { timeoutMs: 15_000 }), "B");
const providers = [a, b] as const;
// Finding the stand-ins only (no check reads these): Solana's public RPC, up to 100 accounts a call, and Solana Vibe
// Station's for getTokenLargestAccounts, which the public RPC rate-limits and PublicNode and the helper do not answer.
const find = solanaJsonRpc("https://api.mainnet-beta.solana.com", { timeoutMs: 15_000 });
const findLargest = solanaJsonRpc("https://public.rpc.solanavibestation.com", { timeoutMs: 15_000 });
type Info = { owner: string; lamports: number; data: [string, string] } | null;
const many = async (keys: string[]) => ((await find("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }])) as { value: Info[] }).value;

for (const [w, i] of (await many(STAND_INS)).map((x, j) => [STAND_INS[j], x] as const)) {
  if (!i || i.owner !== SOLANA_SYSTEM_PROGRAM || i.lamports < 1e9) throw new Error(`stand-in ${w} is not a funded system account`);
}
// Sellers: the largest holders whose account is their own associated account and who are funded system accounts.
const mintInfo = (await many([TOKEN]))[0];
if (!mintInfo) throw new Error("no such mint");
const largest = ((await findLargest("getTokenLargestAccounts", [TOKEN, { commitment: "confirmed" }])) as { value: { address: string; amount: string }[] }).value;
const accounts = await many(largest.map((x) => x.address));
const candidates = largest.flatMap((x, i) => {
  const acc = accounts[i];
  if (!acc || acc.owner !== mintInfo.owner || BigInt(x.amount) === 0n) return [];
  const owner = base58.encode(Buffer.from(acc.data[0], "base64").subarray(32, 64));
  return solanaAta(owner, TOKEN, mintInfo.owner) === x.address ? [{ owner, amount: BigInt(x.amount) }] : [];
});
const owners = await many(candidates.map((c) => c.owner));
const sellers = candidates.filter((_, i) => owners[i]?.owner === SOLANA_SYSTEM_PROGRAM && (owners[i]?.lamports ?? 0) >= 10_000_000).slice(0, 3);
if (sellers.length < 3) throw new Error(`only ${sellers.length} holders fit`);
// Buyers: the two stand-ins and the next funded holder that is not a seller.
const extra = candidates.find((c, i) => owners[i]?.owner === SOLANA_SYSTEM_PROGRAM && (owners[i]?.lamports ?? 0) >= 100_000_000 && !sellers.includes(c));
if (!extra) throw new Error("no third buyer");
const buyers = [...STAND_INS, extra.owner];

const paths = solanaSendPaths({ helper: solanaHelperRpc(HELPER) });
const deps = {
  helper: HELPER,
  providers,
  reference: async (q: { side: "buy" | "sell"; token: string; amount: bigint }) => (await readSolanaReference(providers, q))?.expectedOut ?? null,
  paths,
  dry: true,
} as const;

const run = async (side: "buy" | "sell", legs: { wallet: string; amount: bigint }[]) => {
  const t = performance.now();
  const r = await runSolanaTrade({ side, token: TOKEN, slippageBps: SLIPPAGE_BPS, legs: legs.map((l) => ({ ...l, arm: { own: true } })) }, deps);
  return { r, ms: Math.round(performance.now() - t) };
};
const waitsBefore = () => waits.length;
const w0 = waitsBefore();
const buy = await run("buy", buyers.map((wallet) => ({ wallet, amount: BUY_LAMPORTS })));
const w1 = waitsBefore();
const sell = await run("sell", sellers.map((s) => ({ wallet: s.owner, amount: s.amount })));

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const leg = (l: SolanaTradeRecord["legs"][number]) => ({
  wallet: l.wallet,
  amount: l.amount,
  expectedOut: l.expectedOut,
  minOut: l.minOut,
  refused: l.refused,
  quoteMs: l.quoteMs === undefined ? undefined : Math.round(l.quoteMs),
  buildMs: l.buildMs === undefined ? undefined : Math.round(l.buildMs),
  simulationErrors: l.simulationErrors,
  buildCalls: l.buildCalls,
  size: l.size,
  checks: l.verdict?.results.map((x) => `${x.id} ${x.ok ? "ok" : "FAIL"}`).join(", "),
  dry: l.dry,
  teardown: l.teardown && { frames: l.teardown.frames, ok: l.teardown.verdict.ok, plan: l.teardown.verdict.plan, refused: l.teardown.refused, dry: l.teardown.dry },
});
const out = {
  dry: true,
  at: new Date().toISOString(),
  token: TOKEN,
  helper: HELPER,
  providers: [PROVIDER_A, PROVIDER_B],
  slippageBps: SLIPPAGE_BPS,
  // The harness's waits after an HTTP 429 or 503, per side: a leg's quoteMs includes any of these it met.
  buy: { waits: waits.slice(w0, w1), ms: buy.ms, reference: buy.r.reference, blockhash: buy.r.blockhash, legs: buy.r.legs.map(leg) },
  sell: { waits: waits.slice(w1), ms: sell.ms, reference: sell.r.reference, blockhash: sell.r.blockhash, legs: sell.r.legs.map(leg) },
};
const text = JSON.stringify(out, big, 1);
const file = arg("--out");
if (file) writeFileSync(file, `${text}\n`);
console.log(text);
const good = (r: SolanaTradeRecord) => r.legs.every((l) => !l.refused && l.dry?.state === "simulated" && (l.size ?? 9_999) <= 1_232);
if (!good(buy.r) || !good(sell.r)) process.exit(1);
