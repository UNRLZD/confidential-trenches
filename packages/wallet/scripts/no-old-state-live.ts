// The device's reads for the live check of card evm-device-reads-need-no-old-state
// (scripts/live-checks/evm-device-reads-need-no-old-state.mjs runs this file, with scripts/net-window.mjs imported
// first, and judges what it prints). For each mainnet EVM chain, both at once, as the signing page runs them:
//   - the hold: at the next period's turn + 3 s (the page's EVM_TURN_PASS_MS, its spread left out), the period's first
//     block on the pool's pair (evmEpochBlock), then at once the period's fee state there on two operators of the kit's
//     read list (evmPeriodChainFee: Base the pool's currentTreeSize() then the fee at that depth, Robinhood the fee
//     alone), under the wallet's lag retries: the read the page holds for the period; feeAgeMs is the block's age when
//     the fee's answers were in;
//   - a bind 30 s into the period: the period's first block found again on the pair, by headers alone; the held read
//     stands when its hash is the same, so the bind asks no state (stateReads counts the eth_calls it made: none);
//   - the sync's root times: the pool's currentRoot() at the newest agreed block (fresh), then 30 s on its
//     stateRootTimes at a fresh newest block's hash on two operators of the list, which must agree and be non-zero (a
//     pool with no leaf yet: root 0, never timed, so 0), under the wallet's lag retries as the page's sync reads them.
// A read that still fails on its last lag retry because a provider did not know the fresh block yet records that
// provider's hosts as `lagging` (lag-hosts.ts), which the check judges INCONCLUSIVE, never FAIL.
// No key, no seed, nothing signed or sent. It prints one JSON record on stdout:
//   node --import ./scripts/net-window.mjs packages/wallet/scripts/no-old-state-live.ts
import { evmPoolProvidersOf, evmPoolVenues, evmReadProvidersOf, evmRpcOperator, evmTwoOperators, solanaJsonRpc, type SolanaRpc } from "@blindfill/kit";
import { evmAgreedBlock, evmEpochBlock, evmPeriodChainFee, evmRetryLag, type EvmNetwork } from "../src/pool/evm.ts";
import { laggingHosts, walkLag } from "./lag-hosts.ts";

const EPOCH_MS = 60_000;
const TURN_MS = 3_000;
const SEL = { root: "0xfdab463d", times: "0x4b278d9c" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const err = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const v = evmPoolVenues();
const start = Math.ceil(Date.now() / EPOCH_MS) * EPOCH_MS;

async function chainRun(chain: "base" | "robinhood") {
  const venue = v[chain]!;
  const list = [...evmReadProvidersOf(venue)!];
  let calls = 0;
  // a seat's client, marking the seats whose eth_call answered and each seat's last eth_call refusal (lag-hosts.ts walkLag)
  const client = (url: string, answered?: Set<string>, refused?: Map<string, string>): SolanaRpc => {
    const rpc = solanaJsonRpc(url);
    return Object.assign(async (method: string, params: readonly unknown[]) => {
      if (method === "eth_call") calls++;
      let r;
      try {
        r = await rpc(method, params);
      } catch (e) {
        if (method === "eth_call") refused?.set(url, err(e));
        throw e;
      }
      if (method === "eth_call") answered?.add(url);
      return r;
    }, { url });
  };
  const pu = evmPoolProvidersOf(venue)!.slice(0, 2);
  const pair = [client(pu[0]!), client(pu[1]!)] as const;
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
  const failed = (e: unknown) => {
    const lagging = laggingHosts(e, pu);
    return { ok: false, name: (e as Error)?.name ?? "Error", error: err(e), ...(lagging ? { lagging } : {}) };
  };
  const out: Record<string, unknown> = { start: new Date(start).toISOString() };
  // the sync's anchor, read now (fresh): the pool's current root
  let root: string | null = null;
  try {
    root = await evmRetryLag(async () => {
      const a = await evmAgreedBlock(pair, "latest");
      const [{ value }] = await walked(() => walk.read(`${chain} currentRoot() at ${a.number}`, (rpc) => rpc("eth_call", [{ to: venue.pool, data: SEL.root }, { blockHash: a.hash }]), (x, y) => x === y));
      return String(value);
    }, sleep);
  } catch (e) {
    out.times = failed(e);
  }
  // the hold, at the turn + 3 s
  await sleep(start + TURN_MS - Date.now());
  let held: { number: bigint; hash: string } | null = null;
  try {
    const got = await evmRetryLag(async () => {
      const b = await evmEpochBlock(pair, BigInt(start));
      answered.clear();
      const f = await walked(() => evmPeriodChainFee(walk, chain as EvmNetwork, venue.pool!, b));
      return { b, ...f };
    }, sleep);
    held = { number: got.b.number, hash: got.b.hash };
    const used = list.filter((u) => answered.has(u));
    out.hold = { ok: true, atMs: Date.now() - start, block: got.b.number.toString(), depth: got.depth, chainFee: got.chainFee.toString(), feeAgeMs: got.feeAtMs - Number(got.b.timestamp) * 1000, hosts: used.map((u) => new URL(u).host), operators: used.map(evmRpcOperator) };
  } catch (e) {
    out.hold = { ...failed(e), atMs: Date.now() - start };
  }
  // a bind 30 s in: the first block again, by headers; the held read when its hash holds
  await sleep(start + 30_000 - Date.now());
  if (held !== null) {
    const before = calls;
    try {
      const b = await evmRetryLag(() => evmEpochBlock(pair, BigInt(start)), sleep);
      out.bind = { ok: b.hash === held.hash, sameHash: b.hash === held.hash, stateReads: calls - before };
    } catch (e) {
      out.bind = { ...failed(e), stateReads: calls - before };
    }
  } else out.bind = { ok: false, error: "nothing held" };
  // the sync's root times at a fresh block
  if (root !== null) {
    try {
      // the page's sync reads under evmRetryLag (src/pool/evm.ts trees): a seat behind the fresh block is read again
      const value = await evmRetryLag(async () => {
        const f = await evmAgreedBlock(pair, "latest");
        answered.clear();
        const [{ value: v }] = await walked(() => walk.read(`${chain} stateRootTimes(root) at ${f.number}`, (rpc) => rpc("eth_call", [{ to: venue.pool, data: SEL.times + root!.slice(2) }, { blockHash: f.hash }]), (x, y) => x === y));
        return v;
      }, sleep);
      const used = list.filter((u) => answered.has(u));
      // a pool with no leaf yet has root 0, which the pool never timed (State.sol: a time is written for each root made)
      const empty = BigInt(root) === 0n;
      out.times = { ok: empty || BigInt(String(value)) !== 0n, empty, root, value: String(value), hosts: used.map((u) => new URL(u).host), operators: used.map(evmRpcOperator) };
    } catch (e) {
      out.times = failed(e);
    }
  }
  return out;
}

const [base, robinhood] = await Promise.all([chainRun("base"), chainRun("robinhood")]);
process.stdout.write(`${JSON.stringify({ base, robinhood })}\n`);
