// An EVM pool's verified hold in the wallet store (card evm-pool-sync-holds). A keyless provider keeps a pool's logs for
// a window only: Base's publicnode refuses past about 3.9M blocks, Pocket answers past its window with no logs, and the
// pool's deploy block leaves each in days. A page that synced the pool keeps its hold (evm.ts EvmSyncHeld: the leaves
// up to a finalized block, read alike by two operators and making the pool's trees at the head, and each source's
// kept logs past it), so a new page, a restore or a reload syncs only the blocks after it and never needs the deploy
// block again. The sync proves what it reads here by the pool's root times at its first round, as it does any hold: a
// record they do not prove is cleared (drop) and the pool read again from its deploy block.
//
// One record per pool: meta evm-hold/<network>/<pool> (../store/index.ts WALLET_EVM_HOLD_PREFIX), as evm.ts writes it
// (bigints, kept by IndexedDB's structured clone). The pool's public logs only, no secret: it is in the wallet store,
// not the page's other storage, because it still says this device used the pool, so a sign out deletes it with the
// rest. It moves no seed, and the frame's reader neither reads nor lists it. A write never lowers `to` (evmHoldRises),
// in one compare-and-set (WalletStore.update), so a restore's sync and the pool's on another tab keep the higher.
import { WALLET_EVM_HOLD_PREFIX, type WalletStore } from "../store/index.ts";
import { evmHoldRises, type EvmPoolPin, type EvmSyncHold } from "./evm.ts";

const NETWORK = /^[a-z0-9-]{1,40}$/;
const POOL = /^0x[0-9a-f]{40}$/;

/** The meta key of the hold of `pin`'s pool; refuses a network or a pool not in their shape. */
export function evmHoldKey(pin: Pick<EvmPoolPin, "network" | "pool">): string {
  const p = typeof pin.pool === "string" ? pin.pool.toLowerCase() : "";
  if (typeof pin.network !== "string" || !NETWORK.test(pin.network) || !POOL.test(p)) throw new Error("a hold names a network (a-z, 0-9, -) and a pool (0x and 40 hex digits)");
  return `${WALLET_EVM_HOLD_PREFIX}${pin.network}/${p}`;
}

/** The hold of `pin`'s pool in the wallet store `open` gives. A read or write that fails (a pin not in shape too, which
 *  the sync refuses on its own) is no hold, and no write: it rejects, and the sync goes on without the hold. */
export function evmStoredHold(open: () => Promise<WalletStore>, pin: Pick<EvmPoolPin, "network" | "pool">): EvmSyncHold {
  return {
    read: async () => (await open()).get("meta", evmHoldKey(pin)) as never,
    write: async (v) => void (await (await open()).update("meta", evmHoldKey(pin), (old) => (evmHoldRises(old ?? null, v) ? v : undefined))),
    // a record the pool's views did not prove, cleared to null (no hold) in the same compare-and-set, unless another
    // sync wrote one to another block since
    drop: async (to) => void (await (await open()).update("meta", evmHoldKey(pin), (old) => (old !== null && typeof old === "object" && (old as { to?: unknown }).to === to ? null : undefined))),
  };
}
