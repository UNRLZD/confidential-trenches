// node --test --test-isolation=none scripts/live-checks/notes-per-pool-evm.test.mjs: card notes-per-pool-evm's live
// check, replayed. notes-per-pool-evm.answers.json holds a real run on both testnets (good) and the same answers with
// currentTreeSize one higher on both RPCs (bad). The wallet's own sync runs on the replay: good passes on every chain,
// bad fails on every chain, refused by the pool's own size. Card notes-per-pool-evm-base-hang: Base Sepolia's pair, on
// a stand-in for the chain that answers each provider's eth_getLogs with its own cap read live, pages the pool's whole
// life at the pager's full page; and a sync with no end fails at its deadline, naming the call it is stuck on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, VIEWS, check, replayer, spoil } from "./notes-per-pool-evm.mjs";

const A = JSON.parse(readFileSync(new URL("./notes-per-pool-evm.answers.json", import.meta.url), "utf8"));
/** The pager's first and widest page, in blocks (packages/wallet/src/pool/evm.ts EVM_LOG_PAGE_BLOCKS). */
const PAGE = 10_000;
/** The Base Sepolia pool's deploy block, and its time (sepolia.base.org, publicnode, Pocket alike, 6 Nov 04:35Z). */
const DEPLOY_BLOCK = 53_801_443, DEPLOY_TIME = 1_793_682_157;
/** Base Sepolia's head at the read below (sepolia.base.org, 6 Nov 04:35Z): the pool's life is 1,287,712 blocks. */
const HEAD = 55_089_154;
/** Each Base Sepolia provider's answer to the pool's eth_getLogs over its cap, read live 6 Nov 04:35Z over 1,000,
 * 10,000, 50,000 and 100,000 blocks from the deploy block; Pocket and Tenderly answered all four. */
const CAPS = {
  "sepolia.base.org": [200, "RPC error -32614: eth_getLogs is limited to a 200 range"],
  "base-sepolia-rpc.publicnode.com": [50_000, "RPC error -32701: exceed maximum block range: 50000"],
};

/** A stand-in for Base Sepolia at HEAD, a block every 200 ms, with the pool and none of its leaves: each provider's
 * eth_getLogs over its cap (CAPS) refused in its own words, every other read answered alike on every host, the deploy
 * receipt and SCOPE() as the recorded run read them. `hold(host, method)`: a call that never answers. `pages`: each
 * host's eth_getLogs calls. */
function standIn(hold = () => false) {
  const rec = A.good["base-sepolia"];
  const receipt = rec.find((e) => e.method === "eth_getTransactionReceipt" && e.result).result;
  const scopeSel = Object.keys(VIEWS).find((k) => VIEWS[k] === "SCOPE()");
  const scope = rec.find((e) => e.method === "eth_call" && e.params[0].data === scopeSel && e.result).result;
  const block = (n) => (n > HEAD ? null : { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: `0x${(DEPLOY_TIME + Math.floor((n - DEPLOY_BLOCK) / 5)).toString(16)}`, baseFeePerGas: "0x1" });
  const pages = new Map();
  const transport = async (url, method, params) => {
    const h = new URL(url).host;
    if (hold(h, method)) return new Promise(() => {});
    switch (method) {
      case "eth_getTransactionReceipt": return { result: receipt };
      case "eth_chainId": return { result: "0x14a34" };
      case "eth_getBlockByNumber": return { result: block(params[0] === "latest" ? HEAD : params[0] === "finalized" ? HEAD - 6_000 : Number(BigInt(params[0]))) };
      case "eth_getBlockByHash": return { result: block(Number(BigInt(params[0]))) };
      case "eth_call": return { result: params[0].data === scopeSel ? scope : `0x${"0".repeat(64)}` };
      case "eth_getLogs": {
        pages.set(h, (pages.get(h) ?? 0) + 1);
        const size = Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock)) + 1;
        return CAPS[h] && size > CAPS[h][0] ? { error: CAPS[h][1] } : { result: [] };
      }
    }
    return { error: `unexpected ${method}` };
  };
  return { transport, pages };
}

test("the recorded good run passes on both chains, through the sync's every step", async () => {
  assert.deepEqual(Object.keys(A.good).sort(), Object.keys(CHAINS).sort());
  for (const name of Object.keys(CHAINS)) {
    const r = await check(name, replayer(A.good[name]), { wait: false });
    assert.equal(r.ok, true, `${name}: ${r.lines.join("\n")}`);
    assert.equal(r.lines.length, 6, name);
    assert.match(r.lines[0], new RegExp(`deploy tx ${CHAINS[name].deployTx} in block \\d+`));
    assert.match(r.lines[2], /finalized anchor \d+ 0x[0-9a-f]{64} on both/);
    assert.match(r.lines[3], /newest agreed anchor \d+ 0x[0-9a-f]{64} on both/);
    assert.match(r.lines[4], /currentTreeSize [1-9]\d*, .* currentLabelTreeSize [1-9]\d* at the newest anchor, on both; depth \d+ \(\d+ calls in [\d.]+ s\)/);
    // both pools hold leaves now: the cut at the pool's time is read on both
    assert.match(r.lines[5], /the cut before \d+ ms \([1-9]\d* state, [1-9]\d* label leaves\): stateRootTimes\(\d+\) and labelRootTimes\(\d+\)/);
  }
  // the Base Sepolia run read the pool's life at the pager's full page on each provider
  const span = Number(BigInt(A.good["base-sepolia"].find((e) => e.method === "eth_getBlockByNumber" && e.params[0] === "latest").result.number)) - DEPLOY_BLOCK + 1;
  for (const u of CHAINS["base-sepolia"].rpcs) {
    const n = A.good["base-sepolia"].filter((e) => e.method === "eth_getLogs" && e.url === u).length;
    assert.ok(n <= Math.ceil(span / PAGE) + 10, `${u}: ${n} pages for ${span} blocks`);
  }
});

test("the recorded bad run (currentTreeSize one higher on both RPCs) fails on both chains, and is the good run but that", async () => {
  const size = Object.keys(VIEWS).find((k) => VIEWS[k] === "currentTreeSize()");
  for (const name of Object.keys(CHAINS)) {
    assert.deepEqual(A.bad[name], spoil(A.good[name]), name);
    const changed = A.bad[name].filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[name][i]));
    assert.ok(changed.length >= 2 && changed.every((e) => e.params[0].data === size), name);
    const r = await check(name, replayer(A.bad[name]), { wait: false });
    assert.equal(r.ok, false, name);
    assert.match(r.lines.at(-1), /the state tree from the logs \(\d+ leaves\) is not the pool's/);
  }
});

test("a replay with one RPC's answer missing is a failure, never a pass", async () => {
  const log = A.good["robinhood-testnet"];
  const i = log.findIndex((e) => e.method === "eth_call");
  const r = await check("robinhood-testnet", replayer(log.filter((_, j) => j !== i)), { wait: false });
  assert.equal(r.ok, false);
});

test("Base Sepolia's pair pages the pool's whole life at the pager's full page, each provider under its own cap", async () => {
  // card notes-per-pool-evm-base-hang: on sepolia.base.org's 200-block cap the pager's pages were 156 blocks, about
  // 8,250 for the pool's 1,287,712 blocks (41 min at the 0.3 s a page read live); the check printed nothing in 20 min
  const { transport, pages } = standIn();
  const r = await check("base-sepolia", transport, { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines[5], /no leaf yet/);
  const budget = Math.ceil((HEAD - DEPLOY_BLOCK + 1) / PAGE) + 10;
  for (const u of CHAINS["base-sepolia"].rpcs) {
    const n = pages.get(new URL(u).host) ?? 0;
    assert.ok(n > 0 && n <= budget, `${new URL(u).host}: ${n} eth_getLogs pages, over ${budget} (${[...pages].map(([h, k]) => `${h} ${k}`).join(", ")})`);
  }
});

test("a sync with no end fails at its deadline, naming the call it is stuck on: the host only, the method, the range and the try", async () => {
  const pocket = new URL(CHAINS["base-sepolia"].rpcs[1]).host;
  const { transport } = standIn((h, method) => h === pocket && method === "eth_getLogs");
  const t0 = Date.now();
  const r = await check("base-sepolia", transport, { wait: false, deadlineMs: 3_000 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 15_000, `ended after ${Date.now() - t0} ms`);
  const want = `stuck on eth_getLogs ${DEPLOY_BLOCK}..${DEPLOY_BLOCK + PAGE - 1} (${PAGE} blocks) on ${pocket}, try 1, no answer in `;
  assert.match(r.lines.at(-1), /^base-sepolia: no end in 3\.0 s \(\d+ calls\): /);
  assert.ok(r.lines.at(-1).includes(want), r.lines.at(-1));
  assert.ok(!/https?:\/\//.test(r.lines.at(-1)), r.lines.at(-1));
});
