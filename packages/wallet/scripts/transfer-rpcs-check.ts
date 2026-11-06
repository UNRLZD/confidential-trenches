// The device half of card wallet-restore-transfer-rpcs's live check (scripts/live-checks/wallet-restore-transfer-rpcs.mjs
// runs it as a child process): a restore's W read, src/pool/evm.ts, as src/pool/evm-restore.ts makes it, with no second
// implementation of any check: on Base and Robinhood on the helper's route (POST <helper>/v1/rpc/{chain}, one reader,
// paced at HOLDINGS_RPC_LIMIT as src/pool/buy-wallets.ts evmHelperRpc paces it: evmTokensSentToOne), on a testnet on its
// own Transfer list (EVM_TRANSFER_RPCS, read as a pair with a spare: evmPair). Its RPCs are a bridge over stdio, as in
// ./rpc-hex-case-check.ts, so the live check makes every network call (and records or replays it) and this file makes
// none:
//   node packages/wallet/scripts/transfer-rpcs-check.ts '{"network":"base-sepolia","w":"0x…","from":"54553944","wait":true}'
//   ("back":"2000" in place of "from": the newest 2,000 blocks; "helper":"https://…" on Base and Robinhood; "pool":[urls]
//   reads a pool list's shape instead, below)
// stdout, one JSON object a line: {"rpc":{"id","k","url","method","params"}} for each call, then {"done":report} or
// {"fail":message}; stdin, one a line: {"id","result"} or {"id","error"} (with the client's "name" and "afterMs" when
// it gave them: a SolanaRpcTransportError, a throttle the pager waits out, keeps its name and Retry-After across the
// bridge).
// What it runs on a testnet, on both RPCs, as evmRestoreNotes does for each W: the finalized and the newest agreed anchors
// (evmAgreedBlock), evmHoldsAnchor (the network's chain id on both, the anchor's hash held on both), then
// evmTokensSentTo (the W's Transfer logs from `from` to the newest anchor, paged under each provider's own cap, the
// same on both byte for byte), each a retry on a lag (evmRetryLag). The report: the network's list, the two seats' URLs
// at the end, every URL asked, the anchor, the tokens and each seat's last page size. On Base and Robinhood: the
// finalized and the newest block on the route (the device takes them from the pool pair), then evmTokensSentToOne (the
// anchor's hash held on the route, the W's Transfer logs paged under its cap), a retry on a lag. With "pool" (a pool
// list, the kit's evmPoolVenues providers, read as a pair with spares: evmPair, as evmPool and evmTreeSync read it): the
// same anchors and evmHoldsAnchor, then a log read of the pool's shape (an address, here W, which has no logs, and the
// pool's three event topics) over the blocks asked, alike on both (evmAgreedLogs); no W is named in a topic.
import { createInterface } from "node:readline";
import { solanaPacedRpc } from "@blindfill/kit";
import { HOLDINGS_RPC_LIMIT } from "../src/pool/buy-wallets.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_CHAIN_IDS, EVM_LOG_CEILING_PAGES, EVM_LOG_PAGE_BLOCKS, EVM_NEWEST_TAG, EVM_POOL_EVENTS, EVM_POOL_TAG, EVM_TRANSFER_RPCS, evmAgreedBlock, evmAgreedLogs, evmAnswered, evmHoldsAnchor, evmPair, evmRetryLag, evmRpcHex, evmTokensSentTo, evmTokensSentToOne, type EvmBlock, type EvmNetwork, type EvmRpc } from "../src/pool/evm.ts";

type Args = { network: EvmNetwork; w: string; from?: string; back?: string; wait: boolean; helper?: string; pool?: readonly string[] };

const a = JSON.parse(process.argv[2] ?? "null") as Args;
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let next = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as { id: number; result?: unknown; error?: string; name?: string; afterMs?: number | null };
  const w = waiting.get(m.id);
  if (w === undefined) return;
  waiting.delete(m.id);
  if (m.error !== undefined) w.reject(Object.assign(new Error(m.error), m.name ? { name: m.name } : {}, m.afterMs !== undefined ? { afterMs: m.afterMs } : {}));
  else w.resolve(m.result);
});

try {
  const mainnet = a.network === "base" || a.network === "robinhood";
  const urls = a.pool ?? (mainnet ? [`${new URL(a.helper ?? "").origin}/v1/rpc/${a.network}`] : EVM_TRANSFER_RPCS[a.network as keyof typeof EVM_TRANSFER_RPCS]);
  const chainId = EVM_CHAIN_IDS[a.network];
  if (urls === undefined || chainId === undefined) throw new Error(`network: unknown ${String(a.network)}`);
  const asked = new Set<string>();
  const bridge = (k: number): EvmRpc =>
    Object.assign(
      (method: string, params: readonly unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const id = next++;
          waiting.set(id, { resolve, reject });
          asked.add(urls[k]!);
          out({ rpc: { id, k, url: urls[k], method, params } });
        }),
      { url: urls[k]! },
    );
  const sleep = a.wait ? undefined : async () => {};
  if (mainnet && a.pool === undefined) {
    // the device's reader: one paced transport on the route, its queue keyed on its own function (evmHelperRpc); a
    // replay ("wait": false) reaches no provider, so it waits on no pace either, as it waits on no Retry-After
    const one = bridge(0);
    const reader = a.wait ? solanaPacedRpc((m, p) => one(m, p), HOLDINGS_RPC_LIMIT) : one;
    const block = async (at: string): Promise<EvmBlock> => {
      const b = (await evmAnswered(() => reader("eth_getBlockByNumber", [at, false]), undefined, sleep)) as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
      const n = evmRpcHex(b?.number), h = evmRpcHex(b?.hash), t = evmRpcHex(b?.timestamp);
      if (n === null || h === null || t === null) throw new Error(`block ${at}: not a block`);
      return { number: BigInt(n), hash: h, timestamp: BigInt(t), baseFeePerGas: null };
    };
    const page = [EVM_LOG_PAGE_BLOCKS];
    const r = await evmRetryLag(async () => {
      const fin = await block(EVM_POOL_TAG);
      const anchor = await block(EVM_NEWEST_TAG);
      const from = a.from !== undefined ? BigInt(a.from) : anchor.number - BigInt(a.back ?? "0");
      return { anchor, from, tokens: await evmTokensSentToOne(reader, a.w, from, { fin, anchor }, page, undefined, sleep) };
    }, sleep);
    out({ done: { list: urls, urls, asked: urls.filter((u) => asked.has(u)), chainId: chainId.toString(), anchor: { number: r.anchor.number.toString(), hash: r.anchor.hash }, from: r.from.toString(), tokens: r.tokens, page: page.map(String) } });
    process.exit(0);
  }
  const rpcs = evmPair(urls.map((_, k) => bridge(k)));
  const page = [EVM_LOG_PAGE_BLOCKS, EVM_LOG_PAGE_BLOCKS];
  const read = async () => {
    // the device takes its anchors from the pool pair's sync; here the Transfer pair's stand-in, each read again on a
    // throttle as evmHoldsAnchor's own reads are (evmAnswered)
    const fin = await evmAnswered(() => evmAgreedBlock(rpcs, EVM_POOL_TAG), undefined, sleep);
    const anchor = await evmAnswered(() => evmAgreedBlock(rpcs, EVM_NEWEST_TAG), undefined, sleep);
    await evmHoldsAnchor(rpcs, chainId, anchor, undefined, sleep);
    const from = a.from !== undefined ? BigInt(a.from) : anchor.number - BigInt(a.back ?? "0");
    if (a.pool === undefined) return { anchor, from, tokens: await evmTokensSentTo(rpcs, a.w, from, { fin, anchor }, page, undefined, sleep) };
    const topic = (sig: string) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex")}`;
    const filter = { address: a.w.toLowerCase(), topics: [[topic(EVM_POOL_EVENTS.Deposited), topic(EVM_POOL_EVENTS.Withdrawn), topic(EVM_POOL_EVENTS.Bought)]] };
    // the pool sync's page ceiling (EVM_LOG_CEILING_PAGES, card notes-per-pool-evm-base-hang), as evmTreeSync reads
    const logs = await evmAgreedLogs(rpcs, filter, () => { throw new Error("a log at an address with none"); }, from, { fin, anchor }, page, 0, undefined, sleep, EVM_LOG_CEILING_PAGES);
    return { anchor, from, tokens: logs.map(String) };
  };
  const r = await evmRetryLag(read, sleep);
  out({ done: { list: urls, urls: rpcs.map((r) => r.url), asked: urls.filter((u) => asked.has(u)), chainId: chainId.toString(), anchor: { number: r.anchor.number.toString(), hash: r.anchor.hash }, from: r.from.toString(), tokens: r.tokens, page: page.map(String) } });
  process.exit(0);
} catch (e) {
  out({ fail: String((e as Error)?.message ?? e) });
  process.exit(0);
}
