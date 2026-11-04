// The pool kinds on SIGN_HOST (card signpage-pool-kinds): pool.deposit, pool.buy, pool.sell and pool.withdraw, each
// checked by src/rules/pool.ts before anything else happens, and answered only for a chain whose pool this page's
// network pins (the wallet's SOL_POOLS and EVM_POOLS, both empty until the pools deploy: every kind is refused
// not_allowed until then, and no read is made for a refused one).
// - A sell's amount is in the token's decimals: the device reads the mint (Solana) or decimals() (EVM) on two
//   providers here and the rule parses both answers (tokenDecimalsOf); the app never names a number of decimals.
// - Refused on Base and Robinhood whatever the pins, until a rule checks each: a pool.deposit (no EVM deposit check
//   yet) and a pool.withdraw (its onward send from W to the typed address has no EVM check yet).
// - The flows that build, prove, sign and send each op land with the pools; until a pinned pool has its flow, a
//   request that passed every check is refused not_allowed too, never half run.
// - A sell is a trade: answered as one that runs (Running), so the api's queue never waits on its decimals read or
//   its run, and a flow that runs is answered with its run's own answer once that run's wait settles (card
//   signpage-pool-sell).
import type { KindContext, Deferred, HostAnswer, HostRefusal, Running } from "./api.ts";
import { PoolRuleRefused, checkPoolRequest, poolTokenAddress, type PoolAsk, type PoolChain, type PoolRequest, type TokenDecimalsReads } from "./rules/pool.ts";

/** One provider's JSON-RPC call: the method's result, or a throw. */
export type PoolRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** ERC-20 decimals(): its selector, keccak256("decimals()")[0..4]. */
export const ERC20_DECIMALS = "0x313ce567";

/** The token's decimals as each of two providers answers the device's own read: the mint account on Solana, one
 *  eth_call of decimals() on EVM, one address per request (the token's: never a wallet of the user's). */
export async function readTokenDecimals(chain: PoolChain, token: string, rpcs: readonly [PoolRpc, PoolRpc]): Promise<TokenDecimalsReads> {
  const one = (rpc: PoolRpc) =>
    chain === "solana"
      ? rpc("getAccountInfo", [token, { encoding: "base64", commitment: "confirmed" }])
      : rpc("eth_call", [{ to: token, data: ERC20_DECIMALS }, "latest"]);
  const [a, b] = await Promise.all([one(rpcs[0]), one(rpcs[1])]);
  return [a, b];
}

type PoolKind = "pool.deposit" | "pool.buy" | "pool.sell" | "pool.withdraw";
/** What the page knows, each read when a request comes: the pins of its network, its two providers per chain. */
export type PoolKindsDeps = {
  /** Whether this page's network pins the chain's pool (SOL_POOLS / EVM_POOLS). */
  pinned(chain: PoolChain): boolean;
  /** The chain's two providers, or null when the page has none for it. */
  rpcs(chain: PoolChain): readonly [PoolRpc, PoolRpc] | null;
  /** The ops' flow once their pool is pinned (src/pool-testnet.ts testnetPoolFlow); with none a checked request is refused. */
  flow?: (ask: PoolAsk, ctx: KindContext) => HostRefusal | Running<PoolKind>;
};
type Answer<K extends PoolKind> = HostRefusal | Deferred<K>;
type Handler<K extends PoolKind> = (params: Record<string, unknown>, ctx: KindContext) => Answer<K>;

const NO: { error: "not_allowed" } = Object.freeze({ error: "not_allowed" as const });
const EVM_REFUSED: ReadonlySet<PoolKind> = new Set(["pool.deposit", "pool.withdraw"]);

const checked = (p: PoolRequest, reads?: TokenDecimalsReads): PoolAsk | null => {
  try {
    return checkPoolRequest(p, reads);
  } catch (e) {
    if (e instanceof PoolRuleRefused) return null;
    throw e;
  }
};

/** The four kinds' handlers for the page's api host. */
export function poolKinds(deps: PoolKindsDeps): { [K in PoolKind]: Handler<K> } {
  const handler =
    <K extends PoolKind>(kind: K): Handler<K> =>
    (params, ctx) => {
      const p = { ...params, kind } as PoolRequest;
      const chain = p.chain as PoolChain;
      if (kind !== "pool.sell") {
        const ask = checked(p);
        if (!ask) return NO;
        if (!deps.pinned(ask.chain) || (ask.chain !== "solana" && EVM_REFUSED.has(kind)) || !deps.flow) return NO;
        return deps.flow(ask, ctx) as Answer<K>;
      }
      // a sell: on a pinned pool's chain only, for a token that is an address of that chain, the token's decimals read
      // on two providers, then the whole request checked with them; no read is made for any other string
      if (!(["solana", "base", "robinhood"] as const).includes(chain as never) || !deps.pinned(chain)) return NO;
      const rpcs = deps.rpcs(chain);
      if (!rpcs || !poolTokenAddress(chain, p.token)) return NO;
      let answer: HostAnswer<K> | HostRefusal = NO;
      const after = readTokenDecimals(chain, p.token, rpcs).then(
        async (reads) => {
          const ask = checked(p, reads);
          const got = ask && deps.flow ? deps.flow(ask, ctx) : NO;
          if (!("after" in got)) return void (answer = got);
          // the flow runs: its answer once its own wait settles (the send, or the run's end)
          await got.after.catch(() => {});
          answer = (got.answer() ?? NO) as HostAnswer<K> | HostRefusal;
        },
        () => {
          answer = NO;
        },
      );
      return { running: true, after, answer: () => answer };
    };
  return { "pool.deposit": handler("pool.deposit"), "pool.buy": handler("pool.buy"), "pool.sell": handler("pool.sell"), "pool.withdraw": handler("pool.withdraw") };
}
