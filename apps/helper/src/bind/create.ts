// The creation of a one-time id after 1Click delivered to it (wallet.md §2.4 step 6 and "The gate on U", M280;
// M6: the relayer creates U, R and V by a plain Transfer, only after the delivery to that id). For one 64-hex id:
//
//   1. One run per id in this process: a second call while one runs shares its answer (the store's lock makes this
//      process the only one).
//   2. The read-back first: while an earlier Transfer of ours to the id has no known outcome, the id's account is read
//      (one that exists is never sent to) and that Transfer read again, its stored bytes sent again (one signed nonce
//      lands at most once); nothing new goes out while it may still land. A Transfer known landed holds every later read
//      below its receipt's height: no read older than it counts.
//   3. The gate, in the relayer's queue right before the Transfer is signed: at one final block, the same on both
//      providers (fee.ts agreedBlock), the id is absent (UNKNOWN_ACCOUNT and an empty key list on both, so it has no
//      key) and holds at least MIN_DEPOSIT of the vault's token (ft_balance_of, the same bytes on both). A read that
//      fails or disagrees sends nothing.
//   4. One Transfer of CREATE_YOCTO, the only action of its transaction, written to the store before it is broadcast.
//
// Why the gate: a Transfer before delivery is the cheapest grief, about 0.007-0.01 N of ours per id against 0.00125 N
// of the attacker's (V@1a7a23f:759-762, M280). With it, every id we create holds at least MIN_DEPOSIT, and we spend at
// most one creation per delivery. CREATE_YOCTO comes back to the relayer by the id's clean-up (wallet.md "Clean-up");
// the 0.007 N account creation charge does not.
import { MIN_DEPOSIT } from "./checks.ts";
import { RELAYER_FLOOR_YOCTO, type CreationRecord, type DepositStore, type Relayer, type Rpc, type TxOutcome } from "./send.ts";
import { agreedBlock, viewAt } from "../withdraw/fee.ts";
import { A_STORE_YOCTO, accountAt, type AccountRead } from "../withdraw/send.ts";

/**
 * The Transfer's amount: an implicit id's record and its one key, 182 B x 1e19, the arming account's A_store (M:1586,
 * W:742) for the same account shape; U's storage_usage reads 182 on testnet (c6402698…947f, FastNEAR, 2026-11-06).
 */
export const CREATE_YOCTO = A_STORE_YOCTO;

export type CreateCode =
  /** Not a 64-hex implicit id: never created. */
  | "not_implicit"
  /** The id holds none of the token. */
  | "no_delivery"
  /** The id holds some, under MIN_DEPOSIT. */
  | "under_min"
  /** The id exists already (any key, any balance): never sent to. */
  | "exists"
  /** Our Transfer landed: the id exists now. */
  | "created"
  /** A Transfer of ours may still land, or the reads are behind it: nothing new sent. */
  | "in_flight"
  /** Our Transfer failed on chain. */
  | "create_failed"
  /** The gas account cannot hold the Transfer and one deposit's worst after it. */
  | "relayer_low"
  /** A read failed or the providers disagree: nothing sent. */
  | "unread";

export type CreateAnswer = { code: CreateCode; tx_hash?: string; why?: string };

/** What the gate reads: at one final block on both providers, the id's account and its balance of the token. */
export type Delivery = { height: bigint; account: AccountRead; balance: bigint };

export type CreateDeps = {
  /** The vault's token. */
  token: string;
  /** The gate's read of `id` (deliveryReads). */
  delivery(id: string): Promise<Delivery>;
  store: Pick<DepositStore, "creation" | "putCreation">;
  relayer: Relayer;
};

/** The gate's reads on two providers: one agreed final block, then the account and ft_balance_of at it on both. */
export function deliveryReads(rpcs: readonly [Rpc, Rpc], token: string, now: () => number = Date.now): (id: string) => Promise<Delivery> {
  return async (id) => {
    const b = await agreedBlock(rpcs, now);
    const [account, bal] = await Promise.all([accountAt(rpcs, b, id), viewAt(rpcs, b, token, "ft_balance_of", { account_id: id })]);
    if (typeof bal !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(bal)) throw new Error("ft_balance_of: not a u128 decimal");
    return { height: b.height, account, balance: BigInt(bal) };
  };
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** The gate on one read: null when the id may be created at it, else the code that holds it. */
export function gate(d: Delivery, landedAt: bigint | null): CreateCode | null {
  if (landedAt !== null && d.height < landedAt) return "in_flight";
  if (d.account.kind !== "absent") return "exists";
  if (d.balance === 0n) return "no_delivery";
  if (d.balance < MIN_DEPOSIT) return "under_min";
  return null;
}

/** The ids being created in this process, per gas account (one per network): "<account>/<id>" -> the run's answer. */
const running = new Map<string, Promise<CreateAnswer>>();

/** Creates `id` once 1Click delivered to it; see the header. Concurrent calls for one id share one run. */
export function createOnDelivery(id: string, deps: CreateDeps): Promise<CreateAnswer> {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) return Promise.resolve({ code: "not_implicit" });
  const slot = `${deps.relayer.account}/${id}`;
  const busy = running.get(slot);
  if (busy !== undefined) return busy;
  const run = createOnce(id, deps).finally(() => running.delete(slot));
  running.set(slot, run);
  return run;
}

/** The outcome of a Transfer into its record. */
function outcomeOf(rec: CreationRecord, out: Extract<TxOutcome, { kind: "final" | "dropped" }>): CreationRecord {
  if (out.kind === "dropped") return { ...rec, last: { ...rec.last, state: "dropped" } };
  const ok = out.receipts.length > 0 && out.receipts.every((r) => r.ok);
  const top = out.receipts.reduce((h, r) => (r.height > h ? r.height : h), 0n);
  return { ...rec, last: { ...rec.last, state: ok ? "landed" : "failed", landed_at: top.toString() } };
}

async function createOnce(id: string, deps: CreateDeps): Promise<CreateAnswer> {
  const { store, relayer } = deps;
  let rec: CreationRecord | null = store.creation(id);

  // 2. The read-back: an id that exists is never sent to, so its account is read first; a Transfer of ours that may
  // still land is then read (its bytes sent again) before anything new.
  if (rec !== null && rec.last.state === "pending") {
    let d: Delivery;
    try {
      d = await deps.delivery(id);
    } catch (e) {
      return { code: "unread", why: why(e) };
    }
    if (d.account.kind !== "absent") return { code: "exists", tx_hash: rec.last.tx_hash };
    const out = await relayer.resolve(rec.last, { resend: true });
    if (out.kind === "unknown") return { code: "in_flight", tx_hash: rec.last.tx_hash };
    rec = outcomeOf(rec, out);
    store.putCreation(rec);
    if (rec.last.state === "landed") return { code: "created", tx_hash: rec.last.tx_hash };
    if (rec.last.state === "failed") return { code: "create_failed", tx_hash: rec.last.tx_hash };
  }
  const landedAt = rec !== null && rec.last.state === "landed" && rec.last.landed_at !== null ? BigInt(rec.last.landed_at) : null;

  // The floor: the Transfer and, after it, one deposit's worst (send.ts RELAYER_FLOOR_YOCTO), so a created id is carried.
  if ((await relayer.balance()) < RELAYER_FLOOR_YOCTO + CREATE_YOCTO) return { code: "relayer_low" };

  // 3-4. The gate in the queue, then the one Transfer, recorded before it goes.
  let unread = "";
  const out = await relayer.send<CreateCode>(
    { kind: "transfer", receiver: id, amount: CREATE_YOCTO },
    async () => {
      try {
        return gate(await deps.delivery(id), landedAt);
      } catch (e) {
        unread = why(e);
        return "unread";
      }
    },
    (tx) => {
      const sent: CreationRecord = { id, last: { ...tx, state: "pending", landed_at: null } };
      rec = sent;
      store.putCreation(sent);
    },
  );
  if (out.kind === "guarded") return out.code === "unread" ? { code: "unread", why: unread } : { code: out.code };
  if (out.kind === "unknown") return { code: "in_flight", tx_hash: out.tx_hash };
  rec = outcomeOf(rec!, out);
  store.putCreation(rec);
  // dropped: it never applied and never can, so the next call reads the gate again and may send afresh
  if (out.kind === "dropped") return { code: "in_flight", tx_hash: out.tx_hash, why: out.why };
  return { code: rec.last.state === "landed" ? "created" : "create_failed", tx_hash: out.tx_hash };
}
