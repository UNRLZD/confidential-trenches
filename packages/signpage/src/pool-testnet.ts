// The pool kinds' pins and providers in the testnet build (card signpage-pool-flow; ../../wallet/src/pool/network.ts).
// - Solana: the devnet pool SOL_POOLS pins in that build, read on two devnet RPCs of different operators, the pair
//   scripts/live-checks/helper-pool-senders.mjs reads the devnet Rent sysvar on (RENT_RPCS.devnet).
// - Base Sepolia and Robinhood testnet: the two RPCs each testnet pin was read on (scripts/live-checks/pool-evm-deploy.mjs
//   CHAINS, card evm-venues-pin), each answered as the app's "base" and "robinhood". A chain is pinned only when the
//   wallet's EVM_POOLS holds its testnet pool, so until then every EVM pool kind is refused, as on mainnet.
// - The flow (card signpage-pool-notes): pool.deposit on the devnet pool (src/pool-deposit.ts), with the page's own
//   note store and seed; every other op is refused until its card. A signed-in load finishes the pool's INCOMING notes.
// main.ts takes these only in the testnet build; SIGN_HOST's build keeps its mainnet deps and carries none of this.
import { solanaJsonRpc } from "../../kit/src/trade/solana/send.ts";
import type { WalletStore } from "@blindfill/wallet/store";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import { poolDepositKind, type PoolDepositHost } from "./pool-deposit.ts";
import { SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { EVM_POOLS } from "../../wallet/src/pool/evm.ts";
import type { PoolKindsDeps, PoolRpc } from "./pool-kinds.ts";
import type { PoolChain } from "./rules/pool.ts";

// The freezes are marked pure, so SIGN_HOST's build, which never reads these, drops them whole (scripts/build-network.test.mjs).
/** Each chain's two testnet RPCs, as the app names the chain. */
export const TESTNET_RPCS: Readonly<Record<PoolChain, readonly [string, string]>> = /* @__PURE__ */ Object.freeze({
  solana: /* @__PURE__ */ Object.freeze(["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"] as const),
  base: /* @__PURE__ */ Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"] as const),
  robinhood: /* @__PURE__ */ Object.freeze(["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"] as const),
});
const EVM_TESTNET = /* @__PURE__ */ Object.freeze({ base: "base-sepolia", robinhood: "robinhood-testnet" } as const);

/** The testnet build's deps for poolKinds, with `flow` the ops' flow (none: every checked request is refused). */
export function testnetPoolDeps(flow?: PoolKindsDeps["flow"]): PoolKindsDeps {
  return {
    pinned: (chain) => (chain === "solana" ? SOL_POOLS.devnet !== undefined : EVM_POOLS[EVM_TESTNET[chain]] !== undefined),
    rpcs: (chain) => TESTNET_RPCS[chain].map((u) => solanaJsonRpc(u) as PoolRpc) as unknown as readonly [PoolRpc, PoolRpc],
    ...(flow ? { flow } : {}),
  };
}

/** What the page gives the testnet flow: its wallet store and the seed, each opened when a run needs it. */
export type TestnetPage = { store(): Promise<WalletStore>; seed64(): Promise<Uint8Array> };

function depositHost(page: TestnetPage): () => PoolDepositHost {
  return () => {
    let notes: NoteStore | null = null;
    return {
      pin: SOL_POOLS.devnet!,
      rpcs: [solanaJsonRpc(TESTNET_RPCS.solana[0]), solanaJsonRpc(TESTNET_RPCS.solana[1])],
      notes: async () => (notes = await openNoteStore(await page.store())),
      seed64: page.seed64,
      end: () => notes?.close(),
    };
  };
}

/** The testnet build's pool flow: pool.deposit into the pinned devnet pool, read on TESTNET_RPCS.solana. */
export function testnetPoolFlow(page: TestnetPage): NonNullable<PoolKindsDeps["flow"]> {
  const deposit = poolDepositKind(depositHost(page));
  return (ask, ctx) => (ask.kind === "pool.deposit" && ask.chain === "solana" && SOL_POOLS.devnet !== undefined ? deposit(ask, ctx) : { error: "not_allowed" });
}

/** On a signed-in page load: the devnet pool's INCOMING notes finished (src/pool-deposit.ts settlePoolDeposits). */
export function testnetPoolSettle(page: TestnetPage): void {
  if (SOL_POOLS.devnet === undefined) return;
  poolDepositKind(depositHost(page))(null, null);
}
