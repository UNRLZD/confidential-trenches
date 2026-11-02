// Captures the recorded answers for test/solana-teardown.test.ts: the teardown after a full sell (row M1.4; 06c S-4,
// S-5), simulated on real mainnet wallets that hold what a full sell leaves (token accounts with no tokens, the volume
// accounts under pump.fun's curve and PumpSwap). Per wallet: its accounts and lamports in one getMultipleAccounts on
// two public RPCs, the frames buildSolanaTeardown makes from those reads, and simulateSolanaTeardown's calls of each
// frame on both RPCs (sigVerify false, replaceRecentBlockhash true), every answer recorded as the RPC gave it.
// Nothing is signed or sent, and no key is used.
//   node packages/kit/test/fixtures/solana-teardown-capture.mjs <wallet>... > packages/kit/test/fixtures/solana-teardown.json
import { base64 } from "@scure/base";
import { SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM, solanaTeardownAddresses, solanaTeardownPlan } from "../../src/checks/solana/checks.ts";
import { buildSolanaTeardown, simulateSolanaTeardown } from "../../src/trade/solana/build.ts";

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
async function call(url, method, params) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${url} ${method}: 429 six times`);
}
const held = (a) => a && { owner: a.owner, lamports: BigInt(a.lamports), data: base64.decode(a.data[0]) };

const out = { readAt: new Date().toISOString(), rpcs: RPCS, wallets: [] };
for (const wallet of process.argv.slice(2)) {
  // The mints the wallet holds an account of (getTokenAccountsByOwner, which only the first RPC serves); the device
  // knows its own mints from its trades. The candidates are then solanaTeardownAddresses' own.
  const mints = [];
  for (const program of [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]) {
    const r = await call(RPCS[0], "getTokenAccountsByOwner", [wallet, { programId: program }, { encoding: "jsonParsed" }]);
    for (const a of r.value) mints.push({ mint: a.account.data.parsed.info.mint, program });
  }
  const addresses = solanaTeardownAddresses(wallet, mints);
  const reads = [];
  for (const url of RPCS) reads.push(await call(url, "getMultipleAccounts", [[wallet, ...addresses], { encoding: "base64", commitment: "confirmed" }]));
  const accounts = Object.fromEntries(addresses.map((x, i) => [x, [held(reads[0].value[i + 1]), held(reads[1].value[i + 1])]]));
  const plan = solanaTeardownPlan(wallet, accounts);
  const bh = await call(RPCS[0], "getLatestBlockhash", [{ commitment: "finalized" }]);
  const chain = { blockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight };
  const frames = buildSolanaTeardown(wallet, plan, chain);
  const sims = [];
  for (const f of frames) {
    const pair = [];
    for (const url of RPCS) {
      const calls = [];
      const rec = async (method, params) => { const result = await call(url, method, params); calls.push(result); return result; };
      await simulateSolanaTeardown(rec, f.wire, wallet, addresses);
      pair.push(calls);
    }
    sims.push(pair);
  }
  out.wallets.push({ wallet, mints, addresses, reads, chain, frames: frames.map((f) => base64.encode(f.wire)), sims });
}
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
