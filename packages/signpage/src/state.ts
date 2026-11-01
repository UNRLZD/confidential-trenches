// The framed page's state, read from the wallet store on SIGN_HOST's origin (card signpage-frame-state; wallet.md §2.2
// "Storage and unlock" :151-160, §2.3 the note store table :197-204, §7 item 4; the shapes are
// packages/kit/src/signpage/messages.ts, api 1). src/main.ts hands it to the postMessage API (src/api.ts) in the frame.
//
// - Read through the store's own API only: get("meta", "seed") and keys/get on "ops". APP_HOST and SIGN_HOST are one
//   site, so the frame opens the same database as SIGN_HOST's top-level tabs.
// - signed_in: a whole seed record is stored (checkSeed). code_saved: that record's code_saved. way: how the account came
//   in, from the record's source: "prf" and "random" (Create passkey, with and without PRF) are "passkey", "code" (typed
//   12 words) is "words", "wallet" is "wallet". The seed's entropy is zeroed as soon as those two fields are read.
// - ops: every record of the store's "ops", keyed by its op id, as { id, kind, stage, txs, code? }. Only those fields
//   are copied (a tx as { chain, hash }), and only when the op passes the kit's own state schema, the one the client
//   checks every answer against: a record of another shape is left out, never sent, so one bad record cannot make the
//   client refuse the whole state. Oldest first by the record's created_ms; past the kit's SIGNPAGE_MAX_ARRAY, the
//   newest that many, since a longer list fails the client's schema and would leave the frame down.
// - Nothing secret enters state: no words, key, seed, entropy, note value or passkey data. Every field is built here
//   from a checked value; nothing is spread from a record.
// - A store the frame cannot open or read (IndexedDB blocked or missing, a broken seed record) answers signed out, with
//   no error text, and the next read tries again.
// - Watch: the store's onEvent (BroadcastChannel "ct-wallet", the store's two-tab signal) reports another tab's change
//   or sign out; each one calls the watchers, and the API posts a state event when the state read then differs. After
//   another tab's sign out the store is closed; the next read opens a new one, and the old one, which still hears the
//   channel, is closed only once the new one is open, so no change goes unheard in between.
import type { Operation, SigninWay, SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ARRAY, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { WalletEvent, WalletStore } from "@blindfill/wallet/store";
import { checkSeed, type SeedSource } from "@blindfill/wallet/signin/words";
import { API, RELEASE, signedOutState } from "./api.ts";

const WAY: Record<SeedSource, SigninWay> = { prf: "passkey", random: "passkey", code: "words", wallet: "wallet" };

/** The state for a stored seed's public facts (none: signed out) and the ops read. */
export function stateOf(seed: { source: SeedSource; code_saved: boolean } | undefined, ops: Operation[]): SignpageState {
  if (!seed) return signedOutState();
  const empty = { vault_balance: "0", wallets: [], positions: [], orders: [], held: [] };
  return { release: RELEASE, api: API, signed_in: true, way: WAY[seed.source], code_saved: seed.code_saved === true, ...empty, ops };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The op the API may send for the ops record under `id`, or null when the record is not one. */
export function opOf(id: string, rec: unknown): Operation | null {
  if (!isRecord(rec)) return null;
  const txs = Array.isArray(rec.txs) ? rec.txs.map((t: unknown) => (isRecord(t) ? { chain: t.chain, hash: t.hash } : t)) : rec.txs;
  const op: Record<string, unknown> = { id, kind: rec.kind, stage: rec.stage, txs };
  if ((rec.kind === "buy" || rec.kind === "sell") && rec.code !== undefined) op.code = rec.code;
  const probe = stateOf({ source: "code", code_saved: true }, [op as Operation]);
  return SIGNPAGE_RESULT_SCHEMAS.state(probe) ? (op as Operation) : null;
}

const createdMs = (rec: unknown): number =>
  isRecord(rec) && typeof rec.created_ms === "number" && Number.isFinite(rec.created_ms) ? rec.created_ms : -Infinity;

async function readOps(s: WalletStore): Promise<Operation[]> {
  const keys = await s.keys("ops");
  const rows = await Promise.all(
    keys.map(async (k) => {
      // one record that fails to open leaves the others shown
      const rec = await s.get("ops", k).catch(() => undefined);
      const op = opOf(k, rec);
      return op ? { op, t: createdMs(rec) } : null;
    }),
  );
  const ops = rows.filter((r) => r !== null).sort((a, b) => a.t - b.t || (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : 0));
  return ops.slice(-SIGNPAGE_MAX_ARRAY).map((r) => r.op);
}

/** Opens the wallet store with this event listener (main.ts: openWalletStore({ onEvent })). */
export type StoreOpener = (onEvent: (e: WalletEvent) => void) => Promise<WalletStore>;

export interface FrameState {
  /** The state read now from the store; signed out when it cannot be read. Never throws. */
  state(): Promise<SignpageState>;
  /** Calls `fn` on every change another tab makes to the store, a sign out included. */
  watch(fn: () => void): void;
  close(): void;
}

export function frameState(open: StoreOpener): FrameState {
  type Held = { store: WalletStore; dead: boolean };
  let held: Held | null = null;
  let opening: Promise<Held> | null = null;
  let closed = false;
  const watchers = new Set<() => void>();
  const changed = (): void => {
    for (const f of watchers) f();
  };

  const fresh = async (): Promise<Held> => {
    const h = { dead: false } as Held;
    h.store = await open((e) => {
      if (e.kind === "signout") h.dead = true;
      changed();
    });
    const old = held;
    held = h;
    old?.store.close();
    if (closed) h.store.close();
    return h;
  };
  const live = (): Promise<Held> => {
    if (held && !held.dead) return Promise.resolve(held);
    return (opening ??= fresh().finally(() => (opening = null)));
  };

  return {
    async state() {
      let h: Held | null = null;
      try {
        h = await live();
        const raw = await h.store.get("meta", "seed");
        try {
          const seed = checkSeed(raw);
          return stateOf(seed && { source: seed.source, code_saved: seed.code_saved }, seed ? await readOps(h.store) : []);
        } finally {
          const e = (raw as { entropy?: unknown } | undefined)?.entropy;
          if (e instanceof Uint8Array) e.fill(0);
        }
      } catch {
        // the next read opens the store again
        if (h) h.dead = true;
        return stateOf(undefined, []);
      }
    },
    watch(fn) {
      watchers.add(fn);
    },
    close() {
      closed = true;
      held?.store.close();
    },
  };
}
