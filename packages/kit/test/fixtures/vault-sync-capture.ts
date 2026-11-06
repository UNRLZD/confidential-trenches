// Records fixtures/vault-sync-pages.json's `recorded` set: the testnet vault the set names, read by the kit's own
// vaultSync on its two RPCs, every query and answer kept in the order asked. It reads the network; the tests never do.
//   node packages/kit/test/fixtures/vault-sync-capture.ts
import { readFileSync, writeFileSync } from "node:fs";
import { vaultSync, vaultSyncStart, type VaultSyncRpc } from "../../src/index.ts";

const path = new URL("./vault-sync-pages.json", import.meta.url);
const fix = JSON.parse(readFileSync(path, "utf8"));
const { vault, rpcs: urls } = fix.recorded as { vault: string; rpcs: [string, string] };
const answers: { rpc: string; params: Record<string, unknown>; answer: unknown }[] = [];
const rpc = (url: string): VaultSyncRpc => ({
  name: url,
  async query(params, signal) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: "query", params }),
      ...(signal ? { signal } : {}),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const answer = await res.json();
    answers.push({ rpc: url, params, answer });
    return answer;
  },
});
const r = await vaultSync({ vault, rpcs: [rpc(urls[0]), rpc(urls[1])], cursor: vaultSyncStart(vault) });
fix.recorded = { recorded_at: new Date().toISOString(), vault, rpcs: urls, answers };
// one space a level, as the file was written, with each answer's bytes on one line
const text = JSON.stringify(fix, null, 1).replace(/\[\n\s*(\d+(?:,\n\s*\d+)*)\n\s*\]/g, (_, xs: string) => `[${xs.split(/,\n\s*/).join(",")}]`);
writeFileSync(path, `${text}\n`);
console.log(`recorded ${answers.length} answers at block ${r.height} ${r.blockHash}: deposits ${r.deposits.length}, spends ${r.spends.length}, leaves ${r.leaves.length}, labels ${r.labels.length}`);
