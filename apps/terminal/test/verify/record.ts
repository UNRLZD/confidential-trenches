// Records Verify's reads for test/verify.test.ts and the fixture page: readVerify (src/screens/verify/read.ts) against
// the testnet skeleton vault (contracts/vault/deployments/testnet-skeleton.json) on fastnear and drpc, the same two
// RPCs scripts/live-checks/vault-skeleton.mjs reads. Run by hand only; writes test/verify/reads.json.
//   node apps/terminal/test/verify/record.ts
import { writeFileSync } from "node:fs";
import { readVerify } from "../../src/screens/verify/read.ts";
import type { VerifyPins } from "../../src/screens/verify/read.ts";

const RPCS = [
  ["fastnear", "https://test.rpc.fastnear.com"],
  ["drpc", "https://near-testnet.drpc.org"],
] as const;
const PINS = {
  vault: "vault.bf-vs-20261101t012200.testnet",
  asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
} as VerifyPins;

const rpc = ([name, url]: readonly [string, string]) => ({
  name,
  async query(params: Record<string, unknown>) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query", params }) });
    return await r.json();
  },
});
const reads = await readVerify([rpc(RPCS[0]), rpc(RPCS[1])], PINS);
const out = { vault: PINS.vault, asset: PINS.asset, recorded_at: new Date().toISOString(), urls: Object.fromEntries(RPCS), ...reads };
writeFileSync(new URL("./reads.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${PINS.vault} at block ${reads.height} on ${RPCS.map(([n]) => n).join(" and ")}`);
