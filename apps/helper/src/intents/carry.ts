// POST /v1/intents (card helper-id-intents; markets.md H4.3, the paragraph "The ids' intents on /v1/intents", and H7's
// /v1/intents row): one signed intents.near intent of a one-time id (U, R or V), carried with execute_intents from
// bind.<ours>.near. It carries a transfer to a 1Click deposit address our helper quoted with the signer as refundTo,
// or an ft_withdraw to a NEAR account, and nothing else; it never carries a move into the vault.
//
// The checks, in the paper's order; every one before the simulation reads nothing on chain but the final block's time:
//   1. the gate: a signer our helper saw receive money (records.ts), else id_not_ours (403), before any chain read;
//   2. receiver_is_vault (403): any intent whose receiver_id is the vault;
//   3. bad_shape: one canonical payload (its JSON written back is its own bytes, so no repeated key or escape can make
//      intents.near read another intent than this file does) of exactly one transfer or ft_withdraw, exact keys,
//      verifying_contract intents.near, no memo, no msg, no storage_deposit;
//   4. not_helper_quote (transfer): our quote record of the deposit address, live (dry false), depositType INTENTS,
//      refundTo the signer with refundType INTENTS, its deadline not passed;
//   5. expired: the intent's deadline not ahead of the newer final block time of the two providers;
//   6. sender_struck (403): three failed sends of this signer here, kept across a restart; signer_cap (429): it has had
//      INTENTS_SENDS_MAX sends carried, landed or not (an id makes two or three moves), so a seen signer cannot
//      spend the gas account's NEAR by sends that land;
//   7. in_flight: the same intent (signer and nonce) while one send of it is out;
//   8. simulation_refused: simulate_intents on both providers at one block, both ran it and their bytes agree;
//   9. the signer's own registration on the release's USDC (card intents-u-registered-first): storage_balance_of(signer)
//      on both; null gets one storage_deposit (registration_only, REGISTRATION_YOCTO) for the signer, sent before its
//      intent and only once it ran, so every id leaves a lasting public trace on the token before its first intent
//      (restore's storage rule reads that trace as used, whatever intents.near later deletes or prunes). A second
//      intent of a registered signer sends none. The same registration also starts when a status answer first shows
//      the signer money (registerSeen, from the proxy's status hook): the signing page signs no intent of U's until
//      it reads U registered on two RPCs, so the device's first intent can only come after it;
//  9b. (ft_withdraw) the receiver's registration: storage_balance_of on both; null on both and the token the release's
//      USDC gets one storage_deposit (registration_only, REGISTRATION_YOCTO) per signer, sent before the intent and
//      only once it ran; a second one, or another token, gets receiver_not_registered (409). A receiver that is the
//      signer itself on USDC is the signer's own registration (9);
//  10. relayer_low (503): the gas account under INTENTS_FLOOR_YOCTO, 1 NEAR above the deposits' floor; then expired
//      again, read after the registration (which can take until the deadline);
//  11. the send: execute_intents with nothing attached. A send that fails on chain counts toward the signer's three, as
//      does a registration that fails (registration_failed, no intent sent).
// No prepay, and never token_halted: neither kind calls the token into the vault (H4.3 "No hold on a halt").
import { HELPER_CODE_STATUS, type HelperIntentsCode, type HelperSignedIntent } from "@blindfill/kit";
import { base58decode, RELAYER_FLOOR_YOCTO, type Relayer, type TxOutcome, type TxRef } from "../bind/send.ts";
import { isAccountId } from "../withdraw/checks.ts";
import { STRUCK_AT, type IntentsStore, type Registration, type SignerRecord } from "./records.ts";

export const INTENTS_CONTRACT = "intents.near";
/** The body limit: the kit's HELPER_V1_PATHS row for POST /v1/intents (8 KB). */
export const INTENTS_BODY_MAX = 8_192;
/** execute_intents' gas: the most one transaction holds; what it does not burn comes back to the gas account. */
export const EXECUTE_GAS = 300_000_000_000_000n;
/** storage_deposit's gas (bind/send.ts PREPAY_GAS's 30 Tgas). */
export const REGISTER_GAS = 30_000_000_000_000n;
/** USDC's storage_balance_bounds().min on NEAR (D16, 0.00125 N; withdraw/fixtures/withdraw-fee-table.json register_deposit). */
export const REGISTRATION_YOCTO = 1_250_000_000_000_000_000_000n;
/**
 * The gas account's floor for this endpoint: the deposits' floor (bind/send.ts RELAYER_FLOOR_YOCTO) and 1 NEAR above
 * it, so an intent's send or registration never takes bind.<ours>.near below what a deposit needs (review H1).
 */
/**
 * The most sends this endpoint carries for one signer, landed or failed (review H1): an id makes two or three moves, so
 * four leave one spare. The fifth answers signer_cap (429), final for that signer here as sender_struck is.
 * signer_cap is the helper's own code until the kit lists it (HELPER_INTENTS_CODES and HELPER_CODE_STATUS in
 * packages/kit/src/helper/v1.ts are frozen with kit-v1: adding it there is a kit change with its own tag); the
 * device reads an unlisted code as a refusal and backs off, sending nothing.
 */
export const INTENTS_SENDS_MAX = 4;
export const SIGNER_CAP_STATUS = 429;
export const INTENTS_FLOOR_YOCTO = RELAYER_FLOOR_YOCTO + 10n ** 24n;
/** How often a send whose outcome was not read is read again, until its intent's deadline passes. */
export const RESOLVE_EVERY_MS = 2_000;

export type IntentsCode = HelperIntentsCode | "signer_cap" | "upstream";
export type IntentsAnswer = { status: number; body: { tx_hash: string } | { error: { code: IntentsCode } } };

export type IntentsReads = {
  /** The newer final block's time (unix ms) of the two providers; throws when either does not answer. */
  finalMs(): Promise<bigint>;
  /** simulate_intents on both providers at one block: true only when both ran it, with the same bytes. */
  simulate(signed: HelperSignedIntent): Promise<boolean>;
  /** storage_balance_of(account) on `token` on both providers at one block; throws when they disagree or a read fails. */
  storage(token: string, account: string): Promise<"registered" | "none">;
};

export type IntentsDeps = {
  /** The release's vault and USDC. */
  vault: string;
  usdc: string;
  store: IntentsStore;
  reads: IntentsReads;
  relayer: Pick<Relayer, "send" | "resolve" | "balance">;
  now?: () => number;
  resolveEveryMs?: number;
};

const STATUS: Record<string, number> = { ...HELPER_CODE_STATUS, signer_cap: SIGNER_CAP_STATUS };
const no = (code: IntentsCode): IntentsAnswer => ({ status: STATUS[code] ?? 400, body: { error: { code } } });
const sent = (tx_hash: string): IntentsAnswer => ({ status: 200, body: { tx_hash } });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keysAre = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const AMOUNT = /^[1-9][0-9]{0,38}$/;
const u128 = (s: unknown): s is string => typeof s === "string" && AMOUNT.test(s) && BigInt(s) < 1n << 128n;
const DEADLINE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const NONCE = /^[A-Za-z0-9+/]{43}=$/;
const ASSET = /^nep(141|245):[a-z0-9._:-]{2,200}$/;
const b58len = (s: unknown, prefix: string, n: number) => {
  if (typeof s !== "string" || !s.startsWith(prefix) || !/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s.slice(prefix.length))) return false;
  try {
    return base58decode(s.slice(prefix.length)).length === n;
  } catch {
    return false;
  }
};

type Transfer = { intent: "transfer"; receiver_id: string; asset: string; amount: string };
type Withdraw = { intent: "ft_withdraw"; token: string; receiver_id: string; amount: string };
type Parsed = { signed: HelperSignedIntent; signer: string; deadline: string; nonce: string; intents: unknown[] };

/** The body down to its signer, or null: {signed_intent} of the four raw_ed25519 fields and a canonical payload. */
export function parseBody(body: unknown): Parsed | null {
  if (!isObj(body) || !keysAre(body, ["signed_intent"]) || !isObj(body.signed_intent)) return null;
  const si = body.signed_intent;
  if (!keysAre(si, ["standard", "payload", "public_key", "signature"]) || si.standard !== "raw_ed25519" || typeof si.payload !== "string") return null;
  if (si.payload.length > INTENTS_BODY_MAX) return null;
  let p: unknown;
  try {
    p = JSON.parse(si.payload);
  } catch {
    return null;
  }
  // canonical: the payload is its own JSON written back, so it holds no repeated key, no escape and no whitespace that
  // intents.near could read otherwise than this file
  if (!isObj(p) || JSON.stringify(p) !== si.payload) return null;
  if (!isAccountId(p.signer_id) || !Array.isArray(p.intents)) return null;
  const signed: HelperSignedIntent = { standard: "raw_ed25519", payload: si.payload, public_key: si.public_key as HelperSignedIntent["public_key"], signature: si.signature as HelperSignedIntent["signature"] };
  return { signed, signer: p.signer_id, deadline: p.deadline as string, nonce: p.nonce as string, intents: p.intents };
}

/** The one intent, or null when the payload is not exactly HelperIntentPayload of one transfer or one ft_withdraw. */
export function intentOf(x: Parsed, vault: string): Transfer | Withdraw | null {
  const p = JSON.parse(x.signed.payload) as Record<string, unknown>;
  if (!keysAre(p, ["signer_id", "verifying_contract", "deadline", "nonce", "intents"]) || p.verifying_contract !== INTENTS_CONTRACT) return null;
  if (typeof x.deadline !== "string" || !DEADLINE.test(x.deadline) || !Number.isFinite(Date.parse(x.deadline))) return null;
  if (typeof x.nonce !== "string" || !NONCE.test(x.nonce) || Buffer.from(x.nonce, "base64").length !== 32) return null;
  if (!b58len(x.signed.public_key, "ed25519:", 32) || !b58len(x.signed.signature, "ed25519:", 64)) return null;
  if (x.intents.length !== 1 || !isObj(x.intents[0])) return null;
  const i = x.intents[0];
  if (i.intent === "transfer") {
    if (!keysAre(i, ["intent", "receiver_id", "tokens"]) || !isAccountId(i.receiver_id) || !isObj(i.tokens)) return null;
    const entries = Object.entries(i.tokens);
    if (entries.length !== 1) return null;
    const [asset, amount] = entries[0]!;
    if (!ASSET.test(asset) || !u128(amount)) return null;
    return { intent: "transfer", receiver_id: i.receiver_id, asset, amount };
  }
  if (i.intent === "ft_withdraw") {
    if (!keysAre(i, ["intent", "token", "receiver_id", "amount"]) || !isAccountId(i.token) || !isAccountId(i.receiver_id) || !u128(i.amount)) return null;
    if (i.receiver_id === vault || i.receiver_id === INTENTS_CONTRACT) return null;
    return { intent: "ft_withdraw", token: i.token, receiver_id: i.receiver_id, amount: i.amount };
  }
  return null;
}

export type IntentsCarry = {
  carry(body: unknown): Promise<IntentsAnswer>;
  /**
   * A status answer showed money to `signer` (records.ts onStatusAnswer saw it): its own registration on USDC, as 9
   * sends it, so the device can sign its first intent. Nothing for a signer not seen, struck, or read registered; the
   * answer's code, "registered" when nothing is left to do. Never throws.
   */
  registerSeen(signer: string): Promise<IntentsCode | "registered">;
  /** Every send's background read done (a test's wait; a stop does not need it: the chain keeps the outcome). */
  idle(): Promise<void>;
};

/** How long a registration started by registerSeen is read (and resent) for: an id intent's own window (the signing
 *  page's ID_INTENT_WINDOW_MS). One still unread after it stays pending under its transaction and is read first next time. */
export const SEEN_REGISTER_MS = 120_000;

/** Which registration of a signer's record: its one paid receiver's (9b) or its own on USDC (9). */
type Slot = "registration" | "own";
const slotOf = (rec: SignerRecord, slot: Slot): Registration | null => (slot === "own" ? (rec.own ?? null) : rec.registration);
const withSlot = (rec: SignerRecord, slot: Slot, g: Registration | null): SignerRecord => (slot === "own" ? { ...rec, own: g } : { ...rec, registration: g });

/** A send's outcome: ran when every receipt ran. */
const ran = (out: TxOutcome) => out.kind === "final" && out.receipts.length > 0 && out.receipts.every((r) => r.ok);

export function createIntentsCarry(deps: IntentsDeps): IntentsCarry {
  const { store, reads, relayer, vault, usdc } = deps;
  const now = deps.now ?? Date.now;
  const every = deps.resolveEveryMs ?? RESOLVE_EVERY_MS;
  /** The intents out: "<signer>/<nonce>". Set and read with no await between. */
  const out = new Set<string>();
  const tasks = new Set<Promise<void>>();
  /** The registrations this process is sending now ("<slot>/<signer>"). A pending claim with no transaction that no send
   *  here holds was never signed (the process stopped before): free again. */
  const registering = new Set<string>();
  /** The signers read or seen registered on USDC here: their own registration is never read again. */
  const ownDone = new Set<string>();
  const strike = (signer: string) => {
    const rec = store.signer(signer);
    store.putSigner({ ...rec, failed: rec.failed + 1 });
  };
  const unsend = (signer: string) => {
    const rec = store.signer(signer);
    store.putSigner({ ...rec, sent: Math.max(0, (rec.sent ?? 0) - 1) });
  };
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms).unref?.());

  /** Reads a send of ours until its outcome is known or `untilMs` passed (it can no longer land). */
  const settle = async (tx: TxRef, first: TxOutcome, untilMs: number): Promise<TxOutcome> => {
    let o = first;
    while (o.kind === "unknown" && now() <= untilMs) {
      await sleep(every);
      o = await relayer.resolve(tx, { resend: now() <= untilMs });
    }
    return o;
  };

  /**
   * A registration on `token` of `account`, once per signer and slot: null to go on, or the answer. The receiver's (9b)
   * or the signer's own on USDC (9, `account` the signer).
   */
  const register = async (signer: string, token: string, account: string, slot: Slot, untilMs: number): Promise<IntentsAnswer | null> => {
    let st: "registered" | "none";
    try {
      st = await reads.storage(token, account);
    } catch {
      return no("upstream");
    }
    if (st === "registered") return null;
    if (token !== usdc) return no("receiver_not_registered");
    const was = slotOf(store.signer(signer), slot);
    // the receiver's: one paid per signer, never a second receiver. The signer's own landed while the reads still say
    // null: the providers' final block is behind its landing; read again later, never a second payment
    if (slot === "own" && was !== null && was.state === "landed") return no("in_flight");
    const used = (g: Registration | null) => g !== null && (g.receiver !== account || g.state === "landed");
    if (used(was)) return no("receiver_not_registered");
    // an earlier registration of this account whose outcome was not read: read it before any new one
    if (was !== null && was.tx !== null) {
      const o = await relayer.resolve(was.tx, { resend: false });
      if (o.kind === "unknown") return no("in_flight");
      const r = store.signer(signer);
      if (ran(o)) {
        store.putSigner(withSlot(r, slot, { ...was, state: "landed" }));
        return null;
      }
      store.putSigner({ ...withSlot(r, slot, null), failed: r.failed + (o.kind === "final" ? 1 : 0) });
    }
    if ((await relayer.balance()) < INTENTS_FLOOR_YOCTO + REGISTRATION_YOCTO) return no("relayer_low");
    // the claim, read again after the awaits and written before the send, so two requests never pay two registrations
    const rec: SignerRecord = store.signer(signer);
    const g = slotOf(rec, slot);
    if (used(g)) return no("receiver_not_registered");
    const key = `${slot}/${signer}`;
    if (registering.has(key) || (g !== null && g.tx !== null)) return no("in_flight");
    registering.add(key);
    try {
      return await registerOnce(signer, token, account, slot, untilMs, rec);
    } finally {
      registering.delete(key);
    }
  };

  const registerOnce = async (signer: string, token: string, account: string, slot: Slot, untilMs: number, rec: SignerRecord): Promise<IntentsAnswer | null> => {
    store.putSigner(withSlot(rec, slot, { receiver: account, state: "pending", tx: null }));
    const sentTx: TxRef[] = [];
    let o: TxOutcome;
    try {
      const a = await relayer.send(
        { kind: "call", receiver: token, method: "storage_deposit", args: JSON.stringify({ account_id: account, registration_only: true }), gas: REGISTER_GAS, deposit: REGISTRATION_YOCTO },
        async () => null,
        (tx) => {
          sentTx.push(tx);
          store.putSigner(withSlot(store.signer(signer), slot, { receiver: account, state: "pending", tx }));
        },
      );
      o = a.kind === "guarded" ? { kind: "dropped", tx_hash: "", why: "guarded" } : a;
    } catch {
      // a throw after the signing (its bytes written, then maybe broadcast) is read as an unknown outcome, never freed
      o = sentTx.length > 0 ? { kind: "unknown", tx_hash: sentTx[0]!.tx_hash, why: "the send threw after the signing" } : { kind: "dropped", tx_hash: "", why: "the send threw" };
    }
    const tx = sentTx[0];
    if (tx !== undefined && o.kind === "unknown") o = await settle(tx, o, untilMs);
    const r = store.signer(signer);
    if (ran(o)) {
      store.putSigner(withSlot(r, slot, { receiver: account, state: "landed", tx: tx ?? null }));
      return null;
    }
    if (o.kind === "unknown") return no("in_flight"); // kept pending under its transaction: no second one meanwhile
    // failed or never landed: the registration is free again, and a failure on chain counts
    store.putSigner({ ...withSlot(r, slot, null), failed: r.failed + (o.kind === "final" ? 1 : 0) });
    return no("registration_failed");
  };

  /** The signer's own registration on USDC (9): null once it reads or lands registered. */
  const registerOwn = async (signer: string, untilMs: number): Promise<IntentsAnswer | null> => {
    if (ownDone.has(signer)) return null;
    const a = await register(signer, usdc, signer, "own", untilMs);
    if (a === null) ownDone.add(signer);
    return a;
  };

  const carryOne = async (body: unknown): Promise<IntentsAnswer> => {
    const x = parseBody(body);
    if (x === null) return no("bad_shape");
    // 1. the gate, before any chain read
    if (!store.seen(x.signer)) return no("id_not_ours");
    // 2. never into the vault
    if (x.intents.some((i) => isObj(i) && i.receiver_id === vault)) return no("receiver_is_vault");
    // 3. the shape
    const i = intentOf(x, vault);
    if (i === null) return no("bad_shape");
    // 4. our quote, with the signer as its refundTo
    if (i.intent === "transfer") {
      const q = store.quote(i.receiver_id);
      if (q === null || q.deposit_type !== "INTENTS" || q.refund_to !== x.signer || q.refund_type !== "INTENTS" || q.deadline_ms <= now()) return no("not_helper_quote");
      // the quote's own recipient: 1Click would deliver into the vault (or back into intents.near) for it
      if (q.recipient === vault || q.recipient === INTENTS_CONTRACT) return no("receiver_is_vault");
    }
    // 5. the intent's deadline ahead of the newer final block time
    const deadlineMs = Date.parse(x.deadline);
    let finalMs: bigint;
    try {
      finalMs = await reads.finalMs();
    } catch {
      return no("upstream");
    }
    if (BigInt(deadlineMs) <= finalMs) return no("expired");
    // 6. the strike
    if (store.signer(x.signer).failed >= STRUCK_AT) return no("sender_struck");
    if ((store.signer(x.signer).sent ?? 0) >= INTENTS_SENDS_MAX) return no("signer_cap");
    // 7. the send lock: test-and-set with no await between
    const key = `${x.signer}/${x.nonce}`;
    if (out.has(key)) return no("in_flight");
    out.add(key);
    let held = true;
    try {
      // 8. the simulation, on both providers
      if (!(await reads.simulate(x.signed))) return no("simulation_refused");
      // the intent can land until its deadline; a send's outcome is read until then (and a little past: the chain's
      // time runs behind the helper's)
      const untilMs = deadlineMs + 60_000;
      // 9. the signer's own registration on USDC, before its first intent: its lasting public trace
      const own = await registerOwn(x.signer, untilMs);
      if (own !== null) return own;
      // 9b. the receiver's registration (ft_withdraw only); the signer itself on USDC is 9's
      if (i.intent === "ft_withdraw" && !(i.receiver_id === x.signer && i.token === usdc)) {
        const r = await register(x.signer, i.token, i.receiver_id, "registration", untilMs);
        if (r !== null) return r;
      }
      // 10. the gas account
      if ((await relayer.balance()) < INTENTS_FLOOR_YOCTO) return no("relayer_low");
      // the deadline again: a registration can take until it
      try {
        if (BigInt(deadlineMs) <= (await reads.finalMs())) return no("expired");
      } catch {
        return no("upstream");
      }
      // 11. the send: the device's signed intent as it signed it, nothing attached. Its slot under the cap is taken
      // here, with no await since the check, and given back only when nothing was signed.
      const rec = store.signer(x.signer);
      if ((rec.sent ?? 0) >= INTENTS_SENDS_MAX) return no("signer_cap");
      store.putSigner({ ...rec, sent: (rec.sent ?? 0) + 1 });
      const refs: TxRef[] = [];
      let o: TxOutcome | { kind: "guarded"; code: string };
      try {
        o = await relayer.send({ kind: "call", receiver: INTENTS_CONTRACT, method: "execute_intents", args: JSON.stringify({ signed: [x.signed] }), gas: EXECUTE_GAS, deposit: 0n }, async () => null, (t) => void refs.push(t), { wait: false });
      } catch (e) {
        if (refs.length === 0) unsend(x.signer);
        throw e;
      }
      const tx = refs[0];
      if (o.kind === "guarded" || tx === undefined) {
        if (tx === undefined) unsend(x.signer);
        return no("upstream");
      }
      // the answer goes now; the outcome is read after it, and a failure on chain counts
      held = false;
      const task = (async () => {
        try {
          const end = await settle(tx, o, untilMs);
          if (end.kind === "final" && !ran(end)) strike(x.signer);
        } catch {
          // an outcome not read is never counted
        } finally {
          out.delete(key);
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return sent(tx.tx_hash);
    } finally {
      if (held) out.delete(key);
    }
  };

  return {
    async carry(body) {
      try {
        return await carryOne(body);
      } catch {
        return no("upstream");
      }
    },
    async registerSeen(signer) {
      try {
        if (ownDone.has(signer)) return "registered";
        if (!store.seen(signer) || store.signer(signer).failed >= STRUCK_AT) return "id_not_ours";
        const a = await registerOwn(signer, now() + SEEN_REGISTER_MS);
        return a === null ? "registered" : "error" in a.body ? a.body.error.code : "upstream";
      } catch {
        return "upstream";
      }
    },
    idle: async () => {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
  };
}
