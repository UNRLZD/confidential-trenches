// node --test scripts/live-checks/helper-usdc-pending-pause.test.mjs: the live check replays recorded runs
// (helper-usdc-pending-pause.answers.json), both recorded by the check's own read(). good: mainnet N 218 with no
// request in 202-217 and the carry token_not_accepted; testnet N 4 with request 3 stored on both, kind tag 3 (not a
// Pause) from view_state on both, the carry bad_signature: PASS. bad_pending: the same reads with each request's
// view_state bytes given tag 6, so testnet request 3 is a Pause while the carry runs its checks: FAIL. Made from them:
// the kind unread (the archive then cannot prove request 3 expired: N 3 at the old block), N disagreeing or unread, a
// request answer unread, providers that disagree on the kind, N far above any pin: each judged as the header says.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, NETS, nextOf, probeDelegate, read, requestKey, storedOf, trimBlock, windowOf } from "./helper-usdc-pending-pause.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-usdc-pending-pause.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const net = (run, name) => run.nets.find((x) => x.network === name);

/** A fetch that answers every call read() makes from a recorded run: finals, N, request views, view_state, archive, the carry. */
const replay = (run) => async (url, init) => {
  const body = JSON.parse(init.body);
  if (url.endsWith("/v1/bind")) {
    assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
    const r = run.nets.find((x) => probeDelegate(NETS[x.network].token) === body.signed_delegate);
    return new Response(r.carry.body, { status: r.carry.status });
  }
  const [name, n] = Object.entries(NETS).find(([, v]) => v.rpcs.includes(url) || v.archive === url);
  const r = net(run, name);
  if (url === n.archive) {
    if (body.method === "block") {
      const want = body.params.block_id;
      for (const b of [r.archive.h, r.archive.old]) if (JSON.parse(b).result.header.height === want) return new Response(b);
      // the rate's reference block: the recorded H block's time less 100000 blocks of the recorded old block's rate
      const h = JSON.parse(r.archive.h).result.header;
      const o = JSON.parse(r.archive.old).result.header;
      const per = (BigInt(h.timestamp_nanosec) - BigInt(o.timestamp_nanosec)) / BigInt(h.height - o.height);
      return new Response(JSON.stringify({ result: { header: { height: want, hash: "x", timestamp_nanosec: (BigInt(h.timestamp_nanosec) - per * BigInt(h.height - want)).toString() } } }));
    }
    return new Response(r.archive.oldNext);
  }
  const c = r.chain.find((x) => x.rpc === url);
  if (body.method === "block") return new Response(JSON.stringify({ result: { header: { height: r.h } } }));
  assert.equal(body.params.block_id, r.h, "every read at H");
  if (body.params.request_type === "view_state") return new Response(c.state.find((x) => requestKey(x.id) === body.params.prefix_base64).body);
  if (body.params.method_name === "get_next_multisig_request_id") return new Response(c.next);
  const { request_id } = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
  return new Response(c.stored.find((x) => x.id === request_id).body);
};

test("recorded good run: mainnet no request in the window, testnet request 3 a role request: no Pause pending on either, PASS", async () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.pending, [false, false]);
  assert.ok(r.lines.some((l) => /\[testnet\] {3}request 3: kind tag 3 on both, not a Pause/.test(l)));
  assert.ok(r.lines.includes('ok  [mainnet] POST /v1/bind (a delegate that moves nothing) answers 400 "token_not_accepted"'));
  assert.equal(judge(await read("https://api.example", replay(A.good))).ok, true, "read() over the replay judges the same");
});

test("recorded bad run: testnet request 3 a Pause on both while the carry runs its checks: FAIL", async () => {
  const r = judge(A.bad_pending);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ['BAD [testnet] a request that may be pending is stored, so the deposit carry sends nothing: "bad_signature"']);
  assert.equal(judge(await read("https://api.example", replay(A.bad_pending))).ok, false, "read() over the replay judges the same");
});

test("a Pause while the carry sends nothing (token_halted, token_not_accepted, relayer_low): PASS", () => {
  for (const code of ["token_halted", "token_not_accepted", "relayer_low"]) {
    const run = clone(A.bad_pending);
    net(run, "testnet").carry = { status: 503, body: JSON.stringify({ error: { code } }) };
    assert.equal(judge(run).ok, true, code);
  }
});

test("the kind unread on a provider, or the two disagreeing: the archive decides, and N 3 at the old block proves nothing: FAIL", () => {
  for (const what of ["refused", "disagree"]) {
    const run = clone(A.good);
    const c = net(run, "testnet").chain[1];
    c.state[0].body = what === "refused" ? JSON.stringify({ error: { name: "HANDLER_ERROR", cause: { name: "TOO_LARGE_CONTRACT_STATE" } } }) : clone(A.bad_pending).nets[1].chain[1].state[0].body.replace(/"block_height":\d+/, `"block_height":${net(run, "testnet").h}`);
    const r = judge(run);
    assert.equal(r.ok, false, what);
    assert.ok(r.lines.some((l) => l.includes("request 3: not proven expired")), what);
  }
});

test("made from the good run: N unread or disagreeing, a request answer unread, the wrong networks: FAIL; N far above any pin: judged on its window", () => {
  const unread = clone(A.good);
  net(unread, "mainnet").chain[0].next = "";
  assert.equal(judge(unread).ok, false, "N unread");
  const differ = clone(A.good);
  const j = JSON.parse(net(differ, "mainnet").chain[1].next);
  j.result.result = [...Buffer.from("219")];
  net(differ, "mainnet").chain[1].next = JSON.stringify(j);
  assert.equal(judge(differ).ok, false, "N differs");
  const answer = clone(A.good);
  net(answer, "mainnet").chain[0].stored[3].body = "";
  assert.equal(judge(answer).ok, false, "a request answer unread");
  assert.equal(judge({ nets: [net(A.good, "mainnet")] }).ok, false, "testnet not read");
  // N 300: the window is 284-299, read from the live N, never a pin
  assert.deepEqual(windowOf(300), Array.from({ length: 16 }, (_, i) => 284 + i));
  assert.deepEqual(windowOf(4), [0, 1, 2, 3]);
  const far = clone(A.good);
  const m = net(far, "mainnet");
  for (const c of m.chain) {
    const k = JSON.parse(c.next);
    k.result.result = [...Buffer.from("300")];
    c.next = JSON.stringify(k);
    c.stored = windowOf(300).map((id, i) => ({ id, body: c.stored[i].body }));
  }
  const r = judge(far);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  [mainnet] no Pause pending: no request in 284-299 may be pending"));
});

test("the recorder keeps only the header fields the check reads; the recorded answers parse as the watch reads them", () => {
  const full = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { author: "v.poolv1.near", header: { height: 7, hash: "H", timestamp_nanosec: "1", approvals: ["ed25519:x", null], signature: "ed25519:y" } } });
  assert.equal(trimBlock(full), JSON.stringify({ result: { header: { height: 7, hash: "H", timestamp_nanosec: "1" } } }));
  const t = net(A.good, "testnet");
  for (const b of [t.archive.h, t.archive.old]) assert.deepEqual(Object.keys(JSON.parse(b).result.header), ["height", "hash", "timestamp_nanosec"]);
  for (const c of net(A.good, "mainnet").chain) assert.equal(nextOf(c.next, net(A.good, "mainnet").h), 218);
  for (const c of t.chain) assert.equal(storedOf(c.stored.find((x) => x.id === 3).body, t.h), true);
  assert.equal(requestKey(3), Buffer.from([0x7e, 0x61, 0x6d, 2, 3, 0, 0, 0]).toString("base64"));
});
