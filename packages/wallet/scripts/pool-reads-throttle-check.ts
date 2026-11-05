// The device half of card evm-pool-reads-throttle's live check (scripts/live-checks/evm-pool-reads-throttle.mjs runs it
// as a child process): every read a pool buy or withdraw makes before W signs, src/pool/evm.ts's evmPool on the
// network's pinned pool and providers (the kit's evmPoolVenues), with no second implementation of any check. Its RPCs
// are a bridge over stdio, as in ./transfer-rpcs-check.ts, so the live check makes every network call (and its
// provider stand-in throttles, records or replays them) and this file makes none:
//   node packages/wallet/scripts/pool-reads-throttle-check.ts '{"network":"base-sepolia","fromBlock":"…","feeRecipient":"0x…",
//     "rpcs":["https://…","https://…"],"wait":true}'   (rpcs: the sync's pair; absent, the kit's pinned providers)
// stdout, one JSON object a line: {"rpc":{"id","k","url","method","params"}} for each call (k: 0 and 1 the sync's pair,
// 2 and 3 the fee pair), then {"done":report} or {"fail":message}; stdin, one a line: {"id","result"} or {"id","error"}
// (with the client's "name" and "afterMs" when it gave them, so a SolanaRpcTransportError keeps its name across).
// What it runs, on the kit's pinned pool and fee pair, as the proof queue's pass does for one note (src/pool/queue.ts),
// after one pass that makes the sync's cache: the pool's now(), trees(the epoch's start), then bind for one chunk of EVM_LADDER.min to a W (the address of the published test scalar 1, never money),
// at that epoch with the deadline epoch start + EVM_LIFE_MS. The relayer's fee answer is the device's own fee for that
// epoch (the check is the device's reads, not the helper's), so bind's only refusals are its reads'. Nothing is signed
// or sent. The report: the epoch, the trees' size and roots, the binding's fee, deadline and context.
import { createInterface } from "node:readline";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { evmPoolFee, evmPoolGas, evmPoolVenues } from "@blindfill/kit";
import { evmAddress } from "../src/derive/index.ts";
import { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, evmPool, type EvmFeeAnswer, type EvmNetwork, type EvmRpc } from "../src/pool/evm.ts";

type Args = { network: EvmNetwork; fromBlock: string; feeRecipient: string; rpcs?: [string, string]; wait: boolean };

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
  const venue = evmPoolVenues()[a.network];
  const providers = venue?.providers;
  const feeProviders = (venue as { feeProviders?: readonly string[] } | undefined)?.feeProviders ?? providers;
  const pinned = venue?.pool;
  if (venue === undefined || pinned === undefined || providers === undefined || feeProviders === undefined) throw new Error(`network: no pinned pool or providers for ${String(a.network)}`);
  const poolAddr = pinned.toLowerCase();
  const sync = a.rpcs ?? providers;
  const urls = [sync[0]!, sync[1]!, feeProviders[0]!, feeProviders[1]!];
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
  const sleep = a.wait ? undefined : async () => {};
  let mine: { block: bigint; fee: bigint } | null = null;
  const pool = evmPool({
    pin: { network: a.network, pool: poolAddr, feeRecipient: a.feeRecipient, fromBlock: BigInt(a.fromBlock) },
    rpcs: [bridge(0), bridge(1)],
    feeRpcs: [bridge(2), bridge(3)],
    epochFee: ({ block, baseFeePerGas, depth, chainFee }) => {
      const fee = evmPoolFee({ gas: evmPoolGas(depth), gasPrice: baseFeePerGas, chainFee });
      mine = { block, fee };
      return fee;
    },
    relayFee: async (epochStartMs): Promise<EvmFeeAnswer> => {
      if (mine === null) throw new Error("relayFee before the device's own fee");
      const { block, fee } = mine;
      return { chain: "evm", network: a.network, pool: poolAddr, fee_recipient: a.feeRecipient, epoch_ms: Number(EVM_EPOCH_MS), epoch_start_ms: Number(epochStartMs), block: `0x${block.toString(16)}`, fee: fee.toString(), step: "1" };
    },
    ...(sleep ? { sleep } : {}),
  });
  // the first sync reads the pool's logs from its deploy block (minutes on a 200-block page): the queue's first pass
  // makes the cache; this check's pass, like every later one, reads only past it, inside its epoch
  const warm = await pool.now();
  await pool.trees(warm - (warm % EVM_EPOCH_MS));
  const nowMs = await pool.now();
  const start = nowMs - (nowMs % EVM_EPOCH_MS);
  const trees = await pool.trees(start);
  // W: the address of secp256k1's generator (the published scalar 1): a binding only, nothing signed
  const pub = secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)), true);
  const b = await pool.bind({ chunk: EVM_LADDER.min, wallet: { address: evmAddress(pub), publicKey: pub }, refundPrecommitment: 5n, epochStartMs: start, deadlineMs: start + EVM_LIFE_MS });
  out({
    done: {
      urls, pool: poolAddr, nowMs: nowMs.toString(), epochStartMs: start.toString(), size: trees.stateTree.size, stateRoot: trees.stateRoot.toString(), labelRoot: trees.labelRoot.toString(),
      fee: b.feeCap.toString(), deadlineMs: b.request.relay.deadlineMs.toString(), recipient: b.request.relay.recipient, context: b.context.toString(),
    },
  });
  process.exit(0);
} catch (e) {
  out({ fail: `${(e as Error)?.name ?? "Error"}: ${String((e as Error)?.message ?? e)}` });
  process.exit(0);
}
