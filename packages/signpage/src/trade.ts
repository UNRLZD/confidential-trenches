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
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { readSolanaTxEnd, solanaHelperRpc, solanaSendPaths, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageRpc } from "./page-rpc.ts";
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
export const TRADE_HELPER = "https://api.confidential.unrealized.trade";

/** Provider A of LD1, reached from the device: PublicNode's keyless Solana RPC (the kit's dry run's, solana-flow-dry.ts). */
export const SOLANA_PROVIDER_A = "https://solana-rpc.publicnode.com";

/** The release's trade deps: provider A device-direct and provider B the helper's /v1/rpc/solana (LD1), E(A) from the
 * device's own pool reads on both, and the kit's send paths with the helper's. */
export function releaseTradeDeps(): TradeHost["deps"] {
  // the page's one RPC client (src/page-rpc.ts): a throttled read is tried again within its bounds, never a failed trade
  const providers = [pageRpc(SOLANA_PROVIDER_A), pageHelperRpc(TRADE_HELPER)] as const;
  return {
    helper: TRADE_HELPER,
    providers,
    reference: (q) => readSolanaReference(providers, q),
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
const filled = (l: Leg): boolean => l.outcome?.state === "filled" || l.reread?.state === "filled";
// landed with an error on both providers, or dead (06c A4, the kit's send.ts): its money moves no more
const ended = (l: Leg): boolean => legState(l) === "failed" || legState(l) === "expired";

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
      let writes: Promise<void> = Promise.resolve();
      const write = (patch: Partial<typeof op>): void => {
        Object.assign(op, patch);
        const snap = { ...op, txs: op.txs.map((t) => ({ ...t })) };
        writes = writes.then(() => store.put("ops", ctx.id, snap)).catch(() => {});
      };
      const refuse = async (code: ErrorCode): Promise<void> => {
        write({ stage: "refused", code });
        await writes;
        give({ error: code });
      };

      // a read that fails before the answer refuses the trade; the op says so
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
        await legsRun(store, set, write, refuse);
      } catch (e) {
        if (!answer) return refuse("failed");
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
      // every dead tab's marks at once (one Promise.all), so the pick lock is held for one round of reads, not one per
      // mark; the marks grouped by op, each op's lock probed once (two probes of one op at once would each read the
      // other as a live trade)
      const byOp = new Map<string, { key: string; m: NonNullable<ArmRecord["inflight"]> }[]>();
      for (const { key, rec } of await armRecords(store, "sol")) if (rec.inflight) byOp.set(rec.inflight.op, [...(byOp.get(rec.inflight.op) ?? []), { key, m: rec.inflight }]);
      await Promise.all(
        [...byOp].map(async ([op, marks]) => {
          const live = await locks.request(tradeLock(op), { mode: "exclusive", ifAvailable: true }, async (l) => l === null);
          if (live) return;
          await Promise.all(
            marks.map(async ({ key, m }) => {
              const states = await Promise.all(m.txs.map((t) => txEnd(host.deps.providers, t)));
              if (states.includes("unknown")) return;
              await settleArm(store, key, op, states[0] === "filled" && m.side === "buy" ? { from: "READY", to: "IN_POSITION", token: m.token } : undefined);
              if (m.txs[0]) await noteLeg(store, op, m.txs[0].sig, states[0] as LegEnd).catch(() => {});
            }),
          );
        }),
      );
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
      write: (patch: { stage?: string; txs?: TxRef[] }) => void,
      refuse: (code: ErrorCode) => Promise<void>,
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
      try {
        // wallets: every arm record's address on Solana, so the kit refuses a tx naming another of the user's wallets
        // (solana-buy-flow 249521d's required SolanaTradeRequest.wallets; typed from the kit once it merges)
        const req: SolanaTradeRequest & { wallets: string[] } = { side, token, slippageBps: params.slippage_bps as number, legs, wallets: set.all };
        record = await run(req, {
          ...host.deps,
          sign: (wallet, message, tx) => signer.sign(wallet, message, tx),
          onSigned: (kept) => { signed.splice(0, signed.length, ...kept.map((k) => ({ chain: "solana" as const, hash: k.signature }))); },
          onProgress,
        });
      } catch (e) {
        if (!answer) return (await refuse(e instanceof ArmRefused ? "not_armed" : "failed"), undefined);
        throw e;
      } finally {
        signer.close();
        await unmark(store, keys, record);
      }
      const txs = record.legs.flatMap((l) => (l.signature ? [{ chain: "solana" as const, hash: l.signature }] : []));
      if (!answer) return refuse(refusalCode(record));
      write({ txs });
    }

    // each wallet's mark goes when its txs' end is known here: none signed, none sent (the kit returned its leg
    // unsigned), its swap filled (a buy's goes IN_POSITION) or failed or dead; any other keeps its mark, resolved at a
    // later pick once this trade's lock is free
    async function unmark(store: TradeStore, keys: readonly string[], record: SolanaTradeRecord | null): Promise<void> {
      await Promise.all(
        keys.map(async (key, i) => {
          const rec = armRecordOf(key, await store.get("wallets", key).catch(() => undefined));
          if (rec?.inflight?.op !== ctx.id) return;
          const leg = record?.legs[i];
          if (rec.inflight.txs.length === 0) return settleArm(store, key, ctx.id);
          // a leg the kit returned unsigned was never sent: a signature its signer gave and the kit dropped as late (card
          // kit-renewal-read-bounded) is in the mark only, so the mark goes and no later pick notes it on the op
          if (record && leg && leg.signature === undefined) return settleArm(store, key, ctx.id);
          if (leg && filled(leg)) return settleArm(store, key, ctx.id, side === "buy" ? { from: "READY", to: "IN_POSITION", token } : undefined);
          if (leg && ended(leg)) return settleArm(store, key, ctx.id);
        }).map((x) => x.catch(() => false)),
      );
    }
  };
  return Object.assign(kind, {
    async idle(): Promise<void> {
      while (runs.size > 0) await Promise.allSettled([...runs]);
    },
  });
}

type LegEnd = "filled" | "failed" | "not_landed";

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
