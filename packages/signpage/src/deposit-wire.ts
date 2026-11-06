// deposit.quote on the postMessage API (card signpage-deposit-quote-wire; docs/plan1/wallet.md §2.4 steps 1-3,
// W:416-418; the deposit index rule of §2.3, W:351-361; the deposit quote row of §2.8, W:911). The kind's rule is
// ./rules/deposit-quote.ts; this file gives it what it needs from public data alone and carries its answer back.
//
// - U is named ahead, never here. SIGN_HOST's top-level page, which reads the seed to sign in, copies the note store's
//   one PLANNED deposit note of the vault's scope into the public record meta/"deposit/<scope>" { scope, index, id }
//   (./deposit-name.ts). The API answers from that record and the status record only: it never opens the seed
//   (state-no-seed-read.test.ts), in the shell and in the frame alike.
// - So the deposit index is recorded before any address is shown: no answer carries an address for a U the store has
//   not recorded, and every quote names that same index until money reaches it (W:355-358).
// - The answer is a Deferred (./api.ts): the helper's round trip takes up to DEPOSIT_QUOTE_TIMEOUT_MS. Its codes are the
//   rule's: ok, above_max, busy, down, quote_check_failed, not_allowed (not_available for any other helper status).
//   busy and down are not kept for the id (./api.ts RETRY_CODES), so the same request again runs again. A read here
//   that throws is down too (card pool-read-down): not_allowed comes only from a rule.
// - The records are read again once the quote is back: when the seed's records changed in the wait (a sign out, another
//   account, the index moved, the vault's scope not the record's) the address is dropped and the answer is not_allowed.
// - Refused before anything leaves the device: signed out, no record yet, a record of another scope than the release's
//   vault (none is named on the page's network yet: no quote at all), and the backup gate (backupFirst, the wallet
//   store's one predicate, which the rule holds again).
import { backupFirst, type DepositRecord } from "@blindfill/wallet/store";
import type { SignpageResults } from "../../kit/src/signpage/messages.ts";
import type { Deferred, HostAnswer, HostRefusal, Running } from "./api.ts";
import { depositQuoteKind, type DepositQuoteKindContext } from "./rules/deposit-quote.ts";
import { depositAssetsKind, depositDryKind, type DepositReadAnswer, type DepositReadContext } from "./rules/deposit-dry.ts";
import type { Status } from "./state.ts";

/** The public records the kind reads: the status and the deposit record; null when no seed is stored. */
export interface DepositPublic {
  status: Status | undefined;
  deposit: DepositRecord | undefined;
}

export interface DepositWireDeps {
  /** The scope of the release's vault on the page's network, or null while none is named. */
  scope(): bigint | null;
  /** Reads the public records of `scope` (src/state.ts depositRead); never the seed. */
  read(scope: bigint): Promise<DepositPublic | null>;
  /** Settles once the top-level page's naming of U in flight is done (src/main.ts); the frame names nothing. */
  named?(): Promise<unknown>;
  priced?: DepositQuoteKindContext["priced"];
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * The quote checked under request `id`, before its answer goes out (src/deposit-follow.ts quoted): U named by the
   * deposit record the rule checked it under, never a fresh read. A throw answers "down", so no address goes out
   * that nothing follows.
   */
  checked(id: string, result: SignpageResults["deposit.quote"], u: { scope: bigint; index: number; u: string }): Promise<void>;
}

type Usable = { status: Status; deposit: DepositRecord };

/** The records when a quote may be asked under them: signed in, past the backup gate, U named for the vault's scope. */
function usable(p: DepositPublic | null, scope: bigint | null): Usable | null {
  if (!p || !p.status || !p.deposit || scope === null) return null;
  if (backupFirst(p.status)) return null;
  if (p.deposit.scope !== scope.toString()) return null;
  return { status: p.status, deposit: p.deposit };
}

const same = (a: DepositRecord, b: DepositRecord): boolean => a.scope === b.scope && a.index === b.index && a.id === b.id;

/** The deposit.quote handler for ApiHost.kinds: a Deferred answered once the rule, and the read after it, are done. */
export function depositQuoteHost(deps: DepositWireDeps): (params: Record<string, unknown>, ctx?: { id: string }) => Deferred<"deposit.quote"> {
  return (params, ctx) => {
    let out: HostAnswer<"deposit.quote"> | HostRefusal = { error: "not_allowed" };
    const after = (async () => {
      await deps.named?.().catch(() => {});
      const scope = deps.scope();
      if (scope === null) return;
      const before = usable(await deps.read(scope), scope);
      if (!before) return;
      const got = await depositQuoteKind(params, {
        seed: before.status,
        depositId: before.deposit.id,
        priced: deps.priced,
        fetch: deps.fetch,
        now: deps.now,
      });
      if (!got.ok) return void (out = { error: got.code });
      // the address stands only while the records are the ones it was asked under
      const now = usable(await deps.read(scope), deps.scope());
      if (!now || !same(now.deposit, before.deposit)) return;
      // no request id, no follow: no address goes out
      if (ctx === undefined) return;
      await deps.checked(ctx.id, got.result, { scope, index: before.deposit.index, u: before.deposit.id });
      out = { result: got.result };
    })().catch(() => {
      // a read that threw (the records not answering) is no rule's refusal: "not now" (card pool-read-down), which
      // RETRY_CODES does not keep, so the same request again runs again
      out = { error: "down" };
    });
    return { after, answer: () => out };
  };
}

/**
 * The longest a deposit sheet read runs (card kit-deposit-assets-dry): 14 s, inside the kit client's 15 s for both kinds
 * (packages/kit/src/signpage/client.ts SIGNPAGE_TIMEOUT_MS), so its answer reaches the app before the app gives up on
 * it. One signal over the whole read: every request it makes is cut at that time, and the read answers "down" then.
 */
export const DEPOSIT_READ_DEADLINE_MS = 14_000;

/**
 * A read's answer as a Running kind (./api.ts): it holds no other message of the queue, as a trade does not, so `state`,
 * nav and an open kind are answered while the helper's round trips run. Its result or its code; a read that threw, or
 * that the deadline cut, is "down" (not kept, so the same request again runs again).
 */
function running<K extends "deposit.assets" | "deposit.dry">(
  run: (ctx: DepositReadContext) => Promise<DepositReadAnswer<SignpageResults[K]>>,
  deps: DepositReadContext,
  deadlineMs: number,
): Running<K> {
  let out: HostAnswer<K> | HostRefusal = { error: "down" };
  const deadline = AbortSignal.timeout(deadlineMs);
  const base = deps.fetch ?? fetch;
  // every request of the read carries the deadline beside its own signal
  const cut = ((url: string | URL | Request, init?: RequestInit) =>
    base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline })) as typeof fetch;
  const late = new Promise<null>((ok) => (deadline.aborted ? ok(null) : deadline.addEventListener("abort", () => ok(null), { once: true })));
  const after = Promise.race([run({ ...deps, fetch: cut }), late]).then(
    (got) => void (out = got === null ? { error: "down" } : got.ok ? { result: got.result } : { error: got.code }),
    () => void (out = { error: "down" }),
  );
  return { after, answer: () => out, running: true };
}

/**
 * The deposit sheet's reads for ApiHost.kinds (card kit-deposit-assets-dry; ./rules/deposit-dry.ts): deposit.assets and
 * deposit.dry. Neither reads the store or the seed, so the frame and the top-level page answer them alike, signed in or
 * not: the requests name the public placeholder, never U. Each runs at most `deadlineMs` (DEPOSIT_READ_DEADLINE_MS).
 */
export function depositReadHosts(deps: DepositReadContext & { deadlineMs?: number } = {}): {
  "deposit.assets": () => Running<"deposit.assets">;
  "deposit.dry": (params: Record<string, unknown>) => Running<"deposit.dry">;
} {
  const ms = deps.deadlineMs ?? DEPOSIT_READ_DEADLINE_MS;
  return {
    "deposit.assets": () => running<"deposit.assets">((ctx) => depositAssetsKind(ctx), deps, ms),
    "deposit.dry": (params) => running<"deposit.dry">((ctx) => depositDryKind(params, ctx), deps, ms),
  };
}
