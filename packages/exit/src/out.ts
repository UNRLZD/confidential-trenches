// The exit tool's settle of pending spends (vault paper 2.12 step 4) and its moves out of the one-time ids and arming
// accounts (step 5 and "Nothing into the vault", docs/plan1/vault.md at research db647d3 l.951-962 and l.972-997; V4.2 l.1243): what a deposit's account U, a
// return id R, a refund id V or an arming account A holds, on the token or inside intents.near, goes out to the NEAR
// account the user types, by the account's own transaction, and never into the vault.
//
// - The read (step 5): what each account holds, on two public RPCs at one block, equal on both. Its USDC on the token
//   by ft_balance_of: while USDC is halted that view itself fails with "FiatToken: paused" (vault paper l.993-995), so
//   that error on either RPC reads as "halted", never as a zero. What it holds inside intents.near by mt_balance_of on
//   nep141:<token>; testnet has no intents.near, so there that read is null, never a zero.
// - The moves: the wallet's own builders through the kit's ./core export (packages/wallet/src/deposit/moveout.ts), so
//   the exit tool and the wallet hold one payload rule and one signer: an id's own plain ft_transfer on the token (its
//   registration of the typed account in the same transaction when needed), its own registration alone, and its own
//   ft_withdraw out of intents.near (no memo, no msg). Each is checked before it is signed; the typed account is never
//   the vault, intents.near, the token or the moving account. An id (U, R, V) keeps one base unit, so restore still
//   finds it by its balance (l.988-990); A moves all, so its DeleteAccount can follow (exit-withdraw).
// - The settle (step 4): a spend of ours the restore read refund_pending or paid, not settled, is settled by the tool
//   itself with the vault's own settle(nullifier_hash), the kit's call (vaultSettleCall: 150 Tgas, the refund note's
//   148 B attached for refund_pending, nothing for paid), signed by that spend's own arming account A_{l,j}, which pays
//   its gas (funded, when short, by a Transfer from the typed account, never another account of the seed). It moves no
//   token: the reserve goes to the payer and a refund note is written for the next restore to find. It is the one call
//   the tool signs with the vault as receiver; every move of money goes to the typed account.
// - The key: derived from seed64 here for the one signature, checked to be the account's own by the builder, and zeroed
//   on every path. Nothing here sends: the signed bytes go to the caller, who self-submits them.
import {
  armAccount,
  buildMoveOut,
  buildSettleOut,
  buildRegisterOut,
  buildWithdrawOut,
  depositId,
  readTokenStorageMin,
  refundId,
  returnId,
  type BuiltMove,
  HEIGHT_SPREAD_MAX,
  type MoveOutReadFor,
  type OwnKey,
  type RegisterOutReadFor,
  type RestoredSpend,
  type SettleReadFor,
  type WithdrawOutReadFor,
} from "@blindfill/kit/core";
import { nearPairNetwork, nearPairRule, VAULT_SYNC_BUSY_WAITS_MS, vaultViewBusy, type NearNetwork, type VaultSyncRpc } from "@blindfill/kit";
import { EXIT_NETWORKS, ExitRpcRefused } from "./rpc.ts";
import { EXIT_TOKENS } from "./scan.ts";

/** intents.near, on mainnet only: testnet has none. */
export const EXIT_INTENTS: Readonly<Record<NearNetwork, string | null>> = Object.freeze({ mainnet: "intents.near", testnet: null });
const HALT = "FiatToken: paused";

/** One account the tool moves money out of, by its derivation (packages/wallet/src/derive/keys.ts). */
export type ExitAccount =
  | { kind: "U"; s: bigint; i: number }
  | { kind: "R"; chain: string; l: bigint; j: number }
  | { kind: "V"; l: bigint; j: number }
  | { kind: "A"; l: bigint; j: number };

/** What one account holds, read at one block on both RPCs. */
export type ExitHolding = {
  id: string;
  /** its USDC on the token, or halted when the view fails with FiatToken: paused (never a zero) */
  token: { state: "held"; amount: bigint } | { state: "halted" };
  /** what it holds inside intents.near, or null where there is no intents.near (testnet) */
  intents: bigint | null;
};

/** A read that stopped: the RPCs differ, one failed, or an answer is not what a NEAR RPC gives. Nothing is read from it. */
export class ExitOutStopped extends Error {
  constructor(detail: string) {
    super(`exit out stopped: ${detail}`);
    this.name = "ExitOutStopped";
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;
const args64 = (a: Obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(a))));

/** The account's own key from seed64. The caller zeroes secretKey (exitBuildMove does, on every path). */
export function exitKey(seed64: Uint8Array, a: ExitAccount): OwnKey {
  if (!(seed64 instanceof Uint8Array) || seed64.length !== 64) throw new ExitRpcRefused("seed64 must be 64 bytes");
  switch (a.kind) {
    case "U":
      return depositId(seed64, a.s, a.i);
    case "R":
      return returnId(seed64, a.chain as Parameters<typeof returnId>[1], a.l, a.j);
    case "V":
      return refundId(seed64, a.l, a.j);
    case "A":
      return armAccount(seed64, a.l, a.j);
    default:
      throw new ExitRpcRefused(`no account kind ${JSON.stringify((a as { kind?: unknown }).kind)}`);
  }
}

/** One view's decoded JSON value, or throws: a view answer is { result: { result: bytes, block_height } }. */
function viewValue(answer: unknown, at: number, what: string): unknown {
  const r = isObj(answer) && answer.error === undefined ? answer.result : undefined;
  if (!isObj(r) || r.error !== undefined || r.block_height !== at || !Array.isArray(r.result)) throw new ExitOutStopped(`${what}: no view answer at block ${at}`);
  const bytes = r.result;
  if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new ExitOutStopped(`${what}: not bytes`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes as number[])));
  } catch {
    throw new ExitOutStopped(`${what}: not JSON`);
  }
}
/** Whether a view answer is the token's halt: the error text, in either shape an RPC gives it, holds FiatToken: paused. */
function isHalt(answer: unknown): boolean {
  if (!isObj(answer)) return false;
  const err = answer.error ?? (isObj(answer.result) ? answer.result.error : undefined);
  return err !== undefined && JSON.stringify(err).includes(HALT);
}
const amountOf = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !DIGITS.test(v)) throw new ExitOutStopped(`${what}: not a decimal string`);
  return BigInt(v);
};

/** A query on one RPC, asked again after each of the kit's busy waits while it answers busy (dRPC's free-plan 408), then a stop. */
async function ask(r: VaultSyncRpc, params: Record<string, unknown>, sleep: (ms: number) => Promise<void>): Promise<unknown> {
  for (let i = 0; ; i++) {
    const ans = await r.query(params).catch(() => null);
    if (!vaultViewBusy(ans)) return ans;
    const wait = VAULT_SYNC_BUSY_WAITS_MS[i];
    if (wait === undefined) throw new ExitOutStopped(`${r.name}: busy ${i + 1} times`);
    await sleep(wait);
  }
}
const realSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** The block both RPCs read at: the lower of their final heights, which may spread HEIGHT_SPREAD_MAX blocks at most (the wallet's bound). */
async function finalAt(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], token: string, sleep: (ms: number) => Promise<void>): Promise<number> {
  const finals = await Promise.all(
    rpcs.map(async (r) => {
      const ans = await ask(r, { request_type: "view_account", account_id: token, finality: "final" }, sleep);
      const h = isObj(ans) && isObj(ans.result) ? ans.result.block_height : undefined;
      if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0) throw new ExitOutStopped(`${r.name}: no final height`);
      return h;
    }),
  );
  if (Math.max(...finals) - Math.min(...finals) > HEIGHT_SPREAD_MAX) throw new ExitOutStopped(`the two RPCs' final heights spread ${Math.max(...finals) - Math.min(...finals)} blocks, over ${HEIGHT_SPREAD_MAX}`);
  return Math.min(...finals);
}

/**
 * What each id holds on `network`'s token and inside intents.near, on the release's two RPCs at one block: the lower of
 * their final heights. Throws ExitRpcRefused before any read for an unknown network, a pair not the release's or an id
 * that is not a 64-hex implicit account; ExitOutStopped when a read fails, the two differ, or their heights spread too
 * far. A halt on both RPCs reads as halted for that id; a halt on one only is a split, and stops the read. Each RPC is
 * asked one query at a time, and a busy answer is asked again after the kit's waits. `sleep` is for tests only.
 */
export async function exitHoldings(a: { network: NearNetwork; ids: readonly string[]; rpcs: readonly [VaultSyncRpc, VaultSyncRpc]; at?: number }, sleep: (ms: number) => Promise<void> = realSleep): Promise<{ height: number; holdings: ExitHolding[] }> {
  const { network, rpcs } = a;
  const ids = [...a.ids];
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  for (const id of ids) if (typeof id !== "string" || !HEX64.test(id)) throw new ExitRpcRefused(`${JSON.stringify(id)} is not a 64-hex implicit account`);
  const token = EXIT_TOKENS[network];
  const intents = EXIT_INTENTS[network];
  // `at`, when given, is a block the caller read its other facts at (exit-withdraw: A's close reads every fact at one block)
  if (a.at !== undefined && (!Number.isSafeInteger(a.at) || a.at <= 0)) throw new ExitRpcRefused("at is a block height");
  const at = a.at ?? (await finalAt(rpcs, token, sleep));
  const side = async (r: VaultSyncRpc) => {
    const out: { bal: unknown; mt: unknown }[] = [];
    for (const id of ids) {
      const bal = await ask(r, { request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: args64({ account_id: id }), block_id: at }, sleep);
      const mt = intents === null ? null : await ask(r, { request_type: "call_function", account_id: intents, method_name: "mt_balance_of", args_base64: args64({ account_id: id, token_id: `nep141:${token}` }), block_id: at }, sleep);
      out.push({ bal, mt });
    }
    return out;
  };
  const [x, y] = await Promise.all(rpcs.map(side));
  const holdings = ids.map((id, k): ExitHolding => {
    const p = x![k]!, q = y![k]!;
    let tok: ExitHolding["token"];
    const [hp, hq] = [isHalt(p.bal), isHalt(q.bal)];
    if (hp && hq) tok = { state: "halted" };
    else if (hp || hq) throw new ExitOutStopped(`${rpcs[hp ? 0 : 1].name} reads USDC halted for ${id} and ${rpcs[hp ? 1 : 0].name} does not`);
    else {
      const m = amountOf(viewValue(p.bal, at, `${rpcs[0].name} ft_balance_of(${id})`), "ft_balance_of");
      const n = amountOf(viewValue(q.bal, at, `${rpcs[1].name} ft_balance_of(${id})`), "ft_balance_of");
      if (m !== n) throw new ExitOutStopped(`the two RPCs differ on ${id}'s USDC`);
      tok = { state: "held", amount: m };
    }
    let held: bigint | null = null;
    if (intents !== null) {
      const m = amountOf(viewValue(p.mt, at, `${rpcs[0].name} mt_balance_of(${id})`), "mt_balance_of");
      const n = amountOf(viewValue(q.mt, at, `${rpcs[1].name} mt_balance_of(${id})`), "mt_balance_of");
      if (m !== n) throw new ExitOutStopped(`the two RPCs differ on what ${id} holds inside intents.near`);
      held = m;
    }
    return { id, token: tok, intents: held };
  });
  return { height: at, holdings };
}

// ---------- the typed account ----------
// The signing page's address rule (packages/signpage/src/withdraw/checks.ts addressForm and checkRecipient, l.44-89),
// here because packages/exit may import only its own files and the kit's entries: a NEAR account id, 2-64 characters
// in NEAR's form; never the network's vault, intents.near or its token; and a named account must exist on both RPCs,
// read at one block. A named account that does not exist is refused: money sent there waits for whoever creates that
// name. An implicit account (64 hex, or 0x and 40 hex) needs no read: only its key's holder can use it.
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ANY = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;

/** A typed account exitRecipient checked; exitBuildMove takes only these. */
export type ExitRecipient = { readonly account: string; readonly network: NearNetwork };
const CHECKED = new WeakSet<object>();
/** Whether `to` is a typed account exitRecipient checked for `network` (exit-withdraw takes only these too). */
export function exitRecipientFor(to: unknown, network: NearNetwork): to is ExitRecipient {
  return isObj(to) && CHECKED.has(to) && to.network === network;
}
export type ExitRecipientCheck = { ok: true; recipient: ExitRecipient } | { ok: false; code: "not-account" | "vault" | "intents" | "token" | "no-account" | "unread" };

function seen(answer: unknown, at: number): "exists" | "absent" | "unread" {
  if (!isObj(answer)) return "unread";
  const { result, error } = answer;
  if (result !== undefined && error === undefined) return isObj(result) && result.block_height === at && typeof result.amount === "string" && typeof result.code_hash === "string" ? "exists" : "unread";
  if (error !== undefined && result === undefined && isObj(error) && isObj(error.cause) && error.cause.name === "UNKNOWN_ACCOUNT") return "absent";
  return "unread";
}

/** The typed account checked for `network` on its release pair; a pair that is not the network's throws ExitRpcRefused. `sleep` is for tests only. */
export async function exitRecipient(typed: unknown, network: NearNetwork, rpcs: readonly [VaultSyncRpc, VaultSyncRpc], sleep: (ms: number) => Promise<void> = realSleep): Promise<ExitRecipientCheck> {
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  if (typeof typed !== "string") return { ok: false, code: "not-account" };
  const account = typed.trim();
  if (account.length < 2 || account.length > 64 || !ACCOUNT.test(account)) return { ok: false, code: "not-account" };
  if (account === EXIT_NETWORKS[network].vault) return { ok: false, code: "vault" };
  if (account === "intents.near") return { ok: false, code: "intents" };
  if (account === EXIT_TOKENS[network]) return { ok: false, code: "token" };
  if (!IMPLICIT_ANY.test(account)) {
    // a read that stops (heights spread too far, an RPC busy past the waits) is unread, never a throw: only a refusal throws
    let reads: ("exists" | "absent" | "unread")[];
    try {
      const at = await finalAt(rpcs, EXIT_TOKENS[network], sleep);
      reads = await Promise.all(rpcs.map((r) => ask(r, { request_type: "view_account", account_id: account, block_id: at }, sleep).then((x) => seen(x, at))));
    } catch (e) {
      if (!(e instanceof ExitOutStopped)) throw e;
      return { ok: false, code: "unread" };
    }
    if (reads[0] === "absent" && reads[1] === "absent") return { ok: false, code: "no-account" };
    if (reads[0] !== "exists" || reads[1] !== "exists") return { ok: false, code: "unread" };
  }
  const recipient: ExitRecipient = Object.freeze({ account, network });
  CHECKED.add(recipient);
  return { ok: true, recipient };
}

/** One move the tool builds: on the token (with the registration when due), the registration alone, or out of intents.near. */
export type ExitMove =
  | { leg: "token"; read: MoveOutReadFor; storageMin: bigint }
  | { leg: "register"; read: RegisterOutReadFor; storageMin: bigint }
  | { leg: "intents"; read: WithdrawOutReadFor };

/**
 * One move of `account`'s money on `network` to `to`, a typed account exitRecipient checked for that network, built and
 * checked by the wallet's builder and signed with the account's own key, which is zeroed before this returns, whichever
 * way. The caller self-submits the signed bytes. The intents leg is refused on a network with no intents.near. `keyOf`
 * is exitKey unless a test says.
 */
export function exitBuildMove(a: { seed64: Uint8Array; account: ExitAccount; network: NearNetwork; to: ExitRecipient; move: ExitMove }, keyOf: typeof exitKey = exitKey): BuiltMove {
  // each argument read once, here: a getter answering the checks one value and the builder another has nothing to change
  const { seed64, network, to } = a;
  const account = { ...a.account } as ExitAccount;
  const move = { ...a.move } as ExitMove;
  const leg = move.leg;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (!isObj(to) || !CHECKED.has(to) || to.network !== network) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  const typed = to.account;
  const token = EXIT_TOKENS[network];
  if (leg === "intents" && EXIT_INTENTS[network] === null) throw new ExitRpcRefused(`${network} has no intents.near`);
  const key = keyOf(seed64, account);
  try {
    const kind = account.kind === "A" ? "arm" : "id";
    if (leg === "token") { const m = move as Extract<ExitMove, { leg: "token" }>; return buildMoveOut({ read: m.read, key, kind, to: typed, token, storageMin: m.storageMin }); }
    if (leg === "register") { const m = move as Extract<ExitMove, { leg: "register" }>; return buildRegisterOut({ read: m.read, key, to: typed, token, storageMin: m.storageMin }); }
    if (leg === "intents") { const m = move as Extract<ExitMove, { leg: "intents" }>; return buildWithdrawOut({ read: m.read, key, kind, to: typed, token }); }
    throw new ExitRpcRefused(`no move leg ${JSON.stringify(leg)}`);
  } finally {
    key.secretKey.fill(0);
  }
}

/**
 * The token's storage minimum on `network` (storage_balance_bounds().min), the wallet's own read on both RPCs of the
 * release pair, equal, at final blocks within the wallet's height bound: the deposit an unregistered typed account's
 * registration needs (the "token" and "register" legs). Throws ExitRpcRefused before any read for an unknown network or
 * a pair not the release's, and ExitOutStopped when a read fails or the two differ.
 */
export async function exitStorageMin(network: NearNetwork, rpcs: readonly [VaultSyncRpc, VaultSyncRpc]): Promise<bigint> {
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  try {
    return await readTokenStorageMin(network, rpcs);
  } catch (e) {
    throw new ExitOutStopped(`the token's storage minimum: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- the settle (step 4) ----------
/** The spends of ours the tool settles: refund_pending or paid, not yet settled (in_flight waits for its callback). */
export function exitSettleDue(spends: readonly RestoredSpend[]): RestoredSpend[] {
  return spends.filter((x) => x.spend.status === "refund_pending" || x.spend.status === "paid");
}

/**
 * settle of `spend` on `network`'s vault, signed by the spend's own arming account A_{l,j} at the read's nonce + 1, its
 * key zeroed before this returns, whichever way. `read` is readSettle's of A (both RPCs at one block). A spend that is
 * in_flight or settled is refused: nothing to settle. The caller self-submits the signed bytes, then reads the spends
 * row again on both RPCs: the sender's answer is never the outcome. `keyOf` is exitKey unless a test says.
 */
export function exitBuildSettle(a: { seed64: Uint8Array; network: NearNetwork; spend: RestoredSpend; read: SettleReadFor }, keyOf: typeof exitKey = exitKey): BuiltMove {
  const { seed64, network } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  const spend = a.spend, row = spend.spend;
  const status = row.status, nullifierHash = row.nullifierHash;
  if (status !== "refund_pending" && status !== "paid") throw new ExitRpcRefused(`a ${String(status)} spend has nothing to settle`);
  const key = keyOf(seed64, { kind: "A", l: spend.l, j: spend.j });
  try {
    return buildSettleOut({ read: a.read, key, vault: EXIT_NETWORKS[network].vault, nullifierHash, status });
  } finally {
    key.secretKey.fill(0);
  }
}
