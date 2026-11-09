// Records the mainnet pools' reads for the Verify fixtures and the model tests (card verify-pools): readPool on each
// pool's pair as release.ts names it, live, written whole to pool-reads.json. Test only.
//   node apps/terminal/test/verify/record-pools.ts
import { writeFileSync } from "node:fs";
import { POOL_CHAINS, poolRpc, poolRow, readPool, type PoolPin } from "../../src/screens/verify/pools.ts";
import { VERIFY_RELEASES } from "../../src/screens/verify/release.ts";

const out: Record<string, unknown> = { notes: [`readPool on each mainnet pool's pair (release.ts), live, ${new Date().toISOString()}`] };
for (const c of POOL_CHAINS) {
  const p = VERIFY_RELEASES.mainnet.pools[c] as PoolPin;
  const reads = await readPool(p, poolRpc());
  const row = await poolRow(reads, p);
  console.log(c, row.status, row.checks.map((x) => `${x.id} ${x.status}${x.word ? ` ${x.word}` : ""}`).join(", "), row.height);
  out[c] = reads;
}
writeFileSync(new URL("./pool-reads.json", import.meta.url), JSON.stringify(out) + "\n");
