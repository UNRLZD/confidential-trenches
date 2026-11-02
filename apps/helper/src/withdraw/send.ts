// POST /v1/withdraw's checks 7-10 and the send, then the outcome and the settle (markets paper H3.1, M:991-1004; H3.4
// checks 7-10, M:1363-1392, with check 5's index and check 6's send record, withdraw/index.ts; the route row, M:3366).
// In order, for one request:
//
//   1-4. checks.ts (shape, context, fee, proof), with the fee quoter's fee_min (fee.ts).
//   5-6. index.ts checkNullifier: spent / index_behind / in_flight / withdraw_failed (advice; the claim decides).
//   7.   register_deposit is 0 when storage_balance_of(recipient) is set, and the token's storage_balance_bounds().min
//        when it is null, both read at one agreed final block on two NEAR RPCs (fee.ts agreedBlock and viewAt); else
//        register_deposit_wrong. A send of a stored withdrawal (H3.7's send after done, a carry of the stored request,
//        the restart's send) also takes the minimum for a recipient registered after the request was taken.
//   8.   recipient and fee_recipient are neither the vault nor intents.near, else bad_recipient.
//   9.   deadline_ms is at least the newest final block's time + 30 s (120 s for a request that funds A, H3.7 item 1),
//        the time read as header.timestamp_nanosec (a decimal string) / 10^6 on both providers, never header.timestamp
//        (a JSON number past 2^53) and never the helper's clock; else deadline_too_close.
//   10.  the token watch (token-status/status.ts tokenHeld): anything but a caught-up open token is 503 token_halted,
//        checked again inside the relayer's queue right before the transaction is signed.
//   The send: one FunctionCall withdraw(withdrawal, proof, public_signals) on the vault, 300 Tgas, the storage the
//   vault asks attached (the kit's vaultWithdrawYocto, a tree that may grow always counted: settle returns the rest),
//   signed by one of the relayer's keys (several keys are nonce lanes, M:1044-1054), the send record claimed in one
//   durable create-if-absent write before the broadcast (index.ts claim); a claim that loses drops the signed bytes.
//   The answer is 200 {tx_hash, state: "submitted"} once the bytes are sent.
//
// The outcome rounds (every OUTCOME_ROUND_MS, and once at start before a request is taken): every open send's stored
// bytes go out again to both providers and its outcome is read from blocks only (bind/send.ts resolve, fromBlocks: D
// by the key's nonce, E by the vault's account_changes naming r_w): succeeded; failed by the deadline when E's time is
// above deadline_ms (the row is deleted and the note freed); failed otherwise (kept with its error and release
// number, check 6); never applied (deleted). Then every send that succeeded is settled: the vault's spends row for its
// nullifier, read at one final block on both providers, reads paid or refund_pending (its callback has run) and the
// relayer sends settle(nullifier_hash), with 148 B x 1e19 attached for a refund note whose tree may grow (the vault
// returns what it does not use); settled already (anyone may settle) ends it.
//
// Not here: H3.7's funding of A and its relayed call (fund_recipient_wrong, recipient_refused), H3.5's relayer_low,
// check 5's unknown_root.
import { join } from "node:path";
import { vaultWithdrawYocto, type HelperWithdrawCode } from "@blindfill/kit";
import { createFileStore, nearRpc, relayerKey, RPC_TIMEOUT_MS, startRelayer, type Relayer, type Rpc, type TxOutcome, type TxRef } from "../bind/send.ts";
import { createTokenWatch, readUrls, tokenHeld, USDC, type TokenStatus } from "../token-status/status.ts";
import { checkWithdraw, decimal, isAccountId, type CheckedWithdraw, type WithdrawConfig, type WithdrawReads } from "./checks.ts";
import { agreedBlock, FeeReadRefused, HEIGHT_SPREAD_MAX, RELAYER_ENV, STORE_ENV, TESTNET_RPCS, TESTNET_TOKEN, viewAt, type FeeNetwork, type FeeQuoter } from "./fee.ts";
import { checkNullifier, createSpendsIndex, createWithdrawSendStore, nullifierKey, type SpendsIndex, type WithdrawSendStore } from "./index.ts";
import { pagesAt } from "../near/pages.ts";

// ---- Values ----

/** Check 9's margin for the withdrawal's own send (M:1376) [design]. */
export const SEND_MARGIN_MS = 30_000n;
/** Check 9's margin for a request that funds A first (M:1377-1386) [design]. */
export const FUND_MARGIN_MS = 120_000n;
/** The vault refuses intents.near as a recipient (row 2, V@93b827c:354). */
export const INTENTS = "intents.near";
/** The withdraw call's gas: the kit's figure (VAULT_WITHDRAW.gas_tgas, V@93b827c:392). */
export const WITHDRAW_GAS = 300_000_000_000_000n;
/** settle's gas: above G_settle's 104.475 Tgas (fee.ts FEE_G_SETTLE, a refund note at depth 32); unused gas is refunded. */
export const SETTLE_GAS = 150_000_000_000_000n;
/** settle's attachment for a refund note: a tree that grows a level, 148 B x 1e19 (M:999); the vault returns what it does not use. */
export const SETTLE_REFUND_ATTACH = 148n * 10n ** 19n;
/** The outcome rounds' period: the stored bytes go out again this often until the outcome is final (M:1337). */
export const OUTCOME_ROUND_MS = 10_000;

const U128 = 1n << 128n;
const TOKENS: Record<FeeNetwork, string> = { mainnet: USDC, testnet: TESTNET_TOKEN };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export type WithdrawAnswer = { status: number; body: { tx_hash: string; state: "submitted" } | { error: { code: HelperWithdrawCode | "upstream" } } };

export type WithdrawSendDeps = {
  cfg: WithdrawConfig;
  /** The network's two providers of two operators. */
  rpcs: readonly [Rpc, Rpc];
  /** Check 3's fee_min (fee.ts FeeQuoter.reads). */
  reads: WithdrawReads;
  index: SpendsIndex;
  store: WithdrawSendStore;
  /** One per relayer key (nonce lanes); each send takes the next in turn. */
  relayers: readonly Relayer[];
  /** The token watch (status.ts); anything but a caught-up open token holds. */
  tokenStatus(): Promise<TokenStatus>;
  /** The helper's clock, only for the age bound on two frozen finals (fee.ts agreedBlock), never for the deadline. */
  now?: () => number;
};

const no = (code: HelperWithdrawCode | "upstream", status = 400): WithdrawAnswer => ({ status, body: { error: { code } } });
const held = async (deps: WithdrawSendDeps) => {
  try {
    return tokenHeld(await deps.tokenStatus());
  } catch {
    return true;
  }
};

// ---- Checks 7-9 ----

/**
 * The newest final block's time in ms on the two providers: each one's final header.timestamp_nanosec (a decimal
 * string) / 10^6, the finals at most HEIGHT_SPREAD_MAX apart, the higher of the two times. Throws on anything else.
 */
export async function newestFinalMs(rpcs: readonly [Rpc, Rpc]): Promise<bigint> {
  const finals = await Promise.all(
    rpcs.map(async (r, i) => {
      const b = await r("block", { finality: "final" });
      const h = isObj(b) && isObj(b.header) ? b.header : {};
      const ns = decimal(h.timestamp_nanosec, 1n << 64n);
      if (typeof h.height !== "number" || !Number.isSafeInteger(h.height) || h.height <= 0 || ns === null) throw new FeeReadRefused(`rpc ${i}: not a final header with timestamp_nanosec`);
      return { height: BigInt(h.height), ms: ns / 1_000_000n };
    }),
  );
  const [a, b] = finals as [{ height: bigint; ms: bigint }, { height: bigint; ms: bigint }];
  const spread = a.height > b.height ? a.height - b.height : b.height - a.height;
  if (spread > HEIGHT_SPREAD_MAX) throw new FeeReadRefused(`final: the providers' finals stand ${spread} blocks apart, over ${HEIGHT_SPREAD_MAX}`);
  return a.ms > b.ms ? a.ms : b.ms;
}

export type ChainReads = { registered: boolean; registerMin: bigint; finalMs: bigint };

/** Checks 7's two views at one agreed final block, and check 9's time, all on both providers. */
export async function readChecks(rpcs: readonly [Rpc, Rpc], token: string, recipient: string, now: () => number = Date.now): Promise<ChainReads> {
  const [block, finalMs] = await Promise.all([agreedBlock(rpcs, now), newestFinalMs(rpcs)]);
  const [bal, bounds] = await Promise.all([viewAt(rpcs, block, token, "storage_balance_of", { account_id: recipient }), viewAt(rpcs, block, token, "storage_balance_bounds", {})]);
  if (bal !== null && !(isObj(bal) && decimal(bal.total, U128) !== null)) throw new FeeReadRefused("storage_balance_of: neither null nor a balance");
  const registerMin = isObj(bounds) ? decimal(bounds.min, U128) : null;
  if (registerMin === null) throw new FeeReadRefused("storage_balance_bounds: no u128 min");
  return { registered: bal !== null, registerMin, finalMs };
}

/**
 * Checks 7, 8 and 9 on what was read, in that order; null when all pass. `stored`: a send of a stored withdrawal,
 * which also takes the minimum for a recipient registered since. `funds`: this request funds A first (120 s margin).
 */
export function checks7to9(w: CheckedWithdraw, vault: string, r: ChainReads, opts: { stored?: boolean; funds?: boolean } = {}): HelperWithdrawCode | null {
  const rd = w.register_deposit;
  const ok7 = r.registered ? rd === 0n || (opts.stored === true && rd === r.registerMin) : rd === r.registerMin;
  if (!ok7) return "register_deposit_wrong";
  for (const a of [w.recipient, w.fee_recipient]) if (a === vault || a === INTENTS) return "bad_recipient";
  const margin = opts.funds === true ? FUND_MARGIN_MS : SEND_MARGIN_MS;
  if (BigInt(w.deadline_ms) < r.finalMs + margin) return "deadline_too_close";
  return null;
}

// ---- The carry ----

/** A claim that lost: its signed bytes are dropped, never sent, and the request answers the row's code. */
class ClaimLost extends Error {
  readonly code: "spent" | "in_flight" | "withdraw_failed";
  constructor(code: "spent" | "in_flight" | "withdraw_failed") {
    super(`claim: ${code}`);
    this.code = code;
  }
}

/** The withdraw call's JSON arguments: the request's withdrawal, proof and signals as received (check 1 kept them). */
export function withdrawArgs(w: CheckedWithdraw): string {
  return JSON.stringify({ withdrawal: w.withdrawal, proof: w.proof, public_signals: w.public_signals });
}

let turn = 0;

/** POST /v1/withdraw: checks 1-10, then one send. Reads that fail or disagree answer 503 upstream and send nothing. */
export async function carryWithdraw(request: unknown, deps: WithdrawSendDeps): Promise<WithdrawAnswer> {
  if (deps.relayers.length === 0) throw new Error("no relayer key");
  let w: CheckedWithdraw;
  try {
    const v = await checkWithdraw(request, deps.cfg, deps.reads);
    if (!v.ok) return no(v.code);
    w = v.withdraw;
  } catch (e) {
    if (e instanceof FeeReadRefused) return no("upstream", 503);
    throw e;
  }
  const nf = w.existingNullifierHash;
  const n = await checkNullifier(nf, { index: deps.index, store: deps.store });
  if (!n.ok) return no(n.code, n.code === "index_behind" ? 503 : 400);

  let reads: ChainReads;
  try {
    reads = await readChecks(deps.rpcs, deps.cfg.token, w.recipient, deps.now);
  } catch {
    return no("upstream", 503);
  }
  const c = checks7to9(w, deps.cfg.vault, reads);
  if (c !== null) return no(c);
  if (await held(deps)) return no("token_halted", 503);

  const relayer = deps.relayers[turn++ % deps.relayers.length]!;
  const action = { kind: "call" as const, receiver: deps.cfg.vault, method: "withdraw", args: withdrawArgs(w), gas: WITHDRAW_GAS, deposit: vaultWithdrawYocto(w.register_deposit, w.relay_fee, true) };
  try {
    const out = await relayer.send<HelperWithdrawCode>(
      action,
      async () => ((await held(deps)) ? "token_halted" : null),
      (tx) => {
        const claim = deps.store.claim({ ...tx, nullifier: nullifierKey(nf), key: relayer.key, deadline_ms: w.deadline_ms });
        if (!claim.ok) throw new ClaimLost(claim.code);
      },
      { wait: false },
    );
    if (out.kind === "guarded") return no(out.code, out.code === "token_halted" ? 503 : 400);
    return { status: 200, body: { tx_hash: out.tx_hash, state: "submitted" } };
  } catch (e) {
    if (e instanceof ClaimLost) return no(e.code);
    return no("upstream", 503); // the key read or the store failed: nothing was sent
  }
}

// ---- The outcome rounds ----

/** What a send's outcome read means for its row, or null while it is not known. */
export function outcomeOf(out: TxOutcome, deadline_ms: number): Parameters<WithdrawSendStore["settle"]>[2] | null {
  if (out.kind === "dropped") return { kind: "never_applied" };
  if (out.kind !== "final") return null;
  const r = out.receipts[0];
  if (out.receipts.length !== 1 || r === undefined) return null;
  if (r.ok) return { kind: "succeeded" };
  // the vault's block_timestamp_ms() while r_w ran is E's time: a failure past deadline_ms is the deadline's
  if (r.ms === undefined) return null;
  return r.ms > BigInt(deadline_ms) ? { kind: "deadline" } : { kind: "failed", error: r.failure };
}

/** The spend's status in the vault's spends list at one final block on both providers, or null when not read. */
async function spendStatus(deps: WithdrawSendDeps, nf: bigint): Promise<string | null> {
  let i = deps.index.indexOf(nf);
  if (i === null && (await deps.index.reach(await deps.index.finalHeight()))) i = deps.index.indexOf(nf);
  if (i === null) return null;
  const block = await agreedBlock(deps.rpcs, deps.now ?? Date.now);
  const [row] = await pagesAt(deps.rpcs, deps.cfg.vault, "spends", block.height, i, 1);
  if (row === undefined || decimal(row.nullifier_hash, 1n << 256n) !== nf) throw new Error("spends: the row is not this nullifier's");
  return typeof row.status === "string" ? row.status : null;
}

/** One round: every open send resent and read, then every succeeded send settled. Errors keep a row for the next round. */
export async function outcomeRound(deps: WithdrawSendDeps): Promise<void> {
  const byKey = new Map(deps.relayers.map((r) => [r.key, r]));
  for (const nf of deps.store.open()) {
    try {
      const rec = deps.store.get(nf);
      if (rec === null || rec === "unreadable" || rec.outcome !== "open") continue;
      const relayer = byKey.get(rec.key);
      if (relayer === undefined) continue; // a key no longer served: its row stays open (H3.6 route 2)
      const o = outcomeOf(await relayer.resolve(rec, { resend: true, fromBlocks: true }), rec.deadline_ms);
      if (o !== null) deps.store.settle(nf, rec.tx_hash, o);
    } catch {
      // kept: the next round reads again
    }
  }
  for (const nf of deps.store.toSettle()) {
    try {
      await settleOne(deps, nf, byKey);
    } catch {
      // kept
    }
  }
}

async function settleOne(deps: WithdrawSendDeps, nf: bigint, byKey: Map<string, Relayer>): Promise<void> {
  const rec = deps.store.get(nf);
  if (rec === null || rec === "unreadable" || rec.outcome !== "succeeded" || rec.settle?.done === true) return;
  const mine = rec.settle?.tx ?? null;
  if (mine !== null) {
    const relayer = byKey.get(mine.key);
    if (relayer === undefined) return;
    const out = await relayer.resolve(mine, { resend: true, fromBlocks: true });
    if (out.kind === "unknown") return;
    if (out.kind === "final" && out.receipts.length === 1 && out.receipts[0]!.ok) return deps.store.setSettle(nf, { tx: mine, done: true });
    // failed or never landed: settled by another caller, else signed again next round
    const s = await spendStatus(deps, nf);
    return deps.store.setSettle(nf, s === "settled" ? { tx: mine, done: true } : null);
  }
  const status = await spendStatus(deps, nf);
  if (status === "settled") return deps.store.setSettle(nf, { tx: null, done: true }); // another caller settled it (anyone may)
  if (status !== "paid" && status !== "refund_pending") return; // in_flight: its callback has not run yet
  const relayer = deps.relayers[turn++ % deps.relayers.length]!;
  await relayer.send<never>(
    { kind: "call", receiver: deps.cfg.vault, method: "settle", args: JSON.stringify({ nullifier_hash: nf.toString() }), gas: SETTLE_GAS, deposit: status === "refund_pending" ? SETTLE_REFUND_ATTACH : 0n },
    async () => null,
    (tx: TxRef) => deps.store.setSettle(nf, { tx: { ...tx, key: relayer.key }, done: false }),
    { wait: false },
  );
}

/** The rounds: one now (the restart's rebroadcast, before a request is taken), then every `everyMs`. Returns stop. */
export async function startOutcomeRounds(deps: WithdrawSendDeps, everyMs = OUTCOME_ROUND_MS): Promise<() => void> {
  await outcomeRound(deps);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const loop = () => {
    timer = setTimeout(async () => {
      await outcomeRound(deps).catch(() => undefined);
      if (!stopped) loop();
    }, everyMs);
  };
  loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// ---- The host's configuration ----

/** The release number (index.ts: a whole number that only goes up, one per release), from the image or the host. */
export const RELEASE_ENV = "HELPER_RELEASE";
/** Per network: the release's vault account and the relayer account's full-access keys (comma-separated "ed25519:..."), the nonce lanes. */
export const SEND_ENV = {
  mainnet: ["WITHDRAW_VAULT_MAINNET", "WITHDRAW_RELAYER_KEYS_MAINNET"],
  testnet: ["WITHDRAW_VAULT_TESTNET", "WITHDRAW_RELAYER_KEYS_TESTNET"],
} as const;
/** A network's relayer keys: at most this many lanes (four full-access keys on the server, M:1044-1047). */
export const KEYS_MAX = 8;

export type WithdrawSender = {
  /** POST /v1/withdraw for a parsed body: the network from its token; a token this relayer does not carry is bad_shape. */
  carry(body: unknown): Promise<WithdrawAnswer>;
  /**
   * At the helper's start: every carried network started now, so a restart resends its open sends and settles within
   * one round whether or not a request comes; a start that fails is tried again every OUTCOME_ROUND_MS.
   */
  warm(): void;
  stop(): void;
};

/**
 * The route's sender from the host's environment. A network is carried only when its fee quoter is set (fee.ts), and
 * its vault, its relayer keys, the release number and the store folder are all set; else its requests answer
 * bad_shape (check 1: not the vault's token). Every name is read, set or not, so the deploy gate sees them all. On
 * the first request (and again after a failure) it reads the vault's config() on both providers (its scope, and its
 * asset equal to the token), opens the network's stores under HELPER_STORE_DIR, starts its relayers and runs the
 * first outcome round (the restart's rebroadcast) before it takes the request; then a round every OUTCOME_ROUND_MS.
 */
export function withdrawSenderFromEnv(
  env: Record<string, string | undefined>,
  fee: FeeQuoter,
  status: Partial<Record<FeeNetwork, () => Promise<TokenStatus>>> = { mainnet: createTokenWatch(env).status },
): WithdrawSender {
  const release = env[RELEASE_ENV] ?? "";
  const storeDir = env[STORE_ENV] ?? "";
  const set = Object.fromEntries((Object.keys(SEND_ENV) as FeeNetwork[]).map((n) => [n, SEND_ENV[n].map((k) => env[k] ?? "")])) as Record<FeeNetwork, string[]>;
  const relayerOf = Object.fromEntries((Object.keys(RELAYER_ENV) as FeeNetwork[]).map((n) => [n, env[RELAYER_ENV[n][0]] ?? ""])) as Record<FeeNetwork, string>;
  const feeTo = Object.fromEntries((Object.keys(RELAYER_ENV) as FeeNetwork[]).map((n) => [n, env[RELAYER_ENV[n][1]] ?? ""])) as Record<FeeNetwork, string>;
  const mainnet = readUrls(env);
  const testnet = TESTNET_RPCS.map(({ env: k, fallback }) => env[k] || fallback);
  const urls: Record<FeeNetwork, readonly string[]> = { mainnet, testnet };

  type Net = { network: FeeNetwork; vault: string; keys: string[] };
  const nets = new Map<string, Net>();
  for (const n of Object.keys(SEND_ENV) as FeeNetwork[]) {
    const [vault, keyList] = set[n];
    if (vault === "" && keyList === "") continue;
    const keys = keyList!.split(",").filter((k) => k !== "");
    if (!isAccountId(vault) || keys.length === 0 || keys.length > KEYS_MAX || !keys.every((k) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(k))) throw new Error(`${SEND_ENV[n].join(" and ")} must be a NEAR account id and 1 to ${KEYS_MAX} ed25519 keys`);
    if (!/^[1-9][0-9]{0,8}$/.test(release)) throw new Error(`${RELEASE_ENV} must be a whole number, 1 or more, to carry withdrawals`);
    if (storeDir === "") throw new Error(`${STORE_ENV} must be set to carry withdrawals`);
    if (!isAccountId(relayerOf[n]) || !isAccountId(feeTo[n])) throw new Error(`${RELAYER_ENV[n].join(" and ")} must be set to carry withdrawals`);
    for (const k of keys) relayerKey(k); // a key that does not parse stops the helper at start, never at a request
    nets.set(TOKENS[n], { network: n, vault: vault!, keys });
  }

  const ready = new Map<FeeNetwork, Promise<WithdrawSendDeps>>();
  const stops: (() => void)[] = [];
  const init = async (net: Net): Promise<WithdrawSendDeps> => {
    const rpcs = urls[net.network].map((u) => nearRpc(u, fetch, RPC_TIMEOUT_MS)) as unknown as readonly [Rpc, Rpc];
    const block = await agreedBlock(rpcs, Date.now);
    const c = await viewAt(rpcs, block, net.vault, "config", {});
    const scope = isObj(c) ? decimal(c.scope, 1n << 256n) : null;
    if (!isObj(c) || scope === null || c.asset !== TOKENS[net.network]) throw new Error("the vault's config() names another token or no scope");
    const nonces = createFileStore(join(storeDir, `withdraw-keys-${net.network}`));
    const store = createWithdrawSendStore(join(storeDir, `withdraw-send-${net.network}`), { release: Number(release), keys: nonces });
    const relayers = await Promise.all(net.keys.map((k) => startRelayer(rpcs, rpcs[0], relayerOf[net.network], k, net.vault, nonces)));
    const watch = status[net.network];
    const deps: WithdrawSendDeps = {
      cfg: { vault: net.vault, token: TOKENS[net.network], scope, feeRecipient: feeTo[net.network] },
      rpcs,
      reads: fee.reads(net.network),
      index: createSpendsIndex(rpcs, net.vault),
      store,
      relayers,
      // no watch for this network's token: held (token_halted), as the watch holds while it is not caught up
      tokenStatus: watch ?? (async () => ({ token: TOKENS[net.network], caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: "", block_height: 0, last_event: null })),
    };
    stops.push(await startOutcomeRounds(deps));
    return deps;
  };
  const started = (net: Net): Promise<WithdrawSendDeps> => {
    let p = ready.get(net.network);
    if (p === undefined) {
      p = init(net);
      ready.set(net.network, p);
      p.catch(() => ready.delete(net.network)); // the next request, or the next warm try, starts it again
    }
    return p;
  };
  let stopped = false;
  const warmNet = (net: Net) =>
    started(net).catch(() => {
      if (!stopped) setTimeout(() => warmNet(net), OUTCOME_ROUND_MS).unref();
    });
  return {
    async carry(body) {
      const token = isObj(body) ? body.token : undefined;
      const net = typeof token === "string" ? nets.get(token) : undefined;
      if (net === undefined) return no("bad_shape");
      const p = started(net);
      let deps: WithdrawSendDeps;
      try {
        deps = await p;
      } catch {
        return no("upstream", 503);
      }
      return carryWithdraw(body, deps);
    },
    warm: () => nets.forEach((net) => void warmNet(net)),
    stop: () => {
      stopped = true;
      stops.forEach((s) => s());
    },
  };
}
