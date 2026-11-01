// The money gate with a stubbed network: the record rules and each chain's read. Run: node --test scripts/ci/
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58, checkProof, exactJson, findTxBytes, liteHash, moneyGate, proveNearTx, rebuildTx, txBytesFacts, outcomeLeaf, parseLive, readTx, recordsFrom, RPCS as REAL_RPCS } from "./money-gate.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPCS = { near: ["n1", "n2"], "near-testnet": ["t1", "t2"], solana: ["s1", "s2"], base: ["b1", "b2"], robinhood: ["r1", "r2"] };
const BASE_TX = "0x" + "ab".repeat(32);
const NEAR_TX = "Bv7hjXuDcC9WePLNbq3qntubUKqDR8x8dvgJSSH7mk8o";
const SOL_TX = "2z6qyzLaN9dV3SUaNyCGXm4zPQTQ61vuJJnTvbn3vzPkZNwQ8KJhCEETJeN7vtM9y5BeuGDxCDwrkfAHKUc6rZDw";

// answers: (url, method) -> result object
function stub(answer) {
  return async (url, init) => {
    const { method } = JSON.parse(init.body);
    const result = answer(url, method);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, ...result }) };
  };
}
const NOV2 = Date.parse("2026-11-02T00:00:00Z") / 1000; // seconds
const OCT1 = Date.parse("2026-10-01T00:00:00Z") / 1000;
const chainAnswers = (t) => (url, method) => {
  if (method === "eth_chainId") return { result: url.startsWith("b") ? "0x2105" : "0x1237" };
  if (method === "eth_getTransactionReceipt") return { result: { status: "0x1", blockNumber: "0x10" } };
  if (method === "eth_getBlockByNumber") return { result: { timestamp: "0x" + t.toString(16) } };
  if (method === "getTransaction") return { result: { meta: { err: null }, blockTime: t } };
  if (method === "EXPERIMENTAL_tx_status")
    return { result: { final_execution_status: "FINAL", status: { SuccessValue: "" }, receipts: [], receipts_outcome: [], transaction_outcome: { block_hash: "h" } } };
  if (method === "block") return { result: { header: { timestamp_nanosec: String(BigInt(t) * 1000000000n) } } };
};
const good = stub(chainAnswers(NOV2));
const rec = (body) => [{ path: "scripts/live-checks/demo.md", key: "demo", text: `CARD demo / live: PASS\n${body}` }];

test("every chain read as succeeded on two RPCs passes", async () => {
  const r = await moneyGate(
    rec(`Money path: yes\nTx: base ${BASE_TX}\nTx: robinhood ${BASE_TX}\nTx: solana ${SOL_TX}\nTx: near ${NEAR_TX} intents.near\n`),
    good,
    RPCS,
  );
  assert.deepEqual(r.refusals, []);
  assert.equal(r.read.length, 8);
});

test("a money-path record with no Tx is refused", async () => {
  const r = await moneyGate(rec("Money path: yes\n"), good, RPCS);
  assert.match(r.refusals.join("\n"), /lists no Tx/);
});

test("a live record with no Money path line is refused", async () => {
  const r = await moneyGate(rec(`Tx: base ${BASE_TX}\n`), good, RPCS);
  assert.match(r.refusals.join("\n"), /no "Money path: yes\|no" line/);
});

test("a tx no RPC knows is refused", async () => {
  const none = stub((url, method) => (method === "eth_chainId" ? { result: "0x2105" } : { result: null }));
  const r = await moneyGate(rec(`Money path: yes\nTx: base ${BASE_TX}\n`), none, RPCS);
  assert.match(r.refusals.join("\n"), /missing on b1, missing on b2/);
});

test("a tx one RPC reads as failed is refused", async () => {
  const half = stub((url, method) => {
    if (method === "getTransaction") return { result: { meta: { err: url === "s2" ? { InstructionError: [0, "x"] } : null }, blockTime: NOV2 } };
  });
  const r = await moneyGate(rec(`Money path: yes\nTx: solana ${SOL_TX}\n`), half, RPCS);
  assert.match(r.refusals.join("\n"), /ok on s1, failed on s2/);
});

test("a NEAR tx with a failed receipt is refused, and a NEAR tx needs its signer", async () => {
  const receipt = stub((url, method) =>
    method === "EXPERIMENTAL_tx_status"
      ? { result: { final_execution_status: "FINAL", status: { SuccessValue: "" }, receipts: [], receipts_outcome: [{ outcome: { status: { Failure: {} } } }] } }
      : chainAnswers(NOV2)(url, method),
  );
  const r = await moneyGate(rec(`Money path: yes\nTx: near ${NEAR_TX} intents.near\n`), receipt, RPCS);
  assert.match(r.refusals.join("\n"), /failed \(a receipt failed\)/);
  assert.match(parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: near ${NEAR_TX}\n`, "demo").problems.join(), /needs its signer/);
});

test("an EVM RPC on the wrong chain is refused", async () => {
  const wrong = stub((url, method) => (method === "eth_chainId" ? { result: "0x1" } : { result: { status: "0x1" } }));
  const r = await moneyGate(rec(`Money path: yes\nTx: base ${BASE_TX}\n`), wrong, RPCS);
  assert.match(r.refusals.join("\n"), /wrong chain \(0x1\)/);
});

test("a record that is not a money path reads nothing", async () => {
  const r = await moneyGate(rec("Money path: no\n"), good, RPCS);
  assert.deepEqual(r, { refusals: [], read: [], notes: [], proven: [] });
});

test("a tx from before the build is refused on every chain", async () => {
  const old = stub(chainAnswers(OCT1));
  const r = await moneyGate(
    rec(`Money path: yes\nTx: base ${BASE_TX}\nTx: solana ${SOL_TX}\nTx: near ${NEAR_TX} intents.near\n`),
    old,
    RPCS,
  );
  assert.equal(r.refusals.length, 3, r.refusals.join("\n"));
  for (const x of r.refusals) assert.match(x, /old: 2026-10-01/);
});

test("a tx listed in two records is refused", async () => {
  const a = rec(`Money path: yes\nTx: base ${BASE_TX}\n`);
  const b = [{ path: "scripts/live-checks/other.md", key: "other", text: `CARD other / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n` }];
  const r = await moneyGate(a, good, RPCS, { every: [...a, ...b] });
  assert.match(r.refusals.join("\n"), /listed 2 times/);
});

test("a record that does not parse as its own card's live record is refused", async () => {
  const wrongKey = [{ path: "scripts/live-checks/demo.md", key: "demo", text: `CARD other / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n` }];
  assert.match((await moneyGate(wrongKey, good, RPCS)).refusals.join("\n"), /names card other, not demo/);
  const typo = [{ path: "scripts/live-checks/demo.md", key: "demo", text: `CARD demo / Live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n` }];
  const out = (await moneyGate(typo, good, RPCS)).refusals.join("\n");
  assert.match(out, /does not read "CARD demo/);
  assert.match(out, /outside a live record/);
});

test("a Solana answer with no meta is not a pass", async () => {
  const nometa = stub(() => ({ result: { meta: null, blockTime: NOV2 } }));
  assert.match((await moneyGate(rec(`Money path: yes\nTx: solana ${SOL_TX}\n`), nometa, RPCS)).refusals.join("\n"), /no meta on s1, no meta on s2/);
});

test("a record renamed in the PR, with a made-up Tx added, is read and refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "money-gate-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
    const body = "CARD new-card / live: PASS\nMoney path: yes\n" + "Checked by the live check, every line read back.\n".repeat(8);
    writeFileSync(join(dir, "scripts/live-checks/old-card.md"), body);
    git("add", "scripts/live-checks/old-card.md");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    unlinkSync(join(dir, "scripts/live-checks/old-card.md"));
    writeFileSync(join(dir, "scripts/live-checks/new-card.md"), body + `Tx: base 0x${"01".repeat(32)}\n`);
    git("add", "-A", "scripts/live-checks");
    git("commit", "-q", "-m", "rename");
    const head = git("rev-parse", "HEAD");
    const { records, every } = recordsFrom(dir, [base, head]);
    assert.deepEqual(records.map((r) => r.path), ["scripts/live-checks/new-card.md"]);
    const missing = stub((url, method) => (method === "eth_chainId" ? { result: "0x2105" } : { result: null }));
    const r = await moneyGate(records, missing, RPCS, { every });
    assert.match(r.refusals.join("\n"), /scripts\/live-checks\/new-card\.md: base 0x0101.*missing on b1, missing on b2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Tx or Money path line in any other shape is refused, a bulleted one included", async () => {
  const tx = (await moneyGate(rec(`Money path: no\n- Tx: base ${BASE_TX}\n`), good, RPCS)).refusals.join("\n");
  assert.match(tx, /bad Tx line: - Tx: base/);
  const mp = (await moneyGate(rec(`Money path: no\n* Money path: yes\n`), good, RPCS)).refusals.join("\n");
  assert.match(mp, /bad Money path line: \* Money path: yes/);
  const outside = parseLive(`CARD demo / merge: PASS\n- Tx: base ${BASE_TX}\n`, "demo");
  assert.match(outside.problems.join("\n"), /outside a live record/);
});

test("prose that says tx or money path is not a record line", async () => {
  const r = await moneyGate(rec(`Money path: no\nThe tx was read back on two RPCs, and this card is not on the money path.\n`), good, RPCS);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(parseLive(`CARD demo / merge: PASS\nEvery tx in the money path was read back.\n`, "demo"), null);
});

// Review round 2 at 41dbf4a: real report text. A line is a record line only when it starts with "Tx" or "Money path"
// (after a bullet, a number, a quote or bold); the same words further into a line are prose.
// Lines 1, 2, 51 and 84 of a real merge record (kickoff-kit, 2026-10-26), word for word:
const REAL_MERGE = [
  "CARD kickoff-kit / merge: FAIL",
  "Checked at: card/kickoff-kit@2877a65f0674ba4cb3d668d5f629f0ee3dc71438, 2026-10-26T13:06:39Z (date -u)",
  "",
  "Findings:",
  '   - Repro: base has scripts/live-checks/old-card.md (about 35 lines). The PR has commit "Card old-card: record retired" (git rm of that file), then commit "Card new-card: live record" adding scripts/live-checks/new-card.md: the same text renamed, plus "CARD new-card / live: PASS / Money path: yes / Tx: base 0x000…07".',
  '8. P3, kickoff/kit/scripts/ci/money-gate.mjs:75. A bulleted "- Tx: …" line is silently ignored: of the 3 Tx lines in my probe, 1 was read, with no problem reported. Check to build: refuse any line containing "Tx:" that does not parse.',
  "",
].join("\n");
// Lines 1, 3, 4, 5, 27 and 28 of a real live record (g1-phone-live, 2026-10-26), word for word, then the review's
// probe lines in the report's own shape (a live clause, a note and a Re-runs line, each naming a tx with a colon).
const REAL_LIVE = [
  "CARD g1-phone-live / live: PASS",
  "Money path: yes",
  "Tx: solana 2btTg7crbv6EL6DJtpNo67Vv9J2vioFHz4uMTuHR2hrWnJMumu7PQb9gYQwToV3ac55LGw418hL28JvChi8oc4Rv",
  "Tx: solana 4hN9gQ1PQPSDUJrHAXLHDaYd6mK2C6V3a3KtSoMoUb3nC2X1MEiKswTo6XzGfuoQ7Fb1Le7x3JU648dMwcdrLDA8",
  "",
  "Clause by clause:",
  "1. All 10 trade signatures are finalized, err null, and paid for by the run wallet, on two outside RPCs -> PASS.",
  `- deposit arrives -> PASS (tx: ${BASE_TX}, block 123)`,
  "Findings: none. Note on NEAR Tx: the signer is the fresh wallet",
  `Re-runs: base tx: ${BASE_TX} re-fetched on mainnet.base.org -> status 0x1`,
  "",
].join("\n");

test("real review report text that quotes or cites a tx is not a record line", () => {
  assert.deepEqual(parseLive(REAL_MERGE, "kickoff-kit"), null);
  // its prose cites BASE_TX: it passes when a Tx line lists that tx, and is refused, line by line, when none does
  const listed = REAL_LIVE.replace(/^(Tx: solana 4hN9\S+)$/m, `$1\nTx: base ${BASE_TX}`);
  const live = parseLive(listed, "g1-phone-live");
  assert.deepEqual(live.problems, []);
  assert.equal(live.moneyPath, true);
  assert.equal(live.txs.length, 3);
  const unlisted = parseLive(REAL_LIVE, "g1-phone-live").problems.join("\n");
  assert.match(unlisted, new RegExp(`^line 8 names ${BASE_TX}, which no parsed Tx line lists: - deposit arrives`, "m"));
  assert.match(unlisted, new RegExp(`^line 10 names ${BASE_TX}, which no parsed Tx line lists: Re-runs: base tx:`, "m"));
  const merge = parseLive(`CARD dep / merge: PASS\nRe-runs: base tx: ${BASE_TX} re-fetched on mainnet.base.org -> status 0x1\n`, "dep");
  assert.equal(merge, null);
});

test("a Tx or Money path line after a bullet, a number, a quote or bold still has to parse", () => {
  for (const l of [
    "- Tx: base 0x01",
    `* Tx: base ${BASE_TX} extra`,
    `+ Tx: bitcoin ${BASE_TX}`,
    `1. Tx: base ${BASE_TX}`,
    `> Tx: base ${BASE_TX}`,
    `**Tx:** base ${BASE_TX}`,
    "- **Money path:** yes",
    `tx: base ${BASE_TX}`,
  ]) {
    const r = parseLive(`CARD demo / live: PASS\nMoney path: no\n${l}\n`, "demo");
    assert.match(r.problems.join("\n"), /bad (Tx|Money path) line/, l);
    assert.match(parseLive(`CARD demo / merge: PASS\n${l}\n`, "demo").problems.join("\n"), /outside a live record/, l);
  }
});

// Outside read of fd72db5 (card app-followup, task B2): in a money-path record with one valid Tx line, a second tx in
// any other shape was silently not read back. In a live section a string shaped like a tx id of a listed chain, on a
// line that names a transaction (task C2), must sit on a parsed Tx line, or the same id must be on one.
const BB_TX = "0x" + "bb".repeat(32);
const NEAR_TX2 = "9mX4kLHmBQbB3cJ7rG1xKqaU5pZyWn2Ts8vE6dFhjRtP";
const SOL_TX2 = "3k" + SOL_TX.slice(2);

test("a tx id on a line that is not a parsed Tx line is refused, by line", async () => {
  for (const l of [
    `\`Tx: base ${BB_TX}\``,
    `| Tx: base ${BB_TX} |`,
    `Tx hash: ${BB_TX}`,
    `Txs: ${BB_TX}`,
    `The second leg tx was ${BB_TX.toUpperCase().replace("0X", "0x")}.`,
    `Txs: solana ${SOL_TX2}`,
    `NEAR leg: https://nearblocks.io/txns/${NEAR_TX2}`,
  ]) {
    const text = `CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${l}\n`;
    const p = parseLive(text, "demo");
    assert.equal(p.txs.length, 1, l);
    assert.match(p.problems.join("\n"), /^line 4 names \S+, which no parsed Tx line lists: /m, l);
    const r = await moneyGate([{ path: "scripts/live-checks/demo.md", key: "demo", text }], good, RPCS);
    assert.match(r.refusals.join("\n"), /scripts\/live-checks\/demo\.md: line 4 names /, l);
  }
});

test("prose that cites a listed tx passes, and strings not shaped like a tx id are not read as one", () => {
  const p = parseLive(
    [
      "CARD demo / live: PASS",
      "Money path: yes",
      `Tx: base ${BASE_TX}`,
      `Tx: near ${NEAR_TX} intents.near`,
      `- deposit arrives -> PASS (tx: ${BASE_TX}, block 123)`,
      `the NEAR leg ${NEAR_TX} read back on two RPCs`,
      "Checked at: card/demo@2877a65f0674ba4cb3d668d5f629f0ee3dc71438",
      `sha256 ${"ab".repeat(32)} of the record`,
      "signer intents.near, contract wrap.near",
      "",
    ].join("\n"),
    "demo",
  );
  assert.deepEqual(p.problems, []);
  assert.equal(p.txs.length, 2);
});

// Task B4: a NEAR tx id (43-44 base58) has the shape of most Solana wallet addresses and of NEAR and Solana block
// hashes, so it must be on a parsed Tx line only when its line names a transaction (a backticked or table Tx line
// included). Otherwise it is an address and passes. Task C2 made this the rule for every shape and dropped "hash",
// "receipt" and "signature" from the transaction words (see below).
const SOL_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

test("a fresh wallet address in the prose of a live record passes", async () => {
  const text = [
    "CARD demo / live: PASS",
    "Money path: yes",
    `Tx: solana ${SOL_TX}`,
    `- The fresh wallet ${SOL_WALLET} received 0.1 SOL.`,
    `| fresh wallet | ${SOL_WALLET} |`,
    `Paid from ${SOL_WALLET}, read back on two RPCs.`,
    "",
  ].join("\n");
  assert.deepEqual(parseLive(text, "demo").problems, []);
  assert.deepEqual((await moneyGate([{ path: "scripts/live-checks/demo.md", key: "demo", text }], good, RPCS)).refusals, []);
});

test("a NEAR-shaped id on a line that names a transaction must be listed", async () => {
  for (const l of [
    `NEAR tx hash ${NEAR_TX2}`,
    `Tx hash: ${NEAR_TX2}`,
    `Txs: ${NEAR_TX2}`,
    `\`Tx: near ${NEAR_TX2} intents.near\``,
    `| Tx: near ${NEAR_TX2} |`,
    `the TRANSACTION ${NEAR_TX2} landed`,
    `{"txHash": "${NEAR_TX2}"}`,
    `tx_hash=${NEAR_TX2}`,
    `TXID ${NEAR_TX2}`,
    `txn: ${NEAR_TX2}`,
    `Transactions: ${NEAR_TX2}`,
    `Tx2: near ${NEAR_TX2} intents.near`,
  ]) {
    const text = `CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${l}\n`;
    assert.match(parseLive(text, "demo").problems.join("\n"), new RegExp(`^line 4 names ${NEAR_TX2}, which no parsed Tx line lists: `, "m"), l);
    const r = await moneyGate([{ path: "scripts/live-checks/demo.md", key: "demo", text }], good, RPCS);
    assert.match(r.refusals.join("\n"), /scripts\/live-checks\/demo\.md: line 4 names /, l);
  }
  // listed, the same line passes
  const listed = `CARD demo / live: PASS\nMoney path: yes\nTx: near ${NEAR_TX} intents.near\nNEAR tx hash ${NEAR_TX} read back\n`;
  assert.deepEqual(parseLive(listed, "demo").problems, []);
});

// Task C2 (second outside read of 080a962): the B4 rule read a 0x hash and an 88-base58 word as a tx on any line, and
// "hash", "receipt" and "signature" as transaction words, so real live-record facts (a block hash, a deposit
// commitment and root, an order's signature) were refused. One rule now for every chain and shape: a tx-shaped word
// must be listed only when its line names a transaction (tx, txs, txn, txid, txhash, transaction, any case, plural,
// inside a word). This test replaces B4's "refused unlisted on any line, with or without a tx word".
test("a 0x hash or a Solana signature is refused unlisted on a line that names a transaction, and passes on one that does not", () => {
  for (const [l, id] of [
    [`The swap tx ${SOL_TX2}`, SOL_TX2],
    [`sent in txn ${BB_TX}`, BB_TX],
    [`solscan.io/tx/${SOL_TX2}`, SOL_TX2],
    [`TX1: base ${BB_TX}`, BB_TX],
  ]) {
    const p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: solana ${SOL_TX}\n${l}\n`, "demo");
    assert.match(p.problems.join("\n"), new RegExp(`^line 4 names ${id}, which no parsed Tx line lists: `, "m"), l);
  }
  for (const l of [`The wallet received ${SOL_TX2}`, `sent from ${SOL_WALLET} in ${BB_TX}`, `The second leg was ${BB_TX.toUpperCase().replace("0X", "0x")}.`]) {
    const p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: solana ${SOL_TX}\n${l}\n`, "demo");
    assert.deepEqual(p.problems, [], l);
  }
});

const BLOCK43 = "hkPeVSxaZ1EeiZnop5kQsnwNMNHF31uQ63zAzctzbxA";
const BLOCK44 = "NuzTNUemyv7eYKxtPVdz6LuAw7LMfN8YfUVhX7GHaRJe";
const ORDER_SIG = "nhW5jsYeX4GF3za74n2NkjzzEhaBQ15CCRKxzrrtWDjcNdWzSovvtMGFQuY9Dm3TJRzdKbk1vVyYk6Fo8GfEstGB";
const COMMITMENT = "0x7a32011665b56c0e67ec8019698083a181df4105a07f40d16e58d61149876898";
const ROOT = "0xbe3cff0e589a9a25a4bf623973a9f1a11f3ecfd5c103cc2de98ac0901e9426d0";

test("a block hash, a deposit commitment and root, and an order signature in a live record pass", async () => {
  const facts = [
    `Block hash ${BLOCK43} on NEAR, read on two RPCs.`,
    `Included in blockHash ${BLOCK44}.`,
    `The deposit commitment is ${COMMITMENT}; the root is ${ROOT}.`,
    `Order signature: ${ORDER_SIG}`,
    `- the order's signature ${ORDER_SIG} was checked against the fresh wallet ${SOL_WALLET}`,
    `receipt ${NEAR_TX2}`,
  ];
  for (const [money, tx] of [["yes", `Tx: near ${NEAR_TX} intents.near`], ["yes", `Tx: base ${BASE_TX}`], ["no", ""]]) {
    const text = ["CARD demo / live: PASS", `Money path: ${money}`, ...(tx ? [tx] : []), ...facts, ""].join("\n");
    assert.deepEqual(parseLive(text, "demo").problems, [], text);
    assert.deepEqual((await moneyGate([{ path: "scripts/live-checks/demo.md", key: "demo", text }], good, RPCS)).refusals, [], text);
  }
  // the same facts on a line that names a transaction must be listed
  for (const [l, id] of [
    [`Tx block hash ${BLOCK43}`, BLOCK43],
    [`deposit tx commitment ${COMMITMENT}`, COMMITMENT],
    [`txSignature: ${ORDER_SIG}`, ORDER_SIG],
  ]) {
    const p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${l}\n`, "demo");
    assert.match(p.problems.join("\n"), new RegExp(`^line 4 names ${id}, which no parsed Tx line lists: `, "m"), l);
  }
});

// review of C2: a table whose header names a transaction makes every row of it name one, so a tx in a row
// under a "Tx" column is read like one on a tx-naming line; a table with no such header stays prose
test("a tx id in a table under a header that names a transaction must be listed", () => {
  const unlisted = `0x${"0b".repeat(32)}`;
  const refused = ["| Chain | Tx |", "|---|---|", `| base | ${unlisted} |`].join("\n");
  let p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${refused}\n`, "demo");
  assert.match(p.problems.join("\n"), new RegExp(`^line 6 names ${unlisted}, which no parsed Tx line lists: `, "m"));
  const listed = ["| Chain | Tx |", "|---|---|", `| base | ${BASE_TX} |`].join("\n");
  p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${listed}\n`, "demo");
  assert.deepEqual(p.problems, []);
  const facts = ["| Read | Value |", "|---|---|", `| block hash | ${BLOCK43} |`, `| commitment | ${COMMITMENT} |`].join("\n");
  p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${facts}\n`, "demo");
  assert.deepEqual(p.problems, []);
  // a second table after a blank line takes its own header
  const two = `${listed}\n\n${facts}`;
  p = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: base ${BASE_TX}\n${two}\n`, "demo");
  assert.deepEqual(p.problems, []);
});

// Review round 2, F4 (probe mg-probe2): a table headed "| Chain | Hash | Status |" under a "Transactions read back:"
// line, a blank line between, let an unlisted NEAR hash pass. The nearest non-blank line right above a table counts as
// its header when it names a transaction, so every row of that table is read.
test("a table under a line that names a transaction has every row read", () => {
  // mg-probe2's record, word for word
  const probeListed = "AbcDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstu";
  const probeOther = "BcdEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuv";
  const probe = `CARD d / live: PASS\nMoney path: yes\nTx: near ${probeListed} alice.near\n\nTransactions read back:\n\n| Chain | Hash | Status |\n|---|---|---|\n| near | ${probeOther} | SuccessValue |\n`;
  assert.match(parseLive(probe, "d").problems.join("\n"), new RegExp(`^line 9 names ${probeOther}, which no parsed Tx line lists: `, "m"));
  const table = (id) => ["| Chain | Hash | Status |", "|---|---|---|", `| near | ${id} | SuccessValue |`].join("\n");
  const head = `CARD demo / live: PASS\nMoney path: yes\nTx: near ${NEAR_TX} intents.near\n`;
  // the same with no blank line between
  let p = parseLive(`${head}Transactions read back:\n${table(NEAR_TX2)}\n`, "demo");
  assert.match(p.problems.join("\n"), new RegExp(`^line 7 names ${NEAR_TX2}, which no parsed Tx line lists: `, "m"));
  // a listed hash in such a table passes, with and without the blank line
  for (const gap of ["", "\n"]) assert.deepEqual(parseLive(`${head}Transactions read back:\n${gap}${table(NEAR_TX)}\n`, "demo").problems, [], gap);
  // the same table under a line that names no transaction is unchanged: it passes
  for (const gap of ["", "\n"]) assert.deepEqual(parseLive(`${head}Blocks read back:\n${gap}${table(NEAR_TX2)}\n`, "demo").problems, [], gap);
});

// Review round 3: a table right under a Tx line, headed "| Chain | Hash |" with no line that names a transaction, let
// an unlisted tx pass. Under a Tx line, a header row with a Hash or ID column that does not say Block
// makes every row of the table read.
test("a Hash or ID column right under a Tx line is read unless it says Block", () => {
  const head = `CARD demo / live: PASS\nMoney path: yes\nTx: near ${NEAR_TX} intents.near\n`;
  const table = (cols, id) => [`| ${cols.join(" | ")} |`, `|${"---|".repeat(cols.length)}`, `| ${["near", id, ...cols.slice(2).map(() => "x")].join(" | ")} |`].join("\n");
  for (const cols of [["Chain", "Hash"], ["Chain", "Hash", "Block"], ["Chain", "ID"], ["Chain", "Hashes", "Status"], ["Chain", "receiptId"]])
    for (const gap of ["", "\n"]) {
      const p = parseLive(`${head}${gap}${table(cols, NEAR_TX2)}\n`, "demo");
      assert.match(p.problems.join("\n"), new RegExp(`names ${NEAR_TX2}, which no parsed Tx line lists: `), `${cols} ${JSON.stringify(gap)}`);
      // the listed tx in the same table passes
      assert.deepEqual(parseLive(`${head}${gap}${table(cols, NEAR_TX)}\n`, "demo").problems, [], `${cols} listed`);
    }
  // a Hash column that says Block, a blockHash, and a table with no Hash or ID column pass under a Tx line
  for (const cols of [["Chain", "Block hash"], ["Chain", "blockHash"], ["Chain", "Block ID"], ["Chain", "Value"]])
    assert.deepEqual(parseLive(`${head}${table(cols, BLOCK43)}\n`, "demo").problems, [], `${cols}`);
  // a Hash table under prose that names no transaction is still prose
  assert.deepEqual(parseLive(`${head}Read on two RPCs:\n${table(["Chain", "Hash"], NEAR_TX2)}\n`, "demo").problems, []);
});

// A record must be a regular file: one turned into a symlink in the PR (a type change, T) is read, and a symlinked
// record is refused in a PR and in --all, whatever it points at.
test("a record turned into a symlink, or added as one, is refused in a PR and in --all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "money-gate-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
    writeFileSync(join(dir, "scripts/live-checks/old-card.md"), "CARD old-card / merge: PASS\n");
    git("add", "scripts/live-checks/old-card.md");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "other.md"), `CARD old-card / live: PASS\nMoney path: yes\nTx: base 0x${"07".repeat(32)}\n`);
    unlinkSync(join(dir, "scripts/live-checks/old-card.md"));
    symlinkSync("../../other.md", join(dir, "scripts/live-checks/old-card.md"));
    symlinkSync("old-card.md", join(dir, "scripts/live-checks/new-card.md"));
    git("add", "other.md", "scripts/live-checks/old-card.md", "scripts/live-checks/new-card.md");
    git("commit", "-q", "-m", "a type change");
    const head = git("rev-parse", "HEAD");
    assert.match(git("diff", "--name-status", "--no-renames", `${base}...${head}`, "--", "scripts/live-checks/*.md"), /^T\tscripts\/live-checks\/old-card\.md$/m);
    for (const args of [[base, head], ["--all"]]) {
      const { records, every } = recordsFrom(dir, args);
      const r = await moneyGate(records, good, RPCS, { every });
      for (const p of ["scripts/live-checks/new-card.md", "scripts/live-checks/old-card.md"])
        assert.match(r.refusals.join("\n"), new RegExp(`${p}: a symlink, not a regular file`), `${args[0]} ${p}`);
      assert.deepEqual(r.read, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Money code (2026-10-31): a change that touches a money folder merges with no record. A record its card changes in
// the same change must be true: "Money path: no", a live FAIL or no live section is refused. Every refusal above holds.
function moneyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "money-gate-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).trim();
  const commit = (msg, files) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), body);
      git("add", "--", p);
    }
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const base = commit("Card kickoff-kit: kit", { "README.md": "x\n", "scripts/live-checks/README.md": "How a check works.\n" });
  return { dir, git, commit, base, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const liveRec = (key, body) => `CARD ${key} / live: PASS\n${body}`;
const gate = async (r, base, head, fetchFn = good) => {
  const { records, every, money } = recordsFrom(r.dir, [base, head]);
  return { records, ...(await moneyGate(records, fetchFn, RPCS, { every, money })) };
};

test("a money-path change with its record under scripts/live-checks/ has its Tx lines read", async () => {
  const r = moneyRepo();
  try {
    const head = r.commit("Card arm: the vault call", {
      "contracts/vault/src/lib.rs": "// code\n",
      "scripts/live-checks/arm.md": liveRec("arm", `Money path: yes\nTx: base ${BASE_TX}\n`),
    });
    const out = await gate(r, r.base, head);
    assert.deepEqual(out.refusals, []);
    assert.deepEqual(out.read, [`base ${BASE_TX} ok on b1`, `base ${BASE_TX} ok on b2`]);
  } finally {
    r.done();
  }
});

test("a money-path change with no record merges, in each money folder (real money is proven before Live)", async () => {
  for (const f of ["contracts/vault/src/lib.rs", "packages/kit/src/index.ts", "packages/wallet/src/keys.ts", "apps/terminal/src/trading/send.ts"]) {
    const r = moneyRepo();
    try {
      const head = r.commit("Card arm: code", { [f]: "// code\n" });
      const out = await gate(r, r.base, head);
      assert.deepEqual(out.refusals, [], f);
      assert.deepEqual(out.read, [], f);
    } finally {
      r.done();
    }
  }
});

test('"Money path: no" on a money-path change is refused, and so is a live FAIL', async () => {
  const r = moneyRepo();
  try {
    const no = r.commit("Card arm: code", {
      "packages/wallet/src/keys.ts": "// code\n",
      "scripts/live-checks/arm.md": liveRec("arm", "Money path: no\n"),
    });
    assert.match((await gate(r, r.base, no)).refusals.join("\n"), /scripts\/live-checks\/arm\.md: "Money path: no", but card arm changes money code \(packages\/wallet\/src\/keys\.ts\)/);
    const fail = r.commit("Card arm: record", {
      "scripts/live-checks/arm.md": `CARD arm / live: FAIL\nMoney path: yes\nTx: base ${BASE_TX}\n`,
    });
    assert.match((await gate(r, r.base, fail)).refusals.join("\n"), /scripts\/live-checks\/arm\.md: the last live verdict is FAIL, and card arm changes money code/);
  } finally {
    r.done();
  }
});

test("a docs-only change passes with no record, and screen code is not money code", async () => {
  const r = moneyRepo();
  try {
    const head = r.commit("Card docs-plan: a plan", { "docs/plans/app.md": "# app\n", "apps/terminal/src/screens/home.ts": "export {}\n" });
    const out = await gate(r, r.base, head);
    assert.deepEqual(out.refusals, []);
    assert.deepEqual(out.records, []);
  } finally {
    r.done();
  }
});

test("a record already on main is not re-read for a new money change of the same card", async () => {
  const r = moneyRepo();
  try {
    const first = r.commit("Card arm: code and record", {
      "contracts/vault/src/lib.rs": "// one\n",
      "scripts/live-checks/arm.md": liveRec("arm", "Money path: no\n"),
    });
    const head = r.commit("Card arm: more code", { "contracts/vault/src/lib.rs": "// two\n" });
    const out = await gate(r, first, head);
    assert.deepEqual(out.refusals, []);
    assert.deepEqual(out.records, []);
  } finally {
    r.done();
  }
});

test('"Money path: no" is refused only in the record of a card whose commits touch money code', async () => {
  const r = moneyRepo();
  try {
    const head = r.commit("Card docs-plan: a plan and its record", {
      "docs/plans/app.md": "# app\n",
      "scripts/live-checks/docs-plan.md": liveRec("docs-plan", "Money path: no\n"),
    });
    assert.deepEqual((await gate(r, r.base, head)).refusals, []);
    r.commit("Card arm: code", { "contracts/vault/src/lib.rs": "// code\n" });
    const both = r.commit("Card arm: its record", { "scripts/live-checks/arm.md": liveRec("arm", "Money path: no\n") });
    const out = (await gate(r, r.base, both)).refusals;
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], /scripts\/live-checks\/arm\.md: "Money path: no", but card arm changes money code/);
  } finally {
    r.done();
  }
});

test("money code in a commit that names no card, or added in a merge commit, is refused", async () => {
  const r = moneyRepo();
  try {
    const head = r.commit("tweak the vault", { "contracts/vault/src/lib.rs": "// code\n" });
    assert.match((await gate(r, r.base, head)).refusals.join("\n"), /commit [0-9a-f]{12} changes money code \(contracts\/vault\/src\/lib\.rs\) and names no card/);
    r.git("checkout", "-q", "-b", "side", r.base);
    r.commit("Card docs-plan: a plan", { "docs/plans/app.md": "# app\n" });
    r.git("checkout", "-q", "-b", "card/sneak", r.base);
    r.commit("Card sneak: docs", { "docs/a.md": "a\n" });
    r.git("merge", "-q", "--no-ff", "--no-commit", "side");
    mkdirSync(join(r.dir, "packages/kit"), { recursive: true });
    writeFileSync(join(r.dir, "packages/kit/evil.ts"), "export {}\n");
    r.git("add", "--", "packages/kit/evil.ts");
    r.git("commit", "-q", "-m", "Merge side");
    const merged = r.git("rev-parse", "HEAD");
    assert.match((await gate(r, r.base, merged)).refusals.join("\n"), /packages\/kit\/evil\.ts changes money code in a merge commit, outside any card's commit/);
  } finally {
    r.done();
  }
});

test("the folder's README is not a record", () => {
  const r = moneyRepo();
  try {
    assert.deepEqual(recordsFrom(r.dir, ["--all"]).records, []);
  } finally {
    r.done();
  }
});

// Card money-gate-testnet: a testnet run can be recorded and read back on the testnet RPCs, kept apart from mainnet
// records, with the same FLOOR and the same tx-word rule, and is never real-money proof.
const TESTNET_SIGNER = "g1vg-20261026b.testnet";
const urlsOf = (fetchFn) => {
  const urls = new Set();
  return { urls, fetchFn: async (url, init) => (urls.add(url), fetchFn(url, init)) };
};

test("a near-testnet tx reads ok on both testnet RPCs, and on no mainnet RPC", async () => {
  const seen = urlsOf(good);
  const r = await moneyGate(rec(`Money path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\n`), seen.fetchFn, RPCS);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.read, ["t1", "t2"].map((u) => `near-testnet ${NEAR_TX} ok on ${u} (testnet, not real-money proof)`));
  assert.deepEqual([...seen.urls].sort(), ["t1", "t2"]);
  // the gate's own lists: at least two testnet RPCs, none of them a mainnet one
  assert.ok(REAL_RPCS["near-testnet"].length >= 2);
  for (const u of REAL_RPCS["near-testnet"]) for (const c of ["near", "solana", "base", "robinhood"]) assert.ok(!REAL_RPCS[c].includes(u), u);
});

test("a near-testnet tx from before FLOOR is refused as old", async () => {
  const r = await moneyGate(rec(`Money path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\n`), stub(chainAnswers(OCT1)), RPCS);
  assert.equal(r.refusals.length, 1, r.refusals.join("\n"));
  assert.match(r.refusals[0], /near-testnet \S+: old: 2026-10-01T00:00:00\.000Z is before 2026-11-01T00:00:00\.000Z on t1, old: .* on t2$/);
  assert.deepEqual(r.read, []);
});

test('a testnet hash written as "Tx: near" is refused on the mainnet RPCs', async () => {
  // the testnet RPCs know the tx; the mainnet ones answer as NEAR does for a tx it never saw
  const split = stub((url, method) =>
    url.startsWith("t") ? chainAnswers(NOV2)(url, method) : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, code: -32000 } },
  );
  const asMainnet = await moneyGate(rec(`Money path: yes\nTx: near ${NEAR_TX} ${TESTNET_SIGNER}\n`), split, RPCS);
  assert.match(asMainnet.refusals.join("\n"), new RegExp(`near ${NEAR_TX}: missing on n1, missing on n2$`));
  assert.deepEqual(asMainnet.read, []);
  const asTestnet = await moneyGate(rec(`Money path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\n`), split, RPCS);
  assert.deepEqual(asTestnet.refusals, []);
  assert.equal(asTestnet.read.length, 2);
});

test("a near-testnet record never counts as real-money proof", () => {
  const only = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\n`, "demo");
  assert.deepEqual(only.problems, []);
  assert.equal(only.txs.length, 1);
  assert.deepEqual(only.real, []);
  const mixed = parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\nTx: base ${BASE_TX}\n`, "demo");
  assert.deepEqual(mixed.real.map((t) => `${t.chain} ${t.hash}`), [`base ${BASE_TX}`]);
});

test("a near-testnet record keeps the tx-word rule and needs its signer", () => {
  const head = `CARD demo / live: PASS\nMoney path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\n`;
  assert.match(parseLive(`${head}testnet tx ${NEAR_TX2}\n`, "demo").problems.join("\n"), new RegExp(`^line 4 names ${NEAR_TX2}, which no parsed Tx line lists: `, "m"));
  assert.deepEqual(parseLive(`${head}testnet tx ${NEAR_TX} read back on two RPCs\n`, "demo").problems, []);
  assert.match(parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: near-testnet ${NEAR_TX}\n`, "demo").problems.join(), /near-testnet Tx \S+ needs its signer account/);
});

test("a Tx line whose chain is a built-in object name is a bad Tx line, not a crash", () => {
  for (const c of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    assert.match(parseLive(`CARD demo / live: PASS\nMoney path: yes\nTx: ${c} ${NEAR_TX} a.near\n`, "demo").problems.join(), /bad Tx line/, c);
});

// A public RPC may rate-limit (HTTP 429 with a Retry-After: near.org's archival RPC gave 43 s on testnet and up to 600 s
// on mainnet, read 2026-10-31). The real NEAR set, a network stub by host and a sleep that only records.
const DRPC = "near.drpc.org";
function rateLimited(drpc) {
  const log = [];
  let n = 0;
  const fetchFn = async (url, init) => {
    const host = new URL(url).host;
    const { method } = JSON.parse(init.body);
    log.push(`ask ${host} ${method}`);
    const json = (status, body, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });
    if (host === DRPC) {
      const a = drpc(n++);
      if (a) return json(429, { error: { code: -429, message: "rate limited" } }, a);
    }
    return json(200, { jsonrpc: "2.0", id: 1, ...chainAnswers(NOV2)(url, method) });
  };
  // a pacing wait is at most 1000 ms; a rate-limit wait is longer
  const sleep = async (ms) => void log.push(`sleep ${ms}`);
  return { fetchFn, sleep, log };
}
const nearTx = (fetchFn, sleep) => moneyGate(rec(`Money path: yes\nTx: near ${NEAR_TX} intents.near\n`), fetchFn, { near: REAL_RPCS.near }, { sleep });

test("dRPC answers 429 before ok: the gate waits out each Retry-After and passes on FastNEAR and dRPC", async () => {
  const s = rateLimited((n) => (n < 3 ? { "retry-after": ["43", "600", "5"][n] } : null));
  const r = await nearTx(s.fetchFn, s.sleep);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.read.map((x) => x.split(" ok on ")[1]), REAL_RPCS.near);
  const d = s.log.filter((l) => l.includes(DRPC) || /^sleep (43000|600000|5000)$/.test(l));
  assert.deepEqual(d.slice(0, 7), [`ask ${DRPC} EXPERIMENTAL_tx_status`, "sleep 43000", `ask ${DRPC} EXPERIMENTAL_tx_status`, "sleep 600000", `ask ${DRPC} EXPERIMENTAL_tx_status`, "sleep 5000", `ask ${DRPC} EXPERIMENTAL_tx_status`]);
  // each host at most once a second: the block read right after the tx read on the same host waits up to 1 s before it
  const i = s.log.indexOf("ask archival-rpc.mainnet.fastnear.com block");
  assert.match(s.log[i - 1], /^sleep ([1-9]\d{0,2}|1000)$/);
});

test("a 429 with no Retry-After waits 2 s, doubling, and is still no answer after the last try: refused", async () => {
  const s = rateLimited(() => ({}));
  const r = await nearTx(s.fetchFn, s.sleep);
  assert.match(r.refusals.join("\n"), /no answer \(rate limited \d+ times in a row\) on https:\/\/near\.drpc\.org/);
  // the tx read is waited out; the stub's tx answer has no tx JSON to rebuild its bytes from, so no proof is asked for
  // and nothing more is waited
  const waits = ["sleep 2000", "sleep 4000", "sleep 8000", "sleep 16000", "sleep 32000"];
  assert.deepEqual(s.log.filter((l) => /^sleep \d+$/.test(l) && Number(l.slice(6)) > 1000), waits);
  assert.match(r.refusals.join("\n"), new RegExp(`not proven: its tx JSON names hash undefined, not ${NEAR_TX}`));
});

test("a 429 whose Retry-After is past the 600 s cap is no answer at once: refused, never waited", async () => {
  const s = rateLimited(() => ({ "retry-after": "900" }));
  const r = await nearTx(s.fetchFn, s.sleep);
  assert.match(r.refusals.join("\n"), /no answer \(rate limited, Retry-After 900 s is past the 600 s cap\) on https:\/\/near\.drpc\.org/);
  assert.equal(s.log.filter((l) => l === `ask ${DRPC} EXPERIMENTAL_tx_status`).length, 1);
  assert.deepEqual(s.log.filter((l) => /^sleep \d+$/.test(l) && Number(l.slice(6)) > 1000), []);
});

// Card money-gate-light-proof: a NEAR tx only one operator reads passes only by NEAR's light-client proof. The
// recording (money-gate.light-proof.json) is a real testnet record tx, its FastNEAR answers (tx status, block, one
// EXPERIMENTAL_light_client_proof per outcome) and dRPC's status and final block, read 2026-11-01. dRPC is told it
// does not hold the tx, so FastNEAR is the one operator that reads it.
const LP = JSON.parse(readFileSync(new URL("./money-gate.light-proof.json", import.meta.url), "utf8"));
const T_FN = "https://archival-rpc.testnet.fastnear.com";
const T_DR = "https://near-testnet.drpc.org";
const T_ORG = "https://archival-rpc.testnet.near.org";
const T_RPCS = { "near-testnet": [T_FN, T_DR, T_ORG] };
// the record, with its tx-bytes file's entry when the recording has the tx's bytes
const lpRec = (fx = LP) => [{ ...rec(`Money path: yes\nTx: near-testnet ${fx.tx.hash} ${fx.tx.signer}\n`)[0], bytes: fx.tx_bytes ? { [fx.tx.hash]: fx.tx_bytes } : undefined }];
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function enc58(b) {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
  let s = "";
  for (; n > 0n; n /= 58n) s = ALPHABET[Number(n % 58n)] + s;
  for (const x of b) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const UNKNOWN_BLOCK = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" }, code: -32000 } };
// FastNEAR's two hosts answer from the recording; dRPC lacks the tx and answers its status and final block
function proofHosts(fx = LP) {
  const log = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    log.push(`ask ${url} ${method}`);
    const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ jsonrpc: "2.0", id: 1, ...body }) });
    if (url === T_DR) {
      if (method === "EXPERIMENTAL_tx_status") return json({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, code: -32000 } });
      if (method === "status") return json({ result: fx.drpcStatus });
      if (method === "block" && params.finality === "final") return json({ result: { header: fx.head } });
      if (method === "block") return json(params.block_id === fx.head.hash && !fx.headUnknown ? { result: { header: fx.head } } : UNKNOWN_BLOCK);
    } else {
      if (method === "EXPERIMENTAL_tx_status") return json({ result: fx.known });
      // a block the recorded walk holds answers with its prev_hash (tx-rebuild), any other with the tx's block
      if (method === "block" && Object.hasOwn(fx.walk ?? {}, params.block_id)) return json({ result: { header: { ...fx.txBlock, hash: params.block_id, prev_hash: fx.walk[params.block_id] } } });
      if (method === "block") return json({ result: { header: fx.txBlock } });
      if (method === "EXPERIMENTAL_light_client_proof") {
        const p = fx.proofs[params.transaction_hash ?? params.receipt_id];
        return json(p && params.light_client_head === fx.head.hash ? { result: p } : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION_OR_RECEIPT" }, code: -32000 } });
      }
    }
    return json({ error: { code: -32601, message: `no stub for ${method}` } });
  };
  const sleep = async (ms) => void log.push(`sleep ${ms}`);
  return { fetchFn, sleep, log };
}
const gateOn = async (fx, rpcs = T_RPCS) => {
  const s = proofHosts(fx);
  return { ...(await moneyGate(lpRec(fx), s.fetchFn, rpcs, { sleep: s.sleep })), log: s.log };
};

test("light proof: the recorded real testnet tx, read on FastNEAR alone, is proven on dRPC's final block and passes", async () => {
  const r = await gateOn(LP);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.proven.length, 1);
  assert.match(r.proven[0], new RegExp(`^PROVEN ON near-testnet\\.drpc\\.org: near-testnet ${LP.tx.hash} \\(V0, ${LP.tx.signer} to ${LP.tx.signer}\\): 3 outcome\\(s\\) proven by archival-rpc\\.testnet\\.fastnear\\.com's light-client proof against final block ${LP.head.height} ${LP.head.hash}; confirmed in block \\d+, 2026-11-01T\\d\\d:\\d\\d:\\d\\d\\.\\d+Z; tx bytes its tx-bytes file \\(scripts/live-checks/<card>\\.tx-bytes\\.json\\) \\(testnet, not real-money proof\\)$`));
  // the proof needs no second read on FastNEAR's other host: near.org is asked once, never waited
  assert.equal(r.log.filter((l) => l === `ask ${T_ORG} EXPERIMENTAL_tx_status`).length, 1);
  assert.deepEqual(r.log.filter((l) => /^sleep \d+$/.test(l) && Number(l.slice(6)) > 1000), []);
});

test("light proof: nearcore's own outcome vector (transaction.rs test_outcome_to_hashes) hashes the same here", () => {
  const id = Buffer.alloc(32, 42);
  const outcome = { logs: ["123", "321"], receipt_ids: [], gas_burnt: 123, tokens_burnt: "1234000", executor_id: "alice", status: { SuccessValue: Buffer.from([123]).toString("base64") } };
  const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
  const n = Buffer.alloc(4);
  n.writeUInt32LE(4);
  const want = sha(n, id, base58("5JQs5ekQqKudMmYejuccbtEu1bzhQPXa92Zm4HdV64dQ"), sha(Buffer.from("123")), sha(Buffer.from("321")));
  assert.ok(outcomeLeaf(enc58(id), outcome).equals(want));
});

// every value the proof hashes, changed one at a time: a hash has one byte flipped, a number is one more, a direction
// swapped, a string one letter longer. outcome.metadata (a gas profile) and inner_lite.timestamp (views.rs:1057, the
// legacy copy of timestamp_nanosec) are not hashed and not read.
function leaves(x, path = []) {
  if (x === null || typeof x !== "object") return [[path, x]];
  return Object.entries(x).flatMap(([k, v]) => leaves(v, [...path, k]));
}
function changed(v) {
  if (typeof v === "number") return v + 1;
  if (v === "Left") return "Right";
  if (v === "Right") return "Left";
  if (/^\d+$/.test(v)) return String(BigInt(v) + 1n);
  try {
    const b = base58(v);
    if (b.length === 32) {
      b[0] ^= 1;
      return enc58(b);
    }
  } catch {}
  return `${v}x`;
}
test("light proof planted: one changed value in any part of any outcome's proof is refused", async () => {
  const parts = new Set();
  let n = 0;
  for (const id of Object.keys(LP.proofs))
    for (const [path, v] of leaves(LP.proofs[id])) {
      if (path.includes("metadata") || path.join(".") === "block_header_lite.inner_lite.timestamp") continue;
      const fx = clone(LP);
      let o = fx.proofs[id];
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)] = changed(v);
      const r = await gateOn(fx);
      assert.deepEqual(r.proven, [], `${id} ${path.join(".")}`);
      assert.match(r.refusals.join("\n"), /not proven: /, `${id} ${path.join(".")}`);
      parts.add(path[0] === "outcome_proof" ? `outcome_proof.${path[1]}` : path[0]);
      n++;
    }
  // the recorded mainnet proof: every path long (its chunk held several outcomes), checked by the same checkProof
  const M = LP.mainnetProof;
  assert.equal(checkProof(M.proof, M.id, base58(M.head.block_merkle_root)).height, M.proof.block_header_lite.inner_lite.height);
  for (const [path, v] of leaves(M.proof)) {
    if (path.includes("metadata") || path.join(".") === "block_header_lite.inner_lite.timestamp") continue;
    const p = clone(M.proof);
    let o = p;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path.at(-1)] = changed(v);
    assert.throws(() => checkProof(p, M.id, base58(M.head.block_merkle_root)), undefined, `mainnet ${path.join(".")}`);
    parts.add(path[0] === "outcome_proof" ? `outcome_proof.${path[1]}` : path[0]);
    n++;
  }
  assert.deepEqual([...parts].sort(), ["block_header_lite", "block_proof", "outcome_proof.block_hash", "outcome_proof.id", "outcome_proof.outcome", "outcome_proof.proof", "outcome_root_proof"]);
  assert.ok(n > 100, `${n} changes`);
});

test("light proof planted: a head dRPC does not know, a changed head root, a wrong-network status, no dRPC host: refused", async () => {
  const unknownHead = { ...clone(LP), headUnknown: true }; // dRPC names a final block it then does not answer by hash
  const root = clone(LP);
  root.head.block_merkle_root = changed(LP.head.block_merkle_root);
  const net = clone(LP);
  net.drpcStatus.chain_id = "mainnet";
  for (const [what, fx, rpcs, why] of [
    ["unknown head", unknownHead, T_RPCS, /not proven: near-testnet\.drpc\.org block: .*UNKNOWN_BLOCK/],
    ["head root", root, T_RPCS, /not proven: .*does not reach the head's block_merkle_root/],
    ["network", net, T_RPCS, /not proven: near-testnet\.drpc\.org status names mainnet, not testnet/],
    ["FastNEAR alone", LP, { "near-testnet": [T_FN, T_ORG] }, /not proven: no FastNEAR read ok, or no dRPC host/],
  ]) {
    const r = await gateOn(fx, rpcs);
    assert.deepEqual(r.proven, [], what);
    assert.match(r.refusals.join("\n"), why, what);
  }
});

// A self-consistent proof set built from the recording with chosen outcomes: each outcome its own block (chunk and
// outcome root paths empty), the blocks the leaves of a four-leaf tree whose root is the head's block_merkle_root.
// It checks the rules on what is proven, not the hashing (the recording and the planted changes above check that).
function built(edit) {
  const fx = clone(LP);
  const ids = Object.keys(fx.proofs);
  edit(fx);
  const blocks = ids.map((id) => {
    const p = fx.proofs[id];
    p.outcome_proof.proof = [];
    p.outcome_root_proof = [];
    p.block_header_lite.inner_lite.outcome_root = enc58(createHash("sha256").update(outcomeLeaf(id, p.outcome_proof.outcome)).digest());
    const h = liteHash(p.block_header_lite);
    p.outcome_proof.block_hash = enc58(h);
    return h;
  });
  while (blocks.length < 4) blocks.push(Buffer.alloc(32));
  const sha = (a, b) => createHash("sha256").update(Buffer.concat([a, b])).digest();
  const pair = [sha(blocks[0], blocks[1]), sha(blocks[2], blocks[3])];
  ids.forEach((id, i) => {
    fx.proofs[id].block_proof = [
      { hash: enc58(blocks[i ^ 1]), direction: i % 2 ? "Left" : "Right" },
      { hash: enc58(pair[1 - (i >> 1)]), direction: i >> 1 ? "Left" : "Right" },
    ];
  });
  fx.head.block_merkle_root = enc58(sha(pair[0], pair[1]));
  return fx;
}
const receiptOf = (fx) => Object.keys(fx.proofs).find((id) => id !== LP.tx.hash);

test("light proof planted: a proven receipt outcome that failed, or is Unknown, is refused; the same set all success passes", async () => {
  assert.equal((await gateOn(built(() => {}))).proven.length, 1, "the built set passes as it is");
  for (const status of [{ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "x" } } } } }, "Unknown"]) {
    const r = await gateOn(built((fx) => void (fx.proofs[receiptOf(fx)].outcome_proof.outcome.status = status)));
    assert.deepEqual(r.proven, [], JSON.stringify(status));
    assert.match(r.refusals.join("\n"), new RegExp(`not proven: ${receiptOf(LP)}: its proven outcome is ${typeof status === "string" ? status : "Failure"}, not a success`), JSON.stringify(status));
  }
  const tx = await gateOn(built((fx) => void (fx.proofs[LP.tx.hash].outcome_proof.outcome.status = { Failure: {} })));
  assert.match(tx.refusals.join("\n"), /not a success/);
});

test("light proof planted: a receipt the tx created that FastNEAR does not prove, or names no receiver for, is refused", async () => {
  const gone = clone(LP);
  delete gone.proofs[receiptOf(gone)];
  assert.match((await gateOn(gone)).refusals.join("\n"), /not proven: .*UNKNOWN_TRANSACTION_OR_RECEIPT/);
  const hidden = clone(LP);
  const rid = receiptOf(hidden);
  hidden.known.receipts_outcome = hidden.known.receipts_outcome.filter((o) => o.id !== rid);
  assert.match((await gateOn(hidden)).refusals.join("\n"), new RegExp(`not proven: ${rid}: a receipt of \\S+ that archival-rpc\\.testnet\\.fastnear\\.com names no receiver for`));
});

test("light proof: reviewer probe A2, FastNEAR naming a false height and time, decides nothing: its proof does", async () => {
  // FastNEAR's own block read says Oct 31 (before the floor): refused as old, as any read says so
  const early = clone(LP);
  early.txBlock.timestamp_nanosec = String(Date.parse("2026-10-31T23:00:00Z") * 1000000);
  assert.match((await gateOn(early)).refusals.join("\n"), /old: 2026-10-31T23:00:00\.000Z/);
  // a proven block before the floor is refused even when FastNEAR's block read says after it
  const provenEarly = built((fx) => void (fx.proofs[LP.tx.hash].block_header_lite.inner_lite.timestamp_nanosec = String(Date.parse("2026-10-31T23:00:00Z") * 1000000)));
  assert.match((await gateOn(provenEarly)).refusals.join("\n"), /proven, but old: 2026-10-31T23:00:00\.000Z/);
  // a proven tx outcome whose signer is not the record's
  const signer = built((fx) => void (fx.proofs[LP.tx.hash].outcome_proof.outcome.executor_id = "someone.testnet"));
  assert.match((await gateOn(signer)).refusals.join("\n"), /its proven signer is someone\.testnet/);
});

// Review round 1 of this card. 1: an outcome proof binds an id, not its kind, so a tx one operator reads is proven only
// with its signed bytes, which hash to its id; a receipt id has none.
test("light proof planted (probe 1): a receipt id written as a Tx, with its real proof served as a tx's, is refused", async () => {
  // noBytes: the vault-testnet-usdc record tx 4LbTb…, whose receipt 2ciqy… FastNEAR proves when asked for it as a tx
  const nb = LP.noBytes;
  const receipt = Object.keys(nb.proofs).find((id) => id !== nb.tx.hash && nb.proofs[id].outcome_proof.outcome.executor_id === nb.tx.signer);
  const fx = { ...clone(nb), tx: { ...nb.tx, hash: receipt } };
  const r = await gateOn(fx);
  assert.deepEqual(r.proven, []);
  // with no bytes, the tx JSON FastNEAR serves for the receipt id names the tx's own hash, so no bytes are rebuilt
  assert.match(r.refusals.join("\n"), new RegExp(`${receipt}: .*not proven: its tx JSON names hash ${nb.tx.hash}, not ${receipt}`));
  // with bytes of a real tx, which hash to that tx, not to the receipt
  const withBytes = await gateOn({ ...fx, tx_bytes: LP.tx_bytes });
  assert.match(withBytes.refusals.join("\n"), new RegExp(`not proven: ${receipt}: its tx bytes do not hash to it`));
  // FastNEAR's answer to a "transaction" request for the failed receipt of the failed tx is that receipt's own proof
  assert.equal(LP.receiptAsTx.proof.outcome_proof.id, LP.failed.known.receipts_outcome[0].id);
});

test("light proof planted: a record tx with no bytes, or bytes that hash to another tx or name another signer, is refused", async () => {
  // no bytes and no block that makes its tx JSON hash to it (tx-rebuild: the stub knows no walk)
  const none = await gateOn({ ...clone(LP), tx_bytes: undefined });
  assert.match(none.refusals.join("\n"), /not proven: no block 1 back from its own/);
  const other = await gateOn({ ...clone(LP), tx_bytes: LP.v1.tx_bytes });
  assert.match(other.refusals.join("\n"), new RegExp(`not proven: ${LP.tx.hash}: its tx bytes do not hash to it`));
  const flipped = Buffer.from(LP.tx_bytes, "base64");
  flipped[flipped.length - 1] ^= 1;
  assert.match((await gateOn({ ...clone(LP), tx_bytes: flipped.toString("base64") })).refusals.join("\n"), /its tx bytes do not hash to it/);
  assert.match((await gateOn({ ...clone(LP), tx_bytes: `${LP.tx_bytes}!` })).refusals.join("\n"), /bytes that are not base64/);
  const signer = clone(LP);
  signer.tx.signer = "someone.testnet";
  assert.match((await gateOn(signer)).refusals.join("\n"), /its tx bytes name signer mglp-\d+\.testnet, not someone\.testnet/);
});

test("light proof: V0 and V1 Transaction bytes of real recorded txs hash to their ids and name their signer and receiver", async () => {
  for (const [fx, v] of [[LP, 0], [LP.v1, 1], [LP.failed, 0]]) {
    const f = txBytesFacts(fx.tx_bytes, fx.tx.hash);
    assert.deepEqual(f, { signer: fx.tx.signer, receiver: fx.tx.signer, version: v });
  }
  const r = await gateOn(LP.v1);
  assert.deepEqual(r.refusals, []);
  assert.match(r.proven[0], new RegExp(`near-testnet ${LP.v1.tx.hash} \\(V1, ${LP.v1.tx.signer} to ${LP.v1.tx.signer}\\): 3 outcome\\(s\\)`));
  // a key type the check does not read (ML-DSA, tag 2) is refused even when the bytes hash right
  const b = Buffer.from(LP.tx_bytes, "base64");
  b[4 + b.readUInt32LE(0)] = 2;
  const id = enc58(createHash("sha256").update(b).digest());
  assert.throws(() => txBytesFacts(b.toString("base64"), id), /a key type/);
});

// 2: the proof's id is compared with the id asked
test("light proof planted (probe 2): a failed receipt answered with another receipt's real success proof is refused", async () => {
  const fx = clone(LP.failed);
  const [failedId, okId] = fx.known.receipts_outcome.map((o) => o.id);
  assert.equal(Object.keys(fx.proofs[failedId].outcome_proof.outcome.status)[0], "Failure");
  fx.proofs[failedId] = fx.proofs[okId];
  // FastNEAR's tx status hides the failure, as a lying host would
  fx.known.status = { SuccessValue: "" };
  fx.known.receipts_outcome = fx.known.receipts_outcome.map((o) => ({ ...o, outcome: { ...o.outcome, status: { SuccessValue: "" } } }));
  const r = await gateOn(fx);
  assert.deepEqual(r.proven, []);
  assert.match(r.refusals.join("\n"), new RegExp(`not proven: a proof for ${okId}, not ${failedId}`));
});

// 5: a real Failure outcome: the Failure discriminant (1, no detail) hashes to the chain's own root
test("light proof: the recorded real failed receipt's proof checks out with its Failure status, and the tx is refused for it", async () => {
  const fx = LP.failed;
  const failedId = fx.known.receipts_outcome[0].id;
  const p = checkProof(fx.proofs[failedId], failedId, base58(fx.head.block_merkle_root));
  assert.equal(Object.keys(p.outcome.status)[0], "Failure");
  // the same proof with the status read as a success no longer reaches the root
  const lie = clone(fx.proofs[failedId]);
  lie.outcome_proof.outcome.status = { SuccessValue: "" };
  assert.throws(() => checkProof(lie, failedId, base58(fx.head.block_merkle_root)), /does not reach its block's outcome_root/);
  // FastNEAR's honest tx status says failed: refused as failed; a lying one meets the proven Failure
  assert.match((await gateOn(fx)).refusals.join("\n"), /failed on https:\/\/archival-rpc\.testnet\.fastnear\.com/);
  const liar = clone(fx);
  liar.known.status = { SuccessValue: "" };
  liar.known.receipts_outcome = liar.known.receipts_outcome.map((o) => ({ ...o, outcome: { ...o.outcome, status: { SuccessValue: "" } } }));
  assert.match((await gateOn(liar)).refusals.join("\n"), new RegExp(`not proven: ${failedId}: its proven outcome is Failure, not a success`));
});

// 4: the outcome cap
test("light proof: more outcomes than the cap are refused (cap 2 against the recording's 3; the gate's cap is 200)", async () => {
  const s = proofHosts(LP);
  await assert.rejects(proveNearTx(s.fetchFn, LP.tx, T_FN, T_DR, LP.known, s.sleep, 2), /more than 2 outcomes/);
  assert.equal((await proveNearTx(s.fetchFn, LP.tx, T_FN, T_DR, LP.known, s.sleep, 3)).outcomes, 3);
});

// Review round 2 of this card: the default cap, the tx-bytes file's loader and the version tag, each planted.
// A self-consistent tx whose outcome names n receipts, each its own block, the blocks the leaves of one Merkle tree
// whose root is the head's block_merkle_root (as built() does for four).
function builtMany(n) {
  const fx = clone(LP);
  const sha = (...b) => createHash("sha256").update(Buffer.concat(b)).digest();
  const ids = Array.from({ length: n }, (_, i) => enc58(sha(Buffer.from(`receipt ${i}`))));
  const template = fx.proofs[receiptOf(LP)];
  const tx = fx.proofs[LP.tx.hash];
  tx.outcome_proof.outcome.receipt_ids = ids;
  fx.proofs = { [LP.tx.hash]: tx };
  for (const id of ids) {
    const p = clone(template);
    p.outcome_proof.id = id;
    p.outcome_proof.outcome.receipt_ids = [];
    p.outcome_proof.outcome.status = { SuccessValue: "" };
    fx.proofs[id] = p;
  }
  fx.known.receipts_outcome = ids.map((id) => ({ id, outcome: { executor_id: LP.tx.signer, status: { SuccessValue: "" } } }));
  const all = [LP.tx.hash, ...ids];
  let level = all.map((id) => {
    const p = fx.proofs[id];
    p.outcome_proof.proof = [];
    p.outcome_root_proof = [];
    p.block_header_lite.inner_lite.outcome_root = enc58(sha(outcomeLeaf(id, p.outcome_proof.outcome)));
    const h = liteHash(p.block_header_lite);
    p.outcome_proof.block_hash = enc58(h);
    p.block_proof = [];
    return h;
  });
  while (level.length & (level.length - 1)) level.push(Buffer.alloc(32));
  const at = all.map((_, i) => i);
  while (level.length > 1) {
    all.forEach((id, k) => {
      const i = at[k];
      fx.proofs[id].block_proof.push({ hash: enc58(level[i ^ 1]), direction: i % 2 ? "Left" : "Right" });
      at[k] = i >> 1;
    });
    level = Array.from({ length: level.length / 2 }, (_, i) => sha(level[2 * i], level[2 * i + 1]));
  }
  fx.head.block_merkle_root = enc58(level[0]);
  return fx;
}

test("light proof: the gate's own cap (no cap passed) proves 200 outcomes and refuses 201", async () => {
  const ok = builtMany(199);
  const s = proofHosts(ok);
  assert.equal((await proveNearTx(s.fetchFn, ok.tx, T_FN, T_DR, ok.known, s.sleep)).outcomes, 200);
  const over = builtMany(200);
  const t = proofHosts(over);
  await assert.rejects(proveNearTx(t.fetchFn, over.tx, T_FN, T_DR, over.known, t.sleep), /more than 200 outcomes/);
});

test("light proof planted: a tx-bytes file that is a symlink, a folder, not JSON or not an object of strings is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "money-gate-"));
  try {
    mkdirSync(join(dir, "scripts/live-checks"), { recursive: true });
    writeFileSync(join(dir, "scripts/live-checks/card.md"), `CARD card / live: PASS\nMoney path: yes\nTx: near-testnet ${LP.tx.hash} ${LP.tx.signer}\n`);
    const side = join(dir, "scripts/live-checks/card.tx-bytes.json");
    const good = JSON.stringify({ [LP.tx.hash]: LP.tx_bytes });
    const loaded = () => recordsFrom(dir, ["--all"]).records[0];
    writeFileSync(side, good);
    assert.deepEqual([loaded().bytes, loaded().bytesProblem], [{ [LP.tx.hash]: LP.tx_bytes }, undefined], "a regular file of base64 strings is read");
    for (const [what, body, want] of [
      ["an array", JSON.stringify([LP.tx_bytes]), /not a tx-bytes object/],
      ["a number value", JSON.stringify({ [LP.tx.hash]: 5 }), /not a tx-bytes object/],
      ["null", "null", /not a tx-bytes object/],
      ["a number", "5", /not a tx-bytes object/],
      ["a string", JSON.stringify(LP.tx_bytes), /not a tx-bytes object/],
      ["true", "true", /not a tx-bytes object/],
      ["malformed JSON", good.slice(0, -1), /not a tx-bytes object/],
    ]) {
      writeFileSync(side, body);
      assert.equal(loaded().bytes, undefined, what);
      assert.match(loaded().bytesProblem ?? "", want, what);
    }
    rmSync(side);
    writeFileSync(join(dir, "elsewhere.json"), good);
    symlinkSync("../../elsewhere.json", side);
    assert.match(loaded().bytesProblem ?? "", /a symlink, not a regular file/);
    assert.equal(loaded().bytes, undefined);
    // the gate refuses the record's tx-bytes file by name
    const s = proofHosts(LP);
    const r = await moneyGate([loaded()], s.fetchFn, T_RPCS, { sleep: s.sleep });
    assert.match(r.refusals.join("\n"), /scripts\/live-checks\/card\.tx-bytes\.json: a symlink, not a regular file/);
    unlinkSync(side);
    mkdirSync(side);
    assert.match(loaded().bytesProblem ?? "", /not a file, not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("light proof planted: tx bytes whose version tag is neither V0's nor 1 are refused, even when they hash to the id", () => {
  for (const tag of [2, 0xff]) {
    const b = Buffer.from(LP.v1.tx_bytes, "base64");
    b[0] = tag;
    const id = enc58(createHash("sha256").update(b).digest());
    assert.throws(() => txBytesFacts(b.toString("base64"), id), new RegExp(`version tag ${tag}`));
  }
});

// Card money-gate-rate: near.org's testnet archive answers 429 with a Retry-After of about 279 s (read 2026-11-01), and
// a record lists many txs. Hosts are asked in order; while fewer than two have read a tx ok, a 429 is waited out as
// above. Once two have, a remaining host is still asked once, but its 429 is no answer: not waited, not decisive, named.
// A failed or old answer from a host that does answer still refuses. Stub hosts t1, t2, t3 (no URL, so no pacing wait).
function threeHosts(answer) {
  const log = [];
  const fetchFn = async (url, init) => {
    const { method } = JSON.parse(init.body);
    log.push(`ask ${url} ${method}`);
    const json = (status, body, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });
    const a = answer(url, method);
    if (a === 429) return json(429, { error: { code: -429, message: "rate limited" } }, { "retry-after": "279" });
    return json(200, { jsonrpc: "2.0", id: 1, ...(a ?? chainAnswers(NOV2)(url, method)) });
  };
  const sleep = async (ms) => void log.push(`sleep ${ms}`);
  return { fetchFn, sleep, log };
}
const T3 = { "near-testnet": ["t1", "t2", "t3"] };
const testnetRec = rec(`Money path: yes\nTx: near-testnet ${NEAR_TX} ${TESTNET_SIGNER}\n`);
const NOT_WAITED = `near-testnet ${NEAR_TX} on t3: rate limited, not waited: its read could add no second operator`;

test("two hosts read ok and the third answers 429 with Retry-After 279: passes, never sleeps, names the skip", async () => {
  const s = threeHosts((url) => (url === "t3" ? 429 : null));
  const r = await moneyGate(testnetRec, s.fetchFn, T3, { sleep: s.sleep });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.read, ["t1", "t2"].map((u) => `near-testnet ${NEAR_TX} ok on ${u} (testnet, not real-money proof)`));
  assert.deepEqual(s.log.filter((l) => l.startsWith("sleep")), []);
  assert.equal(s.log.filter((l) => l === "ask t3 EXPERIMENTAL_tx_status").length, 1);
  assert.deepEqual(r.notes, [NOT_WAITED]);
});

test("two hosts read ok and the third reads the tx as failed: refused", async () => {
  const s = threeHosts((url, method) =>
    url === "t3" && method === "EXPERIMENTAL_tx_status"
      ? { result: { final_execution_status: "FINAL", status: { Failure: {} }, receipts: [], receipts_outcome: [], transaction_outcome: { block_hash: "h" } } }
      : null,
  );
  const r = await moneyGate(testnetRec, s.fetchFn, T3, { sleep: s.sleep });
  assert.match(r.refusals.join("\n"), new RegExp(`near-testnet ${NEAR_TX}: ok on t1, ok on t2, failed on t3$`));
});

test("one host read ok and the second answers 429 then ok: the gate waits out its Retry-After and passes", async () => {
  let second = 0;
  const s = threeHosts((url) => (url === "t2" && second++ === 0 ? 429 : null));
  const r = await moneyGate(testnetRec, s.fetchFn, T3, { sleep: s.sleep });
  assert.deepEqual(r.refusals, []);
  assert.equal(r.read.length, 3);
  assert.deepEqual(s.log.slice(s.log.indexOf("ask t2 EXPERIMENTAL_tx_status"), s.log.indexOf("ask t2 EXPERIMENTAL_tx_status") + 3), ["ask t2 EXPERIMENTAL_tx_status", "sleep 279000", "ask t2 EXPERIMENTAL_tx_status"]);
});

// Card delete-refund-readback: a one-use account that deletes itself into its funder. The fixture is the real
// EXPERIMENTAL_tx_status answer for mainnet Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM (rpc.mainnet.near.org,
// wait_until NONE, 2026-11-01; its one signature replaced, as the live checks' recordings do): FINAL, SuccessValue, the
// beneficiary Transfer 9wEBNxb1a7 ok, NEAR's gas refund GBkJTsykxG from system to the deleted signer failed
// AccountDoesNotExist. That refund is the one failed receipt the gate passes; every variant below is refused.
const DEL = JSON.parse(readFileSync(new URL("./fixtures/near-delete-refund.json", import.meta.url), "utf8"));
const DEL_TX = DEL.result.transaction.hash;
const DEL_A = DEL.result.transaction.signer_id;
const DEL_F = DEL.result.transaction.actions[0].DeleteAccount.beneficiary_id;
const REFUND = "GBkJTsykxGSHckvi8iCSwLwXiQScxBgbJGTmQp9VMXsB";
const PAYOUT = "9wEBNxb1a7uLm782NfH4eUyiYqAkRC37ArpT7feKxNgL";
const delRec = rec(`Money path: yes\nTx: near ${DEL_TX} ${DEL_A}\n`);
// the fixture, changed by `edit`, for every way the tx is asked; `asked` keeps each method and its params
function delStub(edit = () => {}) {
  const asked = [];
  const answer = structuredClone(DEL);
  edit(answer.result);
  const fetchFn = stub((url, method) => (method === "tx" || method === "EXPERIMENTAL_tx_status" ? answer : chainAnswers(NOV2)(url, method)));
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push({ method, params });
    return fetchFn(url, init);
  };
  return { fetchFn: wrapped, asked };
}
const receipt = (r, id) => r.receipts.find((x) => x.receipt_id === id);
const outcome = (r, id) => r.receipts_outcome.find((x) => x.id === id);

test("delete refund: the real answer for Dw1nb reads ok on two RPCs, asked by EXPERIMENTAL_tx_status with wait_until NONE", async () => {
  assert.equal(DEL.result.final_execution_status, "FINAL");
  assert.deepEqual(outcome(DEL.result, REFUND).outcome.status, { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: DEL_A } } } } });
  const s = delStub();
  const r = await moneyGate(delRec, s.fetchFn, RPCS);
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.read, [`near ${DEL_TX} ok on n1`, `near ${DEL_TX} ok on n2`]);
  const reads = s.asked.filter((a) => a.method !== "block");
  assert.deepEqual(reads.map((a) => a.method), ["EXPERIMENTAL_tx_status", "EXPERIMENTAL_tx_status"]);
  for (const a of reads) assert.deepEqual(a.params, { tx_hash: DEL_TX, sender_account_id: DEL_A, wait_until: "NONE" });
});

const refused = async (edit, why) => {
  const r = await moneyGate(delRec, delStub(edit).fetchFn, RPCS);
  assert.deepEqual(r.read, []);
  assert.match(r.refusals.join("\n"), why);
};
const FAILED = new RegExp(`near ${DEL_TX}: failed \\(a receipt failed\\) on n1, failed \\(a receipt failed\\) on n2`);

test("delete refund: the refund sent by any account other than system is refused", async () => {
  for (const by of [DEL_A, DEL_F, "intents.near", "System", ""]) await refused((r) => void (receipt(r, REFUND).predecessor_id = by), FAILED);
  await refused((r) => void delete receipt(r, REFUND).predecessor_id, FAILED);
});

test("delete refund: the refund to any other receiver is refused, even when the failure names that receiver", async () => {
  await refused((r) => void (receipt(r, REFUND).receiver_id = DEL_F), FAILED);
  await refused((r) => {
    receipt(r, REFUND).receiver_id = DEL_F;
    outcome(r, REFUND).outcome.status.Failure.ActionError.kind.AccountDoesNotExist.account_id = DEL_F;
  }, FAILED);
});

test("delete refund: a refund with two actions, or with one action that is not a lone Transfer, is refused", async () => {
  await refused((r) => void receipt(r, REFUND).receipt.Action.actions.push({ Transfer: { deposit: "1" } }), FAILED);
  await refused((r) => void (receipt(r, REFUND).receipt.Action.actions = []), FAILED);
  await refused((r) => void (receipt(r, REFUND).receipt.Action.actions = [{ FunctionCall: { method_name: "x", args: "", gas: 1, deposit: "0" } }]), FAILED);
  await refused((r) => void (receipt(r, REFUND).receipt.Action.actions = [{ Transfer: { deposit: "1" }, DeleteAccount: { beneficiary_id: DEL_F } }]), FAILED);
});

test("delete refund: another failure kind, or AccountDoesNotExist naming another account, is refused", async () => {
  const kind = (k) => (r) => void (outcome(r, REFUND).outcome.status.Failure.ActionError.kind = k);
  await refused(kind({ LackBalanceForState: { account_id: DEL_A, amount: "1" } }), FAILED);
  await refused(kind({ AccountDoesNotExist: { account_id: DEL_F } }), FAILED);
  await refused(kind({ AccountDoesNotExist: {} }), FAILED);
  await refused((r) => void (outcome(r, REFUND).outcome.status = { Failure: { InvalidTxError: { InvalidSignerId: { signer_id: DEL_A } } } }), FAILED);
});

test("delete refund: in a tx with no DeleteAccount, or whose signer is not its receiver, the same refund is refused", async () => {
  await refused((r) => void (r.transaction.actions = [{ Transfer: { deposit: "1" } }]), FAILED);
  await refused((r) => void (r.transaction.receiver_id = DEL_F), FAILED);
  await refused((r) => void delete r.transaction, FAILED);
});

test("delete refund: a failed beneficiary Transfer is refused", async () => {
  await refused((r) => void (outcome(r, PAYOUT).outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: DEL_F } } } } }), FAILED);
});

test("delete refund: a second refund-shaped failure is refused (one is passed, never two)", async () => {
  await refused((r) => {
    r.receipts.push({ ...structuredClone(receipt(r, REFUND)), receipt_id: "Extra1111111111111111111111111111111111111" });
    r.receipts_outcome.push({ ...structuredClone(outcome(r, REFUND)), id: "Extra1111111111111111111111111111111111111" });
  }, FAILED);
  // two receipts listed under the refund's id: not that refund
  await refused((r) => void r.receipts.push(structuredClone(receipt(r, REFUND))), FAILED);
});

// P10: NEAR's DeleteAccount pays the balance out as a receipt from system with one Transfer, the same shape as the gas
// refund; nothing stops beneficiary = the account itself, so that payout fails AccountDoesNotExist naming the signer and
// the balance burns. A gas refund carries the tx's signer in receipt.Action.signer_id; a balance payout carries system
// (the fixture: GBkJTsykxG signer_id = the account, 9wEBNxb1a7 signer_id = system).
const selfPayout = (r) => {
  r.transaction.actions[0].DeleteAccount.beneficiary_id = DEL_A;
  receipt(r, PAYOUT).receiver_id = DEL_A;
  outcome(r, PAYOUT).outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: DEL_A } } } } };
};
const noGasRefund = (r) => {
  r.receipts = r.receipts.filter((x) => x.receipt_id !== REFUND);
  r.receipts_outcome = r.receipts_outcome.filter((x) => x.id !== REFUND);
  for (const o of r.receipts_outcome) o.outcome.receipt_ids = o.outcome.receipt_ids.filter((id) => id !== REFUND);
};

test("delete refund P10b: a DeleteAccount whose beneficiary is the account itself, its balance payout failed and no gas refund, is refused", async () => {
  assert.equal(receipt(DEL.result, REFUND).receipt.Action.signer_id, DEL_A);
  assert.equal(receipt(DEL.result, PAYOUT).receipt.Action.signer_id, "system");
  await refused((r) => {
    selfPayout(r);
    noGasRefund(r);
  }, FAILED);
});

test("delete refund P10a: beneficiary = the account itself with the gas refund present (two failures) is refused", async () => {
  await refused(selfPayout, FAILED);
});

test("delete refund: the refund whose receipt signer is system or missing, not the deleted account, is refused", async () => {
  for (const by of ["system", DEL_F, ""]) await refused((r) => void (receipt(r, REFUND).receipt.Action.signer_id = by), FAILED);
  await refused((r) => void delete receipt(r, REFUND).receipt.Action.signer_id, FAILED);
});

test("delete refund: an answer with no receipts list, no receipts_outcome, or no receipt for the failed outcome is not ok", async () => {
  const INCOMPLETE = new RegExp(`near ${DEL_TX}: incomplete \\(no receipts or receipts_outcome list\\) on n1, incomplete \\(no receipts or receipts_outcome list\\) on n2`);
  await refused((r) => void delete r.receipts, INCOMPLETE);
  await refused((r) => void delete r.receipts_outcome, INCOMPLETE);
  await refused((r) => void (r.receipts = r.receipts.filter((x) => x.receipt_id !== REFUND)), FAILED);
});

// Card money-gate-tx-rebuild: a NEAR tx one operator reads is proven from its id alone: its signed bytes are rebuilt
// from FastNEAR's own tx JSON and must hash to the id. The recording (money-gate.tx-rebuild.json) holds real txs read
// 2026-11-01 on FastNEAR archival: every vault-testnet-usdc record tx (the faucet's included), the mainnet delete sweep
// Dw1nb, the light-proof recording's V0 and V1 transfers, a testnet DeleteKey, a mainnet AddKey with a FunctionCall
// permission (openrail D2zix) and two mainnet SWEAT relayer meta txs
// (Delegate holding AddKey, and holding FunctionCall); for each, its tx status as served (read with exactJson: one
// Delegate's max_block_height is u64::MAX),
// the blocks walked back from its own (hash -> prev_hash) and, for the one DeployContract, its view_code answer.
// A Delegate's signature (hashed in the tx) is kept as ed25519-hex:<hex>, since the secret-key scan reads any
// ed25519:<64 bytes base58> as a secret key; the top-level signature (not hashed) is not kept.
const TR = exactJson(readFileSync(new URL("./money-gate.tx-rebuild.json", import.meta.url), "utf8"));
for (const t of TR.txs) for (const a of t.known.transaction.actions) if (a.Delegate) a.Delegate.signature = `ed25519:${enc58(Buffer.from(a.Delegate.signature.replace(/^ed25519-hex:/, ""), "hex"))}`;
const trTx = (id) => TR.txs.find((t) => t.id === id);
// FastNEAR answers from the recording: a block it walked, and the deployed code at the block its receipt ran in
function walkHost(t) {
  const log = [];
  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    log.push(`${method} ${params.block_id ?? ""}`);
    const json = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ jsonrpc: "2.0", id: 1, ...body }) });
    if (method === "block" && Object.hasOwn(t.blocks, params.block_id)) return json({ result: { header: { hash: params.block_id, prev_hash: t.blocks[params.block_id] } } });
    const ran = t.known.receipts_outcome.find((o) => o.id === t.known.transaction_outcome.outcome.receipt_ids[0]);
    if (method === "query" && t.code && params.request_type === "view_code" && params.account_id === t.known.transaction.receiver_id && params.block_id === ran?.block_hash)
      return json({ result: { code_base64: t.code } });
    return json(UNKNOWN_BLOCK);
  };
  return { fetchFn, log, sleep: async () => {} };
}
const rebuilt = (t, known = t.known) => {
  const s = walkHost(t);
  return findTxBytes(s.fetchFn, t.host, t.id, known, s.sleep);
};
const kindsOf = (t) => t.known.transaction.actions.map((a) => (typeof a === "string" ? a : Object.keys(a)[0]));

test("tx rebuild: every recorded real tx rebuilds from its own tx JSON to its id; every rebuilt kind and both versions are pinned", async () => {
  const kinds = new Set();
  const versions = new Set();
  for (const t of TR.txs) {
    const { bytes, back } = await rebuilt(t);
    const f = txBytesFacts(bytes, t.id);
    assert.equal(f.signer, t.signer, t.id);
    assert.equal(f.receiver, t.known.transaction.receiver_id, t.id);
    assert.ok(back >= 1 && back <= 10, `${t.id} ${back}`);
    for (const k of kindsOf(t)) kinds.add(k);
    for (const a of t.known.transaction.actions) {
      if (a.AddKey) kinds.add(`AddKey ${Object.keys(a.AddKey.access_key.permission === "FullAccess" ? { FullAccess: 1 } : a.AddKey.access_key.permission)[0]}`);
      for (const x of a.Delegate?.delegate_action.actions ?? []) kinds.add(`Delegate ${Object.keys(x)[0]}`);
    }
    versions.add(f.version);
  }
  assert.deepEqual([...kinds].sort(), ["AddKey", "AddKey FullAccess", "AddKey FunctionCall", "CreateAccount", "Delegate", "Delegate AddKey", "Delegate FunctionCall", "DeleteAccount", "DeleteKey", "DeployContract", "FunctionCall", "Transfer"]);
  assert.equal(trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn").known.transaction.actions[0].Delegate.delegate_action.max_block_height, "18446744073709551615");
  assert.deepEqual([...versions].sort(), [0, 1]);
  // every tx of the testnet USDC record, the faucet's (signer testnet) included, and the mainnet delete sweep
  const record = readFileSync(new URL("../live-checks/vault-testnet-usdc.md", import.meta.url), "utf8");
  const ids = [...record.matchAll(/^Tx: near-testnet (\S+) (\S+)$/gm)].map((m) => m[1]);
  assert.equal(ids.length, 26);
  for (const id of [...ids, "Dw1nbvYGcjXs3HocsCxxz1GXr6wH8QNUkQV5FxffJPrM"]) assert.ok(trTx(id), id);
  assert.equal(trTx("4Twid1qBm8SxHNFR3s7mvmGTS39rUwZRKMw8iG3oAyYx").signer, "testnet");
  assert.equal(trTx("GRLgfCnH5or6pC2VVykbD6aTwDdtNXKmXbbKMuP9YExp").known.transaction.nonce_index, undefined, "a V1 tx with a plain nonce has a V0-shaped view");
});

// every value of a tx JSON changed: a number one more, a digit string one more, base64 or a key with one bit flipped,
// any other string one letter longer. The signature is not part of the signed bytes' hash (transaction.rs:144-146 hashes
// the Transaction alone), so it is never read: changing it changes nothing.
function mutate(path, v) {
  if (typeof v === "number") return v + 1;
  if (/^\d+$/.test(v)) return v === "18446744073709551615" ? "18446744073709551614" : String(BigInt(v) + 1n);
  const key = /^(ed25519|secp256k1):(.+)$/.exec(v);
  if (key) {
    const b = base58(key[2], 100);
    b[b.length - 1] ^= 1;
    return `${key[1]}:${enc58(b)}`;
  }
  if (["args", "code"].includes(path.at(-1))) {
    const b = Buffer.from(v, "base64");
    b[b.length - 1] ^= 1;
    return b.toString("base64");
  }
  return `${v}x`;
}
test("tx rebuild planted: one changed value anywhere in any recorded tx's JSON is refused (nonce, receiver, an arg byte, a deposit, a key, a code hash)", async () => {
  const fields = new Set();
  let n = 0;
  // one tx per shape of actions (a Delegate by the kinds it holds) per network, and the V1 tx
  const shape = (x) => `${x.network} ${JSON.stringify(x.known.transaction.actions.map((a) => (typeof a === "string" ? a : a.Delegate ? a.Delegate.delegate_action.actions.map((d) => Object.keys(d)[0]) : Object.keys(a)[0])))}`;
  for (const t of TR.txs.filter((x, i, all) => all.findIndex((y) => shape(y) === shape(x)) === i || x.id === "GRLgfCnH5or6pC2VVykbD6aTwDdtNXKmXbbKMuP9YExp"))
    for (const [path, v] of leaves(t.known.transaction)) {
      if (path.length === 1 && path[0] === "signature") continue;
      const known = clone(t.known);
      let o = known.transaction;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)] = mutate(path, v);
      await assert.rejects(rebuilt(t, known), /names hash|no block \d+ back|UNKNOWN_BLOCK|priority_fee 1, not 0|does not rebuild|no code read back|not an account id|is not base64|not a u|that is not ed25519|not \d+ bytes|not a base58|code hash is not 32 bytes/, `${t.id} ${path.join(".")}`);
      fields.add(path.filter((k) => typeof k === "string" && !/^\d+$/.test(k)).join("."));
      n++;
    }
  for (const f of ["nonce", "receiver_id", "signer_id", "public_key", "hash", "actions.FunctionCall.args", "actions.FunctionCall.deposit", "actions.FunctionCall.gas", "actions.FunctionCall.method_name", "actions.Transfer.deposit", "actions.AddKey.public_key", "actions.AddKey.access_key.nonce", "actions.DeployContract.code", "actions.DeleteKey.public_key", "actions.DeleteAccount.beneficiary_id", "actions.AddKey.access_key.permission.FunctionCall.allowance", "actions.AddKey.access_key.permission.FunctionCall.receiver_id", "actions.AddKey.access_key.permission.FunctionCall.method_names", "actions.Delegate.signature", "actions.Delegate.delegate_action.max_block_height", "actions.Delegate.delegate_action.nonce", "actions.Delegate.delegate_action.public_key", "actions.Delegate.delegate_action.sender_id", "actions.Delegate.delegate_action.receiver_id", "actions.Delegate.delegate_action.actions.AddKey.public_key", "actions.Delegate.delegate_action.actions.FunctionCall.args"])
    assert.ok(fields.has(f), f);
  assert.ok(n > 40, `${n} changes`);
  // the signature is not hashed: a changed one still rebuilds the same bytes
  const t = TR.txs[0];
  const sig = clone(t.known);
  const v = sig.transaction.signature;
  sig.transaction.signature = `${v.slice(0, -1)}${v.at(-1) === "2" ? "3" : "2"}`;
  assert.equal((await rebuilt(t, sig)).bytes, (await rebuilt(t)).bytes);
});

test("tx rebuild planted: a changed block on the walk, its own block hash, or one byte of the deployed code is refused", async () => {
  const t = trTx("6oFdTV6xQ5gMnDyf4jd2TJDL1qgyn2CeS583aGdyRQgf");
  const { back } = await rebuilt(t);
  // the block the bytes hash with, read back with another prev_hash on the way: the walk never reaches it
  const walk = clone(t);
  const first = t.known.transaction_outcome.block_hash;
  walk.blocks[first] = changed(walk.blocks[first]);
  await assert.rejects(rebuilt(walk), /no block|UNKNOWN_BLOCK/);
  // its own block named as another: the walk starts elsewhere
  const own = clone(t.known);
  own.transaction_outcome.block_hash = changed(first);
  await assert.rejects(rebuilt(t, own), /UNKNOWN_BLOCK/);
  // a walk cut short of the right block: refused at the cap
  const s = walkHost(t);
  await assert.rejects(findTxBytes(s.fetchFn, t.host, t.id, t.known, s.sleep, back - 1), new RegExp(`no block from its own back ${back - 1} makes its tx JSON hash to it: .*keep its tx-bytes file`));
  // a cap of exactly its depth reaches it
  assert.equal((await findTxBytes(s.fetchFn, t.host, t.id, t.known, s.sleep, back)).back, back);
  // the deployed code, read back with one byte changed: its hash is no longer the view's
  const d = clone(trTx("HVkQ7DY9pYjCiuKeXdCPencjHyzwzs3NBUVzSHgHEK7m"));
  const c = Buffer.from(d.code, "base64");
  c[100] ^= 1;
  d.code = c.toString("base64");
  await assert.rejects(rebuilt(d), /a DeployContract action: no code read back that hashes to/);
});

test("tx rebuild planted: an unknown or unpinned action kind, an unknown field, a permission or a key type no tx pins is refused before any block is read", async () => {
  const t = trTx("4Twid1qBm8SxHNFR3s7mvmGTS39rUwZRKMw8iG3oAyYx"); // CreateAccount, Transfer, AddKey
  const pk = t.known.transaction.public_key;
  const cases = [
    ["an unknown kind", (x) => x.actions.push({ NoSuchAction: {} }), /an action kind this check does not rebuild: NoSuchAction/],
    ["Stake (no pin)", (x) => x.actions.push({ Stake: { stake: "1", public_key: pk } }), /an action kind this check does not rebuild: Stake/],
    ["a Delegate holding a kind not pinned there", (x) => x.actions.push({ Delegate: { ...clone(trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn").known.transaction.actions[0].Delegate), delegate_action: { ...trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn").known.transaction.actions[0].Delegate.delegate_action, actions: [{ Transfer: { deposit: "1" } }] } } }), /an action inside a Delegate this check does not rebuild: \{"Transfer"/],
    ["a Delegate inside a Delegate", (x) => x.actions.push({ Delegate: { ...clone(trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn").known.transaction.actions[0].Delegate), delegate_action: { ...trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn").known.transaction.actions[0].Delegate.delegate_action, actions: [clone(trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn").known.transaction.actions[0])] } } }), /an action inside a Delegate this check does not rebuild: \{"Delegate"/],
    ["a secp256k1 key (no pin)", (x) => (x.public_key = `secp256k1:${enc58(Buffer.alloc(64, 7))}`), /a public key secp256k1:\S+ that is not ed25519/],
    ["UseGlobalContract (no pin)", (x) => x.actions.push({ UseGlobalContract: { code_hash: t.id } }), /does not rebuild: UseGlobalContract/],
    ["DeployGlobalContract (no pin)", (x) => x.actions.push({ DeployGlobalContract: { code: "AA==" } }), /does not rebuild: DeployGlobalContract/],
    ["TransferToGasKey (no pin)", (x) => x.actions.push({ TransferToGasKey: { public_key: pk, deposit: "1" } }), /does not rebuild: TransferToGasKey/],
    ["DelegateV2 (no pin)", (x) => x.actions.push({ DelegateV2: {} }), /does not rebuild: DelegateV2/],
    ["CreateAccount as an object", (x) => (x.actions[0] = { CreateAccount: {} }), /does not rebuild: CreateAccount/],
    ["two kinds in one action", (x) => (x.actions[1] = { Transfer: { deposit: "1" }, DeleteKey: { public_key: pk } }), /an action this check does not rebuild/],
    ["a FunctionCall permission with no allowance (no pin)", (x) => (x.actions[2].AddKey.access_key.permission = { FunctionCall: { allowance: null, receiver_id: "a.testnet", method_names: [] } }), /with a permission this check does not rebuild/],
    ["a gas-key permission", (x) => (x.actions[2].AddKey.access_key.permission = { GasKeyFullAccess: { balance: "0", num_nonces: 1 } }), /with a permission this check does not rebuild/],
    ["an extra field in an action", (x) => (x.actions[1].Transfer.memo = "x"), /a Transfer action has fields deposit,memo, not deposit/],
    ["a missing field in an action", (x) => delete x.actions[2].AddKey.access_key.nonce, /access_key has fields permission, not nonce,permission/],
    ["an unknown tx field", (x) => (x.block_hash = t.known.transaction_outcome.block_hash), /a field this check does not rebuild: block_hash/],
    ["a missing tx field", (x) => delete x.receiver_id, /its tx JSON has no receiver_id/],
    ["a priority fee", (x) => (x.priority_fee = 1), /priority_fee 1, not 0/],
    ["an ML-DSA key", (x) => (x.public_key = `mldsa65:${x.public_key.split(":")[1]}`), /a public key mldsa65:\S+ that is not ed25519/],
    ["a nonce past 2^53", (x) => (x.nonce = 2 ** 53 + 2), /not a u64/],
  ];
  for (const [what, edit, why] of cases) {
    const known = clone(t.known);
    edit(known.transaction);
    const s = walkHost(t);
    await assert.rejects(findTxBytes(s.fetchFn, t.host, t.id, known, s.sleep), why, what);
    assert.deepEqual(s.log, [], what);
  }
});

test("tx rebuild: a V1 tx with a plain nonce, whose view is V0-shaped, rebuilds as V1; a view with nonce_index or nonce_mode (a gas-key tx, no pin) is refused", async () => {
  const v0 = trTx("5JBe7TqfYjEb4FbKHRx2QuE2fnVYcWCoQ12SW9TeLrN6");
  const v1 = trTx("GRLgfCnH5or6pC2VVykbD6aTwDdtNXKmXbbKMuP9YExp");
  assert.equal(txBytesFacts((await rebuilt(v0)).bytes, v0.id).version, 0);
  assert.equal(txBytesFacts((await rebuilt(v1)).bytes, v1.id).version, 1);
  assert.equal(rebuildTx(v0.known.transaction, v0.known.transaction_outcome.block_hash).length, 2, "a plain view: V0 and V1 tried");
  for (const extra of [{ nonce_index: 0 }, { nonce_mode: "strict" }]) {
    const known = clone(v1.known);
    Object.assign(known.transaction, extra);
    const s = walkHost(v1);
    await assert.rejects(findTxBytes(s.fetchFn, v1.host, v1.id, known, s.sleep), new RegExp(`its tx JSON has ${Object.keys(extra)[0]} \\(a gas-key nonce or nonce mode\\), which no recorded tx pins`), JSON.stringify(extra));
    assert.deepEqual(s.log, []);
  }
});

test("tx rebuild in the gate: the light-proof txs with no tx-bytes file pass by their rebuilt bytes and proof; a changed nonce or signer is refused", async () => {
  for (const [fx, v] of [[LP, 0], [LP.v1, 1]]) {
    const ok = { ...clone(fx), tx_bytes: undefined, walk: trTx(fx.tx.hash).blocks };
    const r = await gateOn(ok);
    assert.deepEqual(r.refusals, [], fx.tx.hash);
    assert.match(r.proven[0], new RegExp(`near-testnet ${fx.tx.hash} \\(V${v}, ${fx.tx.signer} to ${fx.tx.signer}\\): 3 outcome\\(s\\) proven .*; tx bytes rebuilt from archival-rpc\\.testnet\\.fastnear\\.com's tx JSON, block hash 5 block\\(s\\) back \\(testnet, not real-money proof\\)$`));
    const nonce = clone(ok);
    nonce.known.transaction.nonce += 1;
    const bad = await gateOn(nonce);
    assert.deepEqual(bad.proven, []);
    assert.match(bad.refusals.join("\n"), /not proven: no block \d+ back from its own/);
    // the record's signer is not the one the rebuilt bytes name
    const signer = clone(ok);
    signer.tx.signer = "someone.testnet";
    assert.match((await gateOn(signer)).refusals.join("\n"), new RegExp(`not proven: its tx bytes name signer ${fx.tx.signer}, not someone\\.testnet`));
  }
  // a tx-bytes file, when present, still serves first: one that hashes to another tx is refused, never rebuilt around
  const other = await gateOn({ ...clone(LP), tx_bytes: LP.v1.tx_bytes, walk: trTx(LP.tx.hash).blocks });
  assert.match(other.refusals.join("\n"), new RegExp(`not proven: ${LP.tx.hash}: its tx bytes do not hash to it`));
});

test("tx rebuild: a NEAR answer is read with every integer past 2^53 kept exact, so a Delegate's u64::MAX rebuilds", async () => {
  const t = trTx("Gusir2ySar6hLo5BQ3iRkYfMwwdPyDqsuc7t3RDaazgn");
  const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: t.known }).replace('"max_block_height":"18446744073709551615"', '"max_block_height":18446744073709551615');
  assert.match(text, /"max_block_height":18446744073709551615[,}]/);
  // JSON.parse alone rounds it, and the bytes no longer hash to the id
  const lossy = JSON.parse(text).result;
  assert.equal(lossy.transaction.actions[0].Delegate.delegate_action.max_block_height, 18446744073709552000);
  await assert.rejects(rebuilt(t, lossy), /not a u64/);
  // the gate's own read (rpc) of a real fetch Response, which offers both json() and text(), keeps it
  const out = {};
  const known = { ...t.known, status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts: [], receipts_outcome: [] };
  const served = JSON.stringify({ jsonrpc: "2.0", id: 1, result: known }).replace('"max_block_height":"18446744073709551615"', '"max_block_height":18446744073709551615');
  const block = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { header: { timestamp_nanosec: "1790000000000000000" } } });
  const f2 = async (url, init) => new Response(JSON.parse(init.body).method === "block" ? block : served, { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await readTx(f2, "stub", { chain: "near", hash: t.id, signer: t.signer }, 0, async () => {}, true, out), "ok");
  assert.equal(out.result.transaction.actions[0].Delegate.delegate_action.max_block_height, "18446744073709551615");
  assert.equal(txBytesFacts((await rebuilt(t, out.result)).bytes, t.id).signer, "sweat-relayer.near");
});

test("tx rebuild: the gate walks back 64 blocks, no more: a tx whose block hash is 64 blocks before its own rebuilds, 65 is refused", async () => {
  const t = trTx("6oFdTV6xQ5gMnDyf4jd2TJDL1qgyn2CeS583aGdyRQgf");
  const { back } = await rebuilt(t);
  // the recorded walk put `extra` stand-in blocks further from the tx: its block hash is then back + extra blocks back
  const deeper = (extra) => {
    const x = clone(t);
    const real = x.known.transaction_outcome.block_hash;
    const fake = Array.from({ length: extra }, (_, i) => enc58(createHash("sha256").update(`stand-in ${i}`).digest()));
    fake.forEach((h, i) => (x.blocks[h] = fake[i + 1] ?? real));
    x.known.transaction_outcome.block_hash = fake[0];
    return x;
  };
  assert.equal((await rebuilt(deeper(64 - back))).back, 64);
  await assert.rejects(rebuilt(deeper(65 - back)), /no block from its own back 64 makes its tx JSON hash to it: .*keep its tx-bytes file/);
});

test("tx rebuild: a deploy from a parent to a new sub-account (the testnet vault skeleton's own, 7sbN) reads its code at the block its receipt ran in, a block after the tx's", async () => {
  const t = trTx("7sbNcxchrT6uMfcJEvfwMAfm2F925L9BXvuR4jH3fwML");
  const ran = t.known.receipts_outcome.find((o) => o.id === t.known.transaction_outcome.outcome.receipt_ids[0]);
  assert.notEqual(t.known.transaction.signer_id, t.known.transaction.receiver_id);
  assert.notEqual(ran.block_hash, t.known.transaction_outcome.block_hash);
  assert.deepEqual(kindsOf(t), ["CreateAccount", "Transfer", "DeployContract", "FunctionCall"]);
  const s = walkHost(t);
  const { bytes } = await findTxBytes(s.fetchFn, t.host, t.id, t.known, s.sleep);
  assert.equal(txBytesFacts(bytes, t.id).receiver, "vault.bf-vs-20261101t012200.testnet");
  assert.deepEqual(s.log.filter((l) => l.startsWith("query")), [`query ${ran.block_hash}`]);
  // the vault's code hash on record (contracts/vault/deployments/testnet-skeleton.json) is the code rebuilt into it
  assert.equal(enc58(createHash("sha256").update(Buffer.from(t.code, "base64")).digest()), "GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn");
});

test("tx rebuild planted: a DeployContract tx with a field it does not rebuild is refused before its code is read", async () => {
  const t = trTx("HVkQ7DY9pYjCiuKeXdCPencjHyzwzs3NBUVzSHgHEK7m");
  for (const [what, edit] of [
    ["an extra tx field", (x) => (x.memo = "x")],
    ["an unknown kind beside it", (x) => x.actions.push({ NoSuchAction: {} })],
    ["a code hash of 31 bytes", (x) => (x.actions[0].DeployContract.code = Buffer.alloc(31).toString("base64"))],
  ]) {
    const known = clone(t.known);
    edit(known.transaction);
    const s = walkHost(t);
    await assert.rejects(findTxBytes(s.fetchFn, t.host, t.id, known, s.sleep), /does not rebuild|not 32 bytes/, what);
    assert.deepEqual(s.log, [], what);
  }
});
