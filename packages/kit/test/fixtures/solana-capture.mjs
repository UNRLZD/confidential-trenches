// Captures the recorded answers for test/solana-quote.test.ts: two real Solana swaps the G1 phone proof built on the
// device and landed (one buy, one sell; signatures from the research repo's
// proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json, results[0] and results[1]), read back keyless from
// two public RPCs, with the lookup table and the mint they use. Nothing is signed, sent or keyed: reads only.
//   node packages/kit/test/fixtures/solana-capture.mjs > packages/kit/test/fixtures/solana-swaps.json
import { solanaDecodeTransaction } from "../../src/checks/solana/message.ts";
const RPCS = ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"];
const TRADES = [
  // results[0]: buy 9874873 lamports of the token, quote minOut 46256353721
  { side: "buy", sig: "2btTg7crbv6EL6DJtpNo67Vv9J2vioFHz4uMTuHR2hrWnJMumu7PQb9gYQwToV3ac55LGw418hL28JvChi8oc4Rv", amount: "9874873", minOut: "46256353721" },
  // results[1]: sell 55991176135 base units, quote minOut 8738871 lamports
  { side: "sell", sig: "4hN9gQ1PQPSDUJrHAXLHDaYd6mK2C6V3a3KtSoMoUb3nC2X1MEiKswTo6XzGfuoQ7Fb1Le7x3JU648dMwcdrLDA8", amount: "55991176135", minOut: "8738871" },
];
const WALLET = "GjM2Cqaj88NsBQSAUfBT25Q9u2uKT7ZHZtF2AZe5cMDa";
const MINT = "FV89Mg4w2vEinVAU9KbVVL8JQZGutDeh5EFSAJyCpump";

async function rpc(url, method, params) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${url} ${method}: 429 five times`);
}
const acct = (a) => a && { owner: a.owner, lamports: a.lamports, data: a.data[0] };

const out = { readAt: new Date().toISOString(), rpcs: RPCS, wallet: WALLET, mint: MINT, source: "proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json results[0..1] (research repo)", trades: [] };
for (const t of TRADES) {
  const per = [];
  for (const url of RPCS) {
    const tx = await rpc(url, "getTransaction", [t.sig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
    per.push(tx);
  }
  if (per[0].transaction[0] !== per[1].transaction[0]) throw new Error(`${t.sig}: the two RPCs return different bytes`);
  const m = per[0].meta;
  out.trades.push({ ...t, slot: per[0].slot, tx: per[0].transaction[0],
    meta: { err: m.err, fee: m.fee, preBalances: m.preBalances, postBalances: m.postBalances, preTokenBalances: m.preTokenBalances, postTokenBalances: m.postTokenBalances, loadedAddresses: m.loadedAddresses, computeUnitsConsumed: m.computeUnitsConsumed } });
}
// The tables the trades use, and the mint, on each RPC (provider A first, B second).
const tableKeys = [...new Set(out.trades.flatMap((t) => solanaDecodeTransaction(Buffer.from(t.tx, "base64")).message.lookups.map((l) => l.table)))];
out.tables = {};
for (const k of tableKeys) {
  out.tables[k] = [];
  for (const url of RPCS) out.tables[k].push(acct((await rpc(url, "getMultipleAccounts", [[k], { encoding: "base64", commitment: "processed" }])).value[0]));
}
out.mintReads = [];
out.rentExempt = {};
for (const url of RPCS) {
  const res = await rpc(url, "getMultipleAccounts", [[MINT], { encoding: "base64", commitment: "processed" }]);
  out.mintReads.push(acct(res.value[0]));
  out.rentExempt[url] = { 137: await rpc(url, "getMinimumBalanceForRentExemption", [137]), 170: await rpc(url, "getMinimumBalanceForRentExemption", [170]) };
}
console.log(JSON.stringify(out, null, 1));
