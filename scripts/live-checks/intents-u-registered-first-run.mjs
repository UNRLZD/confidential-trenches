#!/usr/bin/env node
// The mainnet run's read-back for card intents-u-registered-first (a real-money run: the owner's to make). The run: a
// fresh deposit id U whose deposit 1Click refunds into U inside intents.near (refundType INTENTS), on the deployed
// helper and SIGN_HOST of this card. The helper registers U on USDC when the REFUNDED status first shows it money
// (registerSeen), the signing page then signs U's refund move, and the helper carries it (execute_intents). This script
// reads that run back on two NEAR mainnet RPCs of two operators and holds the card's end state on chain:
//   - the registration: one storage_deposit on USDC for exactly U, registration_only, sent by the relayer, every
//     receipt a success;
//   - U's intent: one execute_intents on intents.near sent by the relayer, its one signed intent's signer_id U, every
//     receipt a success, in a block after the registration's;
//   - storage_balance_of(U) on USDC: null at the block before the registration (U was fresh), non-null at the block
//     before the intent's (registered before its first intent); each read equal on both RPCs.
// It moves nothing and signs nothing. With --write it writes scripts/live-checks/intents-u-registered-first.md, the
// record the money gate reads back (`Money path: yes` and one `Tx: near <hash> <signer>` per transaction).
//   node scripts/live-checks/intents-u-registered-first-run.mjs --u <64-hex U> --reg <tx hash> --intent <tx hash> --relayer <account> [--write] [--dry]
// --dry: the arguments checked and the reads it would make printed; no connection. PASS exit 0, FAIL exit 1, error 2.
// Runs: once, the owner's mainnet run (a real refund into a fresh U) read back; its record then goes to the money gate
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "intents-u-registered-first";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const INTENTS = "intents.near";
/** Two operators' archival mainnet RPCs (FastNEAR's and dRPC's, as the money gate reads them). */
export const RPCS = ["https://archival-rpc.mainnet.fastnear.com", "https://near.drpc.org"];
const HEX64 = /^[0-9a-f]{64}$/;
const TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

/** The run's arguments, checked: { u, reg, intent, relayer } or a thrown Error. */
export function argsOf(a) {
  if (!HEX64.test(a.u ?? "")) throw new Error("--u: a 64-hex implicit account id");
  if (!TX.test(a.reg ?? "") || !TX.test(a.intent ?? "") || a.reg === a.intent) throw new Error("--reg and --intent: two base58 tx hashes");
  if (!ACCOUNT.test(a.relayer ?? "")) throw new Error("--relayer: the helper's bind relayer account");
  return { u: a.u, reg: a.reg, intent: a.intent, relayer: a.relayer };
}

/** A tx status answer's one FunctionCall and its outcome: { receiver, signer, method, args, ok, blockHash } or null. */
export function callOf(status) {
  const t = status?.transaction;
  if (!isObj(t) || !Array.isArray(t.actions) || t.actions.length !== 1 || !isObj(t.actions[0]?.FunctionCall)) return null;
  const f = t.actions[0].FunctionCall;
  let args;
  try {
    args = JSON.parse(Buffer.from(f.args, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const outs = [status.transaction_outcome, ...(Array.isArray(status.receipts_outcome) ? status.receipts_outcome : [])];
  const ok = isObj(status.status) && Object.hasOwn(status.status, "SuccessValue") && outs.every((o) => isObj(o?.outcome?.status) && !Object.hasOwn(o.outcome.status, "Failure"));
  return { receiver: t.receiver_id, signer: t.signer_id, method: f.method_name, args, ok, blockHash: status.transaction_outcome?.block_hash };
}

/**
 * The verdict on the run's reads: { reg: [status, status], intent: [status, status], heights: { reg, intent },
 * before: { reg: [storage, storage], intent: [storage, storage] } }, each pair as the two RPCs answered.
 */
export function judge(run, a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const same = (pair) => Array.isArray(pair) && pair.length === 2 && JSON.stringify(pair[0]) === JSON.stringify(pair[1]);
  for (const k of ["reg", "intent"]) if (!same(a?.[k])) bad(`the ${k} tx does not read alike on both RPCs`);
  const reg = callOf(a?.reg?.[0]);
  const it = callOf(a?.intent?.[0]);
  if (reg === null || reg.receiver !== USDC || reg.method !== "storage_deposit" || reg.signer !== run.relayer) bad("the reg tx is not the relayer's storage_deposit on USDC");
  else {
    if (!isObj(reg.args) || reg.args.account_id !== run.u || reg.args.registration_only !== true || Object.keys(reg.args).length !== 2) bad("the reg tx does not register exactly U, registration_only");
    if (!reg.ok) bad("the reg tx did not succeed in every receipt");
  }
  let signer = null;
  try {
    signer = JSON.parse(it?.args?.signed?.[0]?.payload ?? "null")?.signer_id;
  } catch {
    signer = null;
  }
  if (it === null || it.receiver !== INTENTS || it.method !== "execute_intents" || it.signer !== run.relayer) bad("the intent tx is not the relayer's execute_intents on intents.near");
  else {
    if (!Array.isArray(it.args?.signed) || it.args.signed.length !== 1 || signer !== run.u) bad("the intent tx does not carry one intent signed by U");
    if (!it.ok) bad("the intent tx did not succeed in every receipt");
  }
  const h = a?.heights;
  if (!Number.isSafeInteger(h?.reg) || !Number.isSafeInteger(h?.intent) || !(h.reg < h.intent)) bad("the registration's block is not before the intent's");
  if (!same(a?.before?.reg) || a.before.reg[0] !== null) bad("U was not fresh: storage_balance_of(U) not null on both RPCs before its registration");
  const reg2 = a?.before?.intent;
  if (!same(reg2) || !isObj(reg2[0]) || typeof reg2[0].total !== "string") bad("storage_balance_of(U) not registered on both RPCs before its intent");
  return { ok: lines.length === 0, lines };
}

const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
};
const storageAt = async (url, account, height) => {
  const r = await rpc(url, "query", { request_type: "call_function", block_id: height, account_id: USDC, method_name: "storage_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: account })).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};

/** The run's reads on both RPCs. */
export async function read(run) {
  const status = (hash) => Promise.all(RPCS.map((u) => rpc(u, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: run.relayer, wait_until: "FINAL" })));
  const [reg, intent] = [await status(run.reg), await status(run.intent)];
  const heightOf = async (st) => (await rpc(RPCS[0], "block", { block_id: st[0].transaction_outcome.block_hash })).header.height;
  const heights = { reg: await heightOf(reg), intent: await heightOf(intent) };
  const before = {
    reg: await Promise.all(RPCS.map((u) => storageAt(u, run.u, heights.reg - 1))),
    intent: await Promise.all(RPCS.map((u) => storageAt(u, run.u, heights.intent - 1))),
  };
  return { reg, intent, heights, before };
}

export function record(run) {
  return [
    `CARD ${KEY} / mainnet run: PASS`,
    "Money path: yes",
    `Tx: near ${run.reg} ${run.relayer}`,
    `Tx: near ${run.intent} ${run.relayer}`,
    "",
    `U ${run.u}: storage_balance_of on USDC null before the first Tx (fresh) and registered before the second, read on ${RPCS.join(" and ")} (scripts/live-checks/intents-u-registered-first-run.mjs).`,
    "",
  ].join("\n");
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = argsOf({ u: arg("--u"), reg: arg("--reg"), intent: arg("--intent"), relayer: arg("--relayer") });
    if (process.argv.includes("--dry")) {
      console.log(`DRY ${KEY}: would read on ${RPCS.join(", ")}: EXPERIMENTAL_tx_status of ${run.reg} and ${run.intent} (sender ${run.relayer}), their blocks, and storage_balance_of(${run.u}) on ${USDC} at the block before each`);
      process.exit(0);
    }
    const v = judge(run, await read(run));
    for (const l of v.lines) console.log(l);
    if (v.ok && process.argv.includes("--write")) writeFileSync(new URL(`./${KEY}.md`, import.meta.url), record(run));
    console.log(v.ok ? `PASS ${KEY} mainnet run` : `FAIL ${KEY} mainnet run`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
