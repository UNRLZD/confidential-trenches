// Records the devnet pool as the exit tool's Solana scan reads it, on the release's lister and two RPCs, for the offline
// tests (test/fixtures/devnet-sol.json). The words are the wallet's A.8 vector (packages/wallet/test/vectors/a8.json),
// public test words that hold nothing. It reads the network; the tests never do.
//   node packages/exit/scripts/record-sol.ts [out.json]
import { writeFileSync } from "node:fs";
import { EXIT_SOL_CLUSTERS, exitSolRpc } from "../src/sol-rpc.ts";
import { exitSolScan } from "../src/sol-scan.ts";
import { recordSolRpc, type SolFile, type SolRecording } from "../test/sol-replay.ts";

const out = process.argv[2] ?? new URL("../test/fixtures/devnet-sol.json", import.meta.url).pathname;
const net = EXIT_SOL_CLUSTERS.devnet;
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const rec = (url: string): SolRecording => ({ url, answers: [] });
const recs = { lister: rec(net.lister), rpcs: [rec(net.rpcs[0]), rec(net.rpcs[1])] as [SolRecording, SolRecording] };
const r = await exitSolScan({
  words: WORDS,
  cluster: "devnet",
  lister: recordSolRpc(exitSolRpc(net.lister), recs.lister),
  rpcs: [recordSolRpc(exitSolRpc(net.rpcs[0]), recs.rpcs[0]), recordSolRpc(exitSolRpc(net.rpcs[1]), recs.rpcs[1])],
});
const file: SolFile = { cluster: "devnet", program: net.program, recordedAt: new Date().toISOString(), ...recs };
writeFileSync(out, `${JSON.stringify(file)}\n`);
const count = (s: SolRecording, m: string) => s.answers.filter(([k]) => k.startsWith(`["${m}"`)).length;
console.log(`recorded ${out}: notes ${r.notes.length}, spends ${r.spends.length}; lister getProgramAccounts ${count(recs.lister, "getProgramAccounts")}; getMultipleAccounts ${count(recs.rpcs[0], "getMultipleAccounts")} and ${count(recs.rpcs[1], "getMultipleAccounts")}`);
