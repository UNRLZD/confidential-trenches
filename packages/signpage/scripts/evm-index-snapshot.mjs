#!/usr/bin/env node
// The sign release's pool index snapshots (card robinhood-quote-answers-cold): one cold sync of each EVM chain's pool
// index on the venue's two index readers, the same sync the device runs (kit trade/evm/buy-tap.ts evmPoolIndexRefresh,
// checks/evm/pool-index.ts: every span proven on both readers), written to data/evm-index/<chain>.json in the
// snapshot's compact form (evmPoolIndexSnapshotOf) and read back through the page's own check (evmPoolIndexFromSnapshot)
// before it is written. The build copies them to /evm-index/<chain>.json (build-app.mjs SERVED), so the release list pins
// their bytes; a device with no kept index starts its sync from the snapshot at its first EVM coin quote and reads only
// the blocks past it.
// Read-only: nothing is signed or sent. Run it at each release cut, then commit the files.
//   node packages/signpage/scripts/evm-index-snapshot.mjs [--chain base|robinhood ...]   exit 0 written, 1 a sync failed
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolIndexRefresh } from "../../kit/src/trade/evm/buy-tap.ts";
import { evmPoolVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { evmPoolIndexFromSnapshot, evmPoolIndexSnapshotOf } from "../../kit/src/checks/evm/pool-index.ts";

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "evm-index");
const asked = process.argv.flatMap((a, i, all) => (all[i - 1] === "--chain" ? [a] : []));
const chains = asked.length > 0 ? asked : ["base", "robinhood"];
let failed = 0;
mkdirSync(OUT, { recursive: true });
for (const chain of chains) {
  const v = evmPoolVenues()[chain];
  if (v?.index === undefined || v.poolManager === undefined) {
    console.error(`evm-index-snapshot: ${chain} has no pool index`);
    failed++;
    continue;
  }
  const t0 = performance.now();
  const { sync, served } = await evmPoolIndexRefresh(chain, null);
  if (sync?.index == null || !served) {
    console.error(`evm-index-snapshot: ${chain}: the sync ended partial (${sync?.error?.message ?? "no index"})`);
    failed++;
    continue;
  }
  const text = JSON.stringify(evmPoolIndexSnapshotOf(sync.index));
  if (evmPoolIndexFromSnapshot(JSON.parse(text), { chainId: v.chainId, poolManager: v.poolManager, cap: v.index.cap }) === null) {
    console.error(`evm-index-snapshot: ${chain}: the snapshot does not read back`);
    failed++;
    continue;
  }
  writeFileSync(join(OUT, `${chain}.json`), text + "\n");
  console.log(`evm-index-snapshot: ${chain} ${sync.index.pools.length} pools through block ${sync.index.through}, ${text.length} bytes, ${Math.round(performance.now() - t0)} ms`);
}
process.exit(failed > 0 ? 1 : 0);
