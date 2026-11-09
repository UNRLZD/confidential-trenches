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
// Card sol-pools-mainnet-pin: and the mainnet mark scan's two routes (checkMarksRoute), each asked the scan once.
import { createHash } from "node:crypto";
import { bindSenderFromEnv } from "./bind/env.ts";
import { marksRoutes, MARKS_A_ENV, operatorOf, readUpstreams, RPC_SCAN_PROGRAM_ENV, RPC_UPSTREAMS } from "./rpc/rpc.ts";
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

/**
 * The mark scan's two routes (card sol-pools-mainnet-pin; rpc.ts marksRoutes), asked as the page asks them: with the
 * mainnet pool program set, route A's provider (MARKS_A_ENV) and route B's first one (RPC_UPSTREAMS["solana-marks"], off
 * A's company) must both be set and each answer bucket 0 of each mark size, in scanAllowed's exact shape, HTTP 200 with a
 * list and its slot. Throws, naming the variable, never its value, when B is unset or on A's company, or either does not
 * answer so; returns one line per read: the name, the status, the slot, the count and the value's sha256, so the two
 * routes' answers compare by hash. No mainnet program: the routes refuse every scan, and nothing is asked.
 */
export async function checkMarksRoute(env: Record<string, string | undefined>, doFetch: Fetch = fetch): Promise<string[]> {
  const programName = RPC_SCAN_PROGRAM_ENV["solana-marks"]!;
  const program = env[programName];
  if (!program) return [`marks: ${programName} unset, both routes refuse every scan; nothing asked`];
  const up = readUpstreams(env);
  const { a, b } = marksRoutes(up);
  const nameOf = (url: string): string => [...up.solana.keyed, ...up["solana-marks"].keyed].find((k) => k.url === url)!.env;
  const aUrl = a();
  if (aUrl === undefined) throw new Error(`marks: ${MARKS_A_ENV} unset, so route A has no provider for the scan`);
  const bNames = RPC_UPSTREAMS["solana-marks"].keyed;
  const bUrl = b()[0];
  if (bUrl === undefined) {
    const same = up["solana-marks"].keyed.filter((k) => operatorOf(k.url) === operatorOf(aUrl)).map((k) => k.env);
    throw new Error(same.length > 0 ? `marks: ${same.join(", ")} on ${MARKS_A_ENV}'s company, and no other of ${bNames.join(", ")} set, so route B has no provider of its own` : `marks: none of ${bNames.join(", ")} set, so route B has no provider`);
  }
  const lines: string[] = [];
  for (const url of [aUrl, bUrl]) {
    const name = nameOf(url);
    for (const size of [13, 17]) {
      const body = { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [program, { commitment: "finalized", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: size }, { memcmp: { offset: 9, bytes: bucket0(size) } }] }] };
      let status: number;
      let j: ScanAnswer;
      try {
        const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        status = r.status;
        j = (await r.json().catch(() => null)) as ScanAnswer;
      } catch (e) {
        throw new Error(`marks: ${name} size ${size}: no answer (${(e as { name?: string }).name ?? "error"})`);
      }
      const v = j?.result?.value;
      const slot = j?.result?.context?.slot;
      if (status !== 200 || !Array.isArray(v) || !Number.isSafeInteger(slot)) throw new Error(`marks: ${name} size ${size}: HTTP ${status}${status === 200 ? ", no list with its slot" : ""}`);
      lines.push(`marks: ${name} size ${size}: HTTP 200, slot ${slot as number}, ${v.length} account(s), sha256 ${createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16)}`);
    }
  }
  return lines;
}

if (import.meta.main) {
  try {
    checkPoolEnv(process.env);
    checkSenderEnv(process.env);
    for (const line of await checkMarksRoute(process.env)) console.log(`helper env: ${line}`);
  } catch (e) {
    console.error(`helper env: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log("helper env: the pool senders', the withdrawal relayer's and the deposit carry's settings are whole; the mark scan's two routes answer");
  process.exit(0);
}
