// node --test scripts/live-checks/helper-usdc-event-watch.test.mjs: the live check replays recorded runs
// (helper-usdc-event-watch.answers.json). The live check reads NEAR mainnet only (card live-checks-read-mainnet-only):
// each recording's mainnet half (real) is judged as it judges: good PASS, bad_mainnet_not_carried, bad_provider_mismatch
// and bad_history_mismatch FAIL. The whole recordings, read with testnet and the probe too, replay under WITH_TESTNET,
// the networks and the probe they were read with. good: apps/helper at card/vault-mainnet-record run locally with mainnet (the
// v1 record's vault) and testnet carried, and mainnet USDC and the testnet token on FastNEAR and dRPC, the indexer and
// the archival provider, and the probe's halted-then-open run on FastNEAR's testnet archive, read 2026-11-07: PASS.
// bad_mainnet_not_carried: the deployed helper before the v1 release, its env naming no mainnet vault: FAIL on mainnet's
// caught_up line alone. bad_deployed_before: the deployed helper at 350a7db, whose watch never answered caught up, its
// mainnet block read for the account USDC once blocklisted (before the v1 vault): FAIL on those three lines.
// bad_provider_mismatch: dRPC's is_blocklisted answers
// true where FastNEAR's answers false: FAIL on that line alone. bad_history_mismatch: the archival view at the blocklist's
// block disagrees with the indexer's event: FAIL on that line alone. Made from the good run: a halted answer, an unknown
// halt, two providers far apart: each FAIL. read() replayed through a stub provider: the shapes it records.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verdictOf } from "../ci/live-rerun.mjs";
import { ARCHIVAL, haltOf, HISTORY_ACCOUNT, judge as judgeMainnet, main, NETS, read as readMainnet, viewOutcome } from "./helper-usdc-event-watch.mjs";
import { EXIT, RETRY } from "./provider-answer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-usdc-event-watch.answers.json"), "utf8"));
/** The probe the check read before it read mainnet only: its token and holder, the four transactions, the Pause's and
 *  the Unpause's blocks, on FastNEAR's testnet archive (contracts/vault/deployments/testnet-usdc-probe.json). */
const PROBE = {
  network: "testnet",
  token: "bf-usdc-20261102t164926.testnet", // gitleaks:allow (contracts/vault/deployments/testnet-usdc-probe.json)
  holder: "holder.bf-usdc-20261102t164926.testnet", // gitleaks:allow
  archive: "https://archival-rpc.testnet.fastnear.com",
  txs: [
    { hash: "GfFB4jfhviTTj4xQd3tLPLBKRSCbGZjwaLGsdRTeL8fK", signer: "pauser.bf-usdc-20261102t164926.testnet", what: "Pause: create and approve request 3" }, // gitleaks:allow
    { hash: "3GXgvpDwGpf8v9j5NerAGUWdbYFqxatvueR7X86ZgPth", signer: "pauser2.bf-usdc-20261102t164926.testnet", what: "Pause: approve and execute request 3" }, // gitleaks:allow
    { hash: "2eUSm5iLg8k8DRkSW444jWCWk7ebHsNue8D4Uyi3XmwZ", signer: "pauser.bf-usdc-20261102t164926.testnet", what: "Unpause: create and approve request 4" }, // gitleaks:allow
    { hash: "DoQYjLCp6rwwxyHt4hiJXDy2pupUDETeg1zpDA9Tfmni", signer: "pauser2.bf-usdc-20261102t164926.testnet", what: "Unpause: approve and execute request 4" }, // gitleaks:allow
  ],
  paused: 275929377,
  open: 275929392,
};
/** The networks, carried list and probe the recordings were read with, before the check read mainnet only. */
const WITH_TESTNET = {
  nets: { ...NETS, testnet: { token: "bf-usdc-20261101t022248.testnet", pair: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], watched: "vault.bf-vt-20261102t071444.testnet" } }, // gitleaks:allow (contracts/vault/deployments/testnet-usdc.json, testnet-v1.json)
  carried: ["testnet", "mainnet"],
  probe: PROBE,
};
const judge = (run) => judgeMainnet(run, WITH_TESTNET);
const read = (f, sleep, base) => readMainnet(f, sleep, base, WITH_TESTNET);
/** A recording's mainnet half: what the live check reads now. */
const mainnetHalf = (run) => {
  const { probe, ...rest } = run;
  return { ...rest, helper: { mainnet: run.helper.mainnet }, nets: { mainnet: run.nets.mainnet } };
};

test("the live check reads NEAR mainnet only: good's mainnet half PASSes; the bad runs' mainnet halves FAIL on their mainnet lines", () => {
  assert.deepEqual(Object.keys(NETS), ["mainnet"]);
  const g = judgeMainnet(mainnetHalf(A.good));
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(!g.lines.some((l) => l.includes("testnet")));
  assert.deepEqual(bad(judgeMainnet(mainnetHalf(A.bad_mainnet_not_carried))).map((l) => l.slice(0, 40)), ["BAD [mainnet] helper: caught_up false, h"]);
  assert.deepEqual(bad(judgeMainnet(mainnetHalf(A.bad_provider_mismatch))), [`BAD [mainnet] ${NETS.mainnet.pair[1]} is_blocklisted(${NETS.mainnet.watched}) at the same block: "true"`]);
  assert.equal(bad(judgeMainnet(mainnetHalf(A.bad_history_mismatch))).length, 1);
  assert.equal(judgeMainnet(A.good).ok, true, "a run with testnet in it is judged on mainnet only");
  assert.equal(judgeMainnet({ ...mainnetHalf(A.good), nets: {} }).ok, false, "mainnet not read");
});
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (o) => JSON.parse(JSON.stringify(o));
const DRPC = NETS.mainnet.pair[1];
// the recorded bad runs were read before the probe ran (2026-11-03); each is judged with the good run's probe reads, so
// its own fault stays the one line that fails
for (const k of ["bad_mainnet_not_carried", "bad_deployed_before", "bad_provider_mismatch", "bad_history_mismatch"]) A[k].probe ??= A.good.probe;

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
  assert.equal(r.lines.length, 42);
  assert.ok(r.lines.includes("ok  [mainnet] helper: caught_up true, halted false, vault_blocked false, code_hash_ok true, code_hash the pin"));
  assert.ok(r.lines.includes("ok  [testnet] helper: caught_up true, halted false, vault_blocked false, code_hash_ok true, code_hash the pin"));
});

test("recorded bad run: the deployed helper before the v1 release does not carry mainnet: FAIL on mainnet's caught_up line alone", () => {
  const r = judge(A.bad_mainnet_not_carried);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD [mainnet] helper: caught_up false, halted null, vault_blocked null, code_hash_ok null, code_hash the pin"]);
});

test("recorded bad run: the deployed helper before this card (350a7db) never answers caught up, and read mainnet's block for another account: FAIL on those three lines", () => {
  const r = judge(A.bad_deployed_before);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [`BAD [mainnet] the block read for ${HISTORY_ACCOUNT}, not ${NETS.mainnet.watched}`, "BAD [mainnet] helper: caught_up false, halted null, vault_blocked null, code_hash_ok null, code_hash the pin", "BAD [testnet] helper: caught_up false, halted null, vault_blocked null, code_hash_ok null, code_hash the pin"]);
});

test("made from the good run: the helper halted, blocked, on another code, far behind, or mainnet not caught up or halted: each FAIL", () => {
  const withHelper = (net, f) => {
    const r = copy(A.good);
    r.helper[net].body = JSON.stringify(f(JSON.parse(r.helper[net].body)));
    return judge(r);
  };
  assert.equal(withHelper("testnet", (b) => ({ ...b, halted: true })).ok, false);
  assert.equal(withHelper("testnet", (b) => ({ ...b, vault_blocked: true })).ok, false);
  assert.equal(withHelper("testnet", (b) => ({ ...b, code_hash: "GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT" })).ok, false);
  assert.equal(withHelper("testnet", (b) => ({ ...b, block_height: b.block_height - 101 })).ok, false);
  assert.equal(withHelper("mainnet", (b) => ({ ...b, caught_up: false })).ok, false);
  assert.equal(withHelper("mainnet", (b) => ({ ...b, halted: true })).ok, false);
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

test("the indexer names no account (NearBlocks' args null, live runs 44989861313 to 45006783900): the receipts' archival logs name it: PASS; a log or an indexer naming another account: FAIL (red at fd4d3d39a)", () => {
  const strip = (run) => {
    const r = structuredClone(run);
    for (const m of ["blocklist", "unblocklist"]) for (const x of r.history.indexer[m]) delete x.account;
    return r;
  };
  const live = strip(A.good);
  assert.equal(live.history.indexer.blocklist[0].account, undefined);
  const r = judge(live);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [mainnet] the indexer lists one blocklist 99022747 and one unblocklist 99023053, of \"the account its log names\""), r.lines.join("\n"));
  const other = "a".repeat(64);
  const relog = structuredClone(live);
  relog.history.logs.blocklist.log = relog.history.logs.blocklist.log.replace(HISTORY_ACCOUNT, other);
  assert.deepEqual(bad(judge(relog)).map((l) => l.slice(0, 50)), [`BAD [mainnet] https://archival-rpc.mainnet.fastnear.com the blocklist receipt`.slice(0, 50)]);
  const named = structuredClone(A.good);
  named.history.indexer.unblocklist[0].account = other;
  assert.deepEqual(bad(judge(named)), [`BAD [mainnet] the indexer lists one blocklist 99022747 and one unblocklist 99023053, of "${HISTORY_ACCOUNT}"`]);
  const two = structuredClone(live);
  two.history.indexer.blocklist.push({ ...two.history.indexer.blocklist[0], height: 99030000 });
  assert.match(bad(judge(two))[0] ?? "", /\(2 and 1 listed\)/);
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

const empty = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString("base64"); // a valid wasm with no exports
/** Every source the check reads, answering as the good run's (its code a wasm with no exports); each URL asked is pushed
 *  on `asked`. */
const stubOf = (asked) => async (url, init) => {
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

test("read() through a stub provider: it records each read's outcome, and a wasm that is not USDC's fails the code lines", async () => {
  const asked = [];
  const stub = stubOf(asked);
  const run = await read(stub, async () => {}, "https://helper.example");
  const r = judge(run);
  assert.deepEqual(
    bad(r).map((l) => l.replace(/ view_code of .*/, " view_code").replace(/ the wasm exports .*/, " exports")),
    ["mainnet", "testnet"].flatMap((n) => [...WITH_TESTNET.nets[n].pair.flatMap((u) => [`BAD [${n}] ${u} view_code`, `BAD [${n}] ${u} exports`])]),
  );
  assert.equal(asked.filter((u) => u.startsWith("https://api.nearblocks.io/")).length, 2);
});

// card usdc-watch-no-answer-inconclusive: the helper live run 45401968651 (24 Nov 13:2xZ) ended this check ERROR, exit 2,
// never run again, on NearBlocks answering 522 (its origin timed out, 19.7 s from the Mac too): a source that did not
// answer says nothing of the deploy. Each source the check reads that does not answer (the indexer's 5xx, an RPC's 503,
// a fetch that failed) is now a no-answer: INCONCLUSIVE, exit 3, which the live run reads again after a pause, never
// a PASS. The good stub as read() above, with one source not answering.
test("a source that does not answer (the indexer's 522, an RPC's 503 twice, a dropped fetch): INCONCLUSIVE, exit 3, the live run's inconclusive, naming the host (red at 73619d713: ERROR, exit 2)", async () => {
  RETRY.ms = 0;
  const cases = {
    "api.nearblocks.io": (url) => (url.startsWith("https://api.nearblocks.io/") ? new Response("error code: 522", { status: 522 }) : null),
    "near.drpc.org": (url) => (url === "https://near.drpc.org" ? new Response("<html>503 Service Unavailable</html>", { status: 503 }) : null),
    "archival-rpc.mainnet.fastnear.com": (url) => {
      if (url === ARCHIVAL) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return null;
    },
  };
  for (const [host, down] of Object.entries(cases)) {
    const good = stubOf([]);
    const out = [];
    const code = await main(["--base", "https://helper.example"], { fetchFn: async (url, init) => down(url) ?? good(url, init), sleep: async () => {}, log: (l) => out.push(l), err: (l) => out.push(l) });
    const text = out.join("\n");
    assert.equal(code, EXIT.INCONCLUSIVE, `${host}: ${text}`);
    assert.equal(verdictOf("helper-usdc-event-watch", code, text), "inconclusive", text);
    assert.match(text, new RegExp(`^live-check helper-usdc-event-watch: INCONCLUSIVE: .*${host.replace(/\./g, "\\.")}`, "m"));
  }
  // every source answering: the run is judged, as before (the stub's wasm has no exports, so FAIL, never INCONCLUSIVE)
  const out = [];
  assert.equal(await main(["--base", "https://helper.example"], { fetchFn: stubOf([]), sleep: async () => {}, log: (l) => out.push(l), err: (l) => out.push(l) }), EXIT.FAIL, out.join("\n"));
  // an RPC's 429 is waited out at its Retry-After, as before the move (up to three times): FastNEAR answered the Mac 429
  // on a run a minute after another, 24 Nov 13:4xZ; past three it is the RPC's no-answer. The shared reader reads each
  // no-answer again once itself (RETRY), so each wait follows two 429s: 4 in a row, two waits, then judged; 8, three
  // waits and the fourth read's two 429s: INCONCLUSIVE
  for (const [n, want, waits] of [[4, EXIT.FAIL, 2], [8, EXIT.INCONCLUSIVE, 3]]) {
    const good = stubOf([]);
    let limited = 0;
    const slept = [];
    const lines = [];
    const fetchFn = async (url, init) => (url === "https://rpc.mainnet.fastnear.com" && limited++ < n ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : good(url, init));
    assert.equal(await main(["--base", "https://helper.example"], { fetchFn, sleep: async (ms) => void slept.push(ms), log: (l) => lines.push(l), err: (l) => lines.push(l) }), want, lines.join("\n"));
    assert.equal(slept.filter((ms) => ms === 7000).length, waits, `${n} answers 429: waited Retry-After, at most three times`);
  }
});
