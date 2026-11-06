// POST /v1/bind's sender from the host's environment: per network, the deposit carry of send.ts (carryDeposit with
// checks.ts unchanged, createSendReads, startRelayer, createFileStore, the lock rounds), built the way
// withdraw/send.ts withdrawSenderFromEnv builds the withdrawal relayer, with the same refusals at start.
//
// The network is the delegate's receiver_id: the token a network's vault holds (token-status/status.ts WATCHED). A body
// that does not decode is check 1's bad_shape and a token no carried network holds is token_not_accepted (check 5),
// both with nothing read; with no network set, every request answers one of the two.
//
// The token watch (status.ts) of the delegate's own network holds the carry (H4.3 check 9, at the higher of the two
// finals) and answers R3's paused exception (its pausedAt: USDC's own views at the receipt's block and at its parent, on
// both providers); a network
// with no watch is held, and its paused-error sends stay pending, never counted (send.ts sendState).
import { join } from "node:path";
import { HELPER_CODE_STATUS } from "@blindfill/kit";
import { decodeSignedDelegate } from "./checks.ts";
import { type CreateDeps, deliveryReads, onStatusAnswer } from "./create.ts";
import { carryDeposit, createFileStore, createSendReads, nearRpc, relayerKey, RPC_TIMEOUT_MS, startLockRounds, startRelayer, type Answer, type Rpc, type SendDeps } from "./send.ts";
import { readUrls, tokenWatchesFromEnv, WATCHED, type TokenNetwork, type TokenWatch } from "../token-status/status.ts";
import { isAccountId } from "../withdraw/checks.ts";
import { agreedBlock, RELAYER_ENV, STORE_ENV, viewAt } from "../withdraw/fee.ts";
import { OUTCOME_ROUND_MS, RELEASE_ENV, SEND_ENV } from "../withdraw/send.ts";

/** Per network: the release's vault, the gas account that sends deposits (bind.<ours>) and its one full-access key. */
export const BIND_ENV = {
  mainnet: ["BIND_VAULT_MAINNET", "BIND_RELAYER_MAINNET", "BIND_RELAYER_KEY_MAINNET"],
  testnet: ["BIND_VAULT_TESTNET", "BIND_RELAYER_TESTNET", "BIND_RELAYER_KEY_TESTNET"],
} as const;
/** R4's margin K in blocks (checks.ts BindConfig.marginK): the release's pin, 1 to 600; no carry without it. */
export const MARGIN_K_ENV = "BIND_MARGIN_K";

export type BindSender = {
  /** POST /v1/bind for a parsed body: the network from the delegate's receiver_id. */
  carry(body: unknown): Promise<BindRouteAnswer>;
  /** At the helper's start: every carried network started, so a restart reads and resends its open records at once. */
  warm(): void;
  stop(): void;
  /**
   * A 1Click /v0/status answer the proxy carried, after it was answered (create.ts onStatusAnswer): a delivery to a
   * one-time id on a carried network's token creates that id once. Returns at once; nothing it does reaches the
   * answer, and a failure is logged only.
   */
  delivered?(body: string): void;
};

const STATUS: Record<string, number> = HELPER_CODE_STATUS;
/** A device polls its status: the answers that change nothing are not logged. */
const QUIET: ReadonlySet<string> = new Set(["delivery_used", "exists", "no_delivery", "under_min"]);
/** The route's own answers, before the carry: check 1's and check 5's codes, and upstream (a start that failed). */
export type BindRouteAnswer = { status: number; body: Answer["body"] | { error: { code: "bad_shape" | "token_not_accepted" | "upstream" } } };
const no = (code: "bad_shape" | "token_not_accepted" | "upstream"): BindRouteAnswer => ({ status: STATUS[code] ?? 400, body: { error: { code } } });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The delegate's receiver_id, or null when the body is not {signed_delegate: base64 of one SignedDelegateAction}. */
function receiverOf(body: unknown): string | null {
  if (!isObj(body) || typeof body.signed_delegate !== "string") return null;
  try {
    return decodeSignedDelegate(new Uint8Array(Buffer.from(body.signed_delegate, "base64"))).receiver_id;
  } catch {
    return null;
  }
}

/**
 * A network's watch as the carry takes it: the hold (tokenStatus) and R3's paused exception (pausedAt), both from the
 * network's own watch. With no watch: held (token_halted), as a watch holds while it is not caught up, and the paused
 * exception not known, so a paused-error send stays pending (header).
 */
export function watchDeps(watch: Pick<TokenWatch, "statusAt" | "pausedAt"> | undefined, token: string): Pick<SendDeps, "tokenStatus" | "pausedAt"> {
  return {
    tokenStatus: watch?.statusAt ?? (async () => ({ token, caught_up: false, halted: null, vault_blocked: null, code_hash_ok: null, code_hash: "", block_height: 0, last_event: null })),
    pausedAt: watch?.pausedAt ?? (async () => null),
  };
}

/**
 * The route's sender. A network is carried only when its vault, gas account and key, the release number, the store
 * folder and the margin K are all set; one set in part stops the helper at start, as does a key that does not parse or
 * a vault that is not the one WITHDRAW_VAULT_<NETWORK> names. Every name is read, set or not, so the deploy gate sees
 * them all. On the first request (and again after a failure) it reads the vault's config() on both providers (its asset
 * the network's token), opens the network's store under HELPER_STORE_DIR, starts the relayer and the lock rounds.
 */
export function bindSenderFromEnv(
  env: Record<string, string | undefined>,
  watches: Partial<Record<TokenNetwork, Pick<TokenWatch, "statusAt" | "pausedAt">>> = tokenWatchesFromEnv(env),
  fetchFn: typeof fetch = fetch,
): BindSender {
  const release = env[RELEASE_ENV] ?? "";
  const storeDir = env[STORE_ENV] ?? "";
  const k = env[MARGIN_K_ENV] ?? "";
  const nets = Object.keys(BIND_ENV) as TokenNetwork[];
  const set = Object.fromEntries(nets.map((n) => [n, BIND_ENV[n].map((name) => env[name] ?? "")])) as Record<TokenNetwork, string[]>;
  const withdrawVault = Object.fromEntries(nets.map((n) => [n, env[SEND_ENV[n][0]] ?? ""])) as Record<TokenNetwork, string>;
  const withdrawKeys = Object.fromEntries(nets.map((n) => [n, env[SEND_ENV[n][1]] ?? ""])) as Record<TokenNetwork, string>;
  const withdrawRelayer = Object.fromEntries(nets.map((n) => [n, env[RELAYER_ENV[n][0]] ?? ""])) as Record<TokenNetwork, string>;
  const urls: Record<TokenNetwork, readonly [string, string]> = { mainnet: readUrls(env, "mainnet"), testnet: readUrls(env, "testnet") };

  type Net = { network: TokenNetwork; vault: string; account: string; key: string };
  const carried = new Map<string, Net>();
  for (const n of nets) {
    const [vault, account, key] = set[n] as [string, string, string];
    if (vault === "" && account === "" && key === "") continue;
    if (!isAccountId(vault) || !isAccountId(account) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(key)) throw new Error(`${BIND_ENV[n].join(", ")} must be a NEAR account id, a NEAR account id and one ed25519 key`);
    if (withdrawVault[n] !== "" && withdrawVault[n] !== vault) throw new Error(`${BIND_ENV[n][0]} and ${SEND_ENV[n][0]} must name the same vault`);
    if (!/^[1-9][0-9]{0,8}$/.test(release)) throw new Error(`${RELEASE_ENV} must be a whole number, 1 or more, to carry deposits`);
    if (storeDir === "") throw new Error(`${STORE_ENV} must be set to carry deposits`);
    if (!/^[1-9][0-9]{0,2}$/.test(k) || Number(k) > 600) throw new Error(`${MARGIN_K_ENV} must be a whole number of blocks, 1 to 600, to carry deposits`);
    const pub = Buffer.from(relayerKey(key).pub); // a key that does not parse stops the helper at start, never at a request
    // one key on one account in both relayers would have two nonce counters (bind-<net> and withdraw-keys-<net>), and a
    // concurrent sign would drop a transaction: refused
    if (account === withdrawRelayer[n]) {
      for (const w of withdrawKeys[n].split(",").filter((x) => x !== "")) {
        let other: Buffer | null = null;
        try {
          other = Buffer.from(relayerKey(w).pub);
        } catch {
          other = null; // withdrawSenderFromEnv refuses a key that does not parse
        }
        if (other !== null && other.equals(pub)) throw new Error(`${BIND_ENV[n][2]} must not be one of ${SEND_ENV[n][1]} on the same account`);
      }
    }
    carried.set(WATCHED[n].token, { network: n, vault, account, key });
  }

  const ready = new Map<TokenNetwork, Promise<SendDeps>>();
  /** Each started network's creation (create.ts): the carry's store and relayer, the gate's reads on its providers. */
  const creates = new Map<TokenNetwork, CreateDeps>();
  const stops: (() => void)[] = [];
  const init = async (net: Net): Promise<SendDeps> => {
    const token = WATCHED[net.network].token;
    const rpcs = urls[net.network].map((u) => nearRpc(u, fetchFn, RPC_TIMEOUT_MS)) as unknown as readonly [Rpc, Rpc];
    const block = await agreedBlock(rpcs, Date.now);
    const c = await viewAt(rpcs, block, net.vault, "config", {});
    if (!isObj(c) || c.asset !== token) throw new Error("the vault's config() names another token");
    const store = createFileStore(join(storeDir, `bind-${net.network}`));
    // a start that fails after the store opens closes it, so the next try can take its lock again
    try {
      const relayer = await startRelayer(rpcs, rpcs[0], net.account, net.key, net.vault, store);
      const watch = watches[net.network];
      const deps: SendDeps = {
        cfg: { vault: net.vault, token, marginK: BigInt(k) },
        reads: createSendReads(rpcs, { vault: net.vault, token }),
        store,
        relayer,
        // no watch for this network's token: held (token_halted), as the watch holds while it is not caught up
        ...watchDeps(watch, token),
      };
      stops.push(startLockRounds(deps));
      creates.set(net.network, { token, delivery: deliveryReads(rpcs, token), store, relayer });
      return deps;
    } catch (e) {
      store.close();
      throw e;
    }
  };
  const started = (net: Net): Promise<SendDeps> => {
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
      const receiver = receiverOf(body);
      if (receiver === null) return no("bad_shape");
      const net = carried.get(receiver);
      if (net === undefined) return no("token_not_accepted");
      let deps: SendDeps;
      try {
        deps = await started(net);
      } catch {
        return no("upstream");
      }
      return carryDeposit(body, deps);
    },
    warm: () => carried.forEach((net) => void warmNet(net)),
    delivered(body) {
      const nets = new Map([...carried].map(([token, net]) => [token, () => started(net).then(() => creates.get(net.network)!)]));
      void onStatusAnswer(body, nets).then(
        // the outcome only: no id, no address
        (a) => a !== null && !QUIET.has(a.code) && console.log(`helper: create ${a.code}${a.tx_hash ? ` ${a.tx_hash}` : ""}${a.why ? ` (${a.why})` : ""}`),
        (e: unknown) => console.error(`helper: create failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`),
      );
    },
    stop: () => {
      stopped = true;
      stops.forEach((s) => s());
    },
  };
}
