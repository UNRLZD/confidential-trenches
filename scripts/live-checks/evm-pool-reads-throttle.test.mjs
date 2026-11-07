// node --test scripts/live-checks/evm-pool-reads-throttle.test.mjs: card evm-pool-reads-throttle's live check,
// replayed. evm-pool-reads-throttle.answers.json holds a real run on Base Sepolia (good: the
// pool's now, its trees at the epoch's start and a binding for one chunk, every kind of read throttled once by the
// stand-in on both providers) and the same answers with every eth_chainId of the second provider a throttle (bad).
// The wallet's own reads run on the replay, the stand-in in front: good passes; bad fails by the read's name, inside
// the bound (4 tries), never an answer. The sync's pair is the check's SYNC (PublicNode and Pocket, wide log pages), the
// fee pair the kit's pinned one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { KINDS, check, spoil } from "./evm-pool-reads-throttle.mjs";
import { replayer } from "./wallet-restore-transfer-rpcs.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-reads-throttle.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: the binding is made with every kind of read throttled once on both providers", async () => {
  const r = await check(replayer(A.good), { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[0], /^base-sepolia: pool 0xeb967dfc1b4ffb22942f833c76866ea85fc42266 from block \d+: now \d+, the trees at epoch \d+ \(\d+ leaves\), bound for W 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf at fee \d+ wei, deadline \d+, with \d+ reads throttled once on base-sepolia-rpc\.publicnode\.com, base-testnet\.api\.pocket\.network, sepolia\.base\.org \(eth_chainId, block finalized, block latest, block number, block hash, view, eth_getLogs; views of \d+ kinds\)$/);
  for (const k of KINDS) assert.ok(r.lines[0].includes(k), k);
});

test("the recorded bad run (the second provider's chain id throttled on every try) fails by the read's name, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const changed = A.bad.filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[i]));
  assert.ok(changed.length >= 1 && changed.every((e) => e.method === "eth_chainId" && /^HTTP 429/.test(e.error)));
  const r = await check(replayer(A.bad), { wait: false });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^base-sepolia: EvmUnansweredError: rpc 1 eth_chainId: no answer in 4 tries \(HTTP 429 \(http_429, 4 tries at base-testnet\.api\.pocket\.network\)\)$/);
});

test("a replay whose every view reverts fails: never a pass without the binding", async () => {
  const broken = A.good.map((e) => (e.method === "eth_call" ? { network: e.network, url: e.url, method: e.method, params: e.params, error: "RPC error -32000: execution reverted" } : e));
  const r = await check(replayer(broken), { wait: false });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.lines[0], /bound for W/);
});
