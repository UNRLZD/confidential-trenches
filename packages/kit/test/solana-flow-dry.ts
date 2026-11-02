/// <reference types="node" />
// Row M1.3's dry proof of the joined trade (markets paper §6.1 M1.1-M1.3): runSolanaTrade over a set of 3 on live pump
// tokens, a buy and then a sell of each holder's whole balance, through the whole path: the device's reads and E on two
// providers, the helper's Jupiter build, the assembly, S1-S13, the pre-state read again after the simulation, and
// dryRunSolanaSet (simulateTransaction on both providers, sigVerify off; nothing is sent). No key signs anything: the
// dry flow fills each signature slot with random bytes.
//
// The wallets are stand-ins, the token's own holders, read live: a buyer is a system account holding the buy and 0.02
// SOL more, up to 100 SOL, sellers last (an exchange's hot wallet moves while it is checked, which the flow refuses); on PumpSwap, buyers with
// no PumpSwap volume account come first, so the run covers the buy that creates it. A seller is a holder whose account
// is its own associated account, selling its whole balance. They are not this device's wallets, so their arm is marked
// as the device's own here only to run the path; the refusal of any other arm is in test/solana-flow.test.ts.
//
//   node packages/kit/test/solana-flow-dry.ts --dry [--token <pump mint>]... [--buy <lamports>] [--buyer <wallet>]...
//     [--out <file>] [--record <file>]
// --buyer names the buyers instead (each read live: a funded system account), e.g. a wallet with no PumpSwap volume
// account for a graduated token's first PumpSwap buy.
//
// --record keeps every answer the flow was given (both providers' RPC answers, the helper's builds and the reference),
// keyed by what was asked, for test/solana-flow-replay.test.ts to replay with no network.
import { writeFileSync } from "node:fs";
import { base58 } from "@scure/base";
import {
  SOLANA_PUMP_AMM_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  readSolanaReference,
  runSolanaTrade,
  solanaAta,
  solanaHelperRpc,
  solanaJsonRpc,
  solanaSendPaths,
  solanaVolumeAccumulator,
  type SolanaRpc,
  type SolanaTradeRecord,
} from "../src/index.ts";

if (!process.argv.includes("--dry")) {
  console.error("this script runs only with --dry: it simulates and never sends");
  process.exit(2);
}
const args = (k: string) => process.argv.flatMap((v, i) => (process.argv[i - 1] === k ? [v] : []));
// A live pump.fun curve token and a graduated one in its PumpSwap pool (2026-11-02).
const TOKENS = args("--token").length ? args("--token") : ["7G36iB8rmCjtik3X68siSPxXXnsypXqzxdbJoajQpump", "EQM29p2pzrRMUckhb5umAzSgjEhnCy8gNKSVfVnrpump"];
const BUY_LAMPORTS = BigInt(args("--buy")[0] ?? "10000000"); // 0.01 SOL a wallet
const HELPER = "https://api.confidential.unrealized.trade";
// LD1 (markets paper §2.0): two providers, one reached device-direct; the second may go through the helper's /v1/rpc.
// Provider A is PublicNode's keyless Solana RPC, provider B the helper's /v1/rpc/solana.
const PROVIDER_A = "https://solana-rpc.publicnode.com";
const PROVIDER_B = `${HELPER}/v1/rpc/solana`;
const SLIPPAGE_BPS = 500;

// The keyless provider answers HTTP 429 under a set's burst of reads, the helper's upstream an odd 503; this harness
// waits and asks again (up to 6 times), which a device on its own providers' keys does not need. Every answer still
// goes through the kit's checks.
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
// The recorder: a simulateTransaction is keyed by the accounts it reads back, not by its bytes (the tip account and the
// dry placeholder signature are random each run).
const recording = { requests: [] as unknown[], rpc: [] as { at: string; ask: string; answer: unknown }[], builds: [] as { url: string; status: number; body: string }[], references: [] as { q: unknown; answer: unknown }[] };
const solanaReplayKey = (method: string, params: readonly unknown[]): string =>
  JSON.stringify(method === "simulateTransaction" ? [method, (params[1] as { accounts?: unknown })?.accounts] : [method, params]);
const recorded = (rpc: SolanaRpc, at: string): SolanaRpc => async (method, params) => {
  const answer = await rpc(method, params);
  recording.rpc.push({ at, ask: solanaReplayKey(method, params), answer });
  return answer;
};
const a = recorded(patient(solanaJsonRpc(PROVIDER_A, { timeoutMs: 15_000 }), "A"), "A");
const b = recorded(patient(solanaHelperRpc(HELPER, { timeoutMs: 15_000 }), "B"), "B");
const providers = [a, b] as const;
// Finding the stand-ins only (no check reads these): Solana's public RPC, then Solana Vibe Station's for
// getTokenLargestAccounts, which PublicNode and the helper do not answer.
const find = patient(solanaJsonRpc("https://api.mainnet-beta.solana.com", { timeoutMs: 15_000 }), "find");
const findLargest = patient(solanaJsonRpc("https://public.rpc.solanavibestation.com", { timeoutMs: 15_000 }), "find");
type Info = { owner: string; lamports: number; data: [string, string] } | null;
const many = async (keys: string[]) => ((await find("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }])) as { value: Info[] }).value;

async function standIns(token: string) {
  const mintInfo = (await many([token]))[0];
  if (!mintInfo) throw new Error(`no such mint ${token}`);
  const largest = ((await findLargest("getTokenLargestAccounts", [token, { commitment: "confirmed" }])) as { value: { address: string; amount: string }[] }).value;
  const accounts = await many(largest.map((x) => x.address));
  const holders = largest.flatMap((x, i) => {
    const acc = accounts[i];
    if (!acc || acc.owner !== mintInfo.owner || BigInt(x.amount) === 0n) return [];
    const owner = base58.encode(Buffer.from(acc.data[0], "base64").subarray(32, 64));
    return solanaAta(owner, token, mintInfo.owner) === x.address ? [{ owner, amount: BigInt(x.amount) }] : [];
  });
  const owners = await many(holders.map((c) => c.owner));
  const svas = await many(holders.map((c) => solanaVolumeAccumulator(c.owner, SOLANA_PUMP_AMM_PROGRAM)));
  const funded = holders.map((h, i) => ({ ...h, lamports: owners[i]?.owner === SOLANA_SYSTEM_PROGRAM ? owners[i]!.lamports : 0, sva: svas[i] !== null }));
  const sellers = funded.filter((h) => h.lamports >= 10_000_000).slice(0, 3);
  const buyers = funded
    .filter((h) => h.lamports <= 100e9 && BigInt(h.lamports) >= BUY_LAMPORTS + 20_000_000n)
    .sort((x, y) => Number(x.sva) - Number(y.sva) || Number(sellers.includes(x)) - Number(sellers.includes(y)))
    .slice(0, 3);
  if (args("--buyer").length) {
    const named = args("--buyer");
    const infos = await many(named);
    const svaN = await many(named.map((w) => solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM)));
    buyers.splice(0, buyers.length, ...named.map((owner, i) => {
      const inf = infos[i];
      if (!inf || inf.owner !== SOLANA_SYSTEM_PROGRAM || BigInt(inf.lamports) < BUY_LAMPORTS + 20_000_000n) throw new Error(`buyer ${owner} is not a funded system account`);
      return { owner, amount: 0n, lamports: inf.lamports, sva: svaN[i] !== null };
    }));
  }
  if (sellers.length < 3 || buyers.length < 1) throw new Error(`${token}: ${sellers.length} sellers and ${buyers.length} buyers fit`);
  return { sellers, buyers };
}

const paths = solanaSendPaths({ helper: solanaHelperRpc(HELPER) });
const deps = {
  helper: HELPER,
  providers,
  reference: async (q: { side: "buy" | "sell"; token: string; amount: bigint; amounts: readonly bigint[] }) => {
    const answer = await readSolanaReference(providers, q);
    recording.references.push({ q: { side: q.side, mint: q.token, amount: q.amount, amounts: q.amounts }, answer: answer && { expectedOut: answer.expectedOut, expectedOuts: answer.expectedOuts } });
    return answer;
  },
  fetch: async (url: string, init: RequestInit) => {
    const r = await fetch(url, init);
    const body = await r.text();
    recording.builds.push({ url, status: r.status, body });
    return new Response(body, { status: r.status, headers: r.headers });
  },
  paths,
  dry: true,
} as const;

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const leg = (l: SolanaTradeRecord["legs"][number]) => ({
  wallet: l.wallet,
  amount: l.amount,
  expectedOut: l.expectedOut,
  legExpectedOut: l.legExpectedOut,
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
const runs: unknown[] = [];
let good = true;
for (const token of TOKENS) {
  const { sellers, buyers } = await standIns(token);
  const side = async (s: "buy" | "sell", legs: { wallet: string; amount: bigint }[]) => {
    const w0 = waits.length;
    const t = performance.now();
    const request = { side: s, token, slippageBps: SLIPPAGE_BPS, legs: legs.map((l) => ({ ...l, arm: { own: true } })) };
    // "mint", not "token", in the files: gitleaks reads a base58 address under a "token" key as a secret.
    recording.requests.push({ side: s, mint: token, slippageBps: SLIPPAGE_BPS, legs: request.legs });
    const r = await runSolanaTrade(request, deps);
    const ms = Math.round(performance.now() - t);
    good &&= r.legs.every((l) => !l.refused && l.dry?.state === "simulated" && (l.size ?? 9_999) <= 1_232);
    // The harness's waits after an HTTP 429 or 503: a leg's quoteMs includes any of these it met.
    return { waits: waits.slice(w0), ms, reference: r.reference, blockhash: r.blockhash, legs: r.legs.map(leg) };
  };
  const buy = await side("buy", buyers.map((h) => ({ wallet: h.owner, amount: BUY_LAMPORTS })));
  const sell = await side("sell", sellers.map((h) => ({ wallet: h.owner, amount: h.amount })));
  runs.push({ mint: token, buyersWithoutPumpSwapVolumeAccount: buyers.filter((h) => !h.sva).map((h) => h.owner), buy, sell });
}
const text = JSON.stringify({ dry: true, at: new Date().toISOString(), helper: HELPER, providers: [PROVIDER_A, PROVIDER_B], slippageBps: SLIPPAGE_BPS, buyLamports: BUY_LAMPORTS, runs }, big, 1);
const rec = args("--record")[0];
if (rec) writeFileSync(rec, `${JSON.stringify(recording, big, 1)}\n`);
const file = args("--out")[0];
if (file) writeFileSync(file, `${text}\n`);
console.log(text);
if (!good) process.exit(1);
