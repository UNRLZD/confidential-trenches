// SOL_POOLS.mainnet (card sol-pools-mainnet-pin): the mainnet signing page's Solana pool pin, which every proof binds
// (src/pool/solana.ts bind: the context hashes the fee payer), is the deploy record's program and the fee payer the live
// helper signs mainnet releases with.
//   node --test test/sol-pool-mainnet-pin.test.ts      (from packages/wallet)
// The reads are test/vectors/sol-pool-mainnet-pin.json (test/record-sol-pool-pin.mjs; its recorded_at says when):
// - the program is contracts/pool-solana/deployments/mainnet.json's program_id (SOL_MAINNET_DEPLOY), an executable of
//   the upgradeable loader on two mainnet RPCs of two operators, and its pool account (the PDA ["pool"], solanaPoolOf)
//   is the record's pool, owned by the program on both;
// - the fee payer is the one the helper's GET /v1/pool/fee?cluster=mainnet names for that program and pool, a system
//   account with no data on both RPCs; the device's bind refuses any other answer, so a pin that is not the helper's
//   fee payer fails every mainnet release;
// - neither throwaway key of helper-sol-fee-payer-mainnet's recorded runs is the pin, and the fee payer is not the pool
//   or the program.
// Planted reads (another fee payer in the pin or in the helper's answer, a payer missing on one RPC, a program that is
// not executable, another pool) each fail, so the rule bites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SOL_MAINNET_DEPLOY, SOL_POOLS, solanaPoolOf, type SolanaPoolPin } from "../src/pool/solana.ts";

type Rpc = { url: string; status: number; json: any };
type Reads = { address: string; getAccountInfo: Rpc[] };
type Vector = { recorded_at: string; helper: { fee: { status: number; body: any } }; program: Reads; pool: Reads; fee_payer: Reads };
const V = JSON.parse(readFileSync(new URL("vectors/sol-pool-mainnet-pin.json", import.meta.url), "utf8")) as Vector;
const RECORD = JSON.parse(readFileSync(new URL("../../../contracts/pool-solana/deployments/mainnet.json", import.meta.url), "utf8")) as { cluster: string; program_id: string; pool: string };

/** Two keyless mainnet RPCs of two operators (scripts/live-checks/helper-sol-fee-payer-mainnet.mjs RPCS). */
const PAIR = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
/** helper-sol-fee-payer-mainnet's recorded runs' fresh keys, made on a temp server and thrown away: never a pin. */
const THROWAWAY = ["8Rj4ZJubKsa3dB9b63Y4eopdFbuchWPWsjohC8YAnEzL", "631fQArTgRXskKGAjUCxrwd75rFBEygZo2x3EP1AdrDd"];

/** [] when every read holds `pin` as the mainnet pool's: the record's program and pool, the helper's fee payer. */
function pinProblems(pin: SolanaPoolPin | undefined, v: Vector): string[] {
  if (pin === undefined) return ["SOL_POOLS.mainnet is not pinned"];
  const p: string[] = [];
  const { pool } = solanaPoolOf(pin.program);
  if (pin.program !== RECORD.program_id) p.push(`program ${pin.program} is not the deploy record's ${RECORD.program_id}`);
  if (pool !== RECORD.pool) p.push(`the program's pool ${pool} is not the deploy record's ${RECORD.pool}`);
  if (THROWAWAY.includes(pin.feePayer)) p.push(`fee payer ${pin.feePayer} is a throwaway key of helper-sol-fee-payer-mainnet's runs`);
  if (pin.feePayer === pool || pin.feePayer === pin.program) p.push("the fee payer is the pool or the program");
  const f = v.helper.fee;
  if (f.status !== 200) p.push(`the helper's fee answer is HTTP ${f.status}`);
  else {
    const b = f.body ?? {};
    if (b.chain !== "solana" || b.cluster !== "mainnet" || b.program !== pin.program || b.pool !== pool) p.push(`the helper's fee answer is not this pool's: ${JSON.stringify([b.chain, b.cluster, b.program, b.pool])}`);
    if (b.fee_payer !== pin.feePayer) p.push(`fee payer ${pin.feePayer} is not the helper's ${String(b.fee_payer)}`);
  }
  const each = (r: Reads, address: string, what: string, ok: (x: any) => boolean): void => {
    if (r.address !== address) return void p.push(`${what}: read ${r.address}, not ${address}`);
    if (JSON.stringify(r.getAccountInfo.map((x) => x.url)) !== JSON.stringify(PAIR)) p.push(`${what}: not read on ${PAIR.join(" and ")}`);
    for (const x of r.getAccountInfo) if (x.status !== 200 || !ok(x.json?.result?.value)) p.push(`${what} ${address} on ${x.url}: ${JSON.stringify(x.json?.result ? x.json.result.value : (x.json?.error ?? x.status))}`);
  };
  each(v.program, pin.program, "program", (a) => a?.executable === true && a.owner === LOADER);
  each(v.pool, pool, "pool", (a) => a?.owner === pin.program && a.executable === false);
  each(v.fee_payer, pin.feePayer, "fee payer", (a) => a?.owner === SYSTEM && a.executable === false && a.space === 0 && a.lamports > 0);
  return p;
}

test("SOL_POOLS.mainnet is the deploy record's program and the helper's mainnet fee payer, each read on two RPCs", () => {
  assert.deepEqual(pinProblems(SOL_POOLS.mainnet, V), []);
  assert.equal(SOL_POOLS.mainnet!.program, SOL_MAINNET_DEPLOY!.program, "one program pin, the deploy's");
  assert.ok(Object.isFrozen(SOL_POOLS.mainnet), "the pin is frozen");
});

test("planted: a fee payer that is not the helper's, in the pin or in the answer, is refused", () => {
  const pin = SOL_POOLS.mainnet ?? { program: RECORD.program_id, feePayer: String(V.helper.fee.body.fee_payer) };
  const v = (f: (x: Vector) => void): Vector => {
    const x = structuredClone(V);
    f(x);
    return x;
  };
  const has = (ps: string[], re: RegExp): void => assert.ok(ps.some((s) => re.test(s)), ps.join("\n") || "no problem found");
  for (const other of [...THROWAWAY, "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb"]) has(pinProblems({ ...pin, feePayer: other }, V), /is not the helper's/);
  has(pinProblems(pin, v((x) => (x.helper.fee.body.fee_payer = THROWAWAY[0]))), /is not the helper's 8Rj4/);
  has(pinProblems(pin, v((x) => (x.helper.fee.status = 404))), /HTTP 404/);
  has(pinProblems(pin, v((x) => (x.fee_payer.getAccountInfo[1]!.json.result.value = null))), /fee payer .* on https:\/\/solana-rpc\.publicnode\.com: null/);
  has(pinProblems(pin, v((x) => (x.fee_payer.getAccountInfo = [x.fee_payer.getAccountInfo[0]!, x.fee_payer.getAccountInfo[0]!]))), /fee payer: not read on/);
  has(pinProblems(pin, v((x) => (x.program.getAccountInfo[0]!.json.result.value.executable = false))), /^program .* on https:\/\/api\.mainnet-beta/);
  has(pinProblems({ ...pin, program: "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8" }, V), /is not the deploy record's/);
  has(pinProblems({ ...pin, feePayer: solanaPoolOf(pin.program).pool }, V), /the fee payer is the pool or the program/);
});
