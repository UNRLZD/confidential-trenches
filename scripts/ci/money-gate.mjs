#!/usr/bin/env node
// The money gate. A card's live record (scripts/live-checks/<key>.md, written by the run of the card's live check) says
// whether the card is a money path, and lists its transactions:
//   CARD <key> / live: PASS
//   Money path: yes
//   Tx: near <tx hash> <signer account>
//   Tx: near-testnet <tx hash> <signer account>
//   Tx: solana <signature>
//   Tx: base <0x hash>
//   Tx: robinhood <0x hash>
// Refused: a record that is not a regular file (a symlink); a record whose CARD, Money path or Tx lines do not parse
// as its own card's sections; a money-path record with no Tx; a Tx listed twice, in any record; in the last live
// section, a word shaped like a tx id of a listed chain (a 0x hash, 43-44 or 86-88 base58) on a line that names a
// transaction, when no parsed Tx line lists it, so a tx written in another shape is never silently left unread. A line
// names a transaction when a word of it, or a part of a word (txHash, tx_hash, Tx2, nearblocks.io/txns/<id>), is tx,
// txs, txn(s), txid(s), txhash(es) or transaction(s), in any case; a backticked or table-cell Tx line is one, and so is
// every row of a table whose header row names a transaction (a "Tx" column) or whose nearest non-blank line above
// names one ("Transactions read back:"), and of a table right under a Tx line (blank lines between or not) whose header
// row has a Hash or ID column that does not say Block ("| Chain | Hash |" is read, "| Block hash |" is not). "hash",
// "block hash", "signature", "receipt", "commitment" and "root" are not transaction words: a block hash, a deposit
// commitment or root, an order's signature or a wallet address on a line that names no transaction passes, whatever
// its shape. The rule is the same for every chain and every shape.
// Each Tx is read back on the public RPCs of its chain: it passes only
// when two of them, run by two different operators, read it as succeeded, on or after 2026-11-01T00:00:00Z, and none
// reads it as failed or older. Two hosts of one operator are one read (NEAR's operators: near-rpc-operators.mjs). A
// NEAR tx only one operator reads (one older than dRPC keeps: no second keyless archival operator exists,
// near-rpc-operators.mjs) passes only when FastNEAR's light-client proof of it, and of every receipt it led to, each a
// success, reaches a final block dRPC names on the tx's network (proveNearTx), and its signed bytes, from the record's
// tx-bytes file or rebuilt from FastNEAR's own tx JSON (findTxBytes), hash to its id and name its signer; the output
// names it PROVEN ON dRPC.
// near-testnet is NEAR's test network, read on its own RPCs with the same rules: a testnet tx written as "Tx: near" is
// read on the mainnet RPCs, where it does not exist, and is refused. A testnet tx is never real-money proof: parseLive's
// `real` lists the mainnet txs only, and a release counts those alone.
// A change (a pull request, or a push to main) that touches money code (MONEY below) may merge with no record: when a
// card whose commit touches money code changes its record in the same change, that record must be true, so "Money
// path: no" in it, a last live verdict of FAIL or no live section is refused. Money code in a commit that names no card,
// or added by a merge commit, is refused.
// Real money is proven before Live and before the money code's deploy, by the card's record: the release card checks
// that, not this merge gate.
// No token and no secret.
//   node scripts/ci/money-gate.mjs <base sha> <head sha>   the records changed between the two commits
//   node scripts/ci/money-gate.mjs --all                   every record in scripts/live-checks/
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { operatorOf as nearOperatorOf } from "./near-rpc-operators.mjs";
import { RPC_OPERATORS } from "./rpc-operators.mjs";

// Public RPCs, none ours; each answered a tx read on 2026-10-26 between 11:48 and 11:54Z. NEAR lists two operators on
// three hosts: FastNEAR's archival RPC, dRPC (which keeps only recent txs, enough for a fresh live record), and
// near.org's archival RPC, which FastNEAR runs (near-rpc-operators.mjs): a second door to FastNEAR when its own host
// rate-limits, never a second operator.
export const RPCS = {
  near: ["https://archival-rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org"],
  solana: ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"],
  base: ["https://mainnet.base.org", "https://base.drpc.org"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
  // NEAR testnet, read 2026-10-31 at 16:16Z: the same two operators on three hosts, as for mainnet.
  // test.rpc.fastnear.com and near-testnet.drpc.org keep only recent txs (each answered UNKNOWN_TRANSACTION for a
  // 2026-10-26 tx that both archival RPCs read), so FastNEAR's archival RPC stands in for its test.rpc.
  "near-testnet": ["https://archival-rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://archival-rpc.testnet.near.org"],
};
// test networks: read back like any chain, never real-money proof
export const TESTNET = new Set(["near-testnet"]);
const NEAR = new Set(["near", "near-testnet"]);
// The build starts here: a tx before it is not this repo's (a pasted research tx, say).
export const FLOOR = Date.parse("2026-11-01T00:00:00Z");
// The folders that hold money code, from the kit layout (README.md "Layout": contracts/vault/ the vault, packages/kit/
// the kit, packages/wallet/ the wallets) and the terminal's trade code (docs/plan1/app.md:128 and :141 cite the UNRLZD
// terminal's apps/terminal/src/trading/, which the terminal is rebuilt from). Screens and docs are not money code.
export const MONEY = ["contracts/vault/", "packages/kit/", "packages/wallet/", "apps/terminal/src/trading/"];
export const LIVE = "scripts/live-checks/";
const CHAIN_ID = { base: "0x2105", robinhood: "0x1237" }; // 8453, 4663
const B58 = "[1-9A-HJ-NP-Za-km-z]";
const FORMAT = {
  near: new RegExp(`^${B58}{43,44}$`),
  solana: new RegExp(`^${B58}{86,88}$`),
  base: /^0x[0-9a-f]{64}$/,
  robinhood: /^0x[0-9a-f]{64}$/,
};
FORMAT["near-testnet"] = FORMAT.near;
// a line that starts with Tx or Money path and a colon, in any shape (after a bullet "-", "*", "+" or "1.", a quote ">",
// bold "**"): it must parse, or it is refused. The same words further into a line are prose (a Repro that quotes a
// record line, a clause that cites "(tx: <hash>)"), not record lines.
const LINE_START = String.raw`^\s*(?:(?:[-*+]|\d+[.)])\s+|>\s*)*(?:\*\*)?\s*`;
const TX_LINE = new RegExp(`${LINE_START}Tx\\s*(?:\\*\\*)?\\s*:`, "i");
const MONEY_LINE = new RegExp(`${LINE_START}Money\\s+path\\s*(?:\\*\\*)?\\s*:`, "i");
// a word (a run of letters and digits) shaped like a tx id of a listed chain: a 0x hash in either case, a NEAR tx id
// (43-44 base58, also the shape of a block hash or a wallet address), a Solana signature (86-88 base58, also the shape
// of an order's signature)
const TX_SHAPED = [/^0x[0-9a-f]{64}$/i, FORMAT.near, FORMAT.solana];
const TX_WORDS = new Set(["tx", "txs", "txn", "txns", "txid", "txids", "txhash", "txhashes", "transaction", "transactions"]);
// a line names a transaction when one of its words, a letter run of one (Tx2) or a camelCase part (txHash) is a
// TX_WORDS word; a word longer than 20 characters (an id, whose letters are random) is never read for one
const words = (l) =>
  (l.match(/[0-9A-Za-z]+/g) ?? [])
    .filter((w) => w.length <= 20)
    .flatMap((w) => w.match(/[A-Za-z]+/g) ?? [])
    .flatMap((w) => [w, ...(w.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [])])
    .map((w) => w.toLowerCase());
const namesTx = (l) => words(l).some((w) => TX_WORDS.has(w));
// a table header row with a Hash or ID column (hash, hashes, id, ids, as a word or a camelCase part) whose cell does
// not say Block: under a Tx line, the column that lists more of them
const idColumn = (row) =>
  row.split("|").some((cell) => {
    const ws = words(cell);
    return ws.some((w) => ["hash", "hashes", "id", "ids"].includes(w)) && !ws.some((w) => w === "block" || w === "blocks");
  });
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

// The last live section of a record: null when there is none and nothing in the record looks like one, else
// { moneyPath, txs, real, problems, verdict }, real being the txs on a mainnet (none of TESTNET).
export function parseLive(text, key) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  const sections = []; // [stage, start line]
  lines.forEach((l, i) => {
    if (!/^\s*CARD\b/.test(l)) return;
    const m = l.match(/^\s*CARD (\S+) \/ (merge|live): (PASS|FAIL)\s*$/);
    if (!m) problems.push(`line ${i + 1} does not read "CARD ${key} / merge|live: PASS|FAIL": ${l.trim()}`);
    else if (m[1] !== key) problems.push(`line ${i + 1} names card ${m[1]}, not ${key}`);
    else sections.push([m[2], i, m[3]]);
  });
  const stageAt = (i) => {
    let s = null;
    for (const [stage, at] of sections) if (at < i) s = stage;
    return s;
  };
  lines.forEach((l, i) => {
    if ((TX_LINE.test(l) || MONEY_LINE.test(l)) && stageAt(i) !== "live") problems.push(`line ${i + 1} is outside a live record: ${l.trim()}`);
  });
  const lives = sections.filter(([s]) => s === "live");
  if (!lives.length) return problems.length ? { moneyPath: null, txs: [], real: [], problems } : null;
  const [, start, verdict] = lives[lives.length - 1];
  let moneyPath = null;
  const txs = [];
  const prose = []; // [line index, line] of every other line of the section
  for (let j = start + 1; j < lines.length && !/^\s*CARD\b/.test(lines[j]); j++) {
    const l = lines[j].trim();
    if (!MONEY_LINE.test(l) && !TX_LINE.test(l)) prose.push([j, l]);
    if (MONEY_LINE.test(l)) {
      const mp = l.match(/^Money path: (yes|no)$/);
      if (mp) moneyPath = mp[1] === "yes";
      else problems.push(`bad Money path line: ${l}`);
      continue;
    }
    if (!TX_LINE.test(l)) continue;
    const t = l.match(/^Tx: (\S+) (\S+)(?: (\S+))?$/);
    if (!t || !Object.hasOwn(FORMAT, t[1])) {
      problems.push(`bad Tx line: ${l}`);
      continue;
    }
    const [, chain, hash, signer] = t;
    if (!FORMAT[chain].test(hash)) problems.push(`bad ${chain} hash: ${hash}`);
    else if (NEAR.has(chain) && !(signer && ACCOUNT.test(signer))) problems.push(`${chain} Tx ${hash} needs its signer account`);
    else txs.push({ chain, hash, signer });
  }
  // a tx in any other shape (in backticks, a table, "Tx hash:", "Txs:", a link) would never be read back: every
  // tx-shaped word on a prose line that names a transaction must be one a parsed Tx line lists, so such a line may cite
  // a listed tx and nothing else
  const id = (w) => (/^0x/i.test(w) ? w.toLowerCase() : w); // a 0x hash in any case; a base58 one exactly
  const listed = new Set(txs.map((t) => id(t.hash)));
  // a table row names a transaction when its table's header names one: the header is the first row of a run of lines
  // that start with "|" (a "Tx" column) and the nearest non-blank line right above that run when it is prose, not a
  // record line or a row of another table ("Transactions read back:", with or without a blank line between). A table
  // whose nearest non-blank line above is a Tx line is one too when its header row has a Hash or ID column that does
  // not say Block.
  let header = null;
  for (const [j, l] of prose) {
    const row = l.startsWith("|");
    if (!row) header = null;
    else if (header === null || header.end !== j - 1) {
      let k = j - 1;
      while (k > start && !lines[k].trim()) k--;
      const a = lines[k].trim();
      const above = k > start && !a.startsWith("|") && !TX_LINE.test(a) && !MONEY_LINE.test(a) ? a : "";
      header = { tx: namesTx(l) || namesTx(above) || (k > start && TX_LINE.test(a) && idColumn(l)), end: j };
    } else header.end = j;
    if (!namesTx(l) && !(row && header.tx)) continue;
    const unlisted = (l.match(/[0-9A-Za-z]+/g) ?? []).filter((w) => TX_SHAPED.some((re) => re.test(w)) && !listed.has(id(w)));
    if (unlisted.length) problems.push(`line ${j + 1} names ${[...new Set(unlisted)].join(", ")}, which no parsed Tx line lists: ${l}`);
  }
  if (moneyPath === null) problems.push('the live record has no "Money path: yes|no" line');
  else if (moneyPath && txs.length === 0 && problems.length === 0) problems.push("a money-path live record lists no Tx");
  return { moneyPath, txs, real: txs.filter((t) => !TESTNET.has(t.chain)), problems, verdict };
}

// A rate limit is waited out, never read as an answer: a public RPC may answer HTTP 429 (or code -429) with a
// Retry-After (near.org's archival RPC gave 43 s to 600 s, read 2026-10-31).
// A 429 waits its Retry-After seconds, or 2 s doubling when it gives none (or a date), and asks again, up to
// RATE_TRIES waits in a row; a Retry-After past RATE_CAP seconds is no answer at once. Other trouble (no reply, a
// reply that is not JSON, an HTTP error with no RPC error) is asked 3 times, 2 s and 4 s apart. Each host is asked
// at most once a second.
// A 429 is waited only while the host could add a second operator: once two operators have read a tx ok, or the
// host's own operator has, it is still asked once, but with rateWait off: its 429 is no answer at once (NOT_WAITED),
// never waited and never decisive. A failed or old answer from it still refuses. One operator's read never passes a tx
// alone: a NEAR tx no second operator reads passes only by its light-client proof (proveNearTx), which needs no
// second read on the same operator.
const RATE_TRIES = 5;
const RATE_CAP = 600;
const NOT_WAITED = "rate limited, not waited: its read could add no second operator";
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lastAsked = new Map();
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null; // not a URL (a test's stub name): no host to pace
  }
};

// JSON with every integer past 2^53 kept as its digits: a NEAR tx JSON carries u64s JavaScript numbers cannot hold (a
// Delegate's max_block_height of u64::MAX, read 2026-11-01), and its bytes are rebuilt from them (findTxBytes). Node 24's
// JSON.parse hands a reviver each value's source text.
export const exactJson = (text) => JSON.parse(text, (k, v, ctx) => (typeof v === "number" && !Number.isSafeInteger(v) && /^\d+$/.test(ctx?.source ?? "") ? ctx.source : v));

async function rpc(fetchFn, url, method, params, sleep = wait, rateWait = true) {
  let last;
  let rate = 0;
  for (let attempt = 0; attempt < 3; ) {
    const host = hostOf(url);
    if (host) {
      const gap = (lastAsked.get(host) ?? 0) + 1000 - Date.now();
      if (gap > 0) await sleep(gap);
      lastAsked.set(host, Date.now());
    }
    try {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = r.status === 429 ? null : typeof r.text === "function" ? exactJson(await r.text()) : await r.json();
      if (r.status === 429 || j.error?.code === -429 || j.error?.code === 429) {
        if (!rateWait) throw Object.assign(new Error(NOT_WAITED), { rate: true, notWaited: true });
        const after = Number(r.headers?.get?.("retry-after") ?? NaN);
        if (Number.isFinite(after) && after > RATE_CAP) throw Object.assign(new Error(`rate limited, Retry-After ${after} s is past the ${RATE_CAP} s cap`), { rate: true });
        if (++rate > RATE_TRIES) throw Object.assign(new Error(`rate limited ${rate} times in a row`), { rate: true });
        await sleep(Number.isFinite(after) && after >= 0 ? after * 1000 : 2000 * 2 ** (rate - 1));
        continue;
      }
      if (!r.ok && !j.error) throw new Error(`HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (e?.rate) throw e;
      last = e;
    }
    if (++attempt < 3) await sleep(2000 * attempt);
  }
  throw last;
}

// The one failed receipt a read passes: NEAR's gas refund to an account its own tx deleted. A tx that holds
// DeleteAccount (signer = receiver: a one-use account closing itself into its beneficiary) succeeds, then NEAR sends
// the unused gas back from "system" to the signer, which no longer exists, so that refund fails AccountDoesNotExist
// (mainnet Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM, read 2026-11-01: receipt GBkJTsykxG, system to the signer, one
// Transfer of 229993650000000000000 yocto, receipt signer_id the account, failed; the beneficiary's Transfer 9wEBNxb1a7,
// receipt signer_id system, succeeded). It needs EXPERIMENTAL_tx_status: only its `receipts` list names each receipt's
// predecessor_id, signer_id and actions. `r` is that answer, `o` one failed entry of its receipts_outcome; anything
// missing is not that refund.
export function isDeleteRefund(r, o) {
  const tx = r?.transaction;
  const a = tx?.signer_id;
  if (typeof a !== "string" || tx.receiver_id !== a || !Array.isArray(tx.actions)) return false;
  if (!tx.actions.some((x) => x !== null && typeof x === "object" && "DeleteAccount" in x)) return false;
  const same = Array.isArray(r.receipts) ? r.receipts.filter((x) => x?.receipt_id === o?.id) : [];
  if (typeof o?.id !== "string" || same.length !== 1) return false;
  const [rc] = same;
  if (rc.predecessor_id !== "system" || rc.receiver_id !== a) return false;
  // A gas refund carries the tx's signer; DeleteAccount's balance payout has the same shape but carries system, and
  // with beneficiary = the account itself it fails the same way while the balance burns (P10b).
  if (rc.receipt?.Action?.signer_id !== a) return false;
  const acts = rc.receipt?.Action?.actions;
  if (!Array.isArray(acts) || acts.length !== 1 || acts[0] === null || typeof acts[0] !== "object") return false;
  if (Object.keys(acts[0]).length !== 1 || !("Transfer" in acts[0])) return false;
  const kind = o.outcome?.status?.Failure?.ActionError?.kind;
  return kind !== null && typeof kind === "object" && kind.AccountDoesNotExist?.account_id === a;
}

// How many receipts of an EXPERIMENTAL_tx_status answer failed, the one delete refund above not counted (at most one
// is passed: a second counts as failed). A receipt whose status is not an object counts as failed. null: the answer
// has no receipts_outcome or no receipts list, so it cannot be read.
export function failedReceipts(r) {
  if (!Array.isArray(r?.receipts_outcome) || !Array.isArray(r.receipts)) return null;
  const failed = r.receipts_outcome.filter((o) => typeof o?.outcome?.status !== "object" || o.outcome.status === null || "Failure" in o.outcome.status);
  return failed.length - Math.min(1, failed.filter((o) => isDeleteRefund(r, o)).length);
}

const when = (ms, floor) => (ms >= floor ? "ok" : `old: ${new Date(ms).toISOString()} is before ${new Date(floor).toISOString()}`);

// One read of one tx on one RPC: "ok", "failed...", "old: ...", or why it could not be read. rateWait off: a 429 is
// NOT_WAITED at once. A NEAR read puts its EXPERIMENTAL_tx_status answer in out.result.
export async function readTx(fetchFn, url, { chain, hash, signer }, floor = FLOOR, sleep = wait, rateWait = true, out = {}) {
  let j;
  try {
    if (NEAR.has(chain)) {
      // NONE answers at once: the outcome when the tx is known, UNKNOWN_TRANSACTION when it is not. EXPERIMENTAL_tx_status,
      // not tx: its receipts list is what failedReceipts reads.
      j = await rpc(fetchFn, url, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" }, sleep, rateWait);
      if (j.error) return j.error.cause?.name === "UNKNOWN_TRANSACTION" ? "missing" : `error ${JSON.stringify(j.error).slice(0, 120)}`;
      const r = j.result;
      // only UNKNOWN_TRANSACTION above is "missing": a reply with no error and no status ({}, result null) is no answer
      if (!r?.status) return "no answer (a reply with no status)";
      if (r.status.Failure) return "failed";
      if (r.final_execution_status !== "FINAL") return `not final (${r.final_execution_status})`;
      if (!("SuccessValue" in r.status || "SuccessReceiptId" in r.status)) return `not final (${Object.keys(r.status)[0]})`;
      const failed = failedReceipts(r);
      if (failed === null) return "incomplete (no receipts or receipts_outcome list)";
      if (failed > 0) return "failed (a receipt failed)";
      const b = await rpc(fetchFn, url, "block", { block_id: r.transaction_outcome?.block_hash }, sleep, rateWait);
      const ns = b.result?.header?.timestamp_nanosec;
      if (!ns) return "no block time";
      out.result = r;
      return when(Number(BigInt(ns) / 1000000n), floor);
    }
    if (chain === "solana") {
      j = await rpc(fetchFn, url, "getTransaction", [hash, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }], sleep, rateWait);
      if (j.error) return `error ${JSON.stringify(j.error).slice(0, 120)}`;
      if (!j.result) return "missing";
      if (!j.result.meta) return "no meta";
      if (j.result.meta.err != null) return "failed";
      if (typeof j.result.blockTime !== "number") return "no block time";
      return when(j.result.blockTime * 1000, floor);
    }
    const id = await rpc(fetchFn, url, "eth_chainId", [], sleep, rateWait);
    if (id.result !== CHAIN_ID[chain]) return `wrong chain (${id.result ?? JSON.stringify(id.error)})`;
    j = await rpc(fetchFn, url, "eth_getTransactionReceipt", [hash], sleep, rateWait);
    if (j.error) return `error ${JSON.stringify(j.error).slice(0, 120)}`;
    if (!j.result) return "missing";
    if (j.result.status !== "0x1") return "failed";
    const b = await rpc(fetchFn, url, "eth_getBlockByNumber", [j.result.blockNumber, false], sleep, rateWait);
    if (!b.result?.timestamp) return "no block time";
    return when(Number(b.result.timestamp) * 1000, floor);
  } catch (e) {
    if (e?.notWaited) return NOT_WAITED;
    return `no answer (${String(e?.message ?? e).slice(0, 80)})`;
  }
}

// The operator of an RPC: NEAR's from near-rpc-operators.mjs, the other chains' from rpc-operators.mjs, each cited
// there. A URL neither map holds (a test's stub) is its own operator; every host in RPCS is in a map
// (near-rpc-operators.test.mjs).
export const operatorOf = (chain, url) =>
  (NEAR.has(chain) ? nearOperatorOf(url) : (RPC_OPERATORS[chain]?.[hostOf(url)?.toLowerCase()] ?? null)) ?? url;
/** The operators whose reads ([{ url, r }]) read the tx ok: two of them, never two hosts of one, prove a tx. */
export const okOperators = (chain, reads) => new Set(reads.filter((a) => a.r === "ok").map((a) => operatorOf(chain, a.url)));

// NEAR's light-client proof: a NEAR tx no second operator reads (dRPC keeps about 29 h on mainnet; no second keyless
// archival operator exists, near-rpc-operators.mjs) passes only when FastNEAR proves it against a block dRPC returns.
// FastNEAR answers EXPERIMENTAL_light_client_proof for the tx and for every receipt its outcomes create (each proven
// outcome names the receipts it created, so the proven set is the whole tree from the tx); each proof must reach the
// block_merkle_root of a final block dRPC names, dRPC's status must name the tx's network, and every proven outcome
// must be a success. FastNEAR can then forge nothing: an outcome it changes no longer hashes to that root.
// Every step follows nearcore 2.14.0 (commit bc4e9e8cfb03d9e82f027883055624e18576993e), cited by file:line:
//  - an outcome's leaf: ExecutionOutcomeWithId::to_hashes (core/primitives/src/transaction.rs:795-801) is
//    [id, hash_borsh(PartialExecutionOutcome), hash(log) for each log]; the leaf is hash_borsh of that Vec, since
//    ApplyChunkResult::compute_outcomes_proof merklizes to_hashes() (chain/chain/src/types.rs:151-159) and merklize
//    hashes each item with hash_borsh (core/primitives/src/merkle.rs:52). PartialExecutionOutcome is receipt_ids,
//    gas_burnt (u64), tokens_burnt (u128), executor_id, status (transaction.rs:622-628); its status is Unknown = 0,
//    Failure = 1 (no detail), SuccessValue(Vec<u8>) = 2, SuccessReceiptId(CryptoHash) = 3 (transaction.rs:646-651).
//  - a path: compute_root_from_path (merkle.rs:131-144): Left is combine_hash(item, acc), Right is combine_hash(acc,
//    item), and combine_hash(a, b) is hash_borsh((a, b)), sha256 of a then b (merkle.rs:42-44).
//  - outcome_proof.proof leads from the leaf to the chunk's outcome root; outcome_root_proof leads from
//    hash_borsh(that root) to the block's outcome_root: the block's root merklizes its chunks' prev_outcome_root
//    (chain/client/src/view_client_actor.rs:1187-1193).
//  - the block's hash from block_header_lite: combine_hash(combine_hash(hash(borsh(inner_lite)), inner_rest_hash),
//    prev_block_hash) (core/primitives/src/views.rs:2755-2767; core/primitives/src/block_header.rs:922-932), with
//    inner_lite height u64, epoch_id, next_epoch_id, prev_state_root, prev_outcome_root (the view's outcome_root),
//    timestamp u64 (the view's timestamp_nanosec), next_bp_hash, block_merkle_root (block_header.rs:30-47;
//    views.rs:1089-1101). A header with chunk_execution_root (a later header kind, views.rs:2756) is refused.
//  - block_proof leads from that block's hash, a raw leaf (PartialMerkleTree::insert, merkle.rs:198-208), to the
//    head's block_merkle_root: a block's root is the tree of every block before it (chain/chain/src/chain.rs:1034-1035;
//    the RPC builds the path, chain/jsonrpc/src/lib.rs:2530-2545, core/store/src/merkle_proof.rs:28-44).
// Borsh: integers little-endian, a Vec or String is a u32 length then its items, a CryptoHash 32 bytes.
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(s, max = 64) {
  if (typeof s !== "string" || !s.length || s.length > max) throw new Error(`not a base58 hash: ${String(s).slice(0, 70)}`);
  let n = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) throw new Error(`not a base58 hash: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}
const hash32 = (s) => {
  const b = base58(s);
  if (b.length !== 32) throw new Error(`${s} is not a 32-byte hash`);
  return b;
};
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const uint = (v, bytes) => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^\d{1,40}$/.test(s) || BigInt(s) >= 1n << BigInt(8 * bytes)) throw new Error(`not a u${8 * bytes}: ${v}`);
  const b = Buffer.alloc(bytes);
  for (let i = 0, x = BigInt(s); i < bytes; i++, x >>= 8n) b[i] = Number(x & 255n);
  return b;
};
const str = (s) => {
  if (typeof s !== "string") throw new Error("not a string");
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32(b.length), b]);
};
const one = (o, key) => o !== null && typeof o === "object" && Object.keys(o).length === 1 && Object.hasOwn(o, key);
function partialStatus(s) {
  if (s === "Unknown") return Buffer.from([0]);
  if (one(s, "Failure")) return Buffer.from([1]);
  // base64 read strictly: Node's decoder skips what it cannot read, so only a value that encodes back to itself is read
  if (one(s, "SuccessValue") && typeof s.SuccessValue === "string" && Buffer.from(s.SuccessValue, "base64").toString("base64") === s.SuccessValue) {
    const v = Buffer.from(s.SuccessValue, "base64");
    return Buffer.concat([Buffer.from([2]), u32(v.length), v]);
  }
  if (one(s, "SuccessReceiptId")) return Buffer.concat([Buffer.from([3]), hash32(s.SuccessReceiptId)]);
  throw new Error(`an outcome status this check does not read: ${JSON.stringify(s)?.slice(0, 80)}`);
}
/** The Merkle leaf of one outcome (transaction.rs:795-801, types.rs:151-159). */
export function outcomeLeaf(id, o) {
  if (!Array.isArray(o?.receipt_ids) || !Array.isArray(o.logs)) throw new Error("an outcome with no receipt_ids or logs list");
  const partial = Buffer.concat([u32(o.receipt_ids.length), ...o.receipt_ids.map(hash32), uint(o.gas_burnt, 8), uint(o.tokens_burnt, 16), str(o.executor_id), partialStatus(o.status)]);
  const hashes = [hash32(id), sha(partial), ...o.logs.map((l) => sha(str(l).subarray(4)))];
  return sha(u32(hashes.length), ...hashes);
}
/** compute_root_from_path (merkle.rs:131-144). */
export function rootOf(path, leaf) {
  if (!Array.isArray(path) || path.length > 64) throw new Error("a Merkle path that is not a list of at most 64 steps");
  let acc = leaf;
  for (const step of path) {
    const h = hash32(step?.hash);
    if (step.direction === "Left") acc = sha(h, acc);
    else if (step.direction === "Right") acc = sha(acc, h);
    else throw new Error(`a Merkle step with direction ${step?.direction}`);
  }
  return acc;
}
/** A block's hash from its block_header_lite (views.rs:2755-2767). */
export function liteHash(lite) {
  const i = lite?.inner_lite;
  if (!i) throw new Error("no block_header_lite");
  if (i.chunk_execution_root != null) throw new Error("a header with chunk_execution_root, which this check does not read");
  const inner = Buffer.concat([uint(i.height, 8), hash32(i.epoch_id), hash32(i.next_epoch_id), hash32(i.prev_state_root), hash32(i.outcome_root), uint(i.timestamp_nanosec, 8), hash32(i.next_bp_hash), hash32(i.block_merkle_root)]);
  return sha(sha(sha(inner), hash32(lite.inner_rest_hash)), hash32(lite.prev_block_hash));
}
/** The signer and receiver of a NEAR tx, from its borsh Transaction bytes (base64), which must hash to `id`. An outcome
 * proof binds an id, not its kind: FastNEAR answers a "transaction" proof request for a receipt id with that receipt's
 * proof (nearcore does not check the kind, chain/client/src/view_client_actor.rs:1158-1167; read live 2026-11-01). A
 * tx hash is sha256(borsh(Transaction)) (core/primitives/src/transaction.rs:144-146), which no receipt id has. V0 is
 * TransactionV0 (signer_id, public_key, nonce u64, receiver_id, ...; transaction.rs:36-50); V1 is a 1 then
 * TransactionV1 (signer_id, public_key, nonce as TransactionNonce: 0 then u64, or 1 then u64 and a u16, receiver_id,
 * ...; transaction.rs:66-71, :122-140, :268-276), told apart as nearcore reads them: a second byte of 0 is V0, a
 * first byte of 1 with a second byte not 0 is V1 (transaction.rs:281-318). A public key is its tag then 32 bytes
 * (ed25519, 0) or 64 (secp256k1, 1) (core/crypto/src/signature.rs:39-43, :398-416); another key type is refused. */
export function txBytesFacts(b64, id) {
  if (typeof b64 !== "string" || !b64 || Buffer.from(b64, "base64").toString("base64") !== b64) throw new Error(`${id}: no signed tx bytes for it, or bytes that are not base64`);
  const b = Buffer.from(b64, "base64");
  if (!sha(b).equals(hash32(id))) throw new Error(`${id}: its tx bytes do not hash to it`);
  const v1 = b[1] !== 0;
  if (v1 && b[0] !== 1) throw new Error(`${id}: tx bytes with version tag ${b[0]}`);
  let at = v1 ? 1 : 0;
  const take = (n) => {
    if (at + n > b.length) throw new Error(`${id}: its tx bytes end early`);
    at += n;
    return b.subarray(at - n, at);
  };
  const account = () => {
    const n = take(4).readUInt32LE(0);
    if (n < 2 || n > 64) throw new Error(`${id}: an account id of ${n} bytes in its tx bytes`);
    return take(n).toString("utf8");
  };
  const signer = account();
  const key = { 0: 32, 1: 64 }[take(1)[0]];
  if (!key) throw new Error(`${id}: a key type its tx bytes name that this check does not read`);
  take(key);
  if (!v1) take(8);
  else {
    const kind = take(1)[0];
    if (kind > 1) throw new Error(`${id}: a nonce kind ${kind} in its tx bytes`);
    take(kind ? 10 : 8);
  }
  return { signer, receiver: account(), version: v1 ? 1 : 0 };
}

// Card money-gate-tx-rebuild: a tx's signed bytes rebuilt from an operator's own tx JSON (the `transaction` field of
// EXPERIMENTAL_tx_status, a SignedTransactionView), so a tx one operator reads is provable from its id alone, with no
// bytes kept by the record's writer. The JSON proves itself: only bytes that hash to the id pass (txBytesFacts), so a
// host that changes any field gets no pass. Cited from nearcore 2.14.0 (bc4e9e8cfb03d9e82f027883055624e18576993e):
//  - the view (core/primitives/src/views.rs:1747-1762) is signer_id, public_key, nonce, receiver_id, actions,
//    priority_fee (deprecated, always 0: views.rs:1781), signature, hash, and nonce_index and nonce_mode only when they
//    are not V0's (views.rs:1758-1761, :1768-1776). It has no block_hash: findTxBytes tries the blocks before the tx's
//    own, and only the one that makes the bytes hash to the id is kept.
//  - V0 is signer_id, public_key, nonce u64, receiver_id, block_hash, actions (transaction.rs:36-50); V1 is a 1 then
//    signer_id, public_key, TransactionNonce (0 then nonce u64, or 1 then nonce u64 and nonce_index u16), receiver_id,
//    block_hash, actions, nonce_mode (Monotonic 0, Strict 1) (transaction.rs:56-60, :103-112, :114-123, :231-241). A view
//    with neither nonce_index nor nonce_mode is a V0 or a V1 with a plain nonce, Monotonic: both are tried. A view with
//    either (a gas-key tx) is refused: no recorded tx pins one.
//  - Action is a borsh tag then its payload (core/primitives/src/action/mod.rs:375-397, payloads mod.rs:46-75, :94-112,
//    :249-268, :301-315); the view of each (views.rs:1487-1569, built by views.rs:1571-1645). DeployContract's view
//    holds sha256 of the code, not the code (views.rs:1575-1577): the code is read back and kept only when it hashes so.
//  - AddKey is a PublicKey then an AccessKey: nonce u64 then its permission, FullAccess = 1 (mod.rs:39-44;
//    core/primitives-core/src/account.rs:801-809, :909-920; view: views.rs:165-211).
//  - Delegate is a SignedDelegateAction: sender_id, receiver_id, actions, nonce u64, max_block_height u64, public_key,
//    then a Signature (action/delegate.rs:34-41, :55-58; its view: views.rs:1520-1523, :1597-1600); its actions are
//    NonDelegateAction, an Action with Action's own serde and borsh (delegate.rs:370-371).
//  - a PublicKey is tag 0 then 32 bytes for ed25519, a Signature 0 then 64 bytes (core/crypto/src/signature.rs:39-43,
//    :398-404, :1129-1135). Balance is u128 (near-token), Gas u64.
// The kinds rebuilt are the ones a real recorded tx pins (money-gate.tx-rebuild.json): CreateAccount, DeployContract,
// FunctionCall, Transfer, AddKey with FullAccess, DeleteKey, DeleteAccount and Delegate (holding AddKey with FullAccess
// or FunctionCall), with ed25519 keys, in V0 and V1. Every other kind nearcore has (Stake, a FunctionCall or gas-key
// permission, DelegateV2, the global-contract kinds, DeterministicStateInit, UniversalStateInit, the gas-key transfers),
// any other field and a secp256k1 or ML-DSA key are refused, never guessed: such a tx passes on two operators' reads or
// by its tx-bytes file, as before.
const TX_FIELDS = ["signer_id", "public_key", "nonce", "receiver_id", "actions", "priority_fee", "signature", "hash", "nonce_index", "nonce_mode"];
const exact = (o, keys, what) => {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} is not an object`);
  const got = Object.keys(o).sort().join(",");
  if (got !== [...keys].sort().join(",")) throw new Error(`${what} has fields ${got}, not ${[...keys].sort().join(",")}`);
};
// ed25519 alone: no recorded tx pins a secp256k1 key or signature (tag 1), so one is refused
const ed25519 = (s, n, what) => {
  const m = typeof s === "string" ? /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(s) : null;
  if (!m) throw new Error(`${what} ${String(s).slice(0, 40)} that is not ed25519`);
  const b = base58(m[1], 100);
  if (b.length !== n) throw new Error(`an ed25519 ${what} that is not ${n} bytes`);
  return Buffer.concat([Buffer.from([0]), b]);
};
const pubKey = (s) => ed25519(s, 32, "a public key");
const accountId = (s) => {
  if (typeof s !== "string" || s.length < 2 || s.length > 64 || !ACCOUNT.test(s)) throw new Error(`${String(s).slice(0, 70)} is not an account id`);
  return str(s);
};
const b64 = (s, what) => {
  if (typeof s !== "string" || Buffer.from(s, "base64").toString("base64") !== s) throw new Error(`${what} is not base64`);
  return Buffer.from(s, "base64");
};
const bytesVec = (b) => Buffer.concat([u32(b.length), b]);
// one action of the view; `code(sha256)` gives a deployed contract's bytes by their hash, or null. Inside a Delegate an
// action has Action's own serde (delegate.rs:370-371), the view's shape for the two kinds pinned there.
const IN_DELEGATE = ["AddKey", "FunctionCall"];
function action(a, code, inDelegate = false) {
  if (inDelegate && !(a !== null && typeof a === "object" && Object.keys(a).length === 1 && IN_DELEGATE.includes(Object.keys(a)[0])))
    throw new Error(`an action inside a Delegate this check does not rebuild: ${JSON.stringify(a)?.slice(0, 60)}`);
  if (a === "CreateAccount") return Buffer.from([0]);
  if (a === null || typeof a !== "object" || Array.isArray(a) || Object.keys(a).length !== 1) throw new Error(`an action this check does not rebuild: ${JSON.stringify(a)?.slice(0, 60)}`);
  const [kind] = Object.keys(a);
  const v = a[kind];
  const w = `a ${kind} action`;
  switch (kind) {
    case "DeployContract": {
      exact(v, ["code"], w);
      const h = b64(v.code, `${w}'s code hash`);
      if (h.length !== 32) throw new Error(`${w}'s code hash is not 32 bytes`);
      const c = code(h);
      if (!Buffer.isBuffer(c) || !sha(c).equals(h)) throw new Error(`${w}: no code read back that hashes to ${h.toString("base64")}`);
      return Buffer.concat([Buffer.from([1]), bytesVec(c)]);
    }
    case "FunctionCall":
      exact(v, ["method_name", "args", "gas", "deposit"], w);
      return Buffer.concat([Buffer.from([2]), str(v.method_name), bytesVec(b64(v.args, `${w}'s args`)), uint(v.gas, 8), uint(v.deposit, 16)]);
    case "Transfer":
      exact(v, ["deposit"], w);
      return Buffer.concat([Buffer.from([3]), uint(v.deposit, 16)]);
    case "AddKey":
      exact(v, ["public_key", "access_key"], w);
      exact(v.access_key, ["nonce", "permission"], `${w}'s access_key`);
      if (v.access_key.permission !== "FullAccess") throw new Error(`${w} with a permission this check does not rebuild: ${JSON.stringify(v.access_key.permission)?.slice(0, 60)}`);
      return Buffer.concat([Buffer.from([5]), pubKey(v.public_key), uint(v.access_key.nonce, 8), Buffer.from([1])]);
    case "DeleteKey":
      exact(v, ["public_key"], w);
      return Buffer.concat([Buffer.from([6]), pubKey(v.public_key)]);
    case "DeleteAccount":
      exact(v, ["beneficiary_id"], w);
      return Buffer.concat([Buffer.from([7]), accountId(v.beneficiary_id)]);
    case "Delegate": {
      exact(v, ["delegate_action", "signature"], w);
      const d = v.delegate_action;
      exact(d, ["sender_id", "receiver_id", "actions", "nonce", "max_block_height", "public_key"], `${w}'s delegate_action`);
      if (!Array.isArray(d.actions)) throw new Error(`${w} with no actions list`);
      const inner = d.actions.map((x) => action(x, code, true));
      return Buffer.concat([Buffer.from([8]), accountId(d.sender_id), accountId(d.receiver_id), u32(inner.length), ...inner, uint(d.nonce, 8), uint(d.max_block_height, 8), pubKey(d.public_key), ed25519(v.signature, 64, "signature")]);
    }
  }
  throw new Error(`an action kind this check does not rebuild: ${kind}`);
}

/** The candidate borsh Transactions (base64) a SignedTransactionView `t` can be, with `blockHash` (base58) as its block
 * hash: V0, and V1 with a plain nonce in Monotonic mode, whose view is the same. Throws on a field, kind or key it does
 * not rebuild, nonce_index and nonce_mode among them. `code(sha256)` returns a deployed contract's bytes or null. */
export function rebuildTx(t, blockHash, code = () => null) {
  if (t === null || typeof t !== "object" || Array.isArray(t)) throw new Error("no tx JSON");
  const extra = Object.keys(t).filter((k) => !TX_FIELDS.includes(k));
  if (extra.length) throw new Error(`its tx JSON has a field this check does not rebuild: ${extra.join(", ")}`);
  for (const k of ["signer_id", "public_key", "nonce", "receiver_id", "actions", "signature", "hash"]) if (!Object.hasOwn(t, k)) throw new Error(`its tx JSON has no ${k}`);
  for (const k of ["nonce_index", "nonce_mode"]) if (Object.hasOwn(t, k)) throw new Error(`its tx JSON has ${k} (a gas-key nonce or nonce mode), which no recorded tx pins`);
  if (Object.hasOwn(t, "priority_fee") && t.priority_fee !== 0) throw new Error(`its tx JSON has priority_fee ${t.priority_fee}, not 0`);
  const head = Buffer.concat([accountId(t.signer_id), pubKey(t.public_key)]);
  if (!Array.isArray(t.actions)) throw new Error("its tx JSON has no actions list");
  const rest = Buffer.concat([accountId(t.receiver_id), hash32(blockHash), u32(t.actions.length), ...t.actions.map((a) => action(a, code))]);
  const nonce = uint(t.nonce, 8);
  // V1 with a plain nonce (TransactionNonce 0) and Monotonic mode (0); a gas-key nonce or Strict mode has no pin
  return [Buffer.concat([head, nonce, rest]), Buffer.concat([Buffer.from([1]), head, Buffer.from([0]), nonce, rest, Buffer.from([0])])].map((b) => b.toString("base64"));
}
const MAX_WALK = 64;
/** The signed bytes of NEAR tx `id`, rebuilt from the prover's EXPERIMENTAL_tx_status answer `known`: its block hash is
 * found among the blocks from the tx's own back MAX_WALK, read on `url` (a candidate is never trusted: only bytes that
 * hash to the id are kept); a DeployContract's code is read back on `url` at the block its receipt ran in and kept only
 * when it hashes to the view's code hash. Returns { bytes, back } (back: blocks walked back), or throws why not. */
export async function findTxBytes(fetchFn, url, id, known, sleep = wait, max = MAX_WALK) {
  const t = known?.transaction;
  if (t?.hash !== id) throw new Error(`its tx JSON names hash ${String(t?.hash).slice(0, 60)}, not ${id}`);
  const call = async (method, params) => {
    const j = await rpc(fetchFn, url, method, params, sleep);
    if (j?.error || !j?.result) throw new Error(`${hostOf(url) ?? url} ${method}: ${JSON.stringify(j?.error ?? "no result").slice(0, 120)}`);
    return j.result;
  };
  const codes = new Map();
  if (Array.isArray(t.actions) && t.actions.some((a) => a !== null && typeof a === "object" && Object.hasOwn(a, "DeployContract"))) {
    const first = known.transaction_outcome?.outcome?.receipt_ids?.[0];
    const ran = (Array.isArray(known.receipts_outcome) ? known.receipts_outcome : []).find((o) => o?.id === first);
    if (typeof ran?.block_hash !== "string") throw new Error("a DeployContract tx whose receipt names no block");
    const r = await call("query", { request_type: "view_code", account_id: t.receiver_id, block_id: ran.block_hash });
    const c = b64(r.code_base64, "the code read back");
    codes.set(sha(c).toString("hex"), c);
  }
  const code = (h) => codes.get(h.toString("hex")) ?? null;
  rebuildTx(t, "11111111111111111111111111111111", code); // a field, kind or key it does not rebuild is refused before any walk
  let hash = known.transaction_outcome?.block_hash;
  for (let back = 0; back <= max; back++) {
    if (typeof hash !== "string") throw new Error(`no block ${back} back from its own`);
    for (const bytes of rebuildTx(t, hash, code)) if (sha(Buffer.from(bytes, "base64")).equals(hash32(id))) return { bytes, back };
    if (back < max) hash = (await call("block", { block_id: hash })).header?.prev_hash;
  }
  throw new Error(`no block from its own back ${max} makes its tx JSON hash to it`);
}

/** One EXPERIMENTAL_light_client_proof answer for `id`, checked against the head's block_merkle_root (32 bytes).
 * Returns the proven outcome and its block's height and time (ms); throws why it does not prove. */
export function checkProof(p, id, headRoot) {
  const op = p?.outcome_proof;
  if (op?.id !== id) throw new Error(`a proof for ${String(op?.id).slice(0, 60)}, not ${id}`);
  const chunkRoot = rootOf(op.proof, outcomeLeaf(op.id, op.outcome));
  const outcomeRoot = rootOf(p.outcome_root_proof, sha(chunkRoot));
  const lite = p.block_header_lite;
  if (!outcomeRoot.equals(hash32(lite?.inner_lite?.outcome_root))) throw new Error(`${id}: its outcome does not reach its block's outcome_root`);
  const block = liteHash(lite);
  if (!block.equals(hash32(op.block_hash))) throw new Error(`${id}: its block header does not hash to ${op.block_hash}`);
  if (!rootOf(p.block_proof, block).equals(headRoot)) throw new Error(`${id}: its block does not reach the head's block_merkle_root`);
  return { outcome: op.outcome, height: lite.inner_lite.height, time: Number(BigInt(lite.inner_lite.timestamp_nanosec) / 1000000n) };
}
const MAX_OUTCOMES = 200;
/** Proves a NEAR tx on `prover` (FastNEAR) against a final block of `head` (dRPC). `known`: the prover's
 * EXPERIMENTAL_tx_status answer, which names each receipt's receiver (the proof request needs it; the proof binds the
 * id). Returns { height, time, outcomes, head } or throws why it is not proven. */
export async function proveNearTx(fetchFn, tx, prover, head, known, sleep = wait, max = MAX_OUTCOMES) {
  const network = tx.chain === "near" ? "mainnet" : "testnet";
  const call = async (url, method, params) => {
    let j;
    try {
      j = await rpc(fetchFn, url, method, params, sleep);
    } catch (e) {
      throw new Error(`${hostOf(url) ?? url} ${method}: no answer (${String(e?.message ?? e).slice(0, 80)})`);
    }
    if (j?.error || !j?.result) throw new Error(`${hostOf(url) ?? url} ${method}: ${JSON.stringify(j?.error ?? "no result").slice(0, 120)}`);
    return j.result;
  };
  const st = await call(head, "status", []);
  if (st.chain_id !== network) throw new Error(`${hostOf(head) ?? head} status names ${String(st.chain_id).slice(0, 40)}, not ${network}`);
  const fin = await call(head, "block", { finality: "final" });
  const headHash = fin.header?.hash;
  const hb = await call(head, "block", { block_id: headHash });
  if (typeof headHash !== "string" || hb.header?.hash !== headHash) throw new Error(`${hostOf(head) ?? head} does not answer its final block ${String(headHash).slice(0, 60)} by hash`);
  const headRoot = hash32(hb.header.block_merkle_root);
  const receiver = new Map((Array.isArray(known?.receipts_outcome) ? known.receipts_outcome : []).map((o) => [o?.id, o?.outcome?.executor_id]));
  const todo = [{ id: tx.hash, params: { type: "transaction", transaction_hash: tx.hash, sender_id: tx.signer } }];
  const proven = new Map();
  let first;
  while (todo.length) {
    const { id, params } = todo.shift();
    if (proven.has(id)) continue;
    if (proven.size >= max) throw new Error(`more than ${max} outcomes`);
    // an error answer is asked again, twice, 2 s apart (one such answer was seen live, 2026-11-01): a retry
    // only asks again, every answer is still checked
    let answer;
    for (let i = 0; ; i++)
      try {
        answer = await call(prover, "EXPERIMENTAL_light_client_proof", { ...params, light_client_head: headHash });
        break;
      } catch (e) {
        if (i >= 2) throw e;
        await sleep(2000);
      }
    const p = checkProof(answer, id, headRoot);
    const s = p.outcome.status;
    if (!(one(s, "SuccessValue") || one(s, "SuccessReceiptId")))
      throw new Error(`${id}: its proven outcome is ${typeof s === "string" ? s : Object.keys(s ?? {})[0]}, not a success`);
    if (!first) {
      if (p.outcome.executor_id !== tx.signer) throw new Error(`${id}: its proven signer is ${p.outcome.executor_id}, not ${tx.signer}`);
      first = p;
    }
    proven.set(id, p);
    for (const r of p.outcome.receipt_ids) {
      if (proven.has(r)) continue;
      const to = receiver.get(r);
      if (typeof to !== "string") throw new Error(`${r}: a receipt of ${id} that ${hostOf(prover) ?? prover} names no receiver for`);
      todo.push({ id: r, params: { type: "receipt", receipt_id: r, receiver_id: to } });
    }
  }
  return { height: first.height, time: first.time, outcomes: proven.size, head: `${hb.header.height} ${headHash}` };
}

/** A NEAR tx one operator read ok (answers: [{ url, r, result }] in list's order), proven by its signed tx bytes and
 * FastNEAR's light-client proof against dRPC's final block, or it throws why not. The bytes are tx.bytes (base64 borsh
 * Transaction, from the record's tx-bytes file) when the record has them, else rebuilt from FastNEAR's own tx JSON
 * (findTxBytes); either way they must hash to the id. Returns the PROVEN ON line. The live check and the deploy script
 * use it as the gate does. */
export async function proveRead(fetchFn, tx, answers, list, floor = FLOOR, sleep = wait) {
  const prover = answers.find((a) => a.r === "ok" && operatorOf(tx.chain, a.url) === "fastnear" && a.result);
  const head = list.find((u) => operatorOf(tx.chain, u) === "drpc");
  if (!prover || !head) throw new Error("no FastNEAR read ok, or no dRPC host, to prove it on");
  let bytes = tx.bytes;
  let from = `its tx-bytes file (${LIVE}<card>${BYTES})`;
  if (!bytes) {
    const r = await findTxBytes(fetchFn, prover.url, tx.hash, prover.result, sleep);
    bytes = r.bytes;
    from = `rebuilt from ${hostOf(prover.url)}'s tx JSON, block hash ${r.back} block(s) back`;
  }
  const facts = txBytesFacts(bytes, tx.hash);
  if (facts.signer !== tx.signer) throw new Error(`its tx bytes name signer ${facts.signer}, not ${tx.signer}`);
  const p = await proveNearTx(fetchFn, tx, prover.url, head, prover.result, sleep);
  const old = when(p.time, floor);
  if (old !== "ok") throw new Error(`proven, but ${old}`);
  // the block named is the one whose outcome root holds the tx's outcome: the next block with a chunk on its shard
  // after the one that ran it (view_client_actor.rs:1171-1186)
  return `PROVEN ON ${hostOf(head)}: ${tx.chain} ${tx.hash} (V${facts.version}, ${facts.signer} to ${facts.receiver}): ${p.outcomes} outcome(s) proven by ${hostOf(prover.url)}'s light-client proof against final block ${p.head}; confirmed in block ${p.height}, ${new Date(p.time).toISOString()}; tx bytes ${from}`;
}

// records: the records to read back; every: all records in the repo (for the twice-listed check); money: what
// moneyCode() found in the change; sleep: how a wait is waited (a test records it)
export async function moneyGate(records, fetchFn = fetch, rpcs = RPCS, { every = records, floor = FLOOR, money, sleep = wait } = {}) {
  const refusals = [];
  const read = [];
  const notes = []; // a host's 429 not waited because two operators read it ok
  const proven = []; // a NEAR tx read ok on one operator and proven by its light-client proof on the other
  for (const f of money?.merged ?? []) refusals.push(`${f} changes money code in a merge commit, outside any card's commit`);
  const byCard = new Map();
  for (const c of money?.commits ?? []) {
    if (!c.key) refusals.push(`commit ${c.sha.slice(0, 12)} changes money code (${c.files.join(", ")}) and names no card`);
    else byCard.set(c.key, [...new Set([...(byCard.get(c.key) ?? []), ...c.files])]);
  }
  for (const [key, files] of byCard) {
    const path = `${LIVE}${key}.md`;
    const what = `card ${key} changes money code (${files.join(", ")})`;
    const rec = records.find((r) => r.path === path);
    if (!rec || rec.notFile) continue; // no record in this change merges, a symlink is refused below
    const live = parseLive(rec.text, key);
    if (!live || !live.verdict) refusals.push(`${path} holds no live record, and ${what}`);
    else if (live.verdict !== "PASS") refusals.push(`${path}: the last live verdict is ${live.verdict}, and ${what}`);
    else if (live.moneyPath === false) refusals.push(`${path}: "Money path: no", but ${what}`);
  }
  const seen = new Map();
  for (const { path, key, text } of every) {
    const live = parseLive(text, key);
    for (const t of live?.txs ?? []) {
      const id = `${t.chain} ${t.hash}`;
      seen.set(id, [...(seen.get(id) ?? []), path]);
    }
  }
  for (const { path, key, text, notFile, bytes: bytesOf, bytesProblem } of records) {
    if (bytesProblem) refusals.push(`${path.replace(/\.md$/, BYTES)}: ${bytesProblem}`);
    if (notFile) {
      refusals.push(`${path}: ${notFile}, not a regular file`);
      continue;
    }
    const live = parseLive(text, key);
    if (!live) continue;
    for (const p of live.problems) refusals.push(`${path}: ${p}`);
    if (!live.moneyPath) continue;
    for (const tx of live.txs) {
      const where = seen.get(`${tx.chain} ${tx.hash}`) ?? [];
      if (where.length > 1) refusals.push(`${path}: ${tx.chain} ${tx.hash} is listed ${where.length} times (${where.join(", ")})`);
      const answers = [];
      // in the listed order; a 429 is waited out only while the host could add a second operator
      const okOps = () => okOperators(tx.chain, answers);
      for (const url of rpcs[tx.chain]) {
        const rateWait = okOps().size < 2 && !okOps().has(operatorOf(tx.chain, url));
        const out = {};
        const r = await readTx(fetchFn, url, tx, floor, sleep, rateWait, out);
        answers.push({ url, r, result: out.result });
      }
      const ok = answers.filter((a) => a.r === "ok");
      const decisive = answers.filter((a) => /^(failed|old)/.test(a.r));
      const note = TESTNET.has(tx.chain) ? " (testnet, not real-money proof)" : "";
      for (const a of ok) read.push(`${tx.chain} ${tx.hash} ok on ${a.url}${note}`);
      for (const a of answers) if (a.r === NOT_WAITED) notes.push(`${tx.chain} ${tx.hash} on ${a.url}: ${NOT_WAITED}`);
      let why = "";
      if (!decisive.length && okOps().size === 1 && NEAR.has(tx.chain))
        try {
          proven.push(`${await proveRead(fetchFn, { ...tx, bytes: bytesOf?.[tx.hash] }, answers, rpcs[tx.chain], floor, sleep)}${note}`);
          continue;
        } catch (e) {
          why = `; not proven: ${String(e?.message ?? e).slice(0, 300)}`;
        }
      if (decisive.length || okOps().size < 2)
        refusals.push(`${path}: ${tx.chain} ${tx.hash}: ${answers.map((a) => `${a.r} on ${a.url}`).join(", ")}${why}`);
    }
  }
  return { refusals, read, notes, proven };
}

// a record is read only when it is a regular file: a symlink (to a file anywhere) or anything else is refused, never
// followed, so it adds no Tx to the twice-listed check either
// A record's tx-bytes file (<key>.tx-bytes.json beside it): { "<NEAR tx hash>": "<base64 borsh Transaction>" }, the
// signed bytes the run's own script made. Optional; when present it must be a regular file holding that object.
function load(cwd, path) {
  const key = path.slice(LIVE.length, -".md".length);
  const st = lstatSync(`${cwd}/${path}`, { throwIfNoEntry: false });
  if (!st?.isFile()) return { path, key, text: "", notFile: !st ? "missing" : st.isSymbolicLink() ? "a symlink" : "not a file" };
  const rec = { path, key, text: readFileSync(`${cwd}/${path}`, "utf8") };
  const side = `${cwd}/${path.replace(/\.md$/, BYTES)}`;
  const bst = lstatSync(side, { throwIfNoEntry: false });
  if (!bst) return rec;
  if (!bst.isFile()) return { ...rec, bytesProblem: `${bst.isSymbolicLink() ? "a symlink" : "not a file"}, not a regular file` };
  try {
    const b = JSON.parse(readFileSync(side, "utf8"));
    if (b === null || typeof b !== "object" || Array.isArray(b) || Object.values(b).some((v) => typeof v !== "string")) throw new Error("not an object of strings");
    return { ...rec, bytes: b };
  } catch (e) {
    return { ...rec, bytesProblem: `not a tx-bytes object (${String(e?.message ?? e).slice(0, 80)})` };
  }
}
export const BYTES = ".tx-bytes.json";

// the folder's README says how a check works; it is not a record
const isRecord = (p) => p.endsWith(".md") && p !== `${LIVE}README.md`;

// the money code a change touches, by the commit that touches it: { commits: [{ sha, key, files }], merged: [file] }.
// A merge commit is skipped (its diff is the other side's commits); a money file in the change that no single-parent
// commit touches came in through a merge commit.
export function moneyCode(cwd, base, head) {
  const git = (a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const isMoney = (f) => MONEY.some((d) => f.startsWith(d));
  const lines = (s) => s.split("\n").filter(Boolean);
  const commits = [];
  const touched = new Set();
  for (const sha of lines(git(["rev-list", "--reverse", `${base}..${head}`]))) {
    const parents = git(["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
    if (parents.length > 1) continue;
    const from = parents[0] ?? git(["hash-object", "-t", "tree", "/dev/null"]);
    const files = lines(git(["diff", "--name-only", "--no-renames", from, sha])).filter(isMoney);
    if (!files.length) continue;
    for (const f of files) touched.add(f);
    const key = /^Card ([a-z0-9][a-z0-9-]*): \S/.exec(git(["log", "-1", "--format=%s", sha]))?.[1] ?? null;
    commits.push({ sha, key, files });
  }
  const merged = lines(git(["diff", "--name-only", "--no-renames", `${base}...${head}`])).filter((f) => isMoney(f) && !touched.has(f));
  return { commits, merged };
}

export function recordsFrom(cwd, args) {
  const dir = `${cwd}/${LIVE}`;
  const all = existsSync(dir) ? readdirSync(dir).map((f) => `${LIVE}${f}`).filter(isRecord) : [];
  let paths = all;
  let money;
  if (args[0] !== "--all") {
    const [base, head] = args;
    // every change but a deletion: added, modified, a type change (a record turned into a symlink) and the rest
    paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "--diff-filter=d", `${base}...${head}`, "--", `${LIVE}*.md`], { cwd, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter(isRecord);
    money = moneyCode(cwd, base, head);
  }
  return { records: paths.map((p) => load(cwd, p)), every: all.map((p) => load(cwd, p)), money };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args[0] === "--all" || args.length === 2)) {
    console.error("usage: money-gate.mjs <base sha> <head sha> | --all");
    process.exit(2);
  }
  const { records, every, money } = recordsFrom(process.cwd(), args);
  const { refusals, read, notes, proven } = await moneyGate(records, fetch, RPCS, { every, money });
  for (const r of read) console.log(`money-gate: ${r}`);
  for (const n of notes) console.log(`money-gate: ${n}`);
  for (const p of proven) console.log(`money-gate: ${p}`);
  if (refusals.length) {
    for (const r of refusals) console.error(`money-gate: REFUSED: ${r}`);
    process.exit(1);
  }
  console.log(`money-gate: PASS (${records.length} record(s) read, ${read.length} tx read(s))`);
}
