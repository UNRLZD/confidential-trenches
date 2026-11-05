// The device half of card wallet-restore-transfer-rpcs's live check (scripts/live-checks/wallet-restore-transfer-rpcs.mjs
// runs it as a child process): a restore's W read, src/pool/evm.ts, on the network's own Transfer pair
// (EVM_TRANSFER_RPCS), with no second implementation of any check. Its two RPCs are a bridge over stdio, as in
// ./rpc-hex-case-check.ts, so the live check makes every network call (and records or replays it) and this file makes
// none:
//   node packages/wallet/scripts/transfer-rpcs-check.ts '{"network":"base-sepolia","w":"0x…","from":"54553944","wait":true}'
//   ("back":"2000" in place of "from": the newest 2,000 blocks)
// stdout, one JSON object a line: {"rpc":{"id","k","url","method","params"}} for each call, then {"done":report} or
// {"fail":message}; stdin, one a line: {"id","result"} or {"id","error"}.
// What it runs, on both RPCs, as evmRestoreNotes does for each W: the finalized and the newest agreed anchors
// (evmAgreedBlock), evmHoldsAnchor (the network's chain id on both, the anchor's hash held on both), then
// evmTokensSentTo (the W's Transfer logs from `from` to the newest anchor, paged under each provider's own cap, the
// same on both byte for byte), each a retry on a lag (evmRetryLag). The report: the URLs, the anchor, the tokens and
// each RPC's last page size.
import { createInterface } from "node:readline";
import { EVM_CHAIN_IDS, EVM_LOG_PAGE_BLOCKS, EVM_NEWEST_TAG, EVM_POOL_TAG, EVM_TRANSFER_RPCS, evmAgreedBlock, evmHoldsAnchor, evmRetryLag, evmTokensSentTo, type EvmNetwork, type EvmRpc } from "../src/pool/evm.ts";

type Args = { network: EvmNetwork; w: string; from?: string; back?: string; wait: boolean };

const a = JSON.parse(process.argv[2] ?? "null") as Args;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as { id: number; result?: unknown; error?: string };
  const w = waiting.get(m.id);
  if (w === undefined) return;
  waiting.delete(m.id);
  if (m.error !== undefined) w.reject(new Error(m.error));
  else w.resolve(m.result);
});

try {
  const urls = EVM_TRANSFER_RPCS[a.network];
  const chainId = EVM_CHAIN_IDS[a.network];
  if (urls === undefined || chainId === undefined) throw new Error(`network: unknown ${String(a.network)}`);
  const bridge = (k: number): EvmRpc =>
    Object.assign(
      (method: string, params: readonly unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const id = next++;
          waiting.set(id, { resolve, reject });
          out({ rpc: { id, k, url: urls[k], method, params } });
        }),
      { url: urls[k]! },
    );
  const rpcs: [EvmRpc, EvmRpc] = [bridge(0), bridge(1)];
  const sleep = a.wait ? undefined : async () => {};
  const page = [EVM_LOG_PAGE_BLOCKS, EVM_LOG_PAGE_BLOCKS];
  const read = async () => {
    const fin = await evmAgreedBlock(rpcs, EVM_POOL_TAG);
    const anchor = await evmAgreedBlock(rpcs, EVM_NEWEST_TAG);
    await evmHoldsAnchor(rpcs, chainId, anchor);
    const from = a.from !== undefined ? BigInt(a.from) : anchor.number - BigInt(a.back ?? "0");
    return { anchor, from, tokens: await evmTokensSentTo(rpcs, a.w, from, { fin, anchor }, page) };
  };
  const r = await evmRetryLag(read, sleep);
  out({ done: { urls, chainId: chainId.toString(), anchor: { number: r.anchor.number.toString(), hash: r.anchor.hash }, from: r.from.toString(), tokens: r.tokens, page: page.map(String) } });
  process.exit(0);
} catch (e) {
  out({ fail: String((e as Error)?.message ?? e) });
  process.exit(0);
}
