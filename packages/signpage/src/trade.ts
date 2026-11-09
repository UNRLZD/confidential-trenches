// The `buy` kind on Solana: a buy or a sell from the trade box, signed on SIGN_HOST (card signpage-solana-trade;
// wallet.md §2.8 "Buy from fresh wallets", §7 item 4; markets.md T1.3 the standard-size set, S1-S13, LD1; the shapes are
// packages/kit/src/signpage/messages.ts, api 1). The shell answers it (src/main.ts); the frame never signs.
//
// - The request is hostile. Only chain "solana" is taken here; every other chain is refused not_allowed until its card.
//   A buy's `amount` is USD with at most two decimals, a sell's is the token's base units.
// - Every trade runs holding the seed lock shared (a sign out in any tab waits for it) and its own op lock (its id; a
//   second tab with the same id is answered id_reused at once). Its first step is under TRADE_PICK_LOCK, one tab at a
//   time: the id's ops record is read and, when absent, written as { kind, sha (the request's SHA-256), stage
//   "pending", txs [], created_ms } (wallet.md §7 item 4). An id that already has one is never run again: it is
//   answered from the record (its trade stage and txs, or its code) when the hash is the same, else id_reused, and
//   id_reused while it is pending (a run that a reload cut short may have signed). "pending" is no TradeStage.
// - Still under that lock, the legs come from the wallet store's arm records (packages/wallet/src/arming/records.ts)
//   only, never from the request, and each is marked as this trade's on its record (claimArm) before the lock goes.
//   Every record already marked by a trade whose op lock is free (its tab closed or reloaded) is resolved first, all at
//   once, on both providers by the kit's readSolanaTxEnd (06c A4, the send loop's own rule, from the mark's blockhash
//   and lastValidBlockHeight): every tx filled, failed or dead, its mark goes (a buy's filled wallet goes IN_POSITION
//   with the token; a dead one reads not_landed on its op); anything unknown keeps it out. Every store call is bounded
//   (TRADE_STORE_MS), so a store that never answers refuses the trade instead of holding the seed lock. A buy is the fewest unmarked READY fresh wallets whose sizes sum to the amount
//   (ladderSplit, wallet.md §2.5), each spending its record's `spend` (a_k); a sell takes the unmarked IN_POSITION
//   wallets of that token, reads each one's token account on both providers, one address per request (wallet.md §2.9
//   row 8; the lower), and splits the amount over them in proportion, so an amount equal to the held total sells
//   each whole balance (T1.3 item 6). No wallet set, or a sell over what is held, is refused before anything is signed.
// - runSolanaTrade (the kit) runs the reads, builds, checks S1-S13, signatures, sends and fill reads, given every
//   arm record's address (wallets) to refuse a tx naming another of the user's wallets. Its signer is the
//   wallet's solanaArmedSigner, which signs only for a wallet with this device's own arm record marked by this trade,
//   and gives each signature back only once the mark names it, so no tx is sent that a reload could lose.
// - The answer: { stage "sent", txs } once every leg is signed and sent (the kit's "sent"); each fill stage (filled,
//   part_filled, not_landed) then goes to the frame as a `progress` event as the kit reports it, before any teardown.
//   A trade that ends before "sent" is answered with its code: quote_check_failed when a leg's price check refused it
//   (the trade box's Price check failed), and otherwise not_armed, no_ready_set, no_position, over_held, no_route or
//   failed (the trade box's Failed). Every stage is written to the op as it comes, so a `state` read shows it.
// - At its end the trade takes its mark off each wallet whose txs it saw end (none signed, filled, failed or dead);
//   a filled buy's wallet goes READY → IN_POSITION with the token. A wallet whose tx is still unknown keeps the mark,
//   resolved by a later pick. Nothing here logs.
import { base58 } from "@scure/base";
import { solanaAta, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/index.ts";
import { runSolanaTrade, type SolanaTradeDeps, type SolanaTradeLeg, type SolanaTradeRecord, type SolanaTradeRequest, type SolanaTradeStage } from "../../kit/src/trade/solana/flow.ts";
import { readSolanaTxEnd, solanaHelperRpc, solanaPacedRpc, solanaSendPaths, solanaWrappedRpc, SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageReference, pageRpc } from "./page-rpc.ts";
import type { ErrorCode, SignpageResults, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { ladderSplit } from "@blindfill/wallet/arming/ladder";
import { ArmRefused, armRecordOf, armRecords, claimArm, settleArm, solanaArmedSigner, type ArmRecord } from "@blindfill/wallet/arming/records";
import { WALLET_SEED_LOCK, type WalletStore } from "@blindfill/wallet/store";
import type { HostAnswer, KindContext, Running } from "./api.ts";

export type TradeStore = Pick<WalletStore, "get" | "put" | "keys" | "update">;

/** How long one store read or write may take before the trade is refused: a store that never answers would otherwise
 * hold the seed lock (and so sign out and reload) for good. A mark write refused this way only keeps wallets out. */
export const TRADE_STORE_MS = 10_000;

/** `p`, or a rejection once `ms` have passed without it. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error(`${what}: no answer in ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

/** The store with each call raced against `ms`: past it the call rejects (the trade then refuses or ends). */
export function timedStore(store: TradeStore, ms: number): TradeStore {
  const timed = <T>(p: Promise<T>, what: string): Promise<T> => within(p, ms, `the store's ${what}`);
  return {
    get: (s, k) => timed(store.get(s, k), "a read"),
    put: (s, k, v) => timed(store.put(s, k, v), "a write"),
    keys: (s) => timed(store.keys(s), "a read"),
    update: (s, k, f) => timed(store.update(s, k, f), "a write"),
  };
}

export interface TradeHost {
  /** The wallet store, opened top-level. */
  store(): Promise<TradeStore>;
  /** Opens the seed (BIP-39 seed of the 12 words); called only once a wallet passes its arm check. */
  seed64(): Promise<Uint8Array>;
  /** The kit's trade deps but the signer, the progress and dry: helper, the two LD1 providers, E(A) and the send paths. */
  deps: Omit<SolanaTradeDeps, "sign" | "onProgress" | "dry">;
  /** runSolanaTrade; a test's stand-in. */
  run?: typeof runSolanaTrade;
  now?: () => number;
  /** TRADE_STORE_MS; a test's shorter one. */
  storeMs?: number;
  /** Web Locks (navigator.locks); a test's stand-in. With none, a trade is refused "failed" (the store signs in only with them). */
  locks?: Pick<LockManager, "request"> | null;
}

/** The release's helper: the wallet's RELEASE_HELPER (withdraw/relay.ts; test/trade.test.ts holds them equal), not imported, so
 * the page's bundle carries none of the relay's NEAR code. */
export const TRADE_HELPER = "https://ct-api.unrealized.trade";

/** Provider A of LD1, reached from the device: PublicNode's keyless Solana RPC (the kit's dry run's, solana-flow-dry.ts). */
export const SOLANA_PROVIDER_A = "https://solana-rpc.publicnode.com";

/** The release's trade deps: provider A device-direct and provider B the helper's /v1/rpc/solana (LD1), E(A) from the
 * device's own pool reads on both, and the kit's send paths with the helper's. */
export function releaseTradeDeps(): TradeHost["deps"] {
  // the page's one RPC client (src/page-rpc.ts): a throttled read is tried again within its bounds, never a failed trade;
  // each provider paced where it is made, so every read on it takes its turn in the provider's one queue
  const providers = [solanaPacedRpc(pageRpc(SOLANA_PROVIDER_A)), solanaPacedRpc(pageHelperRpc(TRADE_HELPER))] as const;
  return {
    helper: TRADE_HELPER,
    providers,
    // read on the pair the kit hands it (its paced providers, flow.ts pacedDeps), never on one outside the trade's pace;
    // a provider read that fails past its retry rejects (pageReference), never reads as "no reference pool"
    reference: (q, paced) => pageReference(paced, q),
    paths: solanaSendPaths({ helper: solanaHelperRpc(TRADE_HELPER) }),
  };
}

const TRADE_STAGES: readonly string[] = ["signed", "sent", "filled", "part_filled", "refused", "not_landed"];
const USD = /^(\d{1,15})(?:\.(\d{1,2}))?$/;
const UNITS = /^[1-9]\d{0,19}$/;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** A buy's legs: the fewest unmarked READY fresh wallets whose sizes sum to the amount (ladderSplit), each spending its record's a_k. */
export function buyLegs(records: readonly { key: string; rec: ArmRecord }[], cents: bigint): { legs: SolanaTradeLeg[]; keys: string[] } | null {
  const free = records.filter((r) => r.rec.role === "fresh" && r.rec.state === "READY" && r.rec.inflight === undefined).sort((a, b) => (a.key < b.key ? -1 : 1));
  const sizes = ladderSplit(cents, free.map((r) => r.rec.size_cents));
  if (!sizes) return null;
  const used = new Set<string>();
  const legs: SolanaTradeLeg[] = [];
  const keys: string[] = [];
  for (const s of sizes) {
    const r = free.find((x) => x.rec.size_cents === s && !used.has(x.key))!;
    used.add(r.key);
    keys.push(r.key);
    legs.push({ wallet: r.rec.address, amount: r.rec.spend, arm: { own: true } });
  }
  return { legs, keys };
}

/** `amount` over the held balances in proportion (floor, the rest one unit at a time to the largest holders); each ≤ its balance. */
export function sellSplit(amount: bigint, held: readonly bigint[]): bigint[] | null {
  const total = held.reduce((n, h) => n + h, 0n);
  if (amount <= 0n || amount > total) return null;
  const out = held.map((h) => (amount * h) / total);
  let rest = amount - out.reduce((n, a) => n + a, 0n);
  const order = held.map((h, i) => [h, i] as const).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] > b[0] ? -1 : 1));
  for (let k = 0; rest > 0n; k = (k + 1) % order.length) {
    const i = order[k]![1];
    if (out[i]! < held[i]!) ((out[i] = out[i]! + 1n), (rest -= 1n));
  }
  return out;
}

type Acc = { owner: string; data: Uint8Array } | null;
// one account per request (getAccountInfo): no request names two of the user's wallets (wallet.md §2.9 row 8)
async function account(rpc: SolanaRpc, key: string): Promise<Acc> {
  const r = (await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown } | null;
  if (!r || typeof r !== "object" || !("value" in r)) throw new Error("getAccountInfo answered no value");
  if (r.value === null) return null;
  const o = r.value as { owner?: unknown; data?: unknown };
  if (typeof o !== "object" || typeof o.owner !== "string" || !Array.isArray(o.data) || typeof o.data[0] !== "string" || o.data[1] !== "base64") throw new Error("not a base64 account");
  return { owner: o.owner, data: Uint8Array.from(atob(o.data[0]), (c) => c.charCodeAt(0)) };
}

/** The token balance of each wallet's own account of `mint`, the lower of the two providers'; 0 for none. */
export async function heldOnBoth(providers: readonly [SolanaRpc, SolanaRpc], mint: string, wallets: readonly string[]): Promise<bigint[]> {
  const [ma, mb] = await Promise.all(providers.map((p) => account(p, mint)));
  const program = ma?.owner;
  if (program !== mb?.owner || (program !== SOLANA_TOKEN_PROGRAM && program !== SOLANA_TOKEN_2022_PROGRAM)) throw new Error("the mint is not one token mint on both providers");
  const atas = wallets.map((w) => solanaAta(w, mint, program));
  const reads = await Promise.all(providers.map((p) => Promise.all(atas.map((a) => account(p, a)))));
  const mintBytes = base58.decode(mint);
  const amountOf = (a: Acc, wallet: string): bigint => {
    if (!a) return 0n;
    if (a.owner !== program || a.data.length < 72) throw new Error("a token account is not the mint's program's");
    const same = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((v, i) => v === y[i]);
    if (!same(a.data.subarray(0, 32), mintBytes) || !same(a.data.subarray(32, 64), base58.decode(wallet))) throw new Error("a token account is not the wallet's own of the mint");
    return new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true);
  };
  return wallets.map((w, i) => {
    const x = amountOf(reads[0]![i] ?? null, w);
    const y = amountOf(reads[1]![i] ?? null, w);
    return x < y ? x : y;
  });
}

/** The code a trade that ended before "sent" is refused with, from its record (the trade box draws quote_check_failed as Price check failed, any other as Failed). */
export function refusalCode(record: SolanaTradeRecord): ErrorCode {
  const why = record.legs.map((l) => l.refused ?? "");
  if (why.some((w) => /^checks: |^(renewal: )?no reference pool|^renewal: no reference for the leg|^the route quotes |^the route's floor |^the floor rounds/.test(w))) return "quote_check_failed";
  if (why.length > 0 && why.every((w) => w.startsWith("the wallet was not armed"))) return "not_armed";
  if (why.some((w) => w.startsWith("build no_route"))) return "no_route";
  return "failed";
}

type Leg = SolanaTradeRecord["legs"][number];
const legState = (l: Leg): string | undefined => (l.reread ? l.reread.state : l.outcome?.state);
/** A leg's known end as the op records it: filled, failed (landed with an error on both providers) or not_landed (dead,
 *  06c A4, the kit's send.ts); undefined while unknown. */
const legEnd = (l: Leg): LegEnd | undefined => {
  if (l.outcome?.state === "filled" || l.reread?.state === "filled") return "filled";
  const st = legState(l);
  return st === "failed" ? "failed" : st === "expired" ? "not_landed" : undefined;
};

type Answer = HostAnswer<"buy">;
type Locks = Pick<LockManager, "request">;

/** The cross-tab lock every pick runs under: its op insert, the marks it resolves and the marks it makes. */
export const TRADE_PICK_LOCK = "ct-wallet/trade-pick";
/** Held by a trade for its whole run, in the tab that runs it: a mark whose op lock is free is a dead tab's. */
export const tradeLock = (op: string): string => `ct-wallet/trade/${op}`;

export type TradeKind = ((params: Record<string, unknown>, ctx: KindContext) => Running<"buy"> | null) & {
  /** Settles once no trade of this page is running (the shell's reload waits for it). */
  idle(): Promise<void>;
};

/** The `buy` kind's handler for the shell's `kinds` (src/main.ts). */
export function tradeKind(host: TradeHost): TradeKind {
  const run = host.run ?? runSolanaTrade;
  const now = host.now ?? Date.now;
  const runs = new Set<Promise<void>>();
  const kind = (params: Record<string, unknown>, ctx: KindContext): Running<"buy"> | null => {
    if (params.chain !== "solana") return null;
    const side = params.side as "buy" | "sell";
    const token = params.token as string;
    const amount = params.amount as string;
    let cents = 0n;
    let units = 0n;
    if (side === "buy") {
      const m = USD.exec(amount);
      if (!m) return null;
      cents = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
      if (cents <= 0n) return null;
    } else {
      if (!UNITS.test(amount) || BigInt(amount) > U64_MAX) return null;
      units = BigInt(amount);
    }
    let answer: Answer | null = null;
    let settle!: () => void;
    const after = new Promise<void>((r) => (settle = r));
    const give = (a: Answer): void => {
      if (answer) return;
      answer = a;
      settle();
    };
    const locks: Locks | null = host.locks === undefined ? (globalThis.navigator?.locks ?? null) : host.locks;
    const p = (locks ? held(locks) : Promise.resolve(give({ error: "failed" }))).catch(() => give({ error: "failed" }));
    runs.add(p);
    void p.finally(() => runs.delete(p));
    return { running: true, after, answer: () => answer };

    // the trade's run: the seed lock shared (sign out, in any tab, waits for it) and its own op lock (a second tab
    // with the same id is refused id_reused at once)
    async function held(locks: Locks): Promise<void> {
      await locks.request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(tradeLock(ctx.id), { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) return give({ error: "id_reused" });
          await trade(locks);
        }),
      );
    }

    async function trade(locks: Locks): Promise<void> {
      const ms = host.storeMs ?? TRADE_STORE_MS;
      const store = timedStore(await within(host.store(), ms, "the store's open"), ms);
      const op: { kind: "buy" | "sell"; sha: string; stage: string; txs: TxRef[]; code?: ErrorCode; created_ms: number } = { kind: side, sha: ctx.sha, stage: "pending", txs: [], created_ms: now() };
      // each write in order, tried again before it counts as lost (card app-sell-mount re-check 2, P2-1): a lost write
      // keeps the wallets' marks (legsRun), so the next load or pick settles the op from them, never leaving it open
      let writes: Promise<void> = Promise.resolve();
      let lost = false;
      const write = (patch: Partial<typeof op>): void => {
        Object.assign(op, patch);
        const snap = { ...op, txs: op.txs.map((t) => ({ ...t })) };
        writes = writes.then(() => putAgain(store, ctx.id, snap)).catch(() => void (lost = true));
      };
      const landed = async (): Promise<boolean> => (await writes, !lost);
      const refuse = async (code: ErrorCode): Promise<void> => {
        write({ stage: "refused", code });
        await writes;
        give({ error: code });
      };

      // a read that fails before the answer refuses the trade; the op says so. A provider read that failed past its
      // retry here, at the pick, is "down": nothing is signed yet
      try {
        const set = await locks.request(TRADE_PICK_LOCK, { mode: "exclusive" }, async () => {
          // the op first, under the lock: one id is run once in every tab, and a reload answers it from its record
          const prior = await store.get("ops", ctx.id);
          if (prior !== undefined) return { answer: fromRecord(prior, ctx.sha) };
          await store.put("ops", ctx.id, { ...op });
          return pick(store, locks);
        });
        if (typeof set === "string") return refuse(set);
        if ("answer" in set) return give(set.answer);
        await legsRun(store, set, write, refuse, landed);
      } catch (e) {
        if (!answer) return refuse(e instanceof SolanaRpcTransportError ? "down" : "failed");
        throw e;
      } finally {
        await writes;
      }
    }

    /**
     * Under the pick lock: each wallet a dead tab's trade marked is resolved on both providers first (filled: a buy's
     * goes IN_POSITION; failed: the mark goes; unknown: it stays out), then the legs come from the unmarked records and
     * each one is marked as this trade's before the lock is let go.
     */
    async function pick(store: TradeStore, locks: Locks): Promise<{ legs: SolanaTradeLeg[]; keys: string[]; all: string[] } | ErrorCode> {
      await settleDeadMarks(store, locks, host.deps.providers);
      const records = await armRecords(store, "sol");
      const all = records.map((r) => r.rec.address);
      let set: { legs: SolanaTradeLeg[]; keys: string[] } | ErrorCode;
      if (side === "buy") set = buyLegs(records, cents) ?? "no_ready_set";
      else {
        const pos = records.filter((r) => r.rec.role === "fresh" && r.rec.state === "IN_POSITION" && r.rec.token === token && r.rec.inflight === undefined);
        if (pos.length === 0) return "no_position";
        const held = await heldOnBoth(host.deps.providers, token, pos.map((r) => r.rec.address));
        const split = sellSplit(units, held);
        if (!split) return "over_held";
        set = {
          legs: pos.flatMap((r, i) => (split[i]! > 0n ? [{ wallet: r.rec.address, amount: split[i]!, arm: { own: true } }] : [])),
          keys: pos.flatMap((r, i) => (split[i]! > 0n ? [r.key] : [])),
        };
      }
      if (typeof set === "string") return set;
      const claimed: string[] = [];
      for (const key of set.keys) {
        if (!(await claimArm(store, key, { op: ctx.id, side, token }).catch(() => false))) {
          for (const k of claimed) await settleArm(store, k, ctx.id).catch(() => false);
          return "failed";
        }
        claimed.push(key);
      }
      return { ...set, all };
    }

    /** Runs the trade on its legs, then takes this trade's mark off each wallet whose txs it saw fill or fail. */
    async function legsRun(
      store: TradeStore,
      set: { legs: SolanaTradeLeg[]; keys: string[]; all: string[] },
      write: (patch: { stage?: string; txs?: TxRef[]; code?: ErrorCode }) => void,
      refuse: (code: ErrorCode) => Promise<void>,
      landed: () => Promise<boolean>,
    ): Promise<void> {
      const { legs, keys } = set;
      const signer = solanaArmedSigner(store, () => {
        // a seed that answers after the bound is zeroed when it lands: no copy stays in memory unused
        const p = host.seed64();
        return within(p, host.storeMs ?? TRADE_STORE_MS, "the seed's open").catch((e: unknown) => {
          void p.then((seed) => seed.fill(0), () => {});
          throw e;
        });
      }, ctx.id);
      // the legs' signatures the kit kept, from its onSigned: one it dropped as late (the age rule at a signature, card
      // kit-renewal-read-bounded) reaches no answer, stage write or txs, and a teardown's frames are never in it
      const signed: TxRef[] = [];
      // a provider read that failed past its retry, the reference's or any other (cards pool-read-down,
      // pool-answer-unknown): before a leg is signed the trade is "down" (not now), never a failure, and a price check,
      // not_armed or no_route the kit answers keeps its own code; from the first signature on, never down (a tx may land)
      let readDown = false;
      let signing = false;
      const noteDown = (e: unknown): never => {
        if (e instanceof SolanaRpcTransportError) readDown = true;
        throw e;
      };
      // each provider stays itself to the kit (solanaWrappedRpc): its refusal of two that are one, its URL and its one queue
      const watched = (rpc: SolanaRpc): SolanaRpc => solanaWrappedRpc(rpc, (method, params) => rpc(method, params).catch(noteDown));
      // each stage as it comes: the answer at "sent", the fill stages to the frame at once (before any teardown)
      const onProgress = (stage: SolanaTradeStage): void => {
        if (stage === "signed") write({ stage, txs: signed.slice() });
        else if (stage === "sent") {
          write({ stage, txs: signed.slice() });
          give({ result: { stage: "sent", txs: signed.slice() } });
        } else if (answer && "result" in answer && (stage === "filled" || stage === "part_filled" || stage === "not_landed")) {
          write({ stage });
          ctx.progress(stage);
        }
      };
      let record: SolanaTradeRecord | null = null;
      let end: ErrorCode | null = null;
      try {
        // wallets: every arm record's address on Solana, so the kit refuses a tx naming another of the user's wallets
        // (solana-buy-flow 249521d's required SolanaTradeRequest.wallets; typed from the kit once it merges)
        const req: SolanaTradeRequest & { wallets: string[] } = { side, token, slippageBps: params.slippage_bps as number, legs, wallets: set.all };
        record = await run(req, {
          ...host.deps,
          providers: [watched(host.deps.providers[0]), watched(host.deps.providers[1])],
          reference: (q, p) => host.deps.reference(q, p).catch(noteDown),
          sign: (wallet, message, tx) => {
            signing = true;
            return signer.sign(wallet, message, tx);
          },
          onSigned: (kept) => { signed.splice(0, signed.length, ...kept.map((k) => ({ chain: "solana" as const, hash: k.signature }))); },
          onProgress,
        });
      } catch (e) {
        if (!answer) return (await refuse(e instanceof ArmRefused ? "not_armed" : readDown && !signing ? "down" : "failed"), undefined);
        throw e;
      } finally {
        signer.close();
        if (record) {
          // each leg's known end on its tx (filled, failed, not_landed; none while unknown): the op's own record of it,
          // which noted() reads to end the op once the last leg's end is known (state.ts opOf sends {chain, hash} only)
          const txs = record.legs.flatMap((l) => (l.signature ? [{ chain: "solana" as const, hash: l.signature, ...(legEnd(l) ? { state: legEnd(l)! } : {}) }] : []));
          if (answer) write({ txs });
          else {
            const code = refusalCode(record);
            end = readDown && !signing && code === "failed" ? "down" : code;
            write({ stage: "refused", code: end });
          }
        }
        // the marks go only once the op's own record of the end has landed: a lost write keeps them, and the next load
        // (settleTradeOps) or pick reads their txs and writes the end (P2-1), never an op left signed or sent for good
        if (await landed()) await unmark(store, keys, record);
      }
      if (end) give({ error: end });
    }

    // each wallet's mark goes when its txs' end is known here: none signed, none sent (the kit returned its leg
    // unsigned), its swap filled (a buy's goes IN_POSITION) or failed or dead; any other keeps its mark, resolved at a
    // later pick once this trade's lock is free
    // A leg's mark goes only once its known end is on the op (noteLeg, as settleDeadMarks does; re-check of 91fb908e):
    // a mark dropped with its end unwritten would leave the op open with nothing left to end it. True when every mark of
    // this trade went; a kept one (an unknown leg, a lost note, a failed read) is ended by a later settleTradeOps, which
    // any tab's state read runs once this trade's lock is free (tradeSettleDue).
    async function unmark(store: TradeStore, keys: readonly string[], record: SolanaTradeRecord | null): Promise<boolean> {
      const gone = await Promise.all(
        keys.map(async (key, i) => {
          // a read that failed says nothing of the mark: kept, for the next settle pass (re-check of 81b3ce20)
          const got = await store.get("wallets", key).then((v) => ({ v }), () => null);
          if (!got) return false;
          const rec = armRecordOf(key, got.v);
          if (rec?.inflight?.op !== ctx.id) return true;
          const leg = record?.legs[i];
          if (rec.inflight.txs.length === 0) return settleArm(store, key, ctx.id);
          // a leg the kit returned unsigned was never sent: a signature its signer gave and the kit dropped as late (card
          // kit-renewal-read-bounded) is in the mark only, so the mark goes and no later pick notes it on the op
          if (record && leg && leg.signature === undefined) return settleArm(store, key, ctx.id);
          const end = leg ? legEnd(leg) : undefined;
          if (!leg || !end) return false;
          if (!(await noteLeg(store, ctx.id, leg.signature!, end).then(() => true, () => false))) return false;
          return settleArm(store, key, ctx.id, end === "filled" && side === "buy" ? { from: "READY", to: "IN_POSITION", token } : undefined);
        }).map((x) => x.then((v) => v !== false, () => false)),
      );
      return gone.every(Boolean);
    }
  };
  return Object.assign(kind, {
    async idle(): Promise<void> {
      while (runs.size > 0) await Promise.allSettled([...runs]);
    },
  });
}

type LegEnd = "filled" | "failed" | "not_landed";

/**
 * Whether a settle pass is due (re-check of 54cf7a29): the store holds a buy or sell no tab is running that is not
 * settled, whose trade lock no tab holds (locks.query): a wallet's mark, or an op still open (pending, signed, sent)
 * with no mark and no tx, which a pass refuses. Exactly what a pass acts on, so a record no pass changes (an open op
 * with txs and no mark, written before card app-sell-mount) never makes one due at every read.
 * Read from the store every tab shares, so a trade one tab left (closed, a leg unknown, a lost write, a failed mark
 * read) is due in every other; a running trade holds its lock and is its own to end. src/main.ts runs settleTradeOps at
 * a state read when it is due.
 */
export async function tradeSettleDue(store: TradeStore, locks: Pick<LockManager, "query">): Promise<boolean> {
  const ops = new Set((await armRecords(store, "sol")).flatMap((r) => (r.rec.inflight ? [r.rec.inflight.op] : [])));
  for (const k of await store.keys("ops")) {
    if (ops.has(k)) continue;
    const rec = (await store.get("ops", k)) as { kind?: unknown; stage?: unknown; txs?: unknown } | undefined;
    if (rec && (rec.kind === "buy" || rec.kind === "sell") && ["pending", "signed", "sent"].includes(String(rec.stage)) && !(Array.isArray(rec.txs) && rec.txs.length > 0)) ops.add(k);
  }
  if (ops.size === 0) return false;
  // the held names, as pool-sell.ts settleDeadSellOps reads them: a probe that took a dead op's lock, outside
  // TRADE_PICK_LOCK, could make a pick's own settleDeadMarks read that op as live (re-check of efd3845d, P3-a)
  const held = new Set(((await locks.query()).held ?? []).map((l) => l.name));
  return [...ops].some((op) => !held.has(tradeLock(op)));
}

/** One ops write, tried three times (50 and 200 ms apart) before it rejects: the op's end is what the app's sell lock
 *  reads, so it is never dropped on one failed write. */
async function putAgain(store: TradeStore, id: string, v: unknown): Promise<void> {
  for (const wait of [50, 200, -1]) {
    try {
      return void (await store.put("ops", id, v));
    } catch (e) {
      if (wait < 0) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Every dead tab's marks at once (one Promise.all): the marks grouped by op, each op's lock probed once (two probes of
 * one op at once would each read the other as a live trade). A mark whose txs all ended is noted on its op first and
 * goes only once that note landed (a failed note keeps it, P2-1); anything unknown keeps it. Run under TRADE_PICK_LOCK,
 * by every pick and once per load (settleTradeOps).
 */
export async function settleDeadMarks(store: TradeStore, locks: Locks, providers: readonly [SolanaRpc, SolanaRpc]): Promise<void> {
  const byOp = new Map<string, { key: string; m: NonNullable<ArmRecord["inflight"]> }[]>();
  for (const { key, rec } of await armRecords(store, "sol")) if (rec.inflight) byOp.set(rec.inflight.op, [...(byOp.get(rec.inflight.op) ?? []), { key, m: rec.inflight }]);
  await Promise.all(
    [...byOp].map(async ([op, marks]) => {
      const live = await locks.request(tradeLock(op), { mode: "exclusive", ifAvailable: true }, async (l) => l === null);
      if (live) return;
      await Promise.all(
        marks.map(async ({ key, m }) => {
          const states = await Promise.all(m.txs.map((t) => txEnd(providers, t)));
          if (states.includes("unknown")) return;
          if (m.txs[0] && !(await noteLeg(store, op, m.txs[0].sig, states[0] as LegEnd).then(() => true, () => false))) return;
          await settleArm(store, key, op, states[0] === "filled" && m.side === "buy" ? { from: "READY", to: "IN_POSITION", token: m.token } : undefined);
        }),
      );
    }),
  );
}

/**
 * Once per load (src/main.ts landed): the trade ops a closed or reloaded page left open (pending, signed or sent) are
 * settled, as pool-sell.ts settleSellOps and settleDeadSellOps settle a pool sell's (card app-sell-mount re-check 2,
 * P2-1). Under TRADE_PICK_LOCK, so no pick writes a pending record meanwhile: first every dead tab's marks (their txs
 * read with txEnd, the op's end written from them); then each op still open whose own lock is free and that no mark
 * names: with no tx it sent nothing, so it is refused "failed". An open op with txs and no mark is left as it is: its
 * marks went only after its end landed (legsRun), so only a record written before this fix can be one.
 */
export async function settleTradeOps(store: TradeStore, locks: Locks, providers: readonly [SolanaRpc, SolanaRpc]): Promise<void> {
  await locks.request(TRADE_PICK_LOCK, { mode: "exclusive" }, async () => {
    await settleDeadMarks(store, locks, providers);
    const marked = new Set((await armRecords(store, "sol")).flatMap((r) => (r.rec.inflight ? [r.rec.inflight.op] : [])));
    for (const k of await store.keys("ops")) {
      const rec = (await store.get("ops", k)) as { kind?: unknown; stage?: unknown; txs?: unknown } | undefined;
      if (!rec || (rec.kind !== "buy" && rec.kind !== "sell") || !["pending", "signed", "sent"].includes(String(rec.stage)) || marked.has(k)) continue;
      if (Array.isArray(rec.txs) && rec.txs.length > 0) continue;
      const live = await locks.request(tradeLock(k), { mode: "exclusive", ifAvailable: true }, async (l) => l === null);
      if (live) continue;
      await store.update("ops", k, (v) => {
        const r = v as { stage?: unknown; txs?: unknown } | undefined;
        return r && ["pending", "signed", "sent"].includes(String(r.stage)) && !(Array.isArray(r.txs) && r.txs.length > 0) ? { ...r, stage: "refused", code: "failed" } : v;
      });
    }
  });
}

/** How a tx a dead tab signed ended: the kit's readSolanaTxEnd on both providers (06c A4, the send loop's own rule),
 * its expired read as not_landed; unknown keeps its wallet out. */
export async function txEnd(providers: readonly [SolanaRpc, SolanaRpc], t: { sig: string; lvbh: number; blockhash: string }): Promise<LegEnd | "unknown"> {
  const end = await readSolanaTxEnd(providers, { signature: t.sig, blockhash: t.blockhash, lastValidBlockHeight: t.lvbh });
  return end === "expired" ? "not_landed" : end;
}

/** Records how a dead tab's leg ended on its op: the tx's state, and the op's stage once every tx of it has one. One
 * store.update (a compare-and-set), so legs of one op noted at once all land. */
async function noteLeg(store: TradeStore, op: string, sig: string, end: LegEnd): Promise<void> {
  await store.update("ops", op, (v) => {
    const rec = v as { stage?: unknown; txs?: unknown } | undefined;
    if (!rec || typeof rec !== "object") return undefined;
    return noted(rec, sig, end);
  });
}

function noted(rec: { stage?: unknown; txs?: unknown }, sig: string, end: LegEnd): object {
  const txs = (Array.isArray(rec.txs) ? rec.txs : []).filter((t): t is { hash: string; state?: string } => !!t && typeof t === "object" && typeof (t as { hash?: unknown }).hash === "string");
  const i = txs.findIndex((t) => t.hash === sig);
  if (i >= 0) txs[i] = { ...txs[i]!, state: end };
  else txs.push({ chain: "solana", hash: sig, state: end } as { hash: string; state: string });
  let stage = rec.stage;
  const ends = txs.map((t) => t.state);
  if (!["filled", "part_filled", "not_landed", "refused"].includes(String(stage)) && ends.every((e) => e !== undefined)) {
    stage = ends.every((e) => e === "filled") ? "filled" : ends.some((e) => e === "filled") ? "part_filled" : "not_landed";
  }
  return { ...rec, txs, stage };
}

/** A repeated id's answer from its ops record: its trade stage and txs, its code; id_reused while it is pending or when the request differs. */
export function fromRecord(rec: unknown, sha: string): Answer {
  const r = rec as { kind?: unknown; sha?: unknown; stage?: unknown; txs?: unknown; code?: unknown } | null;
  if (!r || (r.kind !== "buy" && r.kind !== "sell") || typeof r.sha !== "string" || r.sha !== sha) return { error: "id_reused" };
  if (typeof r.code === "string") return { error: r.code };
  if (typeof r.stage === "string" && TRADE_STAGES.includes(r.stage) && Array.isArray(r.txs)) {
    const txs = (r.txs as { chain?: unknown; hash?: unknown }[]).filter((t) => t && t.chain === "solana" && typeof t.hash === "string").map((t) => ({ chain: "solana" as const, hash: t.hash as string }));
    return { result: { stage: r.stage as TradeStage, txs } satisfies SignpageResults["buy"] };
  }
  return { error: "id_reused" };
}
