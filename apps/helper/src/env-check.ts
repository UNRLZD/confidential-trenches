// node src/env-check.ts (card helper-evm-sender): the senders' settings, read from this process's environment by the
// same readers the helper's start runs: the pool senders (pool/evm.ts evmPoolSendersFromEnv, pool/solana.ts
// solanaPoolSendersFromEnv) and, card helper-v1-cutover, the withdrawal relayer and the deposit carry
// (withdraw/send.ts withdrawSenderFromEnv, bind/env.ts bindSenderFromEnv), each with the release's mainnet vault pin
// (withdraw/send.ts MAINNET_VAULT). A network with some of its names set and not the rest, a value a reader refuses, or a
// WITHDRAW_VAULT_MAINNET or BIND_VAULT_MAINNET that is not the pin (the lines left from the vault before) exits 2 with
// the reader's message, which names the variable, never its value; otherwise it exits 0. deploy/redeploy.sh runs it in
// the new image, with the environment compose gives the helper, before any helper is started or stopped, so a set the
// start would refuse stops the redeploy there instead of after the swap's wait (REDEPLOY_READY_S) with a new helper
// that never gets ready. deploy/vault-lines.sh moves the two vault lines to the deploy record's vault.
// Card sol-pools-mainnet-pin: and the mainnet mark scan's two routes (checkMarksRoute), each asked the scan once, and
// no keyed Solana URL of the signing page's direct seat's operator (checkSolanaPairOperators).
import { createHash } from "node:crypto";
import { EVM_POOL_HISTORY, evmPoolProvidersOf, evmPoolVenues, evmRpcOperator } from "@blindfill/kit";
import { bindSenderFromEnv } from "./bind/env.ts";
import { aCandidates, MARKS_A_SLOTS, planSpent, marksRoutes, operatorOf, readUpstreams, RPC_SCAN_PROGRAM_ENV, RPC_UPSTREAMS } from "./rpc/rpc.ts";
import { CREDITS } from "./rpc/slot.ts";
import { RETRY_AFTER_MAX_S } from "./limits/limits.ts";
import { evmPoolSendersFromEnv } from "./pool/evm.ts";
import { solanaPoolSendersFromEnv } from "./pool/solana.ts";
import { statusesOf, tokenWatchesFromEnv } from "./token-status/status.ts";
import type { FeeQuoter } from "./withdraw/fee.ts";
import { MAINNET_VAULT, withdrawSenderFromEnv } from "./withdraw/send.ts";

/** Throws the start's own refusal of a pool sender's settings. */
export function checkPoolEnv(env: Record<string, string | undefined>): void {
  evmPoolSendersFromEnv(env);
  solanaPoolSendersFromEnv(env);
}

/**
 * Throws when a keyed Base or Robinhood URL the helper would use (rpc/rpc.ts RPC_UPSTREAMS keyed names) is run by an
 * operator of that chain's pool list (the kit's evmPoolProvidersOf, by its evmRpcOperator), or has no operator (not an
 * http(s) URL): the device's EVM pool sync keeps old logs only when two operators give them alike, the helper's
 * ?keyed=only route counted as operator "helper" (packages/wallet/src/pool/evm.ts evmSourceOperator), so a keyed URL
 * of a pool-list operator would count one operator twice (card evm-pool-sync-holds). So would one of an operator of
 * the chain's history list (the kit's EVM_POOL_HISTORY, which the device reads after the helper's route; review
 * P3-2), refused the same way. Names the variable and the operator, never the URL or any part of it: a keyed URL
 * carries its key.
 */
export function checkPoolRpcOperators(env: Record<string, string | undefined>): void {
  const venues = evmPoolVenues();
  for (const chain of ["base", "robinhood"] as const) {
    const pool = new Set((evmPoolProvidersOf(venues[chain]) ?? []).map(evmRpcOperator));
    const history = new Set(EVM_POOL_HISTORY[chain].map(evmRpcOperator));
    for (const name of RPC_UPSTREAMS[chain].keyed) {
      const url = env[name];
      if (url === undefined || url === "") continue;
      const op = evmRpcOperator(url);
      if (op === null) throw new Error(`${name}: not an http(s) URL, so no operator apart from the device's pool list`);
      if (pool.has(op)) throw new Error(`${name}: its operator ${op} runs the device's ${chain} pool list`);
      if (history.has(op)) throw new Error(`${name}: its operator ${op} runs the device's ${chain} pool history`);
    }
  }
}

/** The signing page's public Solana seat, every member (packages/signpage/src/trade.ts SOLANA_PUBLIC_SEAT: provider A,
 *  then its spare; card signpage-throttled-provider-has-a-spare). The helper imports no page code, so
 *  packages/signpage/test/pool-testnet.test.ts reads this file's constant and holds the two equal. */
export const PAGE_SOLANA_PUBLIC_SEAT: readonly string[] = Object.freeze(["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network", "https://public.rpc.solanavibestation.com"]);

/**
 * Throws when a keyed Solana URL the helper would read /v1/rpc/solana from (rpc/rpc.ts RPC_UPSTREAMS.solana keyed
 * names) is run by the operator of any member of the signing page's public Solana seat (PAGE_SOLANA_PUBLIC_SEAT: a read
 * provider A throttles goes to its spare, so either may be the pair's public side), or has no operator (not an http(s)
 * URL): the page reads every Solana pool mark and page on its pair, that seat directly and this helper's
 * /v1/rpc/solana as the other (packages/signpage/src/pool-testnet.ts pageSolanaRpcs), and a mark counts only when both
 * give it the same bytes, so the two seats must be two operators (card sol-pools-mainnet-pin, review P3-6 of
 * a34c1626). The operator is rpc/rpc.ts operatorOf's. Names the variable and the operator, never the URL or any part
 * of it: a keyed URL carries its key.
 */
export function checkSolanaPairOperators(env: Record<string, string | undefined>): void {
  const seat = new Set(PAGE_SOLANA_PUBLIC_SEAT.map(operatorOf));
  for (const name of RPC_UPSTREAMS.solana.keyed) {
    const url = env[name];
    if (url === undefined || url === "") continue;
    let op: string | null = null;
    try {
      op = /^https?:$/.test(new URL(url).protocol) ? operatorOf(url) : null;
    } catch {}
    if (op === null) throw new Error(`${name}: not an http(s) URL, so no operator apart from the page's public Solana seat`);
    if (seat.has(op)) throw new Error(`${name}: its operator ${op} runs a member of the signing page's public Solana seat, so the page's pair would read one operator twice`);
  }
}

/**
 * The withdrawal sender's fee quoter, never asked here: the sender reads its settings at construction and its quoter
 * only at a request. The real quoter (withdraw/fee.ts feeQuoterFromEnv) takes its store's lock as it is made, which the
 * running helper holds on the same volume while this check runs beside it, so it is not made here.
 */
const UNASKED: FeeQuoter = {
  networkOf: () => null,
  quote: () => Promise.reject(new Error("env-check asks no fee")),
  reads: () => {
    throw new Error("env-check asks no fee");
  },
};

/**
 * Throws the start's own refusal of the withdrawal relayer's or the deposit carry's settings, the mainnet vault held to
 * `mainnetVault` (the release's pin; a test passes the next one). Both readers only read: no store is opened and
 * nothing is sent until a request, and both are stopped here.
 */
export function checkSenderEnv(env: Record<string, string | undefined>, mainnetVault: string = MAINNET_VAULT): void {
  const watches = tokenWatchesFromEnv(env);
  withdrawSenderFromEnv(env, UNASKED, statusesOf(watches), fetch, mainnetVault).stop();
  bindSenderFromEnv(env, watches, fetch, mainnetVault).stop();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Bucket 0 of a mark size: base58 of size - 9 bytes, the counter's bytes past its low byte (all 0) then the tag 1. */
const bucket0 = (size: number): string => "1".repeat(size - 10) + B58[1];
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type ScanAnswer = { result?: { context?: { slot?: unknown }; value?: unknown } } | null;

/** A provider's answer to one scan as the check reads it: a list with its slot, its plan spent, or another failure. */
type Asked = { ok: true; line: string } | { ok: false; spent: boolean; why: string };
/** How often one short throttle (a 429 that names no spent plan) is waited out on the same provider before the check
 *  refuses on it, never moving past it. [design: 3: a provider's per-second throttle ends within a few of its
 *  Retry-Afters; a longer one is no answer the deploy should go on.] */
export const MARKS_THROTTLE_TRIES = 3;

/**
 * The mark scan's two routes (card sol-pools-mainnet-pin; rpc.ts marksRoutes), asked as the page asks them: with the
 * mainnet pool program set, route A's provider and route B's must each answer bucket 0 of each mark size, in
 * scanAllowed's exact shape, HTTP 200 with a list and its slot, on two companies. Card helper-solana-off-a-spent-key:
 * route A is the first of rpc.ts aCandidates (the Solana slots, SOLANA_RPC_URL first, then the keyed spares) whose plan
 * is not spent and that has a route B provider off its company, as the helper's route A takes it; route B the first of
 * those that answers. A spent plan (a refusal naming it, slot.ts CREDITS; or a JSON-RPC error rpc.ts planSpent reads) moves
 * to the next; a short throttle (any other 429) is waited out for its Retry-After, MARKS_THROTTLE_TRIES times, and then
 * refuses, never moving on; any other failure refuses as before. Throws, naming variables, never a value, when no slot is
 * set, or no A and B on two companies answer; returns one line per read (the name, the status, the slot, the count and
 * the value's sha256, so the two routes' answers compare by hash), a line per spent plan passed, and the pair taken. No
 * mainnet program: the routes refuse every scan, and nothing is asked.
 */
export async function checkMarksRoute(env: Record<string, string | undefined>, doFetch: Fetch = fetch, sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((ok) => setTimeout(ok, ms))): Promise<string[]> {
  const programName = RPC_SCAN_PROGRAM_ENV["solana-marks"]!;
  const program = env[programName];
  if (!program) return [`marks: ${programName} unset, both routes refuse every scan; nothing asked`];
  const up = readUpstreams(env);
  const cands = aCandidates(env);
  if (cands.length === 0) throw new Error(`marks: none of ${MARKS_A_SLOTS.join(", ")} set, so route A has no provider for the scan`);
  const { bOf } = marksRoutes(up, cands);
  const nameOf = (url: string): string => [...cands, ...up["solana-marks"].keyed].find((k) => k.url === url)!.env;
  const bNames = RPC_UPSTREAMS["solana-marks"].keyed;
  const lines: string[] = [];
  const notes: string[] = [];
  /** Both mark sizes asked of `url`: its two lines, or why it gave none (`spent`: its plan spent). */
  const askBoth = async (url: string): Promise<{ ok: true; lines: string[] } | { ok: false; spent: boolean; why: string }> => {
    const out: string[] = [];
    for (const size of [13, 17]) {
      const a = await askOne(url, size);
      if (!a.ok) return a;
      out.push(a.line);
    }
    return { ok: true, lines: out };
  };
  const askOne = async (url: string, size: number): Promise<Asked> => {
    const name = nameOf(url);
    const body = { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [program, { commitment: "finalized", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: size }, { memcmp: { offset: 9, bytes: bucket0(size) } }] }] };
    for (let tries = 0; ; tries++) {
      let status: number;
      let text: string;
      let retryS = 1;
      try {
        const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        status = r.status;
        retryS = Math.min(Math.max(Number(r.headers.get("retry-after")) || 1, 1), RETRY_AFTER_MAX_S);
        text = await r.text().catch(() => "");
      } catch (e) {
        throw new Error(`marks: ${name} size ${size}: no answer (${(e as { name?: string }).name ?? "error"})`);
      }
      let j: ScanAnswer;
      try {
        j = JSON.parse(text) as ScanAnswer;
      } catch {
        j = null;
      }
      if ((status >= 400 && CREDITS.test(text)) || planSpent(j)) return { ok: false, spent: true, why: `marks: ${name} size ${size}: HTTP ${status}, its plan spent` };
      if (status === 429 && tries + 1 < MARKS_THROTTLE_TRIES) {
        await sleep(retryS * 1000);
        continue;
      }
      const v = j?.result?.value;
      const slot = j?.result?.context?.slot;
      if (status !== 200 || !Array.isArray(v) || !Number.isSafeInteger(slot)) throw new Error(`marks: ${name} size ${size}: HTTP ${status}${status === 200 ? ", no list with its slot" : ""}`);
      return { ok: true, line: `marks: ${name} size ${size}: HTTP 200, slot ${slot as number}, ${v.length} account(s), sha256 ${createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16)}` };
    }
  };
  for (const a of cands) {
    const bs = bOf(a.url);
    if (bs.length === 0) {
      const same = up["solana-marks"].keyed.filter((k) => k.url !== a.url && operatorOf(k.url) === operatorOf(a.url)).map((k) => k.env);
      notes.push(`${a.env}: no route B provider off its company${same.length > 0 ? ` (${same.join(", ")} on ${a.env}'s company, and no other of ${bNames.join(", ")} set)` : ""}`);
      continue;
    }
    const aSaid = await askBoth(a.url);
    if (!aSaid.ok) {
      notes.push(aSaid.why);
      lines.push(aSaid.why);
      continue;
    }
    for (const b of bs) {
      const bSaid = await askBoth(b);
      if (!bSaid.ok) {
        notes.push(bSaid.why);
        lines.push(bSaid.why);
        continue;
      }
      return [...lines, ...aSaid.lines, ...bSaid.lines, `marks: route A: ${a.env}; route B: ${nameOf(b)}`];
    }
  }
  throw new Error(`marks: no route A and route B on two companies answer the scan: ${notes.join("; ")}`);
}

if (import.meta.main) {
  try {
    checkPoolEnv(process.env);
    checkSenderEnv(process.env);
    checkPoolRpcOperators(process.env);
    checkSolanaPairOperators(process.env);
    for (const line of await checkMarksRoute(process.env)) console.log(`helper env: ${line}`);
  } catch (e) {
    console.error(`helper env: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log("helper env: the pool senders', the withdrawal relayer's and the deposit carry's settings are whole; no keyed Base or Robinhood URL is a pool-list or pool-history operator's; no keyed Solana URL is the page's direct seat's operator; the mark scan's two routes answer");
  process.exit(0);
}
