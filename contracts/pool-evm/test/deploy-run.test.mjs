// The EVM pool's deploy run (script/deploy.mjs main()) against a mock op-geth chain: Base Sepolia's id and fee
// terms, geth's txpool rules (a resend of what is pending is "already known"; a replacement must pay strictly more
// and at least 10% more on both fee terms, and a resend of a replaced hash is "underpriced"; the balance check counts
// the account's pending costs) and op-geth's L1 fee added to that check and to the fee. The run's
// clock is virtual. Each case is a way a real run could leave money on the run key or send it nowhere:
//   a send answer lost, a deploy stuck below the base fee, an L1 fee rise while the run waits for funding, a bad
//   --return, a second signal during the sweep, a funding transfer that lands after a stop, a chain that includes
//   nothing for 40 min, and a stuck deploy on a chain whose suggested tip is 0 (as Robinhood's is).
//   node --test contracts/pool-evm/test/deploy-run.test.mjs     (after a forge build: it reads out/)
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { CHAINS, DUST, MAINNETS, bytes, hex, keccak } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { BUILT, MAINNET_INIT, MAX_FEE_CAP, ORDER, RPC_TRIES, sinkOf, addressOf, createAddress, deployedElsewhere, initProblems, main, outflowOf } from "../script/deploy.mjs";

const OUT_DIR = new URL("../out/", import.meta.url);
const runtime = (name) => JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT_DIR), "utf8")).deployedBytecode.object;
const init = (name) => JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT_DIR), "utf8")).bytecode.object;
/** the contract a create transaction's data deploys: the one whose init code it starts with */
const createdBy = (data) => BUILT.find((n) => data.startsWith(init(n)));
const E = "0x49f2425b7f33f3a10912de8add6839226ce663a2"; // a stand-in return address with no code
const TMP = mkdtempSync(path.join(tmpdir(), "pool-evm-run-"));

// ---- a minimal RLP decode of the signed transactions ----
function dec(b, i = 0) {
  const p = b[i];
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  if (p < 0xb8) return [b.subarray(i + 1, i + 1 + p - 0x80), i + 1 + p - 0x80];
  if (p < 0xc0) {
    const ll = p - 0xb7;
    const l = Number(BigInt(hex(b.subarray(i + 1, i + 1 + ll))));
    return [b.subarray(i + 1 + ll, i + 1 + ll + l), i + 1 + ll + l];
  }
  let l, s;
  if (p < 0xf8) (l = p - 0xc0), (s = i + 1);
  else {
    const ll = p - 0xf7;
    l = Number(BigInt(hex(b.subarray(i + 1, i + 1 + ll))));
    s = i + 1 + ll;
  }
  const out = [];
  for (let j = s; j < s + l; ) {
    const [x, n] = dec(b, j);
    out.push(x);
    j = n;
  }
  return [out, s + l];
}
const num = (u) => (u.length ? BigInt(hex(u)) : 0n);
const parse = (raw) => {
  const b = bytes(raw);
  const [f] = dec(b, 1);
  return { nonce: num(f[1]), tip: num(f[2]), maxFee: num(f[3]), gas: num(f[4]), to: f[5].length ? hex(f[5]) : null, value: num(f[6]), data: hex(f[7]), len: BigInt(b.length) };
};

/** A mock chain and a virtual clock. `on` hooks: lose(t) -> true loses that send's answer; afterMine(chain). */
function chain(on = {}) {
  const c = { id: on.id ?? "0x14a34", calls: [], base: 5_000_000n, tip: on.tip ?? 1_000_000n, l1Scale: 2n, clock: 0, bal: new Map(), nonce: new Map(), code: new Map(), created: [], pool: [], receipts: new Map(), block: 100, seen: new Set(), deployer: null, fundAt: null, fundWei: 0n, logs: [] };
  const g = (m, k) => m.get(k.toLowerCase()) ?? 0n;
  const l1Of = (len) => c.l1Scale * (len > 100n ? len : 100n);
  const costOf = (t) => t.gas * t.maxFee + t.value + l1Of(t.len);
  c.balanceOf = (a) => g(c.bal, a);
  c.mine = () => {
    if (c.fundAt !== null && c.clock >= c.fundAt) {
      c.bal.set(c.deployer, g(c.bal, c.deployer) + c.fundWei);
      c.fundAt = null;
      c.block++;
    }
    c.pool.sort((a, b) => Number(a.t.nonce - b.t.nonce));
    while (c.pool.length) {
      const { t, hash } = c.pool[0];
      if (t.nonce !== g(c.nonce, c.deployer) || t.maxFee < c.base) break;
      c.pool.shift();
      const used = t.to ? 21000n : (t.gas * 10n) / 12n;
      const price = c.base + (t.tip < t.maxFee - c.base ? t.tip : t.maxFee - c.base);
      // on.arb: an Arbitrum-shaped receipt, the L1 part paid as gas inside gasUsed (gasUsedForL1), with no l1Fee
      const l1Gas = on.arb ? (l1Of(t.len) + price - 1n) / price : 0n;
      const fee = on.arb ? (used + l1Gas) * price : used * price + l1Of(t.len);
      if (g(c.bal, c.deployer) < t.value + fee) continue; // dropped: it cannot pay at execution
      c.bal.set(c.deployer, g(c.bal, c.deployer) - t.value - fee);
      let ca = null;
      // on.revert(t): a create that reverts pays its fee and makes nothing
      const reverted = !t.to && on.revert?.(t, c);
      if (t.to) c.bal.set(t.to, g(c.bal, t.to) + t.value);
      else if (!reverted) c.code.set((ca = createAddress(c.deployer, t.nonce)), runtime(createdBy(t.data))), c.created.push(t.data);
      c.nonce.set(c.deployer, t.nonce + 1n);
      c.block++;
      c.receipts.set(hash, { status: reverted ? "0x0" : "0x1", blockNumber: "0x" + c.block.toString(16), contractAddress: ca, effectiveGasPrice: "0x" + price.toString(16), from: c.deployer, ...(on.arb ? { gasUsed: "0x" + (used + l1Gas).toString(16), gasUsedForL1: "0x" + l1Gas.toString(16) } : { gasUsed: "0x" + used.toString(16), l1Fee: "0x" + l1Of(t.len).toString(16) }) });
      on.afterMine?.(c, t);
    }
  };
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const err = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }) });
  c.fetch = async (url, init) => {
    c.mine();
    const { method, params } = JSON.parse(init.body);
    c.calls.push({ url, method, params });
    if (on.limited?.(method, params, c)) return { ok: false, status: 429, json: async () => ({ code: 429, message: "Connection rate limits exceeded" }) };
    switch (method) {
      case "eth_chainId": return ok(c.id);
      case "eth_blockNumber": return ok("0x" + c.block.toString(16));
      case "eth_getBlockByNumber": return ok({ baseFeePerGas: "0x" + c.base.toString(16), number: "0x" + (params[0] === "safe" ? (c.safeOf?.() ?? c.block) : c.block).toString(16) });
      case "eth_maxPriorityFeePerGas": return ok("0x" + c.tip.toString(16));
      case "eth_estimateGas": return ok(params[0].to ? "0x5208" : "0x" + (600000).toString(16));
      case "eth_call": return ok("0x" + (c.l1Scale * (BigInt("0x" + params[0].data.slice(10)) + 68n)).toString(16).padStart(64, "0"));
      case "eth_getTransactionCount": {
        const a = params[0].toLowerCase();
        if (a !== E) c.deployer ??= a;
        const pend = params[1] === "pending" ? BigInt(c.pool.length) : 0n;
        return ok("0x" + (g(c.nonce, a) + pend).toString(16));
      }
      case "eth_getBalance": return ok("0x" + g(c.bal, params[0]).toString(16));
      case "eth_getCode": return ok(c.code.get(params[0].toLowerCase()) ?? "0x");
      case "eth_getTransactionReceipt": return ok(c.receipts.get(params[0]) ?? null);
      case "eth_sendRawTransaction": {
        const t = parse(params[0]);
        const hash = keccak(params[0]);
        on.sent?.(params[0], hash, c);
        if (c.pool.some((p) => p.hash === hash)) return err("already known");
        if (t.nonce < g(c.nonce, c.deployer)) return err("nonce too low");
        const at = c.pool.findIndex((p) => p.t.nonce === t.nonce);
        if (at >= 0) {
          // geth: strictly greater on both terms, and at least the 10% price bump (a replaced hash sent again lands here)
          const o = c.pool[at].t;
          if (t.tip <= o.tip || t.maxFee <= o.maxFee || t.tip * 10n < o.tip * 11n || t.maxFee * 10n < o.maxFee * 11n) return err("replacement transaction underpriced");
        }
        const others = c.pool.filter((p, i) => i !== at).reduce((s, p) => s + costOf(p.t), 0n);
        if (g(c.bal, c.deployer) < others + costOf(t)) return err("insufficient funds for gas * price + value");
        if (at >= 0) c.pool.splice(at, 1);
        c.seen.add(hash);
        c.pool.push({ t, hash });
        if (on.lose?.(t)) return { ok: false, status: 502, json: async () => null };
        return ok(hash);
      }
    }
    throw new Error(`mock: ${method}`);
  };
  c.io = {
    sleep: async (ms) => {
      c.clock += ms;
      await new Promise((r) => setImmediate(r));
    },
    now: () => c.clock,
  };
  return c;
}

/** Runs main() on the mock with the funder sending the printed need `fundDelay` virtual ms after the waiting line;
 * `onLine(line, c)` sees every printed line. Returns the run's outcome and the chain. */
async function run(t, c, { ret = E, fundDelay = 0, onLine, args = [], head = ["--chain", "base-sepolia", "--rpc", "https://mock.invalid"], io = {}, outArg = true, out: out0 } = {}) {
  const exits = [];
  t.mock.method(process, "exit", (code) => void exits.push(code));
  const realFetch = globalThis.fetch;
  globalThis.fetch = c.fetch;
  const see = (...a) => {
    const line = a.join(" ");
    c.logs.push(line);
    const m = line.match(/^deploy: waiting for (\d+) wei/);
    if (m) (c.fundWei = BigInt(m[1])), (c.fundAt = c.clock + fundDelay);
    onLine?.(line, c);
  };
  t.mock.method(console, "log", see);
  t.mock.method(console, "error", see);
  const out = out0 ?? path.join(TMP, `${t.name.replace(/\W+/g, "-").slice(0, 80)}.json`);
  let error = null;
  const before = process.exitCode;
  try {
    await main([...head, ...(ret === null ? [] : ["--return", ret]), ...(outArg ? ["--out", out] : []), "--no-build", ...args], { ...c.io, ...io });
  } catch (e) {
    error = e;
  } finally {
    globalThis.fetch = realFetch;
  }
  const exitCode = process.exitCode;
  process.exitCode = before;
  for (let i = 0; i < 50; i++) await c.io.sleep(5000), c.mine(); // the chain settles
  let record = null;
  try {
    record = JSON.parse(readFileSync(out, "utf8"));
  } catch {}
  return { error, exits, exitCode, record, out };
}
const why = (c) => "\n" + c.logs.join("\n");
const settled = (c, r) => {
  assert.deepEqual(r.exits, [], "never process.exit" + why(c));
  assert.notEqual(r.exitCode, 1, "no SWEEP FAILED" + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, `the run key keeps ${c.balanceOf(c.deployer)} wei${why(c)}`);
  assert.equal(c.pool.length, 0, "nothing pending");
  // the record lists every transaction that landed, in nonce order, each once
  assert.equal(r.record.txs.length, Number(c.nonce.get(c.deployer)), "the record lists every landed transaction" + why(c));
  for (const tx of r.record.txs) assert.ok(c.receipts.has(tx.hash), tx.hash);
};
const OPTS = { timeout: 60_000 };

test("a deploy whose send answer is lost (a 502, the transaction in the pool) is waited for: every deploy lands, the record lists it, the sweep lands", OPTS, async (t) => {
  let lost = false;
  const c = chain({ lose: (tx) => !tx.to && tx.nonce === 1n && !lost && (lost = true) });
  const r = await run(t, c);
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  assert.deepEqual(r.record.txs.filter((x) => x.contract).map((x) => x.contract), ORDER);
  assert.ok(c.balanceOf(E) > 0n);
});

test("a deploy stuck below a risen base fee is replaced by a cancel at its nonce, then the sweep lands", OPTS, async (t) => {
  const c = chain({ afterMine: (ch, tx) => tx.nonce === 0n && (ch.base *= 10n) });
  const r = await run(t, c);
  assert.match(String(r.error?.message), /no receipt in 180 s|the deploy stopped/, why(c));
  settled(c, r);
  assert.ok(r.record.txs.some((x) => /^cancel \(replaces deploy PrivacyPoolSimple at nonce 1\)/.test(x.step)), why(c));
  assert.ok(r.record.txs.some((x) => x.step.startsWith("sweep")));
  assert.deepEqual(Object.keys(r.record.contracts), ["WithdrawalVerifier"]);
});

test("an L1 fee that triples while the run waits for funding does not strand the sweep", OPTS, async (t) => {
  const c = chain();
  const r = await run(t, c, { onLine: (l, ch) => l.startsWith("deploy: waiting for") && (ch.l1Scale *= 3n) });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
});

test("a funding wait whose balance read meets a burst of 429s keeps waiting: the run is funded, deploys and sweeps (the Solana devnet rehearsal's run ended on one, 5 Nov 18:47Z)", OPTS, async (t) => {
  let waiting = false;
  let limited = 0;
  const c = chain({ limited: (m, p, ch) => waiting && m === "eth_getBalance" && p[0].toLowerCase() === ch.deployer && limited < RPC_TRIES && ++limited });
  const r = await run(t, c, { onLine: (l) => l.startsWith("deploy: waiting for") && (waiting = true) });
  assert.equal(limited, RPC_TRIES, "every try of one read was rate-limited" + why(c));
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  assert.ok(c.logs.some((l) => /^deploy: the run key's balance not read \(eth_getBalance: HTTP 429.*\): reading it again/.test(l)), why(c));
});

test("--return is refused when zero, the run key, of a bad EIP-55 checksum or an account with code; nothing is sent", OPTS, async (t) => {
  for (const [ret, re] of [
    ["0x0000000000000000000000000000000000000000", /zero address/],
    ["0x49F2425b7F33f3a10912DE8add6839226cE663a3", /EIP-55 checksum/],
    ["0x49f2425b7f33f3a10912de8add6839226ce663a3", /has code/],
  ]) {
    const c = chain();
    c.code.set("0x49f2425b7f33f3a10912de8add6839226ce663a3", "0x6000");
    const r = await run(t, c, { ret });
    assert.match(String(r.error?.message), re, ret + why(c));
    assert.equal(c.seen.size, 0, "no transaction sent");
    assert.equal(c.fundAt ?? c.fundWei, 0n, "no need printed");
  }
  // a correct EIP-55 address and an all-lowercase one are taken
  const c = chain();
  const r = await run(t, c, { ret: "0x49F2425b7F33f3a10912DE8add6839226cE663a2" });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
});

test("a second signal during the sweep never exits: the sweep finishes; SIGHUP stops the run like SIGTERM", OPTS, async (t) => {
  const c = chain();
  let n = 0;
  const r = await run(t, c, {
    onLine: (l) => {
      if (l.startsWith("deploy: WithdrawalVerifier ") && n++ === 0) process.emit("SIGHUP", "SIGHUP");
      if (l.startsWith("deploy: sweep ")) process.emit("SIGTERM", "SIGTERM");
    },
  });
  assert.match(String(r.error?.message), /stopped by SIGHUP/, why(c));
  settled(c, r);
  assert.ok(c.balanceOf(E) > 0n);
  assert.deepEqual(r.record.txs.map((x) => x.step), ["deploy WithdrawalVerifier", "sweep (the run key's rest back)"]);
});

test("a funding transfer that lands 20 s after a stop during the funding wait is swept back", OPTS, async (t) => {
  const c = chain();
  const r = await run(t, c, { fundDelay: 20_000, onLine: (l) => l.startsWith("deploy: waiting for") && process.emit("SIGTERM", "SIGTERM") });
  assert.match(String(r.error?.message), /stopped by SIGTERM/, why(c));
  assert.ok(c.balanceOf(E) > (c.fundWei * 9n) / 10n, `the stand-in got back ${c.balanceOf(E)} of ${c.fundWei}${why(c)}`);
  settled(c, r);
});

test("a chain that includes nothing for 40 min from the second deploy on: cancels and the sweep-anyway each price above what is pending, and the sweep lands", { timeout: 120_000 }, async (t) => {
  const c = chain();
  let haltFrom = null;
  const mine = c.mine;
  c.mine = () => {
    if (haltFrom !== null && c.clock < haltFrom + 40 * 60_000) return;
    mine();
  };
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method } = JSON.parse(init.body);
    if (method === "eth_sendRawTransaction" && haltFrom === null && c.nonce.get(c.deployer) === 1n) haltFrom = c.clock;
    return fetch0(u, init);
  };
  const r = await run(t, c);
  assert.match(String(r.error?.message), /no receipt in 180 s|the deploy stopped/, why(c));
  settled(c, r);
  assert.ok(c.balanceOf(E) > (c.fundWei * 8n) / 10n, `the stand-in got back ${c.balanceOf(E)} of ${c.fundWei}${why(c)}`);
});

test("a stuck deploy on a chain whose suggested tip is 0 is cancelled with a tip of at least 1 (geth needs strictly more)", OPTS, async (t) => {
  const c = chain({ tip: 0n, afterMine: (ch, tx) => tx.nonce === 0n && (ch.base *= 10n) });
  const r = await run(t, c);
  assert.match(String(r.error?.message), /no receipt in 180 s|the deploy stopped/, why(c));
  settled(c, r);
  assert.ok(r.record.txs.some((x) => x.step.startsWith("cancel (replaces deploy PrivacyPoolSimple")), why(c));
  assert.ok(c.balanceOf(E) > 0n);
});

test("--only SellDelegate deploys the delegate alone at nonce 0, constructed with the chain's WETH and v4 PoolManager; its record names it alone; the sweep lands", OPTS, async (t) => {
  const c = chain();
  const r = await run(t, c, { args: ["--only", "SellDelegate"] });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  assert.deepEqual(Object.keys(r.record.contracts), ["SellDelegate"]);
  assert.equal(r.record.contracts.SellDelegate.address, createAddress(r.record.deployer, 0));
  assert.deepEqual(r.record.txs.map((x) => x.step), ["deploy SellDelegate", "sweep (the run key's rest back)"]);
  const word = (a) => a.slice(2).padStart(64, "0");
  assert.deepEqual(c.created, [init("SellDelegate") + word(CHAINS["base-sepolia"].weth.address) + word(CHAINS["base-sepolia"].poolManager.address)]);
  assert.ok(c.logs.some((l) => /^deploy: done\. Next: node scripts\/live-checks\/evm-selldelegate-exact-debit\.mjs --deployment /.test(l)), why(c));
});

test("--only FeeCollector deploys the fee collector alone beside the chain's set (card evm-fee-collector), constructed with the sell sender the kit pins; its record names it and its sink; the sweep lands", OPTS, async (t) => {
  const { evmPoolVenues } = await import("../../../packages/kit/src/index.ts");
  for (const name of ["base-sepolia", "robinhood-testnet"]) {
    const sink = evmPoolVenues()[name].sellSender.toLowerCase();
    assert.match(sink, /^0x[0-9a-f]{40}$/, `the kit pins ${name}'s sell sender`);
    assert.equal(CHAINS[name].contracts.includes("FeeCollector"), false, "beside the 3 Nov set, not in it");
    assert.equal(await sinkOf(name), sink);
  }
  const c = chain();
  const r = await run(t, c, { args: ["--only", "FeeCollector"] });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  const sink = (await sinkOf("base-sepolia"));
  assert.deepEqual(r.record.contracts, { FeeCollector: { address: createAddress(r.record.deployer, 0), sink } });
  assert.deepEqual(r.record.txs.map((x) => x.step), ["deploy FeeCollector", "sweep (the run key's rest back)"]);
  assert.deepEqual(c.created, [init("FeeCollector") + sink.slice(2).padStart(64, "0")]);
  assert.ok(c.logs.some((l) => /^deploy: done\. Next: node scripts\/live-checks\/evm-fee-collector\.mjs --deployment /.test(l)), why(c));
  // a chain whose sell sender the kit does not pin gets no collector: refused before a key is made
  await assert.rejects(sinkOf("base"), /the kit pins no sell sender on base, the FeeCollector's sink: nothing was sent/);
  const c2 = chain();
  const r2 = await run(t, c2, { args: ["--only", "FeeCollector"], io: { sinkOf: async () => { throw new Error("the kit pins no sell sender on base-sepolia, the FeeCollector's sink: nothing was sent"); } } });
  assert.match(String(r2.error?.message), /the kit pins no sell sender/);
  assert.equal(c2.created.length, 0, "nothing deployed");
  assert.equal(c2.deployer, null, "refused before a run key exists");
});

test("--only takes the sell delegate alone: any other contract, or none named, is refused before a key is made", OPTS, async (t) => {
  for (const only of ["UniswapV4Adapter", "PrivacyPoolSimple", "--no-build", undefined]) {
    const c = chain();
    const r = await run(t, c, { args: only === undefined ? ["--only"] : ["--only", only] });
    assert.match(String(r.error?.message), /--only is one of SellDelegate/, String(only));
    assert.equal(c.deployer, null, "no run key");
  }
});

// ---- the mainnets (card pool-evm-deploy-mainnet): the owner's paste runs deploy.mjs --mainnet --chain <base|robinhood> ----
const BASE = MAINNETS.base;
const MAIN = ["--chain", "base", "--mainnet", "--rpc", BASE.rpcs[0]];
/** a mainnet chain (Base's id) where the return address E is a wallet in use (it holds ETH); a run's own key folder
 * and record path in a fresh folder */
const mainnet = (on = {}) => {
  const c = chain({ id: BASE.chainId, ...on });
  c.bal.set(E, 10n ** 15n);
  c.e0 = 10n ** 15n;
  return c;
};
const room = (t) => {
  const dir = mkdtempSync(path.join(TMP, "m-"));
  const out = path.join(dir, "base.json");
  return { dir, keys: path.join(dir, "keys"), out, journal: path.join(dir, "base.journal.json"), io: { keysBase: path.join(dir, "keys"), recordOf: () => out, deployedElsewhere: async () => null } };
};
const folders = (keys) => (existsSync(keys) ? readdirSync(keys) : []);

test("mainnet: --mainnet goes with a mainnet chain on its own first RPC (or a loopback fork with --out); a mainnet id without --mainnet is refused; no key is made", OPTS, async (t) => {
  for (const [head, re, outArg] of [
    [["--chain", "base", "--rpc", BASE.rpcs[0]], /--mainnet/, false],
    [["--chain", "base-sepolia", "--mainnet", "--rpc", BASE.rpcs[0]], /--mainnet is for base, robinhood/, false],
    [["--chain", "base", "--mainnet", "--rpc", "https://evil.example"], /https:\/\/mainnet\.base\.org/, false],
    [["--chain", "base", "--mainnet", "--rpc", BASE.rpcs[0]], /--out .*loopback/, true],
    [["--chain", "base", "--mainnet", "--rpc", "http://127.0.0.1:8545"], /needs --out/, false],
  ]) {
    const c = mainnet();
    const m = room(t);
    const r = await run(t, c, { head, io: m.io, outArg, out: m.out });
    assert.match(String(r.error?.message), re, head.join(" ") + why(c));
    assert.equal(c.deployer, null, "no run key");
    assert.deepEqual(folders(m.keys), [], "no key folder");
  }
});

test("mainnet: --return must be a wallet in use, an account with no code holding ETH on both RPCs; the funding line says to send from it", OPTS, async (t) => {
  const c = mainnet();
  c.bal.set(E, 0n);
  const m = room(t);
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /holds no ETH on https:\/\/mainnet\.base\.org/, why(c));
  assert.equal(c.deployer, null, "no run key");
  // held on the first RPC only: the second's answer counts too
  const c2 = mainnet();
  const fetch0 = c2.fetch;
  c2.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_getBalance" && u === BASE.rpcs[1] && params[0] === E) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x0" }) };
    return fetch0(u, init);
  };
  const r2 = await run(t, c2, { head: MAIN, io: room(t).io, outArg: false, out: room(t).out });
  assert.match(String(r2.error?.message), /holds no ETH on https:\/\/base-rpc\.publicnode\.com/, why(c2));
  // a wallet in use: the run goes on, and the funding line names it as the sender
  const c3 = mainnet();
  const m3 = room(t);
  const r3 = await run(t, c3, { head: MAIN, io: m3.io, outArg: false, out: m3.out });
  assert.equal(r3.error, null, String(r3.error?.message) + why(c3));
  // the need in wei and, exactly, in the chain's own unit (ETH)
  const line = c3.logs.find((l) => l.startsWith("deploy: send exactly "));
  const w = String(line).match(/^deploy: send exactly (\d+) wei \((\d+)(?:\.(\d{1,18}))? ETH\) to (0x[0-9a-f]{40}) on base only, from (0x[0-9a-f]{40}), the address you passed, in one transfer$/);
  assert.ok(w, String(line) + why(c3));
  assert.equal(BigInt(w[1]), c3.fundWei);
  assert.equal(BigInt(w[2]) * 10n ** 18n + BigInt((w[3] ?? "").padEnd(18, "0")), c3.fundWei, "the ETH figure is the wei figure exactly");
  assert.deepEqual([w[4], w[5]], [c3.deployer, E]);
});

test("mainnet: the run key is kept 0700/0600 until swept, every transaction is journaled before its send, the final reads are on both RPCs, then the key and the journal are removed and no key is left in a log or a file", OPTS, async (t) => {
  const m = room(t);
  let key = null;
  const unjournaled = [];
  const c = mainnet({
    sent: (raw, hash) => {
      const j = existsSync(m.journal) ? readFileSync(m.journal, "utf8") : "";
      if (!j.includes(hash)) unjournaled.push(hash);
    },
  });
  const r = await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (!l.startsWith("deploy: waiting for")) return;
      const [f] = folders(m.keys);
      const dir = path.join(m.keys, f);
      assert.equal(statSync(m.keys).mode & 0o777, 0o700);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(dir, "key")).mode & 0o777, 0o600);
      key = readFileSync(path.join(dir, "key"), "utf8").trim();
      assert.equal(addressOf(bytes(key)), c.deployer, "the kept key is the run key");
      assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.folder, f, "the journal names the key folder before any funding");
    },
  });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  assert.ok(key, "the key was kept during the run");
  assert.deepEqual(unjournaled, [], "every transaction journaled before its send");
  for (const u of BASE.rpcs) {
    for (const n of ORDER) assert.ok(c.calls.some((x) => x.url === u && x.method === "eth_getCode" && x.params[0] === r.record.contracts[n].address), `${n}'s code read on ${u}`);
    assert.ok(c.calls.some((x) => x.url === u && x.method === "eth_getBalance" && x.params[0] === c.deployer), `the key's rest read on ${u}`);
  }
  assert.deepEqual(folders(m.keys), [], "the key folder is removed");
  assert.equal(existsSync(m.journal), false, "the journal is removed once the record is written and the key is gone");
  assert.ok(!c.logs.some((l) => l.toLowerCase().includes(key.slice(2).toLowerCase())), "no log line holds the key");
  for (const f of readdirSync(m.dir)) if (statSync(path.join(m.dir, f)).isFile()) assert.ok(!readFileSync(path.join(m.dir, f), "utf8").includes(key.slice(2)), `${f} holds the key`);
  assert.ok(c.logs.some((l) => l === `deploy: done. Next: node scripts/live-checks/pool-evm-deploy.mjs --deployment ${path.relative(process.cwd(), m.out)}`), why(c));
});

test("mainnet: a run whose record exists is refused before any key, naming the live check to run alone", OPTS, async (t) => {
  const m = room(t);
  writeFileSync(m.out, "{}\n");
  const c = mainnet();
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /exists: the pool is deployed on base: run its live check alone: node scripts\/live-checks\/pool-evm-deploy\.mjs --deployment /, why(c));
  assert.equal(c.deployer, null, "no run key");
});

test("mainnet: a stopped run whose key still holds ETH keeps it; a new run is refused until --sweep-kept sends it back to the return address only, read on both RPCs; then a new run moves the journal aside", OPTS, async (t) => {
  const m = room(t);
  // stopped during the funding wait; the funding lands after the late-funding watch: the key holds the need
  const c = mainnet();
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 120_000, onLine: (l) => l.startsWith("deploy: waiting for") && process.emit("SIGTERM", "SIGTERM") });
  assert.match(String(r.error?.message), /stopped by SIGTERM/, why(c));
  assert.equal(c.balanceOf(c.deployer), c.fundWei, "the late funding sits on the key");
  const j = JSON.parse(readFileSync(m.journal, "utf8"));
  assert.equal(j.keys.state, "kept", why(c));
  assert.deepEqual(folders(m.keys), [j.keys.folder]);
  assert.ok(c.logs.some((l) => l.includes("--sweep-kept")), why(c));
  // a new run to another address is refused while the key is kept (the same address resumes, the test below)
  const r2 = await run(t, c, { head: MAIN, ret: "0x2222222222222222222222222222222222222222", io: m.io, outArg: false, out: m.out });
  assert.match(String(r2.error?.message), /resumes only to the run's return address/, why(c));
  // --sweep-kept to any other address is refused
  const other = "0x1111111111111111111111111111111111111111";
  const r3 = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: other, io: m.io, outArg: false, out: m.out });
  assert.match(String(r3.error?.message), /goes back only to the run's return address/, why(c));
  // --sweep-kept: the key's ETH back to E, the key folder removed once both RPCs read it at most DUST
  const e0 = c.balanceOf(E);
  c.calls.length = 0;
  const r4 = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(r4.error, null, String(r4.error?.message) + why(c));
  assert.ok(c.balanceOf(E) - e0 > (c.fundWei * 9n) / 10n, `E got back ${c.balanceOf(E) - e0} of ${c.fundWei}${why(c)}`);
  assert.ok(c.balanceOf(c.deployer) <= DUST);
  for (const u of BASE.rpcs) assert.ok(c.calls.some((x) => x.url === u && x.method === "eth_getBalance" && x.params[0] === c.deployer), `the key's rest read on ${u}`);
  assert.deepEqual(folders(m.keys), [], "the key folder is removed");
  assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.state, "removed");
  // a new run: the journal (its key removed) is moved aside and the run goes on
  const c5 = mainnet();
  const r5 = await run(t, c5, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r5.error, null, String(r5.error?.message) + why(c5));
  assert.ok(readdirSync(m.dir).some((f) => /^base\.stopped-\d+T?\d*Z?\.journal\.json$/.test(f)), readdirSync(m.dir).join(","));
});

test("mainnet: each contract's init code is pinned in deploy.mjs (forge's out/ is the pin; one byte off is refused)", OPTS, async () => {
  assert.deepEqual(Object.keys(MAINNET_INIT), BUILT);
  for (const n of BUILT) {
    const code = init(n);
    assert.equal(initProblems(n, code), null, n);
    const off = code.slice(0, -2) + (code.endsWith("00") ? "01" : "00");
    assert.match(String(initProblems(n, off)), new RegExp(`${n}: init code keccak256 .* not the pinned`), n);
  }
});

test("mainnet: a run stopped after two deploys keeps its key and writes no record; the same paste resumes with that key, reuses both contracts once read back on both RPCs as the build's, deploys only the rest, and its record lists every transaction", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l) => l.startsWith("deploy: PrivacyPoolSimple ") && process.emit("SIGTERM", "SIGTERM") });
  assert.match(String(r.error?.message), /stopped by SIGTERM/, why(c));
  assert.equal(existsSync(m.out), false, "a stopped mainnet run writes no record: the record is the one-deploy guard");
  const j = JSON.parse(readFileSync(m.journal, "utf8"));
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(c.logs.some((l) => /made 2 of 5 contracts: the same paste resumes with this key/.test(l)), why(c));
  const made = Object.fromEntries(j.txs.filter((x) => x.contract && x.landed).map((x) => [x.contract, x.address]));
  assert.deepEqual(Object.keys(made), ["WithdrawalVerifier", "PrivacyPoolSimple"]);
  const deployer = c.deployer;
  c.calls.length = 0;
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  settled(c, r2);
  assert.equal(r2.record.deployer, deployer, "the same key");
  for (const [n, a] of Object.entries(made)) {
    assert.equal(r2.record.contracts[n].address, a, `${n} reused`);
    for (const u of BASE.rpcs) assert.ok(c.calls.some((x) => x.url === u && x.method === "eth_getCode" && x.params[0] === a), `${n} read back on ${u} before its reuse`);
  }
  assert.deepEqual(Object.keys(r2.record.contracts), ORDER);
  for (const n of ORDER) assert.equal(c.created.filter((d) => createdBy(d) === n).length, 1, `${n} made once`);
  assert.ok(c.logs.some((l) => l.startsWith("deploy: resuming the stopped run with its key: WithdrawalVerifier ") && l.includes("reused")), why(c));
  assert.deepEqual(folders(m.keys), [], "the key folder is removed");
  assert.equal(existsSync(m.journal), false, "the journal is removed");
});

// ---- the mainnet paste's review (round 1): each case a way the paste could lose or strand the owner's ETH ----
const lineOf = (c, re) => c.logs.find((l) => re.test(l));
/** a run stopped by SIGTERM once the pool is made: its key is kept for the same paste */
async function stoppedAtPool(t, c, m) {
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l) => l.startsWith("deploy: PrivacyPoolSimple ") && process.emit("SIGTERM", "SIGTERM") });
  assert.match(String(r.error?.message), /stopped by SIGTERM/, why(c));
}

test("mainnet review: a resume whose kept key holds the need asks for nothing; one holding part of it asks only for the shortfall", OPTS, async (t) => {
  for (const part of ["all", "half"]) {
    const m = room(t);
    const c = mainnet();
    await stoppedAtPool(t, c, m);
    c.logs.length = 0;
    // as if the stopped run had been killed before its sweep: the key still holds ETH
    c.bal.set(c.deployer, part === "all" ? 10n ** 16n : 0n);
    let need = null;
    const r = await run(t, c, {
      head: MAIN, io: m.io, outArg: false, out: m.out,
      onLine: (l, ch) => {
        const n = l.match(/^deploy: max fee \d+ wei\/gas \(tip \d+\); need (\d+) wei/);
        if (n && part === "half") (need = BigInt(n[1])), ch.bal.set(ch.deployer, need / 2n);
      },
    });
    assert.equal(r.error, null, String(r.error?.message) + why(c));
    if (part === "all") {
      assert.equal(lineOf(c, /^deploy: (send exactly|waiting for)/), undefined, "no transfer asked for" + why(c));
      assert.ok(lineOf(c, /^deploy: the run key 0x[0-9a-f]{40} holds \d+ wei, at least the need \d+ wei: send nothing$/), why(c));
    } else {
      const short = need - need / 2n;
      assert.ok(lineOf(c, new RegExp(`^deploy: send exactly ${short} wei \\(`)), `the shortfall ${short} of ${need}` + why(c));
    }
    assert.deepEqual(folders(m.keys), [], "the key folder is removed");
  }
});

test("mainnet review: a run killed during its sweep leaves its record; the paste names --sweep-kept, which takes the journal (its key in use), sends the rest back with the return wallet empty, lists every sweep in the record and removes the key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let snap = null;
  let key = null;
  let folder = null;
  const r = await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: waiting for")) (folder = folders(m.keys)[0]), (key = readFileSync(path.join(m.keys, folder, "key"), "utf8"));
      if (l.startsWith("deploy: sweep ") && !snap) snap = { journal: readFileSync(m.journal, "utf8"), record: existsSync(m.out) ? readFileSync(m.out, "utf8") : null };
    },
  });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  assert.ok(snap.record, "the record is written before the sweep");
  // the disk as a hard kill at the sweep leaves it: that journal and record, the key folder
  writeFileSync(m.journal, snap.journal);
  writeFileSync(m.out, snap.record);
  mkdirSync(path.join(m.keys, folder), { recursive: true });
  writeFileSync(path.join(m.keys, folder, "key"), key);
  const sweepTx = JSON.parse(snap.journal).txs.find((x) => x.step.startsWith("sweep")).hash;
  const again = await run(t, mainnet(), { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(again.error?.message), /exists: the pool is deployed on base: .*its run key is still in use: send its rest back: sh contracts\/pool-evm\/script\/mainnet-deploy\.sh base --sweep-kept/);
  c.bal.set(E, 0n); // the owner's wallet emptied since: --sweep-kept never needs it to hold ETH
  c.bal.set(c.deployer, c.balanceOf(c.deployer) + 10n ** 15n); // and a late transfer to the key
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, why(c));
  assert.ok(c.balanceOf(E) > 0n, "the rest went back to the return address");
  const rec = JSON.parse(readFileSync(m.out, "utf8"));
  assert.ok(rec.txs.some((x) => x.hash === sweepTx), "the killed run's sweep is in the record");
  assert.equal(rec.txs.length, Number(c.nonce.get(c.deployer)), "the record lists every transaction of the key" + why(c));
  assert.deepEqual(folders(m.keys), [], "the key folder is removed");
});

test("mainnet review: a run killed mid-deploy (its key in use, no record) is swept by --sweep-kept, which keeps the key for the resume (it made 2 of 5: card pool-evm-deploy-resume-safe)", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let snap = null;
  let key = null;
  let folder = null;
  await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: waiting for")) (folder = folders(m.keys)[0]), (key = readFileSync(path.join(m.keys, folder, "key"), "utf8"));
      if (l.startsWith("deploy: PrivacyPoolSimple ") && !snap) snap = readFileSync(m.journal, "utf8");
    },
  });
  rmSync(m.out, { force: true });
  writeFileSync(m.journal, snap);
  mkdirSync(path.join(m.keys, folder), { recursive: true });
  writeFileSync(path.join(m.keys, folder, "key"), key);
  c.bal.set(c.deployer, c.balanceOf(c.deployer) + 10n ** 15n);
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, why(c));
  assert.equal(folders(m.keys).length, 1, "the key folder is kept: the same paste resumes with it");
  assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.state, "kept");
});

test("mainnet review: a 61 s throttle window after the funding (every read HTTP 429, as Robinhood's RPC answers) is waited out: the run deploys and sweeps", OPTS, async (t) => {
  const m = room(t);
  let from = null;
  const c = mainnet({ limited: (meth, p, ch) => from !== null && ch.clock < from + 61_000 });
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l, ch) => l === "deploy: funded" && from === null && (from = ch.clock) });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
});

test("mainnet review: a throw before the run's try (the pool's estimate reverts) leaves no key folder and no journal", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_estimateGas" && !params[0].to && createdBy(params[0].data) === "PrivacyPoolSimple") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }) };
    return fetch0(u, init);
  };
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /execution reverted/);
  assert.deepEqual(folders(m.keys), [], "no key folder");
  assert.equal(existsSync(m.journal), false, "no journal");
});

test("mainnet review: a resume whose landed verifier does not read back on the second RPC is refused before any funding; the pool is never reused without its verifier", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await stoppedAtPool(t, c, m);
  const j = JSON.parse(readFileSync(m.journal, "utf8"));
  const v1 = j.txs.find((x) => x.contract === "WithdrawalVerifier" && x.landed).address;
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_getCode" && u === BASE.rpcs[1] && params[0] === v1) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) };
    return fetch0(u, init);
  };
  c.logs.length = 0;
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r2.error?.message), /WithdrawalVerifier at 0x[0-9a-f]{40} .* landed, but its code does not read back as the build's on https:\/\/base-rpc\.publicnode\.com: nothing was sent/, why(c));
  assert.equal(lineOf(c, /^deploy: (send exactly|waiting for)/), undefined, "no funding asked for");
  assert.equal(c.created.filter((d) => createdBy(d) === "WithdrawalVerifier").length, 1, "no second verifier");
});

test("mainnet review: a send that gets no answer at all (every try a 502, the transaction in the pool) stays journaled and is waited for: the run completes and the record lists it", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  const fetch0 = c.fetch;
  let lost = null;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_sendRawTransaction" && (lost === params[0] || (lost === null && !parse(params[0]).to && createdBy(parse(params[0]).data) === "UniswapV4Adapter"))) {
      if (lost === null) (lost = params[0]), await fetch0(u, init);
      return { ok: false, status: 502, json: async () => null };
    }
    return fetch0(u, init);
  };
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  assert.ok(r.record.txs.some((x) => x.hash === keccak(lost)), "the unanswered deploy is in the record");
});

test("mainnet review: the init code sent is the bytes checked against the pin, never read again from disk", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  const file = new URL("SellDelegate.sol/SellDelegate.json", OUT_DIR);
  const orig = readFileSync(file, "utf8");
  const swapped = JSON.parse(orig);
  swapped.bytecode.object = swapped.bytecode.object.slice(0, -2) + (swapped.bytecode.object.endsWith("00") ? "01" : "00");
  let r;
  try {
    r = await run(t, c, {
      head: MAIN, io: m.io, outArg: false, out: m.out,
      onLine: (l) => {
        if (l.startsWith("deploy: run key ")) writeFileSync(file, JSON.stringify(swapped)); // after the pin check
        if (l.startsWith("deploy: max fee ")) writeFileSync(file, orig);
      },
    });
  } finally {
    writeFileSync(file, orig);
  }
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  assert.ok(c.created.some((d) => d.startsWith(init("SellDelegate"))), "the pinned SellDelegate bytes were sent");
});

test("mainnet review: fees are the lower of both RPCs', and a max fee over the cap is refused before any key", OPTS, async (t) => {
  {
    const m = room(t);
    const c = mainnet();
    const fetch0 = c.fetch;
    c.fetch = async (u, init) => {
      const { method } = JSON.parse(init.body);
      if (method === "eth_getBlockByNumber" && u === BASE.rpcs[0]) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { baseFeePerGas: "0x" + (c.base * 10n).toString(16) } }) };
      return fetch0(u, init);
    };
    const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
    assert.equal(r.error, null, String(r.error?.message) + why(c));
    assert.ok(lineOf(c, new RegExp(`^deploy: max fee ${2n * c.base + c.tip} wei/gas`)), "the second RPC's lower fee" + why(c));
  }
  {
    const m = room(t);
    const c = mainnet();
    c.base = MAX_FEE_CAP / 2n + 1n;
    const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
    assert.match(String(r.error?.message), /is over the cap 2000000000 .*nothing was sent/, why(c));
    assert.deepEqual(folders(m.keys), [], "no key folder");
    assert.equal(existsSync(m.journal), false);
  }
});

test("mainnet review: a pool deployed beyond this checkout (origin/main's record, or the kit's pin) is refused before any key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  const r = await run(t, c, { head: MAIN, io: { ...m.io, deployedElsewhere: async () => "origin/main holds contracts/pool-evm/deployments/base.json" }, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /the pool is deployed on base already: origin\/main holds contracts\/pool-evm\/deployments\/base\.json/);
  assert.equal(c.deployer, null, "no run key");
  assert.deepEqual(folders(m.keys), []);
});

test("mainnet review: the journal and the record are written whole (a new file renamed over the old), never truncated in place", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  // a hard link (a .hold path) to the file before its rewrite: it keeps the old file's inode in use, so no later file
  // can be given its number. A rename over the path leaves the hold with the old bytes and inode, and the path with
  // new bytes and another inode; a write in place (truncate, then write) changes the hold's bytes too
  const holds = {};
  const hold = (file) => {
    const at = `${file}.hold`;
    linkSync(file, at);
    holds[file] = { at, bytes: readFileSync(file, "utf8"), ino: statSync(at).ino };
  };
  const held = (file, what) => {
    const h = holds[file];
    assert.ok(h, `${what} was held before its rewrite`);
    assert.equal(readFileSync(h.at, "utf8"), h.bytes, `${what}'s old file keeps its bytes: it was not written in place`);
    assert.equal(statSync(h.at).ino, h.ino);
    assert.notEqual(readFileSync(file, "utf8"), h.bytes, `${what} was rewritten`);
    assert.notEqual(statSync(file).ino, h.ino, `${what} is a new file after its rewrite`);
  };
  let journalChecked = false;
  const r = await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: waiting for")) hold(m.journal);
      if (l.startsWith("deploy: SellDelegate ")) held(m.journal, "the journal"), (journalChecked = true);
      if (l.startsWith("deploy: sweep ") && !holds[m.out]) hold(m.out);
    },
  });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  assert.ok(journalChecked, "the journal's rewrite was checked");
  held(m.out, "the record");
  assert.deepEqual(readdirSync(m.dir).filter((f) => f.includes(".tmp-")), [], "no temporary file is left");
});

// ---- the mainnet paste's review (round 2) ----
/** a run hard-killed when its sweep is sent: the disk as it is then (journal, record, key folder) */
async function killedAtSweep(t, m, c) {
  let snap = null;
  let keyFile = null;
  let key = null;
  await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (!keyFile && folders(m.keys).length) (keyFile = path.join(m.keys, folders(m.keys)[0], "key")), (key = readFileSync(keyFile, "utf8"));
      if (l.startsWith("deploy: sweep ") && !snap) snap = { journal: readFileSync(m.journal, "utf8"), record: existsSync(m.out) ? readFileSync(m.out, "utf8") : null };
    },
  });
  writeFileSync(m.journal, snap.journal);
  if (snap.record) writeFileSync(m.out, snap.record);
  else rmSync(m.out, { force: true });
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  return snap;
}

test("mainnet review 2: a resumed run killed during its sweep has a record naming every contract; --sweep-kept keeps each deploy's contract, and the record lists every transaction of the key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await stoppedAtPool(t, c, m);
  const snap = await killedAtSweep(t, m, c);
  assert.deepEqual(Object.keys(JSON.parse(snap.record).contracts), MAINNETS.base.contracts, "the record at the kill names all five");
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  const d = JSON.parse(readFileSync(m.out, "utf8"));
  assert.deepEqual(Object.keys(d.contracts), MAINNETS.base.contracts);
  for (const n of MAINNETS.base.contracts) {
    const tx = d.txs.find((x) => x.step === `deploy ${n}`);
    assert.equal(tx?.contract, n, `${n}'s deploy names its contract`);
    assert.equal(c.receipts.get(tx.hash).contractAddress, d.contracts[n].address, n);
  }
  assert.equal(d.txs.length, Number(c.nonce.get(c.deployer)), "every transaction of the key" + why(c));
  assert.deepEqual(folders(m.keys), []);
});

test("mainnet review 2: --sweep-kept of a run killed in its funding wait watches the key and keeps it while the asked transfer has not landed; once it lands, --sweep-kept sends it back and removes the key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let snap = null;
  let keyFile = null;
  let key = null;
  await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: send exactly") && !snap) (snap = readFileSync(m.journal, "utf8")), (keyFile = path.join(m.keys, folders(m.keys)[0], "key")), (key = readFileSync(keyFile, "utf8"));
    },
  });
  const j = JSON.parse(snap);
  assert.equal(j.txs.length, 0, "killed before any transaction");
  // a chain where the owner's transfer of the need lands 120 s from now, after the watch
  const c2 = mainnet();
  c2.deployer = j.deployer;
  c2.fundAt = 120_000;
  c2.fundWei = BigInt(j.need);
  rmSync(m.out, { force: true });
  writeFileSync(m.journal, snap);
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  const sw = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c2));
  assert.equal(folders(m.keys).length, 1, "the key is kept while its transfer may land" + why(c2));
  assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.state, "kept");
  assert.equal(c2.balanceOf(j.deployer), BigInt(j.need), "the transfer landed on a key still kept");
  const e0 = c2.balanceOf(E);
  const sw2 = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw2.error, null, String(sw2.error?.message) + why(c2));
  assert.ok(c2.balanceOf(E) - e0 > (BigInt(j.need) * 9n) / 10n, "sent back" + why(c2));
  assert.ok(c2.balanceOf(j.deployer) <= DUST);
  assert.deepEqual(folders(m.keys), [], "removed once the transfer was swept");
});

test("mainnet review 2: a resume whose journaled deploy reads no receipt at a spent nonce is refused before any funding, never redeployed", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await stoppedAtPool(t, c, m);
  const j = JSON.parse(readFileSync(m.journal, "utf8"));
  const vtx = j.txs.find((x) => x.contract === "WithdrawalVerifier").hash;
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_getTransactionReceipt" && params[0] === vtx) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) };
    return fetch0(u, init);
  };
  c.logs.length = 0;
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /deploy WithdrawalVerifier 0x[0-9a-f]{64} at nonce 0: the nonce is spent but no journaled transaction there has a receipt .*nothing was sent/, why(c));
  assert.equal(lineOf(c, /^deploy: (send exactly|waiting for)/), undefined, "no funding asked for");
  assert.equal(c.created.filter((d) => createdBy(d) === "WithdrawalVerifier").length, 1, "no second verifier");
});

test("mainnet review 2: a failed git fetch is refused as itself, never as a pool deployed already; origin/main with no record and a kit with no pin pass", OPTS, async () => {
  const ok = { status: 0 };
  const no = { status: 1 };
  await assert.rejects(deployedElsewhere("base", { git: (cmd) => (cmd === "fetch" ? no : ok) }), (e) => /^git fetch origin main failed, so main's record could not be read: nothing was sent/.test(e.message) && !/deployed/.test(e.message));
  await assert.rejects(deployedElsewhere("base", { git: (cmd) => (cmd === "rev-parse" ? no : ok) }), (e) => /^origin\/main is not in this checkout, so main's record could not be read: nothing was sent/.test(e.message));
  assert.equal(await deployedElsewhere("base", { git: (cmd) => (cmd === "cat-file" ? no : ok) }), null);
  assert.equal(await deployedElsewhere("base", { git: () => ok }), "origin/main holds contracts/pool-evm/deployments/base.json");
});

// ---- the mainnet paste's review (round 3) ----
test("mainnet review 3: a resumed run stopped in its funding wait is unfunded: --sweep-kept watches the key and keeps it while the shortfall the resume asked for may land", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await stoppedAtPool(t, c, m);
  // the same paste resumes and asks for the shortfall; stopped in the wait; the owner's transfer is slow
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => l.startsWith("deploy: send exactly") && process.emit("SIGTERM", "SIGTERM") });
  const j2 = JSON.parse(readFileSync(m.journal, "utf8"));
  assert.equal(j2.keys.state, "kept");
  c.logs.length = 0;
  const r3 = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(r3.error, null, String(r3.error?.message) + why(c));
  assert.ok(c.logs.some((l) => /watching .* balance/.test(l)), "the key is watched" + why(c));
  assert.equal(folders(m.keys).length, 1, "the key is kept");
  assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.state, "kept");
  assert.notEqual(c.fundAt, null, "the asked transfer is still to land");
  c.clock = c.fundAt;
  c.mine();
  const r4 = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(r4.error, null, String(r4.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, "once it lands, it is sent back" + why(c));
});

test("mainnet review 3: a funding-wait key holding part of its need is kept by every --sweep-kept (a sweep it sent is no reading of the need) until the rest lands", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let snap = null;
  let keyFile = null;
  let key = null;
  await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: send exactly") && !snap) (snap = readFileSync(m.journal, "utf8")), (keyFile = path.join(m.keys, folders(m.keys)[0], "key")), (key = readFileSync(keyFile, "utf8"));
    },
  });
  const j = JSON.parse(snap);
  const need = BigInt(j.need);
  const c2 = mainnet();
  c2.deployer = j.deployer;
  c2.bal.set(j.deployer.toLowerCase(), need / 2n);
  c2.fundAt = 1e9;
  c2.fundWei = need - need / 2n;
  writeFileSync(m.journal, snap);
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  for (const pass of [1, 2]) {
    c2.logs.length = 0;
    const s = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
    assert.equal(s.error, null, String(s.error?.message) + why(c2));
    assert.ok(c2.logs.some((l) => /watching .* balance/.test(l)), `pass ${pass} watches` + why(c2));
    assert.equal(folders(m.keys).length, 1, `pass ${pass} keeps the key`);
  }
  c2.clock = c2.fundAt;
  c2.mine();
  const s3 = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(s3.error, null, String(s3.error?.message) + why(c2));
  assert.ok(c2.balanceOf(j.deployer) <= DUST, "the rest is sent back once it lands" + why(c2));
  assert.deepEqual(folders(m.keys), [], "once the rest has landed and is swept, the key is removed" + why(c2));
  assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.state, "removed");
});

test("mainnet review 3: a settled run's final record reads no receipt over RPC: an outage once its key is removed still leaves a record of every transaction", OPTS, async (t) => {
  const m = room(t);
  let raised = false;
  let down = false;
  const c = mainnet();
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => (down ? { ok: false, status: 503, json: async () => null } : fetch0(u, init));
  const r = await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l, ch) => {
      // the base fee jumps once the first sweep is sent, so a cancel replaces it
      if (l.startsWith("deploy: sweep ") && !raised) (raised = true), (ch.base *= 10n);
      if (/its key folder is removed/.test(l)) down = true;
    },
  });
  down = false;
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  const d = JSON.parse(readFileSync(m.out, "utf8"));
  assert.equal(d.txs.length, Number(c.nonce.get(c.deployer)), "the record lists every transaction of the key" + why(c));
});

const partFunded = async (t, on = {}) => {
  const m = room(t);
  const c = mainnet(on);
  let snap = null;
  let keyFile = null;
  let key = null;
  await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: send exactly") && !snap) (snap = readFileSync(m.journal, "utf8")), (keyFile = path.join(m.keys, folders(m.keys)[0], "key")), (key = readFileSync(keyFile, "utf8"));
    },
  });
  const j = JSON.parse(snap);
  const need = BigInt(j.need);
  const c2 = mainnet(on);
  c2.deployer = j.deployer;
  c2.bal.set(j.deployer.toLowerCase(), need / 2n);
  c2.fundAt = 1e9;
  c2.fundWei = need - need / 2n;
  writeFileSync(m.journal, snap);
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  // pass 1: the part is sent back; the rest is still to land: kept
  const s1 = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(s1.error, null, String(s1.error?.message) + why(c2));
  assert.equal(folders(m.keys).length, 1, "pass 1 keeps the key");
  // the rest lands
  c2.clock = c2.fundAt;
  c2.mine();
  // pass 2: the key's balance and what it sent out reach the need: swept and removed
  const s2 = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(s2.error, null, String(s2.error?.message) + why(c2));
  assert.ok(c2.balanceOf(j.deployer) <= DUST, "the rest is sent back" + why(c2));
  assert.deepEqual(folders(m.keys), [], "the key is removed once the rest has landed and is swept" + why(c2));
  const jj = JSON.parse(readFileSync(m.journal, "utf8"));
  assert.equal(jj.keys.state, "removed");
  assert.equal(jj.funded, true);
};
test("mainnet review 4: a funding-wait key that held part of its need and sent it back is removed once the rest lands and is swept, and kept on every pass before", OPTS, (t) => partFunded(t));
test("mainnet review 5: the same on Arbitrum-shaped receipts (the L1 part inside gasUsed, no l1Fee)", OPTS, (t) => partFunded(t, { arb: true }));

test("mainnet review 5: a stopped run's sweep that lands after the resume read its nonce never counts as sent since the resume's wait: --sweep-kept keeps the key while the asked transfer may land", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await stoppedAtPool(t, c, m);
  const j1 = JSON.parse(readFileSync(m.journal, "utf8"));
  const top = j1.txs.reduce((x, s) => (BigInt(s.nonce) + 1n > x ? BigInt(s.nonce) + 1n : x), 0n);
  const sweep1 = j1.txs.find((s) => s.step.startsWith("sweep"));
  assert.ok(sweep1 && BigInt(sweep1.nonce) === top - 1n, "the stopped run's last transaction is its sweep");
  // the resume's latest and pending nonce reads come from a replica a block behind, before that sweep
  let stale = 2;
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (stale > 0 && method === "eth_getTransactionCount" && params[0].toLowerCase() === c.deployer) {
      stale--;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (top - 1n).toString(16) }) };
    }
    return fetch0(u, init);
  };
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => l.startsWith("deploy: send exactly") && process.emit("SIGTERM", "SIGTERM") });
  c.fetch = fetch0;
  assert.equal(JSON.parse(readFileSync(m.journal, "utf8")).keys.state, "kept");
  const r3 = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(r3.error, null, String(r3.error?.message) + why(c));
  assert.notEqual(c.fundAt, null, "the asked transfer has not landed");
  assert.equal(folders(m.keys).length, 1, "the key is kept while the asked transfer may land" + why(c));
});

test("mainnet review 5: outflowOf counts what a receipt says the key paid, on each receipt shape", () => {
  const me = "0x264c8ff331fe18ae69bb01cc66732e391c1e758d";
  const other = "0x1da00622b51c37bf321bed40659f56adfa79f828";
  // Base mainnet's receipt of 0x995a24c2...e754 (read 6 Nov 02:36Z): an OP stack (Jovian) self-send, gasUsed x price + l1Fee
  const base = { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x4c4b40", l1Fee: "0x280ab79d", daFootprintGasScalar: "0x94", from: me, to: me };
  const fee = 0x5208n * 0x4c4b40n + 0x280ab79dn;
  assert.equal(outflowOf({ value: 7n, to: me }, base, me), fee, "a send to itself keeps its value");
  assert.equal(outflowOf({ value: 7n, to: other }, base, me), fee + 7n);
  // Robinhood mainnet's receipt of 0x38fc62f4...05c1 (read 6 Nov 02:36Z): Arbitrum, the L1 part inside gasUsed, no l1Fee
  const arb = { status: "0x1", gasUsed: "0x6866", gasUsedForL1: "0x0", effectiveGasPrice: "0x14b7390", from: me, to: other };
  assert.equal(outflowOf({ value: 5n, to: other }, arb, me), 0x6866n * 0x14b7390n + 5n);
  assert.equal(outflowOf({ value: 5n, to: other }, { ...arb, gasUsedForL1: "0x100" }, me), 0x6866n * 0x14b7390n + 5n, "gasUsedForL1 is inside gasUsed, never added");
  // a failed transaction pays its fee, never its value
  assert.equal(outflowOf({ value: 9n, to: other }, { ...arb, status: "0x0" }, me), 0x6866n * 0x14b7390n);
  // OP operator fee: Isthmus (scalar / 1e6) and, once receipts carry daFootprintGasScalar, Jovian (scalar x 100)
  const op = { status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x10", l1Fee: "0x0", operatorFeeScalar: "0x3e8", operatorFeeConstant: "0x5" };
  assert.equal(outflowOf({ value: 0n, to: other }, op, me), 0x5208n * 0x10n + (0x5208n * 1000n) / 1_000_000n + 5n);
  assert.equal(outflowOf({ value: 0n, to: other }, { ...op, daFootprintGasScalar: "0x0" }, me), 0x5208n * 0x10n + 0x5208n * 1000n * 100n + 5n);
  // what the receipt or the journal does not say is no count
  assert.equal(outflowOf({ value: 1n, to: other }, { ...arb, effectiveGasPrice: undefined }, me), null);
  assert.equal(outflowOf({ to: other }, arb, me), null);
});

// ---- card pool-evm-deploy-resume-safe: a stop, resume or sweep never deploys a contract twice and never removes a key
// a transfer can still reach ----
/** `c.fetch` with `f(u, method, params)` answering first where it returns a value */
const answer = (c, f) => {
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    const v = f(u, method, params);
    return v === undefined ? fetch0(u, init) : { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: v }) };
  };
  return fetch0;
};
const journalOf = (m) => JSON.parse(readFileSync(m.journal, "utf8"));
/** a mainnet run killed in its funding wait (no transaction signed): the disk as it is then */
async function killedInWait(t, m, c) {
  let snap = null;
  let keyFile = null;
  let key = null;
  await run(t, c, {
    head: MAIN, io: m.io, outArg: false, out: m.out,
    onLine: (l) => {
      if (l.startsWith("deploy: send exactly") && !snap) (snap = readFileSync(m.journal, "utf8")), (keyFile = path.join(m.keys, folders(m.keys)[0], "key")), (key = readFileSync(keyFile, "utf8"));
    },
  });
  rmSync(m.out, { force: true });
  writeFileSync(m.journal, snap);
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  return JSON.parse(snap);
}

test("resume-safe R1: --sweep-kept of a run that made 2 of 5 sends its rest back and keeps its key and journal; the same paste then resumes with that key and makes only the other 3", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await stoppedAtPool(t, c, m);
  c.bal.set(c.deployer, c.balanceOf(c.deployer) + 10n ** 15n); // a late transfer to the kept key
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, "its rest went back" + why(c));
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(j.keys.why.some((w) => /made 2 of 5 contracts/.test(w)), j.keys.why.join("; "));
  assert.equal(folders(m.keys).length, 1, "the key folder is kept");
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  for (const n of ORDER) assert.equal(c.created.filter((d) => createdBy(d) === n).length, 1, `${n} made once` + why(c));
  assert.deepEqual(folders(m.keys), [], "removed once the run is whole and swept");
});

test("resume-safe R4: a deploy whose receipt the first RPC lags on (its code on both RPCs) counts as made: the key is kept, and once the receipt shows the same paste reuses it", OPTS, async (t) => {
  const m = room(t);
  let vh = null;
  let lag = true;
  const c = mainnet({ sent: (raw, hash) => !parse(raw).to && createdBy(parse(raw).data) === "WithdrawalVerifier" && (vh ??= hash) });
  answer(c, (u, method, params) => (lag && method === "eth_getTransactionReceipt" && u === BASE.rpcs[0] && params[0] === vh ? null : undefined));
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /deploy WithdrawalVerifier .*no receipt/, why(c));
  assert.equal(c.created.length, 1, "the verifier landed");
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(j.keys.why.some((w) => /made 1 of 5 contracts/.test(w)), j.keys.why.join("; "));
  assert.equal(folders(m.keys).length, 1, "the key folder is kept");
  lag = false;
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  settled(c, r2);
  for (const n of ORDER) assert.equal(c.created.filter((d) => createdBy(d) === n).length, 1, `${n} made once` + why(c));
});

test("resume-safe pending transfer: a resume funded by its own transfer, while the stopped run's asked transfer is still to land, keeps its key; once that lands, --sweep-kept sends it back and removes the key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  // run 1 asks for its need and stops in the wait; the owner's transfer is slow
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => l.startsWith("deploy: send exactly") && process.emit("SIGTERM", "SIGTERM") });
  assert.equal(journalOf(m).keys.state, "kept");
  const first = c.fundWei;
  // run 2 resumes and asks again; its own transfer lands at once (the mock's funding of its line), run 1's is still to
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  assert.deepEqual(Object.keys(r2.record.contracts), ORDER, "deployed");
  assert.equal(folders(m.keys).length, 1, "the key is kept while a transfer it asked for may still land" + why(c));
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept");
  assert.ok(j.keys.why.some((w) => /asked for \d+ wei in 2 transfers/.test(w)), j.keys.why.join("; "));
  // run 1's slow transfer lands on the kept key
  c.bal.set(c.deployer, c.balanceOf(c.deployer) + first);
  const e0 = c.balanceOf(E);
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.ok(c.balanceOf(E) - e0 > (first * 9n) / 10n, "sent back" + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST);
  assert.deepEqual(folders(m.keys), [], "removed once every transfer it asked for has landed" + why(c));
});

test("resume-safe both RPCs: the funding wait reads the key on both RPCs: a first RPC reading a balance the second does not never counts as funded, and the run deploys once the transfer lands", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let reads = 0;
  answer(c, (u, method, params) => (method === "eth_getBalance" && u === BASE.rpcs[0] && params[0] === c.deployer && ++reads === 2 ? "0x" + (10n ** 18n).toString(16) : undefined));
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 30_000 });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  settled(c, r);
  assert.deepEqual(Object.keys(r.record.contracts), ORDER);
});

test("resume-safe both RPCs: --sweep-kept reads the funding on both RPCs: a first RPC reading the need the second does not keeps the key while the transfer may land", OPTS, async (t) => {
  const m = room(t);
  const j = await killedInWait(t, m, mainnet());
  const c2 = mainnet();
  c2.deployer = j.deployer;
  c2.fundAt = 1e9;
  c2.fundWei = BigInt(j.need);
  let reads = 0;
  answer(c2, (u, method, params) => (method === "eth_getBalance" && u === BASE.rpcs[0] && params[0] === j.deployer && ++reads === 1 ? "0x" + BigInt(j.need).toString(16) : undefined));
  const sw = await run(t, c2, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c2));
  assert.ok(lineOf(c2, /less than the \d+ wei its run asked for: it is kept/), why(c2));
  assert.equal(folders(m.keys).length, 1, "the key is kept" + why(c2));
  assert.equal(journalOf(m).keys.state, "kept");
});

test("resume-safe block: the key is removed only once both RPCs' safe block is past every transaction the run saw land: a second RPC whose safe block stays behind the run's sweep keeps it after the wait; once it is safe, --sweep-kept removes it", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let behind = true;
  answer(c, (u, method, params) => (behind && method === "eth_getBlockByNumber" && params[0] === "safe" && u === BASE.rpcs[1] ? { baseFeePerGas: "0x" + c.base.toString(16), number: "0x64" } : undefined));
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, why(c));
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(j.keys.why.some((w) => /safe block 100 on https:\/\/base-rpc\.publicnode\.com is behind block \d+/.test(w)), j.keys.why.join("; "));
  behind = false;
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.deepEqual(folders(m.keys), [], why(c));
});

test("resume-safe unread: a run whose sweep receipt the first RPC lags on keeps its key (what it received is not known) and reads the receipt again: once it shows, --sweep-kept removes the key", OPTS, async (t) => {
  const m = room(t);
  let sh = null;
  let lag = true;
  const c = mainnet({ sent: (raw, hash) => parse(raw).to === E && (sh ??= hash) });
  answer(c, (u, method, params) => (lag && method === "eth_getTransactionReceipt" && u === BASE.rpcs[0] && params[0] === sh ? null : undefined));
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST, why(c));
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(j.keys.why.some((w) => /no receipt read yet/.test(w)), j.keys.why.join("; "));
  lag = false;
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.deepEqual(folders(m.keys), [], "removed once the receipt is read" + why(c));
  assert.equal(JSON.parse(readFileSync(m.out, "utf8")).txs.length, Number(c.nonce.get(c.deployer)), "the record lists the sweep" + why(c));
});

test("resume-safe unread: a removal read that fails on one RPC keeps the key; once both RPCs answer, --sweep-kept removes it", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let down = true;
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (down && u === BASE.rpcs[1] && method === "eth_getBalance" && params[1] !== "latest") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } }) };
    return fetch0(u, init);
  };
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(j.keys.why.some((w) => /its rest was not read on https:\/\/base-rpc\.publicnode\.com: .*header not found/.test(w)), j.keys.why.join("; "));
  down = false;
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.deepEqual(folders(m.keys), [], why(c));
});

test("REVIEW: a resume killed outright in its funding wait, its first run's transfer landed and its own still to land: --sweep-kept keeps the key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => l.startsWith("deploy: send exactly") && process.emit("SIGTERM", "SIGTERM") });
  const first = c.fundWei;
  // the resume, killed outright once its line is printed: the disk as it is then
  let snap = null;
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => { if (l.startsWith("deploy: send exactly") && !snap) { snap = readFileSync(m.journal, "utf8"); process.emit("SIGTERM", "SIGTERM"); } } });
  writeFileSync(m.journal, snap);
  c.fundAt = null; // the resume's transfer is still to land
  c.bal.set(c.deployer, c.balanceOf(c.deployer) + first); // the first run's lands
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.equal(folders(m.keys).length, 1, "kept while the resume's transfer may land" + why(c));
});

test("REVIEW phantom: a run stopped in its funding wait before the owner sent anything, then resumed and funded: the key is never removed, not even by --sweep-kept", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => l.startsWith("deploy: send exactly") && process.emit("SIGTERM", "SIGTERM") });
  c.fundAt = null; // the owner never sent the first run's ask
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  assert.ok(c.balanceOf(c.deployer) <= DUST);
  for (let i = 0; i < 3; i++) await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept");
  // kept, and said as no money at risk: an ask never sent means nothing more lands, and the key holds at most dust
  assert.ok(j.keys.why.some((w) => /If an amount it asked for was never sent, nothing more will land: the key holds at most \d+ wei and nothing is lost/.test(w)), j.keys.why.join(" | "));
});

test("REVIEW receipt: the first RPC's sweep receipt reads a larger fee than the chain charged (one RPC wrong, not lagging) while a transfer the run asked for is still to land: is the key removed?", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, fundDelay: 1e9, onLine: (l) => l.startsWith("deploy: send exactly") && process.emit("SIGTERM", "SIGTERM") });
  const first = c.fundWei; // the first run's transfer, still to land
  let sh = null;
  c.sent0 = null;
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_sendRawTransaction" && parse(params[0]).to === E) sh ??= keccak(params[0]);
    const res = await fetch0(u, init);
    if (method === "eth_getTransactionReceipt" && u === BASE.rpcs[0] && params[0] === sh) {
      const j = await res.json();
      if (j.result) j.result = { ...j.result, l1Fee: "0x" + (BigInt(j.result.l1Fee) + first).toString(16) };
      return { ok: true, status: 200, json: async () => j };
    }
    return res;
  };
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  const removedLine = c.logs.find((l) => /its key folder is removed/.test(l));
  assert.equal(folders(m.keys).length, 1, `kept while the first run's transfer of ${first} wei may land; folders ${folders(m.keys).length}; journal exists ${existsSync(m.journal)}; ${removedLine}`);
});

// ---- the review of a235475a (card pool-evm-deploy-resume-safe) ----
test("review: the run waits until its last block is safe on both RPCs, then removes the key", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let until = null;
  let lag = 0;
  c.safeOf = () => (until !== null && c.clock >= until ? c.block : c.block - lag);
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l, ch) => l.startsWith("deploy: sweep ") && until === null && ((until = ch.clock + 180_000), (lag = 3)) });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  assert.ok(lineOf(c, /^deploy: waiting until block \d+, the key's last, is safe on both RPCs/), why(c));
  const removed = c.logs.findIndex((l) => /its key folder is removed/.test(l));
  assert.ok(removed >= 0, why(c));
  assert.deepEqual(folders(m.keys), []);
});

test("review: a deploy that reverted names no contract in the record: the resume's own deploy of it does", OPTS, async (t) => {
  const m = room(t);
  let once = false;
  const c = mainnet({ revert: (tx) => createdBy(tx.data) === "PrivacyPoolSimple" && !once && (once = true) });
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /deploy PrivacyPoolSimple .*status 0x0/, why(c));
  assert.equal(journalOf(m).keys.state, "kept");
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  settled(c, r2);
  const pool = r2.record.contracts.PrivacyPoolSimple.address;
  assert.notEqual(c.code.get(pool) ?? "0x", "0x", `the record's pool ${pool} holds code` + why(c));
  assert.notEqual(pool, createAddress(c.deployer, 1n), "not the reverted deploy's address at nonce 1");
  assert.equal(r2.record.txs.filter((x) => x.step === "deploy PrivacyPoolSimple").length, 2, "both pool deploys landed and are listed");
});

test("review: a completed run's journal with its record missing is refused, never moved aside for a second deploy", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  await killedAtSweep(t, m, c);
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.equal(sw.error, null, String(sw.error?.message) + why(c));
  assert.equal(journalOf(m).keys.state, "removed");
  assert.equal(journalOf(m).complete, true);
  rmSync(m.out);
  const made = c.created.length;
  // a fresh key would deploy again (the mock chain models one key, so stop the run at once if one is made)
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l) => { if (/\(made in this run/.test(l)) throw new Error("a fresh run key was made"); } });
  assert.match(String(r.error?.message), /a completed run deployed base's pool with the run key 0x[0-9a-f]{40}, but its record .* is missing: restore the record .*nothing was sent/, why(c));
  assert.equal(c.created.length, made, "nothing deployed again");
  assert.ok(existsSync(m.journal), "the journal stays where it is");
});

test("review: one run per chain at a time: a lock held by a live process refuses the paste before anything is read; one left by a process that is gone is taken over, and the run removes it", OPTS, async (t) => {
  const m = room(t);
  const lock = `${m.journal}.lock`;
  mkdirSync(m.dir, { recursive: true });
  writeFileSync(lock, `${process.pid}\n`);
  const c = mainnet();
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r.error?.message), /base\.journal\.json\.lock: another run on this chain \(pid \d+\) is going: nothing was read or sent/, why(c));
  assert.equal(c.calls.length, 0, "nothing read");
  assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid), "the other run's lock is left alone");
  const sw = await run(t, c, { head: [...MAIN, "--sweep-kept", m.journal], ret: null, io: m.io, outArg: false, out: m.out });
  assert.match(String(sw.error?.message), /another run on this chain/, "--sweep-kept takes the same lock");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(lock, `${gone}\n`);
  let held = null;
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l) => l.startsWith("deploy: waiting for") && (held = readFileSync(lock, "utf8").trim()) });
  assert.equal(r2.error, null, String(r2.error?.message) + why(c));
  assert.equal(held, String(process.pid), "taken over by this run");
  assert.equal(existsSync(lock), false, "removed when the run ends");
});

test("review: the floor is the higher block either RPC puts the key's transactions in: a second RPC whose receipt names a later block than its safe block keeps the key", OPTS, async (t) => {
  const m = room(t);
  let sh = null;
  const c = mainnet({ sent: (raw, hash) => parse(raw).to === E && (sh ??= hash) });
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    const res = await fetch0(u, init);
    if (method === "eth_getTransactionReceipt" && u === BASE.rpcs[1] && params[0] === sh) {
      const j = await res.json();
      if (j.result) j.result = { ...j.result, blockNumber: "0x" + (BigInt(j.result.blockNumber) + 5n).toString(16) };
      return { ok: true, status: 200, json: async () => j };
    }
    return res;
  };
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  const j = journalOf(m);
  assert.equal(j.keys.state, "kept", why(c));
  assert.ok(j.keys.why.some((w) => /its safe block \d+ on https:\/\/base-rpc\.publicnode\.com is behind block \d+/.test(w)), j.keys.why.join("; "));
});

test("REVIEW2 head: ETH that lands on the key after its sweep, in a block past the safe block, is on the key at the head: is the key removed?", OPTS, async (t) => {
  const m = room(t);
  const c = mainnet();
  let safe = null;
  c.safeOf = () => safe ?? c.block;
  const extra = 10n ** 15n;
  // the mock's balance read honours a block tag for this one transfer: before its block, the key does not hold it yet
  const fetch0 = c.fetch;
  c.fetch = async (u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "eth_getBalance" && safe !== null && params[0].toLowerCase() === c.deployer && /^0x/.test(params[1]) && BigInt(params[1]) <= BigInt(safe)) {
      await fetch0(u, init);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + (c.balanceOf(c.deployer) - extra).toString(16) }) };
    }
    return fetch0(u, init);
  };
  const r = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out, onLine: (l, ch) => {
    // the sweep is done (its last balance read): a second transfer lands in the next block, not yet safe
    if (/^deploy: run key keeps \d+ wei, less than two sweeps' fee bound/.test(l) && safe === null) {
      safe = ch.block;
      ch.block++;
      ch.bal.set(ch.deployer, ch.balanceOf(ch.deployer) + extra);
    }
  } });
  assert.equal(r.error, null, String(r.error?.message) + why(c));
  const removedLine = c.logs.find((l) => /its key folder is removed/.test(l));
  assert.equal(folders(m.keys).length, 1, `the key holds ${c.balanceOf(c.deployer)} wei at the head (safe ${safe}, head ${c.block}): kept? ${removedLine}`);
});
