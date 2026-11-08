// The exit tool's moves out of the one-time ids and arming accounts (vault paper 2.12 step 5 and "Nothing into the
// vault", docs/plan1/vault.md at research db647d3 l.951-962 and l.972-997; V4.2 l.1243): what a deposit's account U, a
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
// - The key: derived from seed64 here for the one signature, checked to be the account's own by the builder, and zeroed
//   on every path. Nothing here sends: the signed bytes go to the caller, who self-submits them.
import {
  armAccount,
  buildMoveOut,
  buildRegisterOut,
  buildWithdrawOut,
  depositId,
  refundId,
  returnId,
  type BuiltMove,
  type MoveOutRead,
  type OwnKey,
  type WithdrawOutRead,
} from "@blindfill/kit/core";
import { nearPairNetwork, nearPairRule, type NearNetwork, type VaultSyncRpc } from "@blindfill/kit";
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

/** The account's own key from seed64. The caller zeroes secretKey (signWith does). */
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

/**
 * What each id holds on `network`'s token and inside intents.near, on the release's two RPCs at one block: the lower of
 * their final heights. Throws ExitRpcRefused before any read for an unknown network, a pair not the release's or an id
 * that is not a 64-hex implicit account; ExitOutStopped when a read fails or the two differ. A halt on either RPC reads
 * as halted for that id.
 */
export async function exitHoldings(a: { network: NearNetwork; ids: readonly string[]; rpcs: readonly [VaultSyncRpc, VaultSyncRpc] }): Promise<{ height: number; holdings: ExitHolding[] }> {
  const { network, rpcs } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  for (const id of a.ids) if (typeof id !== "string" || !HEX64.test(id)) throw new ExitRpcRefused(`${JSON.stringify(id)} is not a 64-hex implicit account`);
  const token = EXIT_TOKENS[network];
  const intents = EXIT_INTENTS[network];
  const finals = await Promise.all(
    rpcs.map(async (r) => {
      const ans = await r.query({ request_type: "view_account", account_id: token, finality: "final" }).catch(() => null);
      const h = isObj(ans) && isObj(ans.result) ? ans.result.block_height : undefined;
      if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0) throw new ExitOutStopped(`${r.name}: no final height`);
      return h;
    }),
  );
  const at = Math.min(...finals);
  const side = (r: VaultSyncRpc) =>
    Promise.all(
      a.ids.map(async (id) => {
        const bal = await r.query({ request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: args64({ account_id: id }), block_id: at }).catch(() => null);
        const mt = intents === null ? null : await r.query({ request_type: "call_function", account_id: intents, method_name: "mt_balance_of", args_base64: args64({ account_id: id, token_id: `nep141:${token}` }), block_id: at }).catch(() => null);
        return { bal, mt };
      }),
    );
  const [x, y] = await Promise.all(rpcs.map(side));
  const holdings = a.ids.map((id, k): ExitHolding => {
    const p = x![k]!, q = y![k]!;
    // the halt first: a FiatToken: paused error on either RPC is a halt, whatever the other says
    let tok: ExitHolding["token"];
    if (isHalt(p.bal) || isHalt(q.bal)) tok = { state: "halted" };
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

/** One move the tool builds: on the token (with the registration when due), the registration alone, or out of intents.near. */
export type ExitMove =
  | { leg: "token"; read: MoveOutRead; storageMin: bigint }
  | { leg: "register"; read: Pick<MoveOutRead, "nonce" | "blockHash" | "registered">; storageMin: bigint }
  | { leg: "intents"; read: WithdrawOutRead };

/**
 * One move of `account`'s money on `network` to the typed account `to`, built and checked by the wallet's builder and
 * signed with the account's own key, which is zeroed before this returns, whichever way. The caller self-submits the
 * signed bytes. The intents leg is refused on a network with no intents.near. `keyOf` is exitKey unless a test says.
 */
export function exitBuildMove(a: { seed64: Uint8Array; account: ExitAccount; network: NearNetwork; to: string; move: ExitMove }, keyOf: typeof exitKey = exitKey): BuiltMove {
  if (!Object.hasOwn(EXIT_NETWORKS, a.network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(a.network)}`);
  const token = EXIT_TOKENS[a.network];
  if (a.move.leg === "intents" && EXIT_INTENTS[a.network] === null) throw new ExitRpcRefused(`${a.network} has no intents.near`);
  const key = keyOf(a.seed64, a.account);
  try {
    const kind = a.account.kind === "A" ? "arm" : "id";
    const m = a.move;
    if (m.leg === "token") return buildMoveOut({ read: m.read, key, kind, to: a.to, token, storageMin: m.storageMin });
    if (m.leg === "register") return buildRegisterOut({ read: m.read, key, to: a.to, token, storageMin: m.storageMin });
    if (m.leg === "intents") return buildWithdrawOut({ read: m.read, key, kind, to: a.to, token });
    throw new ExitRpcRefused(`no move leg ${JSON.stringify((m as { leg?: unknown }).leg)}`);
  } finally {
    key.secretKey.fill(0);
  }
}
