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
// when two of them read it as succeeded, on or after 2026-11-01T00:00:00Z, and none reads it as failed or older.
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
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Public RPCs, none ours; each answered a tx read on 2026-10-26 between 11:48 and 11:54Z. NEAR lists three:
// near.org's archival RPC says it is deprecated and rate-limits, and near.drpc.org keeps only recent txs (enough for a
// fresh live record).
export const RPCS = {
  near: ["https://archival-rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org"],
  solana: ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"],
  base: ["https://mainnet.base.org", "https://base.drpc.org"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
  // NEAR testnet, read 2026-10-31 at 16:16Z: three providers, as for mainnet. test.rpc.fastnear.com and
  // near-testnet.drpc.org keep only recent txs (each answered UNKNOWN_TRANSACTION for a 2026-10-26 tx that both
  // archival RPCs read), so the archival ones keep a record readable after a few days; FastNEAR's archival RPC stands
  // in for its test.rpc (one provider, never two answers).
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

// A rate limit is waited out, never read as an answer: near.org's archival RPC, one of the two that keep a NEAR tx
// older than drpc's window, answers HTTP 429 (or code -429) with a Retry-After of 43 s to 600 s (read 2026-10-31).
// A 429 waits its Retry-After seconds, or 2 s doubling when it gives none (or a date), and asks again, up to
// RATE_TRIES waits in a row; a Retry-After past RATE_CAP seconds is no answer at once. Other trouble (no reply, a
// reply that is not JSON, an HTTP error with no RPC error) is asked 3 times, 2 s and 4 s apart. Each host is asked
// at most once a second.
// Once two hosts have read a tx ok, a remaining host is still asked once, but with rateWait off: its 429 is no answer at
// once (NOT_WAITED), never waited and never decisive. A failed or old answer from it still refuses.
const RATE_TRIES = 5;
const RATE_CAP = 600;
const NOT_WAITED = "rate limited, not waited: two hosts read it ok";
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lastAsked = new Map();
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null; // not a URL (a test's stub name): no host to pace
  }
};

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
      const j = r.status === 429 ? null : await r.json();
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
// Transfer of 229993650000000000000 yocto, failed; the beneficiary's Transfer 9wEBNxb1a7 succeeded). It needs
// EXPERIMENTAL_tx_status: only its `receipts` list names each receipt's predecessor_id and actions. `r` is that answer,
// `o` one failed entry of its receipts_outcome; anything missing is not that refund.
export function isDeleteRefund(r, o) {
  const tx = r?.transaction;
  const a = tx?.signer_id;
  if (typeof a !== "string" || tx.receiver_id !== a || !Array.isArray(tx.actions)) return false;
  if (!tx.actions.some((x) => x !== null && typeof x === "object" && "DeleteAccount" in x)) return false;
  const same = Array.isArray(r.receipts) ? r.receipts.filter((x) => x?.receipt_id === o?.id) : [];
  if (typeof o?.id !== "string" || same.length !== 1) return false;
  const [rc] = same;
  if (rc.predecessor_id !== "system" || rc.receiver_id !== a) return false;
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
// NOT_WAITED at once.
export async function readTx(fetchFn, url, { chain, hash, signer }, floor = FLOOR, sleep = wait, rateWait = true) {
  let j;
  try {
    if (NEAR.has(chain)) {
      // NONE answers at once: the outcome when the tx is known, UNKNOWN_TRANSACTION when it is not. EXPERIMENTAL_tx_status,
      // not tx: its receipts list is what failedReceipts reads.
      j = await rpc(fetchFn, url, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" }, sleep, rateWait);
      if (j.error) return j.error.cause?.name === "UNKNOWN_TRANSACTION" ? "missing" : `error ${JSON.stringify(j.error).slice(0, 120)}`;
      const r = j.result;
      if (!r?.status) return "missing";
      if (r.status.Failure) return "failed";
      if (r.final_execution_status !== "FINAL") return `not final (${r.final_execution_status})`;
      if (!("SuccessValue" in r.status || "SuccessReceiptId" in r.status)) return `not final (${Object.keys(r.status)[0]})`;
      const failed = failedReceipts(r);
      if (failed === null) return "incomplete (no receipts or receipts_outcome list)";
      if (failed > 0) return "failed (a receipt failed)";
      const b = await rpc(fetchFn, url, "block", { block_id: r.transaction_outcome?.block_hash }, sleep, rateWait);
      const ns = b.result?.header?.timestamp_nanosec;
      if (!ns) return "no block time";
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

// records: the records to read back; every: all records in the repo (for the twice-listed check); money: what
// moneyCode() found in the change; sleep: how a wait is waited (a test records it)
export async function moneyGate(records, fetchFn = fetch, rpcs = RPCS, { every = records, floor = FLOOR, money, sleep = wait } = {}) {
  const refusals = [];
  const read = [];
  const notes = []; // a host's 429 not waited because two hosts had read the tx ok
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
  for (const { path, key, text, notFile } of records) {
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
      // in the listed order; a 429 is waited out only while fewer than two hosts have read the tx ok
      for (const url of rpcs[tx.chain]) {
        const rateWait = answers.filter((a) => a.r === "ok").length < 2;
        answers.push({ url, r: await readTx(fetchFn, url, tx, floor, sleep, rateWait) });
      }
      const ok = answers.filter((a) => a.r === "ok");
      const decisive = answers.filter((a) => /^(failed|old)/.test(a.r));
      const note = TESTNET.has(tx.chain) ? " (testnet, not real-money proof)" : "";
      for (const a of ok) read.push(`${tx.chain} ${tx.hash} ok on ${a.url}${note}`);
      for (const a of answers) if (a.r === NOT_WAITED) notes.push(`${tx.chain} ${tx.hash} on ${a.url}: ${NOT_WAITED}`);
      if (decisive.length || ok.length < 2)
        refusals.push(`${path}: ${tx.chain} ${tx.hash}: ${answers.map((a) => `${a.r} on ${a.url}`).join(", ")}`);
    }
  }
  return { refusals, read, notes };
}

// a record is read only when it is a regular file: a symlink (to a file anywhere) or anything else is refused, never
// followed, so it adds no Tx to the twice-listed check either
function load(cwd, path) {
  const key = path.slice(LIVE.length, -".md".length);
  const st = lstatSync(`${cwd}/${path}`, { throwIfNoEntry: false });
  if (!st?.isFile()) return { path, key, text: "", notFile: !st ? "missing" : st.isSymbolicLink() ? "a symlink" : "not a file" };
  return { path, key, text: readFileSync(`${cwd}/${path}`, "utf8") };
}

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
  const { refusals, read, notes } = await moneyGate(records, fetch, RPCS, { every, money });
  for (const r of read) console.log(`money-gate: ${r}`);
  for (const n of notes) console.log(`money-gate: ${n}`);
  if (refusals.length) {
    for (const r of refusals) console.error(`money-gate: REFUSED: ${r}`);
    process.exit(1);
  }
  console.log(`money-gate: PASS (${records.length} record(s) read, ${read.length} tx read(s))`);
}
