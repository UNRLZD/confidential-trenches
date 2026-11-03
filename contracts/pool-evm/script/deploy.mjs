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
//     and make its expected address, and the code read there must be the build's.
//  6. Always, in a finally (SIGINT or SIGTERM stop the run at its next step, after any transaction already sent has
//     landed, and so land here): the key's balance, less the sweep's fee bound, goes to --return in one transfer,
//     repeated while what is left is more than two sweeps' fee bound. Every sweep's hash is printed.
//  7. Writes the deployment record (scripts/live-checks/pool-evm-deploy.<chain>.json, or --out) with every
//     transaction, and prints the live check to run next.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eth = (wei) => `${Number(wei) / 1e18} ETH`;

/** The chain's fee terms now: tip, max fee (twice the base fee plus the tip) */
async function fees(url) {
  const block = await rpc(fetch, url, "eth_getBlockByNumber", ["latest", false]);
  const tip = big(await rpc(fetch, url, "eth_maxPriorityFeePerGas", []).catch(() => "0x0"));
  return { tip, maxFee: 2n * big(block.baseFeePerGas) + tip };
}
const l1Bound = async (chain, url, n) =>
  chain.op ? big(await rpc(fetch, url, "eth_call", [{ to: OP_ORACLE, data: selector("getL1FeeUpperBound(uint256)") + word(n) }, "latest"])) : 0n;
async function receipt(url, hash, ms = 180_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(2000)) {
    const r = await rpc(fetch, url, "eth_getTransactionReceipt", [hash]);
    if (r) return r;
  }
  throw new Error(`no receipt for ${hash} in ${ms / 1000} s`);
}

export async function main(args) {
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const chainName = opt("--chain");
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`--chain is one of ${Object.keys(CHAINS).join(", ")}`);
  const ret = String(opt("--return") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ret)) throw new Error("--return <address>: where the run key's rest goes");
  const url = opt("--rpc") ?? chain.rpcs[0];
  const dryRun = isLoopback(url);
  const out = opt("--out") ?? (dryRun ? null : deploymentFile(chainName));
  if (!out) throw new Error("a dry run (a loopback RPC) needs --out, so it never writes the real record");

  // 1. the chain
  const id = await rpc(fetch, url, "eth_chainId", []);
  if (MAINNET_IDS[id]) throw new Error(`${url} answers ${MAINNET_IDS[id]} mainnet (${id}): its deploy is the owner's`);
  if (id !== chain.chainId) throw new Error(`${url} answers chain id ${id}, not ${chainName}'s ${chain.chainId}`);
  console.log(`deploy: ${chainName} (${BigInt(id)}) on ${url}${dryRun ? ", a loopback fork: the dry run" : ""}`);

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
  console.log(`deploy: run key ${deployer} (made in this run, never printed)`);
  if (big(await rpc(fetch, url, "eth_getTransactionCount", [deployer, "pending"])) !== 0n) throw new Error(`${deployer} has sent transactions already`);
  const names = chain.contracts;
  const addrs = Object.fromEntries(names.map((n, i) => [n, createAddress(deployer, i)]));
  const datas = Object.fromEntries(names.map((n) => [n, initOf(n) + argsOf(n, chain, addrs).map(addrArg).join("")]));

  // 4. the need
  const { tip, maxFee } = await fees(url);
  const verifierCode = JSON.parse(readFileSync(path.join(POOL_DIR, "out/WithdrawalVerifier.sol/WithdrawalVerifier.json"), "utf8")).deployedBytecode.object;
  const gas = {};
  for (const [i, n] of names.entries()) {
    // each estimate at the nonce its deploy will have, so it creates at the address the deploy will
    const over = { [deployer]: { nonce: "0x" + i.toString(16) } };
    if (n === "PrivacyPoolSimple") over[addrs.WithdrawalVerifier] = { code: verifierCode };
    gas[n] = GAS_MARGIN(big(await rpc(fetch, url, "eth_estimateGas", [{ from: deployer, data: datas[n] }, "latest", over])));
  }
  const sweepGas = GAS_MARGIN(big(await rpc(fetch, url, "eth_estimateGas", [{ from: deployer, to: ret, value: "0x0" }, "latest"])));
  const sweepL1 = await l1Bound(chain, url, SWEEP_TX_BYTES);
  const parts = [];
  for (const n of names) parts.push([n, gas[n] * maxFee + (await l1Bound(chain, url, BigInt(bytes(datas[n]).length) + SWEEP_TX_BYTES))]);
  parts.push(["the sweep", sweepGas * maxFee + sweepL1]);
  const need = parts.reduce((s, [, v]) => s + v, 0n);
  console.log(`deploy: max fee ${maxFee} wei/gas (tip ${tip}); need ${need} wei (${eth(need)}): ${parts.map(([n, v]) => `${n} ${v}`).join(", ")}`);

  const txs = [];
  let done = false;
  let sweeping = null;
  const record = () => {
    const d = {
      chain: chainName, chainId: Number(BigInt(id)), dryRun, at: new Date().toISOString(), deployer, return: ret, need: need.toString(),
      build: `solc 0.8.28 (contracts/pool-evm/foundry.toml), ${forgeVersion}`,
      contracts: Object.fromEntries(names.filter((n) => txs.some((t) => t.contract === n)).map((n) => [n, { address: addrs[n] }])),
      txs,
    };
    writeFileSync(out, JSON.stringify(d, null, 2) + "\n");
    console.log(`deploy: wrote ${out}`);
  };
  // 6. the sweep: one transfer of all but its fee bound, again while the rest still pays for one
  const sweep = () => (sweeping ??= (async () => {
    for (let i = 0; i < 3; i++) {
      const bal = big(await rpc(fetch, url, "eth_getBalance", [deployer, "latest"]));
      const f = await fees(url);
      const reserve = sweepGas * f.maxFee + sweepL1;
      if (bal <= 2n * reserve) {
        console.log(`deploy: run key keeps ${bal} wei, less than two sweeps' fee bound (${2n * reserve})`);
        return;
      }
      const nonce = big(await rpc(fetch, url, "eth_getTransactionCount", [deployer, "pending"]));
      const t = signTx(sk, { chainId: big(id), nonce, maxPriorityFeePerGas: f.tip, maxFeePerGas: f.maxFee, gas: sweepGas, to: ret, value: bal - reserve });
      await rpc(fetch, url, "eth_sendRawTransaction", [t.raw]);
      console.log(`deploy: sweep ${bal - reserve} wei to ${ret}: ${t.hash}`);
      const r = await receipt(url, t.hash);
      if (r.status !== "0x1") throw new Error(`sweep ${t.hash} failed`);
      txs.push({ step: "sweep (the run key's rest back)", hash: t.hash });
    }
  })());
  // A signal stops the run at its next step: a transaction already sent is waited for, so the sweep never races a
  // deploy for a nonce; the finally below then sweeps. A second signal exits at once.
  let stopped = null;
  const onSignal = (s) => {
    if (stopped) process.exit(1);
    stopped = s;
    console.error(`deploy: ${s}: stopping at the next step, then sweeping`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const go = () => {
    if (stopped) throw new Error(`stopped by ${stopped}`);
  };

  try {
    // 4. the funding
    console.log(`deploy: waiting for ${need} wei (${eth(need)}) at ${deployer} on ${chainName}`);
    while ((go(), big(await rpc(fetch, url, "eth_getBalance", [deployer, "latest"]))) < need) await sleep(5000);
    console.log("deploy: funded");

    // 5. the deploys
    for (const [i, n] of names.entries()) {
      go();
      const f = await fees(url);
      const maxFeePerGas = f.maxFee > maxFee ? maxFee : f.maxFee; // never above what the need was counted at
      const t = signTx(sk, { chainId: big(id), nonce: BigInt(i), maxPriorityFeePerGas: f.tip > maxFeePerGas ? maxFeePerGas : f.tip, maxFeePerGas, gas: gas[n], to: null, data: datas[n] });
      await rpc(fetch, url, "eth_sendRawTransaction", [t.raw]);
      const r = await receipt(url, t.hash);
      txs.push({ step: `deploy ${n}`, hash: t.hash, contract: n });
      if (r.status !== "0x1" || r.contractAddress?.toLowerCase() !== addrs[n]) throw new Error(`deploy ${n} ${t.hash}: status ${r.status}, contract ${r.contractAddress}, want ${addrs[n]}`);
      const code = await rpc(fetch, url, "eth_getCode", [addrs[n], "latest"]);
      const got = runtimeOf(code, pinned[n].immutables);
      if (got.length !== pinned[n].length || got.masked !== pinned[n].masked) throw new Error(`${n} at ${addrs[n]}: code is not the build's`);
      console.log(`deploy: ${n} ${addrs[n]} (${t.hash}), ${r.gasUsed && big(r.gasUsed)} gas, code is the build's`);
    }
    done = true;
  } finally {
    try {
      await sweep();
    } catch (e) {
      console.error(`deploy: SWEEP FAILED: ${e.message}; the run key ${deployer} still holds its balance`);
      process.exitCode = 1;
    }
    if (txs.length) record();
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
          "Each contract's runtime as forge builds it (solc 0.8.28, contracts/pool-evm/foundry.toml): its length, the keccak256 of the runtime with every immutable's 32 bytes zeroed, and each immutable's start offsets. Written by contracts/pool-evm/script/deploy.mjs --write-build; test/deploy.test.mjs fails when forge's output differs.",
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
