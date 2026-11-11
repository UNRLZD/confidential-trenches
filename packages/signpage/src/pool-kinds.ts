// The pool kinds on SIGN_HOST (card signpage-pool-kinds): pool.deposit, pool.buy, pool.sell and pool.withdraw, each
// checked by src/rules/pool.ts before anything else happens, and answered only for a chain whose pool this page's
// network pins (the wallet's SOL_POOLS and EVM_POOLS: on mainnet the Solana pool since card sol-pools-mainnet-pin, no
// EVM pool yet; a kind on a chain with no pin is refused not_allowed, and no read is made for a refused one).
// - A sell's amount is in the token's decimals: the device reads the mint (Solana) or decimals() (EVM) on two
//   providers here and the rule parses both answers (tokenDecimalsOf); the app never names a number of decimals. Two
//   answers that do not parse or do not agree are refused not_allowed, and nothing is kept.
// - Kept for the session (card sell-first-read-waits-out-a-throttle; the app's devnet run 5, 11 Nov 02:24Z: a sell
//   tapped 2.3 s after a buy met four HTTP 429s to the mint's getAccountInfo and answered down, nothing signed): the
//   number two providers agreed on is kept per chain and token (PAGE_TOKEN_DECIMALS, the page's one store) and never
//   read again on this page. A buy's own read counts: the Solana buy's amount W received, read on both RPCs with its
//   decimals the same (pool-buy.ts outDecimals), and the EVM buy's decimals() on both (pool-buy-evm.ts evmBuyHost), so
//   a sell after a buy asks no decimals read. What the kept number assumes: on Solana that a mint's decimals never
//   change (no SPL Token or Token-2022 instruction sets them after InitializeMint; a mint closed and made again at the
//   same address, which Token-2022 allows only at zero supply with a close authority, is read again by its next buy);
//   on Base and Robinhood that the token's decimals() answers the same all session (a token behind a proxy could change
//   it). What still checks the amounts before any signature is unchanged and reads afresh each time: the units are
//   held to what each W holds on both RPCs, and the quote checks (min out from the device's own pool reads, the rule's
//   checks of the signed bytes).
// - The first read waits out a provider that fails (a throttle, a 5xx or no answer past the page client's own retry,
//   kit send.ts SOLANA_RPC_RETRY): on the page's one rule for a kind's reads (read-waits.ts readWaits: the wallet's
//   throttleWaitMs from 1 s, doubling, at most 10 s, a Retry-After honoured to 10 s, until READ_WAIT_TOTAL_MS),
//   asking again only the provider that failed (the other's answer is still one of the two that must agree). "down"
//   (card pool-read-down: never not_allowed) only once the bound is spent; any other error is down at once, as before.
//   A sign out ends the wait, and the sell then answers failed, its flow never run (card start-reads-wait-out-a-
//   throttle, review of 49efdb0c).
// - On Base and Robinhood every kind goes to the flow once its pool is pinned: a pool.deposit's tx from the one-time
//   wallet U is checked by rules/pool.ts checkEvmDeposit (card pool-deposits, src/pool-deposit-evm.ts), a pool.withdraw's
//   onward send from W to the typed address by checkEvmOnwardSend (card signpage-pool-withdraw-form); the page's EVM
//   flows land with signpage-evm-pool-trade.
// - The flows that build, prove, sign and send each op land with the pools; until a pinned pool has its flow, a
//   request that passed every check is refused not_allowed too, never half run.
// - A sell is a trade: answered as one that runs (Running), so the api's queue never waits on its decimals read or
//   its run, and a flow that runs is answered with its run's own answer once that run's wait settles (card
//   signpage-pool-sell).
// - A flow that fails with the wallet's EvmNotFinalError (../../wallet/src/pool/evm-restore.ts evmNextNote: a take in a
//   block not final yet stands before the note to sign) is answered busy, a "not now" (api.ts RETRY_CODES: the same
//   request runs again), however it fails with it: thrown at once, or its run's wait rejecting (card
//   pool-restore-wired). Any other error is answered as before.
import { EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import type { KindContext, Deferred, HostAnswer, HostRefusal, Running } from "./api.ts";
import { afterOf, readWaits, ReadStopped, waitsOn, waitUnless } from "./read-waits.ts";
import { PoolRuleRefused, checkPoolRequest, poolTokenAddress, tokenDecimalsKeptOf, tokenDecimalsOf, type PoolAsk, type PoolChain, type PoolRequest } from "./rules/pool.ts";

/** One provider's JSON-RPC call: the method's result, or a throw. */
export type PoolRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** ERC-20 decimals(): its selector, keccak256("decimals()")[0..4]. */
export const ERC20_DECIMALS = "0x313ce567";

/** The decimals the device agreed on two providers, per chain and token (see the header). */
export type TokenDecimalsKept = {
  get(chain: PoolChain, token: string): number | undefined;
  /** Kept only for an address of the chain and a number the rule takes (tokenDecimalsKeptOf); anything else is not kept. */
  keep(chain: PoolChain, token: string, decimals: number): void;
};
/** A new store: each page has one (PAGE_TOKEN_DECIMALS); a poolKinds made with none has its own. */
export function tokenDecimalsKept(): TokenDecimalsKept {
  const kept = new Map<string, number>();
  // an EVM address in any case is one token; a Solana key is case-sensitive
  const key = (chain: PoolChain, token: string): string => `${chain} ${chain === "solana" ? token : token.toLowerCase()}`;
  return {
    get: (chain, token) => kept.get(key(chain, token)),
    keep: (chain, token, decimals) => {
      if (!poolTokenAddress(chain, token)) return;
      try {
        kept.set(key(chain, token), tokenDecimalsKeptOf(decimals));
      } catch {
        /* not a token's decimals: not kept */
      }
    },
  };
}
/** The page's one store: the sell's read (testnetPoolDeps), the Solana buy's (pool-testnet.ts) and the EVM buy's. */
export const PAGE_TOKEN_DECIMALS: TokenDecimalsKept = /* @__PURE__ */ tokenDecimalsKept();

export type TokenDecimalsRead = {
  /** The store (PAGE_TOKEN_DECIMALS otherwise). */
  kept?: TokenDecimalsKept;
  /** 0: no wait at all, the first failure thrown (the EVM buy's read between its check and the signature). */
  waits?: 0;
  /** The wait (tests replace it). */
  wait?: (ms: number) => Promise<void>;
  /** A sign out: ends the wait, and the read throws ReadStopped. */
  signal?: AbortSignal;
};

/** The token's decimals: kept, or read on both providers (the mint account on Solana, one eth_call of decimals() on EVM,
 *  one address per request: the token's, never a wallet of the user's), both answers parsed and the same
 *  (tokenDecimalsOf: else PoolRuleRefused, nothing kept), then kept. A provider whose read fails is asked again alone
 *  after the wait (see the header); past `waits` waits the last failure is thrown. */
export async function keptTokenDecimals(chain: PoolChain, token: string, rpcs: readonly [PoolRpc, PoolRpc], o: TokenDecimalsRead = {}): Promise<number> {
  const kept = o.kept ?? PAGE_TOKEN_DECIMALS;
  const had = kept.get(chain, token);
  if (had !== undefined) return had;
  const waits = o.waits === 0 ? null : readWaits();
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const one = (rpc: PoolRpc) =>
    chain === "solana"
      ? rpc("getAccountInfo", [token, { encoding: "base64", commitment: "confirmed" }])
      : rpc("eth_call", [{ to: token, data: ERC20_DECIMALS }, "latest"]);
  const answers: [unknown, unknown] = [undefined, undefined];
  const answered = [false, false];
  for (;;) {
    const failed: unknown[] = [];
    await Promise.all(
      ([0, 1] as const).map(async (i) => {
        if (answered[i]) return;
        try {
          answers[i] = await one(rpcs[i]);
          answered[i] = true;
        } catch (e) {
          failed.push(e);
        }
      }),
    );
    if (failed.length === 0) break;
    // only a provider's fault waits; any other error is thrown at once
    const other = failed.find((e) => !waitsOn(e));
    if (other !== undefined) throw other;
    // the fault with the longest Retry-After any failed provider named
    const fault = failed.reduce((a, e) => ((afterOf(e) ?? -1) > (afterOf(a) ?? -1) ? e : a));
    const ms = waits === null ? null : waits.next(fault);
    if (ms === null) throw fault;
    await waitUnless(wait, ms, o.signal);
    if (o.signal?.aborted) throw new ReadStopped();
  }
  const decimals = tokenDecimalsOf(chain, answers);
  kept.keep(chain, token, decimals);
  return decimals;
}

type PoolKind = "pool.deposit" | "pool.buy" | "pool.sell" | "pool.withdraw";
/** What the page knows, each read when a request comes: the pins of its network, its two providers per chain. */
export type PoolKindsDeps = {
  /** Whether this page's network pins the chain's pool (SOL_POOLS / EVM_POOLS). */
  pinned(chain: PoolChain): boolean;
  /** The chain's two providers, or null when the page has none for it. */
  rpcs(chain: PoolChain): readonly [PoolRpc, PoolRpc] | null;
  /** The ops' flow once their pool is pinned (src/pool-testnet.ts testnetPoolFlow); with none a checked request is refused. */
  flow?: (ask: PoolAsk, ctx: KindContext) => HostRefusal | Running<PoolKind> | HostAnswer<"pool.withdraw">;
  /** The tokens' decimals kept this session (the page's PAGE_TOKEN_DECIMALS); none: a store of this poolKinds' own. */
  decimals?: TokenDecimalsKept;
  /** The first read's wait after a provider fails (tests replace it). */
  wait?: (ms: number) => Promise<void>;
  /** The sign out of the session a request is asked in (the page's), read when it comes: it ends the wait, and a kind
   *  asked before it never runs after it. */
  stop?: () => AbortSignal;
};
type Answer<K extends PoolKind> = HostRefusal | Deferred<K> | HostAnswer<K>;
type Handler<K extends PoolKind> = (params: Record<string, unknown>, ctx: KindContext) => Answer<K>;

const NO: { error: "not_allowed" } = Object.freeze({ error: "not_allowed" as const });
/** A provider read that still fails after the page's own retry (card pool-read-down): "not now", never "no" (api.ts
 *  RETRY_CODES, so the same request again runs again). not_allowed comes only from a rule. */
const DOWN: { error: "down" } = Object.freeze({ error: "down" as const });
/** evmNextNote's wait for finality: "not now" (api.ts RETRY_CODES), never failed or not_allowed. */
const BUSY: { error: "busy" } = Object.freeze({ error: "busy" as const });
/** A sell asked before a sign out: never run after it (read-waits.ts ReadStopped). */
const FAILED: { error: "failed" } = Object.freeze({ error: "failed" as const });

type Flow = NonNullable<PoolKindsDeps["flow"]>;
// the flow's answer, an EvmNotFinalError busy whether thrown at once or its run's wait rejects with it; any other throw
// or rejection is the flow's own, as before (a Running stays Running, a Deferred a Deferred)
const runFlow = (flow: Flow, ask: PoolAsk, ctx: KindContext): ReturnType<Flow> | Deferred<PoolKind> | typeof BUSY => {
  let got: ReturnType<Flow>;
  try {
    got = flow(ask, ctx);
  } catch (e) {
    if (e instanceof EvmNotFinalError) return BUSY;
    throw e;
  }
  if (!("after" in got)) return got;
  let notFinal = false;
  const after = got.after.catch((e: unknown) => {
    if (!(e instanceof EvmNotFinalError)) throw e;
    notFinal = true;
  });
  // busy only while the run has no result of its own: a run that sent something answers with what it sent
  const answer = () => {
    const own = got.answer();
    return notFinal && !(own !== null && "result" in own) ? BUSY : own;
  };
  return "running" in got ? { running: true, after, answer } : { after, answer };
};

const checked = (p: PoolRequest, decimals?: number): PoolAsk | null => {
  try {
    return checkPoolRequest(p, decimals);
  } catch (e) {
    if (e instanceof PoolRuleRefused) return null;
    throw e;
  }
};

/** The four kinds' handlers for the page's api host. */
export function poolKinds(deps: PoolKindsDeps): { [K in PoolKind]: Handler<K> } {
  const kept = deps.decimals ?? tokenDecimalsKept();
  const handler =
    <K extends PoolKind>(kind: K): Handler<K> =>
    (params, ctx) => {
      const p = { ...params, kind } as PoolRequest;
      const chain = p.chain as PoolChain;
      if (kind !== "pool.sell") {
        const ask = checked(p);
        if (!ask) return NO;
        if (!deps.pinned(ask.chain) || !deps.flow) return NO;
        return runFlow(deps.flow, ask, ctx) as Answer<K>;
      }
      // a sell: on a pinned pool's chain only, for a token that is an address of that chain, the token's decimals (kept,
      // or read on two providers), then the whole request checked with them; no read is made for any other string
      if (!(["solana", "base", "robinhood"] as const).includes(chain as never) || !deps.pinned(chain)) return NO;
      const rpcs = deps.rpcs(chain);
      if (!rpcs || !poolTokenAddress(chain, p.token)) return NO;
      let answer: HostAnswer<K> | HostRefusal = NO;
      const signal = deps.stop?.();
      const after = keptTokenDecimals(chain, p.token, rpcs, { kept, ...(deps.wait ? { wait: deps.wait } : {}), ...(signal ? { signal } : {}) }).then(
        async (decimals) => {
          // a sign out since the request came: the flow never runs for it
          if (signal?.aborted) return void (answer = FAILED);
          const ask = checked(p, decimals);
          const got = ask && deps.flow ? runFlow(deps.flow, ask, ctx) : NO;
          if (!("after" in got)) return void (answer = "error" in got ? got : NO); // a sell's flow answers only by running
          // the flow runs: its answer once its own wait settles (the send, or the run's end)
          await got.after.catch(() => {});
          answer = (got.answer() ?? NO) as HostAnswer<K> | HostRefusal;
        },
        // two answers that do not parse or agree: not_allowed, as the rule refuses them; a provider's read that still
        // failed past the waits: down, and the same request again reads again (nothing was kept)
        (e: unknown) => {
          answer = e instanceof PoolRuleRefused ? NO : e instanceof ReadStopped ? FAILED : DOWN;
        },
      );
      return { running: true, after, answer: () => answer };
    };
  return { "pool.deposit": handler("pool.deposit"), "pool.buy": handler("pool.buy"), "pool.sell": handler("pool.sell"), "pool.withdraw": handler("pool.withdraw") };
}
