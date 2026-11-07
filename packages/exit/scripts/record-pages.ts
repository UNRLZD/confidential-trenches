// Records the testnet vault's four lists as the exit tool reads them, on the release's two public RPCs, for the
// offline tests (test/fixtures/testnet-pages.json). It reads the network; the tests never do.
//   node packages/exit/scripts/record-pages.ts [out.json]
import { writeFileSync } from "node:fs";
import { EXIT_NETWORKS, exitReadPages, exitRpc } from "../src/rpc.ts";
import { recordRpc, type PagesFile, type Recording } from "../test/replay.ts";

const out = process.argv[2] ?? new URL("../test/fixtures/testnet-pages.json", import.meta.url).pathname;
const net = EXIT_NETWORKS.testnet;
const recs: [Recording, Recording] = [
  { url: net.rpcs[0], answers: [] },
  { url: net.rpcs[1], answers: [] },
];
const r = await exitReadPages({ network: "testnet", rpcs: [recordRpc(exitRpc(net.rpcs[0]), recs[0]), recordRpc(exitRpc(net.rpcs[1]), recs[1])] });
const file: PagesFile = { network: "testnet", vault: net.vault, recordedAt: new Date().toISOString(), rpcs: recs };
writeFileSync(out, `${JSON.stringify(file)}\n`);
console.log(
  `recorded ${out}: block ${r.height} ${r.blockHash}, deposits ${r.deposits.length}, spends ${r.spends.length}, leaves ${r.leaves.length}, labels ${r.labels.length}`,
);
