// node --test scripts/live-checks/helper-usdc-event-watch.test.mjs: the live check replays recorded runs
// (helper-usdc-event-watch.answers.json). good: the helper at 66e1cbb run locally with testnet carried, and mainnet USDC
// and the testnet token on FastNEAR and dRPC, the indexer and the archival provider, on 2026-11-03: PASS.
// bad_deployed_before: the deployed helper at 350a7db, whose watch never answered caught up: FAIL on that line alone.
// bad_provider_mismatch: dRPC's is_blocklisted answers
// true where FastNEAR's answers false: FAIL on that line alone. bad_history_mismatch: the archival view at the blocklist's
// block disagrees with the indexer's event: FAIL on that line alone. Made from the good run: a halted answer, an unknown
// halt, two providers far apart: each FAIL. read() replayed through a stub provider: the shapes it records.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { haltOf, judge, NETS, read, viewOutcome } from "./helper-usdc-event-watch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-usdc-event-watch.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (o) => JSON.parse(JSON.stringify(o));
const DRPC = NETS.mainnet.pair[1];

test("recorded good run: both networks' code, halt, block and code hash on two providers, and the history: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, 33);
  assert.ok(r.lines.includes("ok  [testnet] helper: caught_up true, halted false, vault_blocked false, code_hash_ok true, code_hash the pin"));
});

test("recorded bad run: the deployed helper before this card (350a7db) never answers caught up on testnet: FAIL on that line alone", () => {
  const r = judge(A.bad_deployed_before);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD [testnet] helper: caught_up false, halted null, vault_blocked null, code_hash_ok null, code_hash the pin"]);
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

test("a view's outcome: a balance is not halted, USDC's paused panic is, any other error is not known", () => {
  // the shapes providers answer: a value, the panic inside an error object (sandbox run 20261026T171345Z), the panic as a
  // result.error string (D48's MethodNotFound came back this way)
  const balance = viewOutcome({ result: { block_height: 5, result: [...Buffer.from('"20000"')] } });
  assert.deepEqual(balance, { at: 5, answer: '"20000"' });
  assert.equal(haltOf(balance), false);
  const panicked = viewOutcome({ error: { cause: { name: "CONTRACT_EXECUTION_ERROR", info: { block_height: 6 } }, data: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })' } });
  assert.deepEqual(panicked, { at: 6, panic: "FiatToken: paused" });
  assert.equal(haltOf(panicked), true);
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
