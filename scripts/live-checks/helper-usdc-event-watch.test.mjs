// node --test scripts/live-checks/helper-usdc-event-watch.test.mjs: the live check replays recorded runs
// (helper-usdc-event-watch.answers.json). good: the deployed helper with testnet carried, and mainnet USDC (the v1
// record's vault the account whose block is read) and the testnet token on FastNEAR and dRPC, the indexer and the
// archival provider, and the probe's halted-then-open run on FastNEAR's testnet archive, read 2026-11-07: PASS.
// bad_deployed_before: the deployed helper at 350a7db, whose watch never answered caught up, its mainnet block read for
// the account USDC once blocklisted (before the v1 vault): FAIL on those two lines.
// bad_provider_mismatch: dRPC's is_blocklisted answers
// true where FastNEAR's answers false: FAIL on that line alone. bad_history_mismatch: the archival view at the blocklist's
// block disagrees with the indexer's event: FAIL on that line alone. Made from the good run: a halted answer, an unknown
// halt, two providers far apart: each FAIL. read() replayed through a stub provider: the shapes it records.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { haltOf, HISTORY_ACCOUNT, judge, NETS, PROBE, read, viewOutcome } from "./helper-usdc-event-watch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-usdc-event-watch.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (o) => JSON.parse(JSON.stringify(o));
const DRPC = NETS.mainnet.pair[1];
// the recorded bad runs were read before the probe ran (2026-11-03); each is judged with the good run's probe reads, so
// its own fault stays the one line that fails
for (const k of ["bad_deployed_before", "bad_provider_mismatch", "bad_history_mismatch"]) A[k].probe ??= A.good.probe;

test("mainnet's block is read for the v1 record's vault; the history for the one account USDC ever blocklisted", () => {
  const record = JSON.parse(readFileSync(path.join(HERE, "../../contracts/vault/deployments/mainnet-v1.json"), "utf8"));
  assert.equal(NETS.mainnet.watched, record.account_id);
  assert.equal(HISTORY_ACCOUNT, "da179a3b4754fa92c637a90533071075142fd931dcd4987e8f362dedc6e0087d");
  assert.notEqual(HISTORY_ACCOUNT, NETS.mainnet.watched);
  // the good run read the vault's block on both mainnet providers, and the history for that one account
  assert.equal(A.good.nets.mainnet.watched, record.account_id);
  assert.equal(A.good.history.indexer.blocklist[0].account, HISTORY_ACCOUNT);
  // a run that read another account's block fails on that line
  const other = copy(A.good);
  other.nets.mainnet.watched = HISTORY_ACCOUNT;
  assert.deepEqual(bad(judge(other)), [`BAD [mainnet] the block read for ${HISTORY_ACCOUNT}, not ${record.account_id}`]);
});

test("recorded good run: both networks' code, halt, block and code hash on two providers, and the history: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 41);
  assert.ok(r.lines.includes("ok  [testnet] helper: caught_up true, halted false, vault_blocked false, code_hash_ok true, code_hash the pin"));
});

test("recorded bad run: the deployed helper before this card (350a7db) never answers caught up on testnet, and read mainnet's block for another account: FAIL on those two lines", () => {
  const r = judge(A.bad_deployed_before);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [`BAD [mainnet] the block read for ${HISTORY_ACCOUNT}, not ${NETS.mainnet.watched}`, "BAD [testnet] helper: caught_up false, halted null, vault_blocked null, code_hash_ok null, code_hash the pin"]);
});

test("made from the good run: the helper halted, blocked, on another code, far behind, or mainnet answering caught up with nulls: each FAIL", () => {
  const withHelper = (net, f) => {
    const r = copy(A.good);
    r.helper[net].body = JSON.stringify(f(JSON.parse(r.helper[net].body)));
    return judge(r);
  };
  assert.equal(withHelper("testnet", (b) => ({ ...b, halted: true })).ok, false);
  assert.equal(withHelper("testnet", (b) => ({ ...b, vault_blocked: true })).ok, false);
  assert.equal(withHelper("testnet", (b) => ({ ...b, code_hash: "GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT" })).ok, false);
  assert.equal(withHelper("testnet", (b) => ({ ...b, block_height: b.block_height - 101 })).ok, false);
  assert.equal(withHelper("mainnet", (b) => ({ ...b, caught_up: true })).ok, false);
  const gone = copy(A.good);
  gone.helper.testnet = { status: 404, body: "{}" };
  assert.equal(judge(gone).ok, false);
});

test("recorded bad run, a provider mismatch: dRPC says blocklisted where FastNEAR does not: FAIL on that line alone", () => {
  const r = judge(A.bad_provider_mismatch);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [`BAD [mainnet] ${DRPC} is_blocklisted(${NETS.mainnet.watched}) at the same block: "true"`]);
});

test("recorded bad run, a history mismatch: the view at the blocklist's block disagrees with the indexer's event: FAIL on that line alone", () => {
  const r = judge(A.bad_history_mismatch);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD \[mainnet\] is_blocklisted read at \[99022746,99022747,99023052,99023053\] answers \["false","false","true","false"\]/);
});

test("made from the good run, the probe: never halted, another code, a failed transaction, an answer of another block, not read: each FAIL on its line", () => {
  const atPause = (f) => {
    const r = copy(A.good);
    f(r.probe.blocks[PROBE.paused], r);
    return bad(judge(r));
  };
  assert.deepEqual(atPause((b) => (b.at = { ...b.before, block_hash: b.hash })).map((l) => l.slice(0, 80)), [`BAD [testnet] ${PROBE.archive} the Pause's block ${PROBE.paused}`.slice(0, 80)]);
  assert.equal(atPause((b) => (b.code.at = "GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT")).length, 1);
  assert.equal(atPause((b) => (b.at.block_hash = b.prev_hash)).length, 1);
  assert.equal(atPause((b) => (b.at = { other: true })).length, 1);
  assert.equal(atPause((_, r) => (r.probe.txs[PROBE.txs[1].hash].ok = false)).length, 1);
  const none = copy(A.good);
  delete none.probe;
  assert.equal(bad(judge(none)).length, PROBE.txs.length + 2);
});

test("made from the good run: halted, an unknown halt, providers far apart, a missing network: each FAIL", () => {
  const halted = copy(A.good);
  halted.nets.testnet.state["https://near-testnet.drpc.org"].halt = { at: 275916885, panic: "FiatToken: paused" };
  assert.ok(bad(judge(halted)).some((l) => l.endsWith("FiatToken: paused, halted")));
  const unknown = copy(A.good);
  unknown.nets.mainnet.state[DRPC].halt = { at: 222736786, panic: "FiatToken: something else" };
  assert.equal(judge(unknown).ok, false);
  const apart = copy(A.good);
  apart.nets.mainnet.state[DRPC].halt.at += 31;
  assert.equal(judge(apart).ok, false);
  const missing = copy(A.good);
  delete missing.nets.testnet;
  assert.ok(bad(judge(missing)).includes("BAD [testnet] not read"));
});

test("a view's outcome, by the helper's own functions (status.ts): a balance is not halted, USDC's paused panic is, any other answer is not known", () => {
  // the shapes: a value; the panic as a result.error string, as FastNEAR and dRPC answer it (read 2026-11-02); the panic
  // inside a top-level error object (a sandbox's shape, 20261026T171345Z): not a provider's answer, so not known, as the
  // watch holds on it
  const balance = viewOutcome({ result: { block_height: 5, result: [...Buffer.from('"20000"')] } });
  assert.deepEqual(balance, { at: 5, answer: '"20000"' });
  assert.equal(haltOf(balance), false);
  const panicked = viewOutcome({ error: { cause: { name: "CONTRACT_EXECUTION_ERROR", info: { block_height: 6 } }, data: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })' } });
  assert.equal(haltOf(panicked), null);
  const inResult = viewOutcome({ result: { block_height: 7, logs: [], error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })' } });
  assert.equal(haltOf(inResult), true);
  assert.equal(haltOf(viewOutcome({ result: { block_height: 8, error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } })), null);
  assert.equal(haltOf(viewOutcome({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } })), null);
  assert.equal(haltOf({ at: 9, answer: "null" }), null);
});

test("read() through a stub provider: it records each read's outcome, and a wasm that is not USDC's fails the code lines", async () => {
  const empty = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString("base64"); // a valid wasm with no exports
  const asked = [];
  const stub = async (url, init) => {
    asked.push(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (url.startsWith("https://helper.example/")) return json(JSON.parse(A.good.helper[new URL(url).searchParams.get("token") === NETS.mainnet.token ? "mainnet" : "testnet"].body));
    if (url.startsWith("https://api.nearblocks.io/")) {
      const m = new URL(url).searchParams.get("method");
      const t = A.good.history.indexer[m][0];
      return json({ txns: [{ receipt_id: t.receipt_id, transaction_hash: t.tx, predecessor_account_id: t.signer, receipt_block: { block_height: t.height }, receipt_outcome: { status: true }, actions: [{ method: m, args: JSON.stringify({ account_id: t.account }) }] }] });
    }
    const { method, params: p } = JSON.parse(init.body);
    // the probe on the archive: its transactions, its switch blocks' headers, and its views by block hash
    const probe = Object.values(A.good.probe.blocks);
    if (method === "EXPERIMENTAL_tx_status" && PROBE.txs.some((t) => t.hash === p.tx_hash)) return json({ result: { final_execution_status: "FINAL", status: { SuccessValue: "" } } });
    if (method === "block") {
      const b = A.good.probe.blocks[p.block_id];
      return json({ result: { header: { height: b.height, hash: b.hash, prev_hash: b.prev_hash } } });
    }
    const side = probe.flatMap((b) => [["before", b.prev_hash, b], ["at", b.hash, b]]).find(([, h]) => h === p.block_id);
    if (side) {
      const [k, hash, b] = side;
      if (p.request_type === "view_account") return json({ result: { code_hash: b.code[k], block_hash: hash, block_height: 1 } });
      const o = b[k];
      const panic = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "' + o.panic + '" })';
      return json({ result: { block_height: o.at, block_hash: hash, ...(o.panic !== undefined ? { error: panic } : { result: [...Buffer.from(o.answer)] }) } });
    }
    if (method === "EXPERIMENTAL_tx_status") {
      const log = Object.values(A.good.history.logs).find((l) => A.good.history.indexer[JSON.parse(l.log.slice(11)).event][0].tx === p.tx_hash);
      return json({ result: { receipts_outcome: [{ id: log.receipt_id, outcome: { executor_id: log.executor, logs: [log.log] } }] } });
    }
    if (p.request_type === "view_code") return json({ result: { code_base64: empty, hash: "x", block_height: 1 } });
    if (p.request_type === "view_account") return json({ result: { code_hash: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q", block_height: p.block_id } });
    const at = p.block_id ?? 1000;
    if (p.method_name === "ft_balance_of") return json({ result: { block_height: at, result: [...Buffer.from('"1"')] } });
    const hist = A.good.history.views.find((v) => v.at === at);
    return json({ result: { block_height: at, result: [...Buffer.from(hist ? hist.answer : "false")] } });
  };
  const run = await read(stub, async () => {}, "https://helper.example");
  const r = judge(run);
  assert.deepEqual(
    bad(r).map((l) => l.replace(/ view_code of .*/, " view_code").replace(/ the wasm exports .*/, " exports")),
    ["mainnet", "testnet"].flatMap((n) => [...NETS[n].pair.flatMap((u) => [`BAD [${n}] ${u} view_code`, `BAD [${n}] ${u} exports`])]),
  );
  assert.equal(asked.filter((u) => u.startsWith("https://api.nearblocks.io/")).length, 2);
});
