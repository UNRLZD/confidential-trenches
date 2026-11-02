// The `buy` kind on Solana: a buy or a sell from the trade box, signed on SIGN_HOST (card signpage-solana-trade;
// wallet.md §2.8 "Buy from fresh wallets", §7 item 4; markets.md T1.3 the standard-size set, S1-S13, LD1; the shapes are
// packages/kit/src/signpage/messages.ts, api 1). The shell answers it (src/main.ts); the frame never signs.
//
// - The request is hostile. Only chain "solana" is taken here; every other chain is refused not_allowed until its card.
//   A buy's `amount` is USD with at most two decimals, a sell's is the token's base units.
// - Before anything is read or signed, the request's id is written to the store's "ops" as { kind, stage "pending",
//   txs [], created_ms } (wallet.md §7 item 4). A request whose id already has an ops record is never run again: it is
//   answered from the record (its trade stage and txs, or its code), or "id_reused" while the record is still pending
//   (a run that a reload cut short may have signed). "pending" is no TradeStage, so the frame's state leaves it out.
// - The legs come from the wallet store's arm records (packages/wallet/src/arming/records.ts) only, never from the
//   request: a buy is the amount's ladder split (1-2-5 per power of ten from $2, largest first, wallet.md §2.5), each
//   size a READY fresh wallet of that size, which spends its record's `spend` (a_k, set by the arming); a sell takes
//   the IN_POSITION wallets of that token, reads each one's token balance on both providers (the lower), and splits the
//   amount over them in proportion, so an amount equal to the held total sells each whole balance (T1.3 item 6). A
//   size with no ready wallet, or a sell over what is held, is refused before anything is signed.
// - runSolanaTrade (the kit) runs the reads, builds, checks S1-S13, signatures, sends and fill reads. Its signer is the
//   wallet's solanaArmedSigner, which refuses any wallet without this device's own arm record before the seed opens,
//   whatever the legs' `arm.own` says; the seed is zeroed when the trade ends.
// - The answer: { stage "sent", txs } once every leg is signed and sent (the kit's "sent"); the fill then comes as a
//   `progress` event (filled, part_filled, not_landed). A trade that ends before "sent" is answered with its code:
//   quote_check_failed when a leg's price check refused it (the trade box's Price check failed), and otherwise
//   not_armed, no_ready_set, no_position, over_held, no_route or failed (the trade box's Failed). Every stage is
//   written to the op as it comes, so a `state` read after a client timeout shows it.
// - After the fill, each filled buy leg's record moves READY → IN_POSITION with the token (moveArmRecord, which makes
//   no record and never touches its own-withdrawal mark). Nothing here logs.
import { base58 } from "@scure/base";
import { solanaAta, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/index.ts";
import { runSolanaTrade, type SolanaTradeDeps, type SolanaTradeLeg, type SolanaTradeRecord, type SolanaTradeStage } from "../../kit/src/trade/solana/flow.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { solanaHelperRpc, solanaJsonRpc, solanaSendPaths, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { ErrorCode, SignpageResults, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { ArmRefused, armRecords, moveArmRecord, solanaArmedSigner, type ArmRecord } from "@blindfill/wallet/arming/records";
import type { WalletStore } from "@blindfill/wallet/store";
import type { HostAnswer, KindContext, Running } from "./api.ts";

export type TradeStore = Pick<WalletStore, "get" | "put" | "keys">;

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
}

/** The release's helper: the wallet's RELEASE_HELPER (withdraw/relay.ts; test/trade.test.ts holds them equal), not imported, so
 * the page's bundle carries none of the relay's NEAR code. */
export const TRADE_HELPER = "https://api.confidential.unrealized.trade";

/** Provider A of LD1, reached from the device: PublicNode's keyless Solana RPC (the kit's dry run's, solana-flow-dry.ts). */
export const SOLANA_PROVIDER_A = "https://solana-rpc.publicnode.com";

/** The release's trade deps: provider A device-direct and provider B the helper's /v1/rpc/solana (LD1), E(A) from the
 * device's own pool reads on both, and the kit's send paths with the helper's. */
export function releaseTradeDeps(): TradeHost["deps"] {
  const providers = [solanaJsonRpc(SOLANA_PROVIDER_A), solanaHelperRpc(TRADE_HELPER)] as const;
  return {
    helper: TRADE_HELPER,
    providers,
    reference: async (q) => (await readSolanaReference(providers, q))?.expectedOut ?? null,
    paths: solanaSendPaths({ helper: solanaHelperRpc(TRADE_HELPER) }),
  };
}

const TRADE_STAGES: readonly string[] = ["signed", "sent", "filled", "part_filled", "refused", "not_landed"];
const USD = /^(\d{1,15})(?:\.(\d{1,2}))?$/;
const UNITS = /^[1-9]\d{0,19}$/;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** The ladder sizes of an amount in cents, largest first with repeats; null when it is not a sum of ladder sizes. */
export function ladderSizes(cents: bigint): bigint[] | null {
  const rungs: bigint[] = [];
  for (let p = 100n; p <= cents; p *= 10n) for (const m of [1n, 2n, 5n]) if (p * m >= 200n && p * m <= cents) rungs.push(p * m);
  rungs.reverse();
  const out: bigint[] = [];
  let rest = cents;
  for (const r of rungs) while (rest >= r) (out.push(r), (rest -= r));
  return rest === 0n && out.length > 0 ? out : null;
}

/** A buy's legs: one READY fresh wallet of each ladder size of the amount, each spending its record's a_k. */
export function buyLegs(records: readonly { key: string; rec: ArmRecord }[], cents: bigint): { legs: SolanaTradeLeg[]; keys: string[] } | null {
  const sizes = ladderSizes(cents);
  if (!sizes) return null;
  const free = records.filter((r) => r.rec.role === "fresh" && r.rec.state === "READY").sort((a, b) => (a.key < b.key ? -1 : 1));
  const used = new Set<string>();
  const legs: SolanaTradeLeg[] = [];
  const keys: string[] = [];
  for (const s of sizes) {
    const r = free.find((x) => x.rec.size_cents === s && !used.has(x.key));
    if (!r) return null;
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
async function accounts(rpc: SolanaRpc, keys: readonly string[]): Promise<Acc[]> {
  const out: Acc[] = [];
  for (let i = 0; i < keys.length; i += 10) {
    const group = keys.slice(i, i + 10);
    const r = (await rpc("getMultipleAccounts", [group, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown };
    if (!r || !Array.isArray(r.value) || r.value.length !== group.length) throw new Error("getMultipleAccounts answered another count");
    for (const a of r.value as unknown[]) {
      if (a === null) out.push(null);
      else {
        const o = a as { owner?: unknown; data?: unknown };
        if (typeof o.owner !== "string" || !Array.isArray(o.data) || typeof o.data[0] !== "string" || o.data[1] !== "base64") throw new Error("not a base64 account");
        out.push({ owner: o.owner, data: Uint8Array.from(atob(o.data[0]), (c) => c.charCodeAt(0)) });
      }
    }
  }
  return out;
}

/** The token balance of each wallet's own account of `mint`, the lower of the two providers'; 0 for none. */
export async function heldOnBoth(providers: readonly [SolanaRpc, SolanaRpc], mint: string, wallets: readonly string[]): Promise<bigint[]> {
  const [ma, mb] = await Promise.all(providers.map((p) => accounts(p, [mint])));
  const program = ma![0]?.owner;
  if (program !== mb![0]?.owner || (program !== SOLANA_TOKEN_PROGRAM && program !== SOLANA_TOKEN_2022_PROGRAM)) throw new Error("the mint is not one token mint on both providers");
  const atas = wallets.map((w) => solanaAta(w, mint, program));
  const reads = await Promise.all(providers.map((p) => accounts(p, atas)));
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
  if (why.some((w) => /^checks: |^no reference pool|^the route quotes |^the route's floor |^the floor rounds/.test(w))) return "quote_check_failed";
  if (why.length > 0 && why.every((w) => w.startsWith("the wallet was not armed"))) return "not_armed";
  if (why.some((w) => w.startsWith("build no_route"))) return "no_route";
  return "failed";
}

const filled = (l: SolanaTradeRecord["legs"][number]): boolean => l.outcome?.state === "filled" || l.reread?.state === "filled";
// sent, and neither filled nor failed on both providers: its money may still move
const unknown = (l: SolanaTradeRecord["legs"][number]): boolean =>
  l.signature !== undefined && (l.reread ? l.reread.state === "unknown" : l.outcome === undefined || l.outcome.state === "unknown");

type Answer = HostAnswer<"buy">;

/** The `buy` kind's handler for the shell's `kinds` (src/main.ts). */
export function tradeKind(host: TradeHost): (params: Record<string, unknown>, ctx: KindContext) => Running<"buy"> | null {
  const run = host.run ?? runSolanaTrade;
  const now = host.now ?? Date.now;
  // the arm records of wallets a trade of this page is using: no second trade picks one until the first has ended, and
  // one whose tx is still unknown stays out for the page's life (its money may yet move)
  const busy = new Set<string>();
  return (params, ctx) => {
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
    void trade().catch(() => give({ error: "failed" }));
    return { running: true, after, answer: () => answer };

    async function trade(): Promise<void> {
      const store = await host.store();
      const prior = await store.get("ops", ctx.id);
      if (prior !== undefined) return give(fromRecord(prior));
      const op: { kind: "buy" | "sell"; stage: string; txs: TxRef[]; code?: ErrorCode; created_ms: number } = { kind: side, stage: "pending", txs: [], created_ms: now() };
      let writes: Promise<void> = store.put("ops", ctx.id, { ...op });
      const write = (patch: Partial<typeof op>): void => {
        Object.assign(op, patch);
        const snap = { ...op, txs: op.txs.map((t) => ({ ...t })) };
        writes = writes.then(() => store.put("ops", ctx.id, snap)).catch(() => {});
      };
      await writes;
      const refuse = async (code: ErrorCode): Promise<void> => {
        write({ stage: "refused", code });
        await writes;
        give({ error: code });
      };

      // a read that fails before the answer refuses the trade; the op says so
      try {
        const records = (await armRecords(store, "sol")).filter((r) => !busy.has(r.key));
        let legs: SolanaTradeLeg[];
        let keys: string[] = [];
        if (side === "buy") {
          const set = buyLegs(records, cents);
          if (!set) return refuse("no_ready_set");
          ({ legs, keys } = set);
        } else {
          const pos = records.filter((r) => r.rec.role === "fresh" && r.rec.state === "IN_POSITION" && r.rec.token === token);
          if (pos.length === 0) return refuse("no_position");
          const held = await heldOnBoth(host.deps.providers, token, pos.map((r) => r.rec.address));
          const split = sellSplit(units, held);
          if (!split) return refuse("over_held");
          legs = pos.flatMap((r, i) => (split[i]! > 0n ? [{ wallet: r.rec.address, amount: split[i]!, arm: { own: true } }] : []));
          keys = pos.flatMap((r, i) => (split[i]! > 0n ? [r.key] : []));
        }
        for (const k of keys) busy.add(k);
        let keep = keys;
        try {
          keep = await legsRun(store, legs, keys, write, refuse);
        } finally {
          for (const k of keys) if (!keep.includes(k)) busy.delete(k);
        }
      } catch (e) {
        if (!answer) return refuse("failed");
        throw e;
      } finally {
        await writes;
      }
    }

    /** Runs the trade on its legs; answers the keys whose txs are still unknown at its end (all of them on a throw after the answer). */
    async function legsRun(
      store: TradeStore,
      legs: SolanaTradeLeg[],
      keys: string[],
      write: (patch: { stage?: string; txs?: TxRef[] }) => void,
      refuse: (code: ErrorCode) => Promise<void>,
    ): Promise<string[]> {
      const signer = solanaArmedSigner(store, host.seed64);
      const signed: TxRef[] = [];
      let last: SolanaTradeStage | null = null;
      const onProgress = (stage: SolanaTradeStage): void => {
        last = stage;
        if (stage === "signed") write({ stage, txs: signed.slice() });
        else if (stage === "sent") {
          write({ stage, txs: signed.slice() });
          give({ result: { stage: "sent", txs: signed.slice() } });
        }
      };
      let record: SolanaTradeRecord;
      try {
        record = await run(
          { side, token, slippageBps: params.slippage_bps as number, legs },
          {
            ...host.deps,
            sign: async (wallet, message) => {
              const sig = await signer.sign(wallet, message);
              // the legs sign before "signed"; a teardown's frames sign after the fill and are not the trade's txs
              if (last === null) signed.push({ chain: "solana", hash: base58.encode(sig) });
              return sig;
            },
            onProgress,
          },
        );
      } catch (e) {
        if (!answer) return (await refuse(e instanceof ArmRefused ? "not_armed" : "failed"), []);
        throw e;
      } finally {
        signer.close();
      }
      const txs = record.legs.flatMap((l) => (l.signature ? [{ chain: "solana" as const, hash: l.signature }] : []));
      if (!answer) return (await refuse(refusalCode(record)), []);
      const final = last as SolanaTradeStage | null;
      if (final === "filled" || final === "part_filled" || final === "not_landed") {
        write({ stage: final, txs });
        ctx.progress(final);
      } else write({ txs });
      if (side === "buy") {
        await Promise.all(
          record.legs.map((l, i) => (filled(l) ? moveArmRecord(store, keys[i]!, "READY", "IN_POSITION", token).catch(() => false) : false)),
        );
      }
      return keys.filter((_, i) => unknown(record.legs[i]!));
    }
  };
}

/** A repeated id's answer from its ops record: its trade stage and txs, its code, or id_reused while it is pending. */
function fromRecord(rec: unknown): Answer {
  const r = rec as { kind?: unknown; stage?: unknown; txs?: unknown; code?: unknown } | null;
  if (!r || (r.kind !== "buy" && r.kind !== "sell")) return { error: "id_reused" };
  if (typeof r.code === "string") return { error: r.code };
  if (typeof r.stage === "string" && TRADE_STAGES.includes(r.stage) && Array.isArray(r.txs)) {
    const txs = (r.txs as { chain?: unknown; hash?: unknown }[]).filter((t) => t && t.chain === "solana" && typeof t.hash === "string").map((t) => ({ chain: "solana" as const, hash: t.hash as string }));
    return { result: { stage: r.stage as TradeStage, txs } satisfies SignpageResults["buy"] };
  }
  return { error: "id_reused" };
}
