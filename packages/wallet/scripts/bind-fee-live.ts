// The bind's own fee reads for the live check of card device-evm-fee-read-walks-operators
// (scripts/live-checks/device-evm-fee-read-walks-operators.mjs runs this file, with scripts/net-window.mjs imported
// first, and judges what it prints). For each mainnet EVM chain it runs bind's reads in bind's order with the wallet's
// own functions (src/pool/evm.ts): evmEpochBlock on the pool's pair, the tree depth there, evmBindChainFee on two
// operators of the kit's read list, under evmRetryLag; at the current period's first block and, when that fails, at the
// next period's, as the proof queue's next pass does while the period's proof still lives (src/pool/queue.ts take). The
// depth is the pool's public currentTreeSize() at the block, read on two operators of the list (the device counts its
// sync's leaves there, the same number). A try that still fails on its last lag retry because a provider did not know
// the block yet records that provider's hosts as `lagging` (lag-hosts.ts), which the check judges INCONCLUSIVE. No key,
// no seed, nothing signed or sent. It prints one JSON record on stdout:
//   node --import ./scripts/net-window.mjs packages/wallet/scripts/bind-fee-live.ts
import { evmPoolProvidersOf, evmPoolVenues, evmReadProvidersOf, evmRpcOperator, evmTwoOperators, solanaJsonRpc, type SolanaRpc } from "@blindfill/kit";
import { evmBindChainFee, evmEpochBlock, evmRetryLag, type EvmNetwork } from "../src/pool/evm.ts";
import { laggingHosts, walkLag } from "./lag-hosts.ts";

const EPOCH_MS = 60_000;
/** currentTreeSize() */
const TREE_SIZE = "0xa8f0f95a";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const v = evmPoolVenues();
const out: Record<string, { tries: Record<string, unknown>[] }> = {};
for (const chain of ["base", "robinhood"] as const) {
  const venue = v[chain]!;
  const list = [...evmReadProvidersOf(venue)!];
  // a seat's client, marking the seats whose eth_call answered (the fee read's two operators) and each seat's last eth_call
  // refusal (lag-hosts.ts walkLag)
  const client = (url: string, answered?: Set<string>, refused?: Map<string, string>): SolanaRpc => {
    const rpc = solanaJsonRpc(url);
    return Object.assign(async (method: string, params: readonly unknown[]) => {
      let r;
      try {
        r = await rpc(method, params);
      } catch (e) {
        if (method === "eth_call") refused?.set(url, String((e as Error)?.message ?? e).slice(0, 300));
        throw e;
      }
      if (method === "eth_call") answered?.add(url);
      return r;
    }, { url });
  };
  const pairUrls = evmPoolProvidersOf(venue)!.slice(0, 2);
  const pair = [client(pairUrls[0]!), client(pairUrls[1]!)] as const;
  const tries: Record<string, unknown>[] = [];
  const start0 = Math.floor(Date.now() / EPOCH_MS) * EPOCH_MS;
  for (const start of [start0, start0 + EPOCH_MS]) {
    if (Date.now() < start + 5_000) await sleep(start + 5_000 - Date.now());
    const answered = new Set<string>();
    const refused = new Map<string, string>();
    const walk = evmTwoOperators(list.map((url) => ({ url, rpc: client(url, answered, refused) })));
    // a walk's read, a lag when every seat that refused it did not know the block (so evmRetryLag reads again)
    const walked = async <T>(f: () => Promise<T>): Promise<T> => {
      refused.clear();
      try {
        return await f();
      } catch (e) {
        throw walkLag(e, refused);
      }
    };
    try {
      const got = await evmRetryLag(async () => {
        const b = await evmEpochBlock(pair, BigInt(start));
        const [{ value: word }] = await walked(() => walk.read(`${chain} currentTreeSize() at block ${b.number}`, (rpc) => rpc("eth_call", [{ to: venue.pool, data: TREE_SIZE }, { blockHash: b.hash }]), (x, y) => x === y));
        const size = Number(BigInt(String(word)));
        let depth = 0;
        while (2 ** depth < size) depth++;
        answered.clear();
        const chainFee = await walked(() => evmBindChainFee(walk, chain as EvmNetwork, b, depth));
        // the block's base fee the pair agreed on: bind's fee is the kit's evmPoolFee at it (evm-deposit-on-mainnet.mjs)
        return { block: b.number.toString(), depth, chainFee: chainFee.toString(), baseFeePerGas: String(b.baseFeePerGas) };
      }, sleep);
      const used = list.filter((u) => answered.has(u));
      tries.push({ start: new Date(start).toISOString(), ok: true, ...got, hosts: used.map((u) => new URL(u).host), operators: used.map(evmRpcOperator) });
      break;
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      const noAnswer = /no answer in \d+ ms|HTTP 429|rate limit/i.test(m) && !/answered differently/.test(m);
      const lagging = laggingHosts(e, pairUrls);
      tries.push({ start: new Date(start).toISOString(), ok: false, name: noAnswer ? "noAnswer" : ((e as Error)?.name ?? "Error"), error: m.slice(0, 300), ...(lagging ? { lagging } : {}) });
    }
  }
  out[chain] = { tries };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
