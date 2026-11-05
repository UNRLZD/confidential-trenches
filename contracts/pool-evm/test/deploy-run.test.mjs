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
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHAINS, DUST, MAINNETS, bytes, hex, keccak } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { MAINNET_INIT, ORDER, addressOf, createAddress, initProblems, main } from "../script/deploy.mjs";

const OUT_DIR = new URL("../out/", import.meta.url);
const runtime = (name) => JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT_DIR), "utf8")).deployedBytecode.object;
const init = (name) => JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT_DIR), "utf8")).bytecode.object;
/** the contract a create transaction's data deploys: the one whose init code it starts with */
const createdBy = (data) => ORDER.find((n) => data.startsWith(init(n)));
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
  const c = { id: on.id ?? "0x14a34", calls: [], base: 5_000_000n, tip: on.tip ?? 1_000_000n, l1Scale: 2n, clock: 0, bal: new Map(), nonce: new Map(), code: new Map(), created: [], pool: [], receipts: new Map(), seen: new Set(), deployer: null, fundAt: null, fundWei: 0n, logs: [] };
  const g = (m, k) => m.get(k.toLowerCase()) ?? 0n;
  const l1Of = (len) => c.l1Scale * (len > 100n ? len : 100n);
  const costOf = (t) => t.gas * t.maxFee + t.value + l1Of(t.len);
  c.balanceOf = (a) => g(c.bal, a);
  c.mine = () => {
    if (c.fundAt !== null && c.clock >= c.fundAt) {
      c.bal.set(c.deployer, g(c.bal, c.deployer) + c.fundWei);
      c.fundAt = null;
    }
    c.pool.sort((a, b) => Number(a.t.nonce - b.t.nonce));
    while (c.pool.length) {
      const { t, hash } = c.pool[0];
      if (t.nonce !== g(c.nonce, c.deployer) || t.maxFee < c.base) break;
      c.pool.shift();
      const used = t.to ? 21000n : (t.gas * 10n) / 12n;
      const fee = used * (c.base + (t.tip < t.maxFee - c.base ? t.tip : t.maxFee - c.base)) + l1Of(t.len);
      if (g(c.bal, c.deployer) < t.value + fee) continue; // dropped: it cannot pay at execution
      c.bal.set(c.deployer, g(c.bal, c.deployer) - t.value - fee);
      let ca = null;
      if (t.to) c.bal.set(t.to, g(c.bal, t.to) + t.value);
      else c.code.set((ca = createAddress(c.deployer, t.nonce)), runtime(createdBy(t.data))), c.created.push(t.data);
      c.nonce.set(c.deployer, t.nonce + 1n);
      c.receipts.set(hash, { status: "0x1", contractAddress: ca, gasUsed: "0x" + used.toString(16), from: c.deployer });
      on.afterMine?.(c, t);
    }
  };
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const err = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }) });
  c.fetch = async (url, init) => {
    c.mine();
    const { method, params } = JSON.parse(init.body);
    c.calls.push({ url, method, params });
    switch (method) {
      case "eth_chainId": return ok(c.id);
      case "eth_getBlockByNumber": return ok({ baseFeePerGas: "0x" + c.base.toString(16) });
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
  return { dir, keys: path.join(dir, "keys"), out, journal: path.join(dir, "base.journal.json"), io: { keysBase: path.join(dir, "keys"), recordOf: () => out } };
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
  assert.ok(c3.logs.some((l) => l === `deploy: send exactly ${c3.fundWei} wei to ${c3.deployer} from ${E}, the address you passed`), why(c3));
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
  // a new run is refused while the key is kept
  const r2 = await run(t, c, { head: MAIN, io: m.io, outArg: false, out: m.out });
  assert.match(String(r2.error?.message), /kept.*--sweep-kept/, why(c));
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
  assert.deepEqual(Object.keys(MAINNET_INIT), ORDER);
  for (const n of ORDER) {
    const code = init(n);
    assert.equal(initProblems(n, code), null, n);
    const off = code.slice(0, -2) + (code.endsWith("00") ? "01" : "00");
    assert.match(String(initProblems(n, off)), new RegExp(`${n}: init code keccak256 .* not the pinned`), n);
  }
});
