#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Deploys the Blindfill EVM pool to Base Sepolia or Robinhood testnet (or an anvil fork of one, the dry run), with no
// admin: the withdrawal verifier, the pool, the v4 adapter, the v3 adapter (Base Sepolia only, M365) and the sell
// delegate. The deployer is a run key made in memory; it is never printed, written or passed to another process.
//
//   node contracts/pool-evm/script/deploy.mjs --chain <base-sepolia|robinhood-testnet> --return <address>
//     [--rpc <url>] [--out <file>] [--no-build]
//   node contracts/pool-evm/script/deploy.mjs --write-build      rewrites scripts/live-checks/pool-evm-deploy.build.json
//     from forge's output (out/), after a forge build
//
// Steps:
//  1. The chain from eth_chainId: the named testnet's id, on its RPC or on a loopback URL (an anvil fork of it, the dry
//     run, which needs --out so it never writes the real record). A mainnet id is refused: that deploy is the owner's.
//     --return must not be the zero address, must pass its EIP-55 checksum when mixed case, and must have no code on
//     the chain's two RPCs (the fork's one URL on a dry run).
//  2. The build: forge build --root contracts/pool-evm (CI's command), and each contract's runtime checked against
//     pool-evm-deploy.build.json (length, keccak256 with the immutables zeroed), so the code sent is the code pinned.
//  3. The run key, made in memory by @noble/curves; its address is printed, the key never is. Its nonce must be 0, so
//     every contract's address is known before the first transaction: CREATE from the key at nonces 0, 1, ...
//  4. The need, printed with its parts: each deploy's eth_estimateGas plus 20%, each at the nonce its deploy will have
//     (state overrides: the key's nonce, and for the pool the verifier's code at its address, since the pool's
//     constructor checks it), at a max fee of twice the base fee plus the tip; on Base Sepolia each transaction's L1
//     fee bound (GasPriceOracle.getL1FeeUpperBound); and the sweep's own fee. Then it waits until the key holds that
//     much (the line "deploy: waiting for <wei> wei ... at <address>" is what the funder, or the dry run's stand-in
//     wallet, reads).
//  5. The deploys, one EIP-1559 transaction each, signed here and sent with eth_sendRawTransaction. Each must succeed
//     and make its expected address, and the code read there must be the build's. Each transaction is kept before it
//     is sent, so a send whose answer is lost is still waited for and recorded ("already known" on a resend is taken).
//  6. Always, in a finally. SIGINT, SIGTERM or SIGHUP stop the run at its next step; later signals never cut the sweep
//     short; a stop during the funding wait watches the balance for WAITS.lateFunding first, so a transfer in flight
//     is swept too. The settle: until the key's latest nonce covers every nonce it signed, a pending transaction is
//     sent again, and one pending longer than WAITS.stuck is replaced at its nonce by a cancel (0 to the key itself,
//     both fee terms 12.5% and at least 1 wei above the highest the key sent at that nonce; a refused send never
//     counts). A sweep at a nonce with something pending (after a settle that ran out) is priced the same way. Then the sweep: the key's balance, less the transfer's fee bound (the L1 fee bound
//     read on each pass, doubled), goes to --return, again while what is left is more than two such bounds; a failed
//     pass is retried with backoff over WAITS.sweep. Every hash is printed.
//  7. Writes the deployment record (scripts/live-checks/pool-evm-deploy.<chain>.json, or --out) with every
//     transaction that landed, in nonce order, and prints the live check to run next.
import "../../../scripts/net-window.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUILD_FILE, CHAINS, MAINNET_IDS, bytes, deploymentFile, hex, keccak, rpc, runtimeOf, selector, word,
} from "../../../scripts/live-checks/pool-evm-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POOL_DIR = path.join(HERE, "..");
const REPO = path.join(POOL_DIR, "../..");
const req = createRequire(path.join(REPO, "packages/kit/package.json"));
const { secp256k1 } = await import(pathToFileURL(req.resolve("@noble/curves/secp256k1.js")).href);

// The contracts in deploy order, each with its constructor's arguments on a chain (the pool's is the verifier's
// address the run computes).
export const ORDER = ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate"];
const argsOf = (name, chain, addrs) => ({
  WithdrawalVerifier: [],
  PrivacyPoolSimple: [addrs.WithdrawalVerifier],
  UniswapV4Adapter: [chain.poolManager.address, chain.weth.address],
  UniswapV3Adapter: [chain.router?.address],
  SellDelegate: [chain.weth.address],
})[name];
const GAS_MARGIN = (g) => (g * 12n) / 10n;
const OP_ORACLE = "0x420000000000000000000000000000000000000f"; // the OP Stack GasPriceOracle predeploy
const SWEEP_TX_BYTES = 200n; // an EIP-1559 transfer signed is about 110 bytes

// ---- encoding and signing (EIP-1559, EIP-155 chain ids) ----
const big = (x) => BigInt(x);
/** a non-negative integer as RLP wants it: big-endian, no leading zero bytes, 0 as empty */
export function intBytes(n) {
  n = BigInt(n);
  if (n === 0n) return new Uint8Array(0);
  const h = n.toString(16);
  return bytes(h.length % 2 ? "0" + h : h);
}
/** RLP of a byte string or a list */
export function rlp(x) {
  const prefix = (n, off) => {
    if (n < 56) return Uint8Array.of(off + n);
    const l = intBytes(n);
    return Uint8Array.of(off + 55 + l.length, ...l);
  };
  if (Array.isArray(x)) {
    const body = Buffer.concat(x.map(rlp));
    return Uint8Array.from(Buffer.concat([prefix(body.length, 0xc0), body]));
  }
  const b = typeof x === "string" ? bytes(x) : x;
  if (b.length === 1 && b[0] < 0x80) return Uint8Array.from(b);
  return Uint8Array.from(Buffer.concat([prefix(b.length, 0x80), b]));
}
export const addressOf = (sk) => hex(bytes(keccak(secp256k1.getPublicKey(sk, false).subarray(1))).subarray(12));
/** CREATE's address: keccak256(rlp([sender, nonce]))[12:] */
export const createAddress = (sender, nonce) => hex(bytes(keccak(rlp([bytes(sender), intBytes(nonce)]))).subarray(12));
/** The signed raw EIP-1559 transaction and its hash; `to` null makes a contract */
export function signTx(sk, t) {
  const fields = [t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas].map(intBytes);
  const unsigned = [...fields, t.to ? bytes(t.to) : new Uint8Array(0), intBytes(t.value ?? 0n), bytes(t.data ?? "0x"), []];
  const digest = bytes(keccak(Uint8Array.of(2, ...rlp(unsigned))));
  const sig = secp256k1.sign(digest, sk, { prehash: false, format: "recovered" }); // [recovery, r, s], low s
  const raw = Uint8Array.of(2, ...rlp([...unsigned, intBytes(sig[0]), intBytes(BigInt(hex(sig.subarray(1, 33)))), intBytes(BigInt(hex(sig.subarray(33, 65))))]));
  return { raw: hex(raw), hash: keccak(raw) };
}
const addrArg = (a) => word(BigInt(a));

// ---- the build ----
/** Each contract's runtime as pool-evm-deploy.build.json pins it, from forge's out/ */
export function buildOf(outDir = path.join(POOL_DIR, "out")) {
  const contracts = {};
  for (const name of ORDER) {
    const a = JSON.parse(readFileSync(path.join(outDir, `${name}.sol`, `${name}.json`), "utf8"));
    const refs = a.deployedBytecode.immutableReferences ?? {};
    const immutables = Object.keys(refs).sort((x, y) => Number(x) - Number(y)).map((id) => {
      for (const r of refs[id]) if (r.length !== 32) throw new Error(`${name}: an immutable of ${r.length} bytes`);
      return refs[id].map((r) => r.start);
    });
    const r = runtimeOf(a.deployedBytecode.object, immutables);
    contracts[name] = { length: r.length, masked: r.masked, immutables };
  }
  return contracts;
}
const initOf = (name) => JSON.parse(readFileSync(path.join(POOL_DIR, "out", `${name}.sol`, `${name}.json`), "utf8")).bytecode.object;

// ---- the run ----
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopback = (u) => LOOPBACK.has(new URL(u).hostname);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eth = (wei) => `${Number(wei) / 1e18} ETH`;
const ZERO = "0x0000000000000000000000000000000000000000";
// The waits (ms): a deploy's receipt; how long a sent transaction may sit before it is replaced; how long the settle
// before a sweep waits for the run key's transactions to land; the sweep's whole retry window; the balance watch after
// a stop during the funding wait (a funding transfer still in flight lands and is swept too).
export const WAITS = Object.freeze({ receipt: 180_000, stuck: 90_000, settle: 900_000, sweep: 1_800_000, lateFunding: 60_000, poll: 5_000 });
// a replacement pays at least 10% more on both fee terms, and strictly more (geth's txpool price bump and its
// strictly-greater check); 12.5%, rounded up and at least +1 (a tip of 0, as Robinhood suggests, must become 1)
const bump = (x) => {
  const b = (x * 1125n + 999n) / 1000n;
  return b > x ? b : x + 1n;
};
const maxOf = (...xs) => xs.reduce((a, b) => (b > a ? b : a));

/** --return: a 20-byte address, EIP-55 when mixed case, not the zero address */
export function returnAddress(s) {
  s = String(s ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error("--return <address>: where the run key's rest goes");
  const low = s.toLowerCase();
  if (s.slice(2) !== low.slice(2) && s.slice(2) !== s.slice(2).toUpperCase()) {
    const h = keccak(new TextEncoder().encode(low.slice(2))).slice(2);
    const sum = [...low.slice(2)].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
    if (sum !== s.slice(2)) throw new Error(`--return ${s} fails its EIP-55 checksum (want 0x${sum})`);
  }
  if (low === ZERO) throw new Error("--return is the zero address: the rest would be burned");
  return low;
}

/**
 * The deploy run. `io` is for tests: fetchFn, sleep(ms) and now() (a mock chain and a virtual clock); a run from the
 * command line uses the network and the real clock.
 */
export async function main(args, io = {}) {
  const fetchFn = io.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  const sleep = io.sleep ?? realSleep;
  const now = io.now ?? Date.now;
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const chainName = opt("--chain");
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`--chain is one of ${Object.keys(CHAINS).join(", ")}`);
  const ret = returnAddress(opt("--return"));
  const url = opt("--rpc") ?? chain.rpcs[0];
  const dryRun = isLoopback(url);
  const out = opt("--out") ?? (dryRun ? null : deploymentFile(chainName));
  if (!out) throw new Error("a dry run (a loopback RPC) needs --out, so it never writes the real record");
  const call = (method, params, u = url) => rpc(fetchFn, u, method, params, sleep);

  // 1. the chain, and where the rest goes: an account with no code (a contract could refuse the sweep or keep it)
  const id = await call("eth_chainId", []);
  if (MAINNET_IDS[id]) throw new Error(`${url} answers ${MAINNET_IDS[id]} mainnet (${id}): its deploy is the owner's`);
  if (id !== chain.chainId) throw new Error(`${url} answers chain id ${id}, not ${chainName}'s ${chain.chainId}`);
  console.log(`deploy: ${chainName} (${BigInt(id)}) on ${url}${dryRun ? ", a loopback fork: the dry run" : ""}`);
  for (const u of dryRun ? [url] : chain.rpcs) {
    if ((await call("eth_chainId", [], u)) !== chain.chainId) throw new Error(`${u} does not answer ${chainName}'s chain id`);
    const c = await call("eth_getCode", [ret, "latest"], u);
    if (c !== "0x") throw new Error(`--return ${ret} has code on ${u} (${(c.length - 2) / 2} bytes): the rest goes only to an account with none`);
  }

  // 2. the build
  if (!args.includes("--no-build")) {
    const b = spawnSync("forge", ["build", "--root", POOL_DIR], { stdio: "inherit" });
    if (b.status !== 0) throw new Error("forge build failed");
  }
  const pinned = JSON.parse(readFileSync(BUILD_FILE, "utf8")).contracts;
  const built = buildOf();
  for (const n of ORDER) if (JSON.stringify(built[n]) !== JSON.stringify(pinned[n])) throw new Error(`${n}: forge's build differs from ${path.basename(BUILD_FILE)}`);
  const forgeVersion = spawnSync("forge", ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "forge";

  // 3. the run key and the addresses
  const sk = secp256k1.utils.randomSecretKey();
  const deployer = addressOf(sk);
  if (deployer === ret) throw new Error("--return is the run key itself");
  console.log(`deploy: run key ${deployer} (made in this run, never printed)`);
  if (big(await call("eth_getTransactionCount", [deployer, "pending"])) !== 0n) throw new Error(`${deployer} has sent transactions already`);
  const names = chain.contracts;
  const addrs = Object.fromEntries(names.map((n, i) => [n, createAddress(deployer, i)]));
  const datas = Object.fromEntries(names.map((n) => [n, initOf(n) + argsOf(n, chain, addrs).map(addrArg).join("")]));

  // 4. the need
  const fees = async () => {
    const block = await call("eth_getBlockByNumber", ["latest", false]);
    const tip = big(await call("eth_maxPriorityFeePerGas", []).catch(() => "0x0"));
    return { tip, maxFee: 2n * big(block.baseFeePerGas) + tip };
  };
  const l1Bound = async (n) => (chain.op ? big(await call("eth_call", [{ to: OP_ORACLE, data: selector("getL1FeeUpperBound(uint256)") + word(n) }, "latest"])) : 0n);
  const transferGas = async (to) => GAS_MARGIN(big(await call("eth_estimateGas", [{ from: deployer, to, value: "0x0" }, "latest"])));
  const { tip, maxFee } = await fees();
  const verifierCode = JSON.parse(readFileSync(path.join(POOL_DIR, "out/WithdrawalVerifier.sol/WithdrawalVerifier.json"), "utf8")).deployedBytecode.object;
  const gas = {};
  for (const [i, n] of names.entries()) {
    // each estimate at the nonce its deploy will have, so it creates at the address the deploy will
    const over = { [deployer]: { nonce: "0x" + i.toString(16) } };
    if (n === "PrivacyPoolSimple") over[addrs.WithdrawalVerifier] = { code: verifierCode };
    gas[n] = GAS_MARGIN(big(await call("eth_estimateGas", [{ from: deployer, data: datas[n] }, "latest", over])));
  }
  const parts = [];
  for (const n of names) parts.push([n, gas[n] * maxFee + (await l1Bound(BigInt(bytes(datas[n]).length) + SWEEP_TX_BYTES))]);
  parts.push(["the sweep", (await transferGas(ret)) * maxFee + 2n * (await l1Bound(SWEEP_TX_BYTES))]);
  const need = parts.reduce((s, [, v]) => s + v, 0n);
  console.log(`deploy: max fee ${maxFee} wei/gas (tip ${tip}); need ${need} wei (${eth(need)}): ${parts.map(([n, v]) => `${n} ${v}`).join(", ")}`);

  // Every transaction the run signs, recorded before it is sent, so one whose send answer is lost is still waited for
  // and listed: { step, hash, raw, nonce, tip, maxFee, gas, sentAt, receipt }. The record lists the ones that landed.
  const signed = [];
  const landed = () => signed.filter((s) => s.receipt).sort((a, b) => Number(a.nonce - b.nonce));
  const send = async (step, t, extra = {}) => {
    const s = { step, ...extra, nonce: t.nonce, tip: t.maxPriorityFeePerGas, maxFee: t.maxFeePerGas, gas: t.gas, ...signTx(sk, { chainId: big(id), ...t }), sentAt: now(), receipt: null };
    signed.push(s);
    try {
      await call("eth_sendRawTransaction", [s.raw]);
    } catch (e) {
      // a resend of a send whose answer was lost (or one already mined) is the node saying it has it; any other answer
      // is a refusal: that transaction is dropped, so it never becomes the fee basis of a replacement
      if (!/already known|known transaction|nonce too low|already imported/i.test(e.message)) {
        signed.splice(signed.indexOf(s), 1);
        throw e;
      }
    }
    return s;
  };
  // The fees for a transaction at nonce n: the chain's now, and when the key has sent one at n already, a bump over
  // the highest of each term it sent there (a replacement geth takes)
  const priceAt = (n, f) => {
    const at = signed.filter((s) => s.nonce === n);
    if (!at.length) return f;
    const tip = maxOf(bump(maxOf(...at.map((s) => s.tip))), f.tip);
    return { tip, maxFee: maxOf(bump(maxOf(...at.map((s) => s.maxFee))), f.maxFee, tip) };
  };
  const receiptOf = async (s) => (s.receipt ??= await call("eth_getTransactionReceipt", [s.hash]));
  const waitReceipt = async (s, ms) => {
    for (const end = now() + ms; now() < end; await sleep(2000)) if (await receiptOf(s)) return s.receipt;
    return null;
  };
  const record = () => {
    const txs = landed().map((s) => ({ step: s.step, hash: s.hash, ...(s.contract ? { contract: s.contract } : {}) }));
    const d = {
      chain: chainName, chainId: Number(BigInt(id)), dryRun, at: new Date().toISOString(), deployer, return: ret, need: need.toString(),
      build: `solc 0.8.28 (contracts/pool-evm/foundry.toml), ${forgeVersion}`,
      contracts: Object.fromEntries(names.filter((n) => txs.some((t) => t.contract === n && t.step === `deploy ${n}`)).map((n) => [n, { address: addrs[n] }])),
      txs,
    };
    writeFileSync(out, JSON.stringify(d, null, 2) + "\n");
    console.log(`deploy: wrote ${out}`);
  };

  // 6a. the settle: until the key's latest nonce covers every nonce it signed, each still pending is sent again; one
  // pending longer than WAITS.stuck is replaced at its nonce by a cancel (0 to the key itself) paying 12.5% more
  const settle = async () => {
    for (const end = now() + WAITS.settle; ; ) {
      const latest = big(await call("eth_getTransactionCount", [deployer, "latest"]));
      for (const s of signed) await receiptOf(s);
      const top = signed.reduce((m, s) => (s.nonce + 1n > m ? s.nonce + 1n : m), 0n);
      if (latest >= top) return true;
      if (now() >= end) return false;
      for (let n = latest; n < top; n++) {
        const last = signed.filter((s) => s.nonce === n).at(-1);
        if (now() - last.sentAt < WAITS.stuck) {
          await call("eth_sendRawTransaction", [last.raw]).catch(() => {});
          continue;
        }
        const p = priceAt(n, await fees());
        const c = await send(`cancel (replaces ${last.step} at nonce ${n})`, { nonce: n, maxPriorityFeePerGas: p.tip, maxFeePerGas: p.maxFee, gas: await transferGas(deployer), to: deployer, value: 0n })
          .catch((e) => console.error(`deploy: cancel at nonce ${n} not taken: ${e.message}`));
        if (c) console.log(`deploy: nonce ${n} pending since ${Math.round((now() - last.sentAt) / 1000)} s: replaced by a cancel ${c.hash}`);
      }
      await sleep(WAITS.poll);
    }
  };
  // 6b. the sweep: once settled, all but its fee bound (the L1 fee bound read on each pass, doubled) goes to --return,
  // again while what is left is more than two such bounds; a failure is retried with backoff over WAITS.sweep
  let sweeping = null;
  const sweep = () => (sweeping ??= (async () => {
    const end = now() + WAITS.sweep;
    for (let wait = WAITS.poll; ; ) {
      try {
        if (!(await settle())) console.error(`deploy: the run key's transactions have not all landed after ${WAITS.settle / 1000} s; sweeping anyway`);
        // at the latest nonce: after a settle that ran out, a sweep that replaces what is pending there, priced above it
        const nonce = big(await call("eth_getTransactionCount", [deployer, "latest"]));
        const bal = big(await call("eth_getBalance", [deployer, "latest"]));
        const p = priceAt(nonce, await fees());
        const g = await transferGas(ret);
        const reserve = g * p.maxFee + 2n * (await l1Bound(SWEEP_TX_BYTES));
        if (bal <= 2n * reserve) {
          console.log(`deploy: run key keeps ${bal} wei, less than two sweeps' fee bound (${2n * reserve})`);
          return;
        }
        const s = await send("sweep (the run key's rest back)", { nonce, maxPriorityFeePerGas: p.tip, maxFeePerGas: p.maxFee, gas: g, to: ret, value: bal - reserve });
        console.log(`deploy: sweep ${bal - reserve} wei to ${ret}: ${s.hash}`);
        await waitReceipt(s, WAITS.receipt); // no receipt yet: the next pass's settle waits for it or replaces it
      } catch (e) {
        if (now() >= end) throw e;
        console.error(`deploy: sweep pass failed (${String(e.message).split("\n")[0]}); again in ${wait / 1000} s`);
        await sleep(wait);
        wait = wait * 2 > 60_000 ? 60_000 : wait * 2;
      }
    }
  })());

  // A signal stops the run at its next step: a transaction already sent is waited for, so the sweep never races a
  // deploy for a nonce; the finally below then sweeps. Later signals never cut the sweep short.
  let stopped = null;
  let funded = false;
  const onSignal = (s) => {
    if (stopped) return console.error(`deploy: ${s} again: the sweep finishes first`);
    stopped = s;
    console.error(`deploy: ${s}: stopping at the next step, then sweeping`);
  };
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of SIGNALS) process.on(s, onSignal);
  const go = () => {
    if (stopped) throw new Error(`stopped by ${stopped}`);
  };

  let done = false;
  try {
    // 4. the funding
    console.log(`deploy: waiting for ${need} wei (${eth(need)}) at ${deployer} on ${chainName}`);
    while ((go(), big(await call("eth_getBalance", [deployer, "latest"]))) < need) await sleep(WAITS.poll);
    funded = true;
    console.log("deploy: funded");

    // 5. the deploys
    for (const [i, n] of names.entries()) {
      go();
      const f = await fees();
      const maxFeePerGas = f.maxFee > maxFee ? maxFee : f.maxFee; // never above what the need was counted at
      const s = await send(`deploy ${n}`, { nonce: BigInt(i), maxPriorityFeePerGas: f.tip > maxFeePerGas ? maxFeePerGas : f.tip, maxFeePerGas, gas: gas[n], to: null, data: datas[n] }, { contract: n });
      const r = await waitReceipt(s, WAITS.receipt);
      if (!r) throw new Error(`deploy ${n} ${s.hash}: no receipt in ${WAITS.receipt / 1000} s`);
      if (r.status !== "0x1" || r.contractAddress?.toLowerCase() !== addrs[n]) throw new Error(`deploy ${n} ${s.hash}: status ${r.status}, contract ${r.contractAddress}, want ${addrs[n]}`);
      const code = await call("eth_getCode", [addrs[n], "latest"]);
      const got = runtimeOf(code, pinned[n].immutables);
      if (got.length !== pinned[n].length || got.masked !== pinned[n].masked) throw new Error(`${n} at ${addrs[n]}: code is not the build's`);
      console.log(`deploy: ${n} ${addrs[n]} (${s.hash}), ${r.gasUsed && big(r.gasUsed)} gas, code is the build's`);
    }
    done = true;
  } finally {
    try {
      if (!funded) {
        // stopped while waiting: a funding transfer may be in flight; watch the balance before the final sweep
        console.log(`deploy: stopped before funding; watching ${deployer}'s balance for ${WAITS.lateFunding / 1000} s`);
        for (const end = now() + WAITS.lateFunding; now() < end; ) await sleep(WAITS.poll);
      }
      await sweep();
    } catch (e) {
      console.error(`deploy: SWEEP FAILED: ${e.message}; the run key ${deployer} still holds its balance`);
      process.exitCode = 1;
    } finally {
      for (const s of SIGNALS) process.off(s, onSignal);
    }
    if (signed.length) record();
  }
  if (!done) throw new Error("the deploy stopped; the record lists what landed");
  const rpcArg = dryRun ? ` --rpc ${url},${url.replace("127.0.0.1", "localhost")}` : "";
  console.log(`deploy: done. Next: node scripts/live-checks/pool-evm-deploy.mjs --deployment ${path.relative(process.cwd(), out)}${rpcArg}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--write-build")) {
      const file = {
        notes: [
          "Each contract's runtime as forge builds it (solc 0.8.28, contracts/pool-evm/foundry.toml): its length, the keccak256 of the runtime with every immutable's 32 bytes zeroed, and each immutable's start offsets. Written by contracts/pool-evm/script/deploy.mjs --write-build; test/deploy.test.mjs fails when forge's output differs; CI runs it after its forge test, with the forge CI installs (1.7.1). Forge 1.7.1 and 1.8.6 both build these bytes (solc 0.8.28 does the compiling): the test passed on 1.7.1 and the dry run, whose deploy.mjs refuses a build that differs, ran on 1.8.6, 2026-11-03.",
        ],
        contracts: buildOf(),
      };
      writeFileSync(BUILD_FILE, JSON.stringify(file, null, 2) + "\n");
      console.log(`deploy: wrote ${path.relative(process.cwd(), BUILD_FILE)}`);
    } else {
      await main(args);
    }
  } catch (e) {
    console.error(`deploy: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
