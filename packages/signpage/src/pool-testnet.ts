// The pool kinds' pins and providers in the testnet build (card signpage-pool-flow; ../../wallet/src/pool/network.ts).
// - Solana: the devnet pool SOL_POOLS pins in that build, read on two devnet RPCs of different operators, the pair
//   scripts/live-checks/helper-pool-senders.mjs reads the devnet Rent sysvar on (RENT_RPCS.devnet).
// - Base Sepolia and Robinhood testnet: the two RPCs each testnet pin was read on (scripts/live-checks/pool-evm-deploy.mjs
//   CHAINS, card evm-venues-pin), each answered as the app's "base" and "robinhood". A chain is pinned only when the
//   wallet's EVM_POOLS holds its testnet pool, so until then every EVM pool kind is refused, as on mainnet.
// main.ts takes these only in the testnet build; SIGN_HOST's build keeps its mainnet deps and carries none of this.
import { solanaJsonRpc } from "../../kit/src/trade/solana/send.ts";
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
