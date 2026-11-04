#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The EVM pool's whole money path on a testnet, run through the device's own code (card pool-evm-testnet-run): one
// deposit, one private buy through each pinned adapter into a fresh W, one sell of each W's token back into the pool
// through the pinned SellDelegate (EIP-7702), and a withdraw of every note left to its fresh W, then a restore of the
// run's notes from its 12 words. The run key sends every transaction, as the relayer does.
//
//   node contracts/pool-evm/script/testnet-run.mjs --chain base-sepolia --return <address> [--venues v4,v3]
//     [--rpc <url>,<url>] [--out <file>]
//
// What runs, and whose code:
//  - The pins: the kit's evmPoolVenues() (the pool, the adapters, the sell delegate, the router, the v4 PoolManager,
//    WETH, the quoters and the two providers). The path a user's device takes, through the kit's index only (card
//    evm-sell-device-quote): each buy from the device's own quote (evmPoolBuyQuote, then evmPoolBuildQuoted and
//    evmPoolSignBuy; a route the device refuses below its own best is quoted again on that best route, as
//    EvmQuoteError.reference offers), each sell from the device's own sell quote (evmPoolSellQuote: the device picks
//    the pool and sets minOut, probes the token for a fee on transfer; then evmPoolBuildSell, evmPoolSignSell and
//    evmPoolSignSellAuthorization), poolProveWithdraw (snarkjs in this process, the setup files checked by sha256
//    against ZK_SETUP_FILES). A real run quotes on the chain's pinned providers, as the index does; the dry run on its
//    fork's two loopback URLs (evmPoolBuyQuoteWith and evmPoolSellQuoteWith, the same code with the providers named). The wallet's own evmTreeSync (trees on two RPCs, the pool's views and root times) and
//    evmPool's bind (the context, the epoch's fee read on two RPCs), noteSecrets and freshWallet from the run's words,
//    and evmRestoreNotes for the restore. The kit has no EVM withdraw signer yet: the Withdraw digest
//    (PrivacyPool.sol WITHDRAW_TYPEHASH) is made in testnet-run-lib.mjs, as test/Signing.sol makes it.
//  - The notes are the device's: the deposit note (deposit, scope, 0); each release spends a note (l, j = jOf(ref)) to
//    W_{evm, l, j} and leaves change (l, j); each sell deposits the W's proceeds as the return note (evm, l, j). So the
//    restore from the words finds every one.
//  - The token: Base Sepolia's USDC (Circle's testnet USDC, 0x036CbD53…CF7e), with a v4 pool against native ETH (fee 100,
//    tick spacing 1, no hook) and a v3 pool against WETH (fee 3000), both read on chain (StateView and the v3 factory,
//    4 Nov 20:50Z). minOut for each buy and sell is the device quote's, at 5% slippage.
//  - The run key and the words are made in memory; neither is printed, written or passed on. The need is printed
//    with its parts, then the run waits for it at the run key ("run: waiting for <wei> wei ... at <address>"). Always,
//    in a finally: every note still in the pool is withdrawn to its W when it can be, each W holding ETH is swept, then
//    the run key, to --return. A stop (SIGINT, SIGTERM, SIGHUP) ends the run at its next step and runs the same.
//  - Every transaction is simulated (eth_estimateGas) before it is signed, and must succeed. The record
//    (scripts/live-checks/pool-evm-testnet-run.<chain>.json, or --out) lists every one that landed, in order, with the
//    public values the live check reads back: commitments, labels, nullifiers, Ws, tokens and amounts. Never a secret.
//  - A loopback --rpc (an anvil fork; two URLs, 127.0.0.1 and localhost, so the wallet's two-provider rule holds) is the
//    dry run: it needs --out, and it skips the restore's Transfer reads (they need two other providers).
import "../../../scripts/net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addressOf, returnAddress, signTx } from "./deploy.mjs";
import { MAINNET_IDS, deploymentFile, hex, keccak, rpc, selector, word } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { authJson, balanceOfData, buyData, depositData, proofArg, revertName, sellData, sign65, signTx7702, withdrawData, withdrawDigest, withdrawLeft } from "./testnet-run-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../../..");
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href);
const kit = await imp("packages/kit/src/index.ts");
const { evmPoolBuyQuoteWith, evmPoolSellQuoteWith } = await imp("packages/kit/src/checks/evm/quote.ts");
const { evmPool, evmTreeSync, evmNow: evmNowOnce, evmRelayDataBytes, evmPoolScopeOf, evmEpochBlock: evmEpochBlockOnce, evmRetryLag, EVM_EPOCH_MS, EVM_LIFE_MS, EVM_CHAIN_IDS } = await imp("packages/wallet/src/pool/evm.ts");
// The run's own reads of the pool's time and the epoch's block, as the device's evmPool makes them: again while an RPC
// has not caught up (EvmLagError, evmRetryLag). Read once, Robinhood testnet's own RPC answering null for a block the
// other held stopped a run after its deposit (4 Nov 08:45Z, "rpc 0 does not know block 148245096 yet").
const evmNow = (rpcs) => evmRetryLag(() => evmNowOnce(rpcs));
const evmEpochBlock = (rpcs, startMs) => evmRetryLag(() => evmEpochBlockOnce(rpcs, startMs));
const { evmRestoreNotes } = await imp("packages/wallet/src/pool/evm-restore.ts");
const { noteSecrets } = await imp("packages/wallet/src/notes/secrets.ts");
const { entropyToWords, freshWallet, newEntropy, wordsToSeed64 } = await imp("packages/wallet/src/derive/index.ts");
const { jOf } = await imp("packages/wallet/src/pool/queue.ts");
const kitReq = createRequire(path.join(REPO, "packages/kit/package.json"));
const { secp256k1 } = await import(pathToFileURL(kitReq.resolve("@noble/curves/secp256k1.js")).href);

export const KEY = "pool-evm-testnet-run";
export const recordFile = (chain) => path.join(REPO, "scripts/live-checks", `${KEY}.${chain}.json`);
const ZERO = "0x0000000000000000000000000000000000000000";
const OP_ORACLE = "0x420000000000000000000000000000000000000f";
const eth = (wei) => `${Number(wei) / 1e18} ETH`;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => a.toLowerCase();

// Each testnet the run knows: its two RPCs (the money gate's), the token and its pools, the chain's quoters. Base
// Sepolia's addresses are Uniswap's published testnet deployments (developers.uniswap.org), each read on chain on
// 4 Nov: V4Quoter.poolManager() is the pinned PoolManager, QuoterV2.factory() the v3 factory 0x4752ba5D…aD24.
export const NETS = Object.freeze({
  "base-sepolia": Object.freeze({
    rpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    // the restore's Transfer reads go to two other providers (evmRestoreNotes refuses a pool provider)
    walletRpcs: ["https://base-sepolia.drpc.org", "https://base-sepolia.gateway.tenderly.co"],
    op: true,
    coin: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // the token bought: USDC
    v4: { fee: 100, tickSpacing: 1, hooks: ZERO, quoter: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba" },
    v3: { fee: 3000, quoter: "0xc5290058841028f1614f3a6f0f5816cad0df5e27" },
  }),
  // Robinhood testnet: no Uniswap page lists it. Read on both RPCs on 4 Nov: the V4Quoter and StateView sit at the
  // addresses developers.uniswap.org lists for Robinhood mainnet (4663), with mainnet's code hashes, and
  // V4Quoter.poolManager() is the pinned PoolManager 0x8366a39c...; the token is tSPILL (18 decimals), whose native ETH
  // pool (fee 10000, tick spacing 200, no hook, id 0x601b493e...) is the deepest hookless one the PoolManager's
  // Initialize logs name. No v3 and no router there (M365), so the run buys and sells through v4 only, the sell through
  // the pinned PoolManager (card evm-sell-v4-kit). The Transfer reads
  // go to thirdweb's and dRPC's public gateways (chainid.network, chain 46630), neither a pool provider.
  "robinhood-testnet": Object.freeze({
    rpcs: ["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"],
    walletRpcs: ["https://46630.rpc.thirdweb.com", "https://robinhood-testnet.drpc.org"],
    op: false,
    coin: "0x10e626a1d0857174b9a5bdb7a1397068811fbbbc", // the token bought: tSPILL
    v4: { fee: 10000, tickSpacing: 200, hooks: ZERO, quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" },
  }),
});

// Gas bounds per transaction, above every measured run (kit pool-fee.ts: a one-hop buy 686,812 at depth 2,
// 1,332,356 at depth 32; contracts/pool-evm NOTICE's gas table), and the bytes each one's L1 fee is bounded for.
export const GAS = Object.freeze({ deposit: 300_000n, buy: 1_600_000n, sell: 1_000_000n, withdraw: 1_500_000n, sweep: 30_000n });
const TX_BYTES = 2_600n;
/** The chunk each release takes: the wallet's ladder's smallest (EVM_LADDER.min, 0.001 ETH). */
export const CHUNK = 1_000_000_000_000_000n;
/** The epoch fee the run's relayer asks and the device recomputes (M356 (4), before the L1 fee): 2 x G(depth) x the
 *  epoch block's base fee, rounded up to the helper's step of 1e13 wei. */
export const FEE_STEP = 10_000_000_000_000n;
export const epochFee = ({ baseFeePerGas, depth }) => {
  const f = 2n * kit.evmPoolGas(depth) * baseFeePerGas;
  return ((f + FEE_STEP - 1n) / FEE_STEP) * FEE_STEP;
};
/** The pool's events (contracts/pool-evm/src/interfaces/IPrivacyPool.sol:65, 78, 253) */
export const EVENTS = Object.freeze({
  Deposited: "Deposited(address,uint256,uint256,uint256,uint256)",
  Withdrawn: "Withdrawn(address,address,uint256,uint256,uint256,uint256)",
  Bought: "Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)",
});
/** The slippage of every device quote the run makes, in basis points */
const SLIPPAGE_BPS = 500;

/** The need: the deposit, and for each transaction its gas bound at maxFee plus its L1 fee bound. */
export function needOf({ venues, maxFee, l1 }) {
  const n = BigInt(venues.length);
  const parts = [
    ["deposit", CHUNK * (n + 1n)],
    ["deposit tx", GAS.deposit * maxFee + l1],
    ["buys", n * (GAS.buy * maxFee + l1)],
    ["sells", n * (GAS.sell * maxFee + l1)],
    ["withdraws", (n + 1n) * (GAS.withdraw * maxFee + l1)],
    ["sweeps", (n + 2n) * (GAS.sweep * maxFee + l1)],
  ];
  return { parts, need: parts.reduce((s, [, v]) => s + v, 0n) };
}

/** A node prover: snarkjs's fullProve in this process, on the release's setup files, each checked by sha256 first. */
function nodeProver() {
  const snarkjs = kitReq("snarkjs");
  const file = (f) => {
    const b = readFileSync(path.join(REPO, "packages/kit/zk", f));
    if (createHash("sha256").update(b).digest("hex") !== kit.ZK_SETUP_FILES[f].sha256) throw new Error(`zk/${f} is not the release's pinned file`);
    return new Uint8Array(b);
  };
  let wasm, zkey;
  return {
    async load() {
      wasm ??= file("withdraw.wasm");
      zkey ??= file("withdraw.zkey");
    },
    async prove(circuit, input) {
      if (circuit !== "withdraw") throw new Error("withdraw only");
      const t0 = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey, undefined, undefined, { singleThread: true });
      return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
    },
    close: () => globalThis.curve_bn128?.terminate?.(),
  };
}

export async function main(args, io = {}) {
  const fetchFn = io.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  const sleep = io.sleep ?? realSleep;
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const chain = opt("--chain");
  const net = NETS[chain];
  if (!net) throw new Error(`--chain is one of ${Object.keys(NETS).join(", ")}`);
  const ret = returnAddress(opt("--return"));
  const venues = (opt("--venues") ?? "v4").split(",");
  if (!venues.length || venues.some((v) => v !== "v4" && v !== "v3") || new Set(venues).size !== venues.length) throw new Error("--venues: v4 and/or v3, each once");
  const urls = opt("--rpc")?.split(",") ?? net.rpcs;
  if (urls.length !== 2) throw new Error("--rpc: two URLs");
  const dryRun = urls.every((u) => ["127.0.0.1", "localhost"].includes(new URL(u).hostname));
  const out = opt("--out") ?? (dryRun ? null : recordFile(chain));
  if (!out) throw new Error("a dry run (loopback RPCs) needs --out, so it never writes the real record");
  const call = (method, params, u = urls[0]) => rpc(fetchFn, u, method, params, sleep);
  const evmRpc = (u) => Object.assign((method, params) => rpc(fetchFn, u, method, params, sleep), { url: u });
  const rpcs = [evmRpc(urls[0]), evmRpc(urls[1])];
  // the device's quotes: a real run's on the chain's pinned providers (the kit's index); the dry run's on the fork
  const batchRpc = (u) => async (calls) => {
    const res = await fetchFn(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }))) });
    const arr = await res.json();
    return calls.map((_, id) => arr.find((a) => a?.id === id) ?? null);
  };
  const forkRpcs = () => [batchRpc(urls[0]), batchRpc(urls[1])];
  const buyQuote = (q) => (dryRun ? evmPoolBuyQuoteWith(q, forkRpcs(), Date.now()) : kit.evmPoolBuyQuote(q));
  const sellQuote = (q) => (dryRun ? evmPoolSellQuoteWith(q, forkRpcs(), Date.now()) : kit.evmPoolSellQuote(q));
  /** A device quote and what is built from it within the quote's 30 s: a quote whose block is too old by then
   *  (stale_quote) is asked again, at most 3 times, as an app asks again. A fork reads each pool's state from its
   *  source the first time, so its first quote can take longer than 30 s (dry run, 4 Nov 10:07Z). */
  const fresh = async (quoteOf, build) => {
    for (let i = 0; ; i++) {
      try {
        const q = await quoteOf();
        return { q, built: build(q) };
      } catch (e) {
        if (!(e instanceof kit.EvmQuoteError && e.code === "stale_quote") || i === 2) throw e;
        console.log(`run: ${e.message}; quoting again`);
      }
    }
  };

  // 1. the chain and the pins
  const venue = kit.evmPoolVenues()[chain];
  const chainId = EVM_CHAIN_IDS[chain];
  for (const u of urls) {
    const id = await call("eth_chainId", [], u);
    if (MAINNET_IDS[id]) throw new Error(`${u} answers a mainnet (${id}): that run is the owner's`);
    if (BigInt(id) !== chainId) throw new Error(`${u} answers chain ${BigInt(id)}, not ${chain}'s ${chainId}`);
    if ((await call("eth_getCode", [ret, "latest"], u)) !== "0x") throw new Error(`--return ${ret} has code on ${u}`);
  }
  const pool = lower(venue.pool), weth = lower(venue.weth), token = net.coin;
  const adapters = { v4: lower(venue.adapters.v4), v3: lower(venue.adapters.v3 ?? ZERO) };
  for (const v of venues) if (adapters[v] === ZERO) throw new Error(`${chain} has no pinned ${v} adapter`);
  for (const v of venues) if (!net[v]) throw new Error(`${chain} has no ${v} pool or quoter in NETS`);
  const deployRec = JSON.parse(readFileSync(deploymentFile(chain), "utf8"));
  const deployTx = deployRec.txs.find((t) => t.step === "deploy PrivacyPoolSimple").hash;
  const fromBlock = BigInt((await call("eth_getTransactionReceipt", [deployTx])).blockNumber);
  const scope = evmPoolScopeOf(pool, chainId);
  console.log(`run: ${chain} (${chainId}), pool ${pool} (from block ${fromBlock}), venues ${venues.join(", ")}, token ${token}${dryRun ? ", loopback: the dry run" : ""}`);

  // 2. the run key and the words, in memory only
  const sk = secp256k1.utils.randomSecretKey();
  const relayer = addressOf(sk);
  if (relayer === ret) throw new Error("--return is the run key");
  let seed64 = wordsToSeed64(entropyToWords(newEntropy()));
  console.log(`run: run key ${relayer} (made in this run, never printed); 12 words made in this run, never printed`);
  if (BigInt(await call("eth_getTransactionCount", [relayer, "pending"])) !== 0n) throw new Error(`${relayer} has sent transactions already`);

  const pin = { network: chain, pool, feeRecipient: relayer, fromBlock };
  const fees = async () => {
    const block = await call("eth_getBlockByNumber", ["latest", false]);
    const tip = BigInt(await call("eth_maxPriorityFeePerGas", []).catch(() => "0x0"));
    return { tip, maxFee: 2n * BigInt(block.baseFeePerGas) + tip };
  };
  const l1Bound = async (n) => (net.op ? BigInt(await call("eth_call", [{ to: OP_ORACLE, data: selector("getL1FeeUpperBound(uint256)") + word(n) }, "latest"])) : 0n);
  const { tip, maxFee } = await fees();
  const { parts, need } = needOf({ venues, maxFee, l1: await l1Bound(TX_BYTES) });
  console.log(`run: max fee ${maxFee} wei/gas (tip ${tip}); need ${need} wei (${eth(need)}): ${parts.map(([n, v]) => `${n} ${v}`).join(", ")}`);

  // the relayer's side: the epoch fee its answer names, from the same reads the device makes (its own sync)
  const relaySync = evmTreeSync({ rpcs, pin });
  const relayFee = async (epochStartMs) => {
    const block = await evmEpochBlock(rpcs, epochStartMs);
    const depth = await relaySync.depthAt(block.number);
    const fee = epochFee({ block: block.number, baseFeePerGas: block.baseFeePerGas, depth });
    return { chain: "evm", network: chain, pool, fee_recipient: relayer, epoch_ms: Number(EVM_EPOCH_MS), epoch_start_ms: Number(epochStartMs), block: `0x${block.number.toString(16)}`, fee: fee.toString(), step: FEE_STEP.toString() };
  };
  const device = evmPool({ pin, rpcs, relayFee, epochFee });
  // The device's one sync is evmPool's own (its trees and bind's depthAt share one cache); the relayer's is the
  // relaySync above. A cold sync reads every block from the pool's deploy block: on sepolia.base.org, whose eth_getLogs
  // takes 200 blocks a call (read 4 Nov 22:00Z), that is one call per ~156 blocks at ~0.36 s, ~12 min for the 305,000
  // blocks since the deploy. Both are read while the run waits for its funding (warm, below), never between a release's
  // epoch and its bind, where the deadline would pass.
  const prover = nodeProver();

  // every transaction signed, in order; the record lists those that landed
  const steps = [];
  let nonce = 0n;
  const receipt = async (hash, raw) => {
    for (let t = 0; t < 90; t++) {
      const r = await call("eth_getTransactionReceipt", [hash]);
      if (r) return r;
      if (t % 10 === 9) await call("eth_sendRawTransaction", [raw]).catch(() => {});
      await sleep(2000);
    }
    throw new Error(`${hash}: no receipt in 180 s`);
  };
  /** Simulates, signs, sends and waits for one transaction of `from` (the run key unless a W's key is given). */
  const send = async (step, t, extra = {}, key = sk) => {
    const from = addressOf(key);
    const at = key === sk ? nonce : BigInt(await call("eth_getTransactionCount", [from, "pending"]));
    const sim = { from, to: t.to, data: t.data ?? "0x", value: `0x${(t.value ?? 0n).toString(16)}`, ...(t.authorizations ? { authorizationList: t.authorizations.map(authJson) } : {}) };
    let gas;
    try {
      gas = (BigInt(await call("eth_estimateGas", [sim, "latest"])) * 13n) / 10n;
    } catch (e) {
      throw new Error(`${step}: the simulation reverts (${revertName(e.rpcError?.data)}): ${e.message.split("\n")[0]}`);
    }
    const f = await fees();
    const tx = { chainId, nonce: at, maxPriorityFeePerGas: f.tip, maxFeePerGas: f.maxFee, gas, ...t };
    const s = t.authorizations ? signTx7702(key, tx) : signTx(key, tx);
    const row = { step, hash: s.hash, from, ...extra };
    steps.push(row);
    if (key === sk) nonce++;
    await call("eth_sendRawTransaction", [s.raw]).catch((e) => {
      if (!/already known|known transaction/i.test(e.message)) throw e;
    });
    const r = await receipt(s.hash, s.raw);
    row.block = BigInt(r.blockNumber).toString();
    row.gasUsed = BigInt(r.gasUsed).toString();
    if (r.status !== "0x1") throw new Error(`${step} ${s.hash}: status ${r.status}`);
    row.landed = true;
    console.log(`run: ${step}: ${s.hash} (block ${row.block}, ${row.gasUsed} gas)`);
    return r;
  };
  const poolLog = (r, topic) => r.logs.find((l) => lower(l.address) === pool && l.topics[0] === topic);
  const T = Object.fromEntries(Object.entries(EVENTS).map(([k, sig]) => [k, keccak(new TextEncoder().encode(sig))]));
  const words = (data) => data.slice(2).match(/.{64}/g).map((w) => BigInt(`0x${w}`));
  const blockTime = async (n) => BigInt((await call("eth_getBlockByNumber", [`0x${BigInt(n).toString(16)}`, false])).timestamp);

  // the run's notes: { ref, value, label, commitment, block, spent }
  const notes = [];
  const bought = []; // { l, j, w, out, v, route }
  const wallets = new Set(); // Ws a withdraw paid, swept at the end

  /** The trees once the pool's agreed time is past `block`'s, so the cut holds that block's leaves. */
  const treesAfter = async (block) => {
    const t = await blockTime(block);
    for (;;) {
      const now = await evmNow(rpcs);
      if (now > t * 1000n) return device.trees(now);
      await sleep(2000);
    }
  };

  /** One release of `withdrawn` from `note` to W_{evm, l, jOf(ref)}: a buy through `v`, or a withdraw (v null). */
  const release = async (note, withdrawn, v) => {
    const trees = await treesAfter(note.block);
    // the epoch from the pool's time after the trees: bind refuses a deadline within the send margin of now
    const now = await evmNow(rpcs);
    const l = note.label, j = jOf(note.ref);
    const W = freshWallet(seed64, "evm", l, j);
    try {
      const epochStartMs = now - (now % EVM_EPOCH_MS);
      const s = noteSecrets(seed64, note.ref);
      const cref = { kind: "change", l, j };
      const c = noteSecrets(seed64, cref);
      const b = await device.bind({ chunk: withdrawn, wallet: { address: W.address, publicKey: W.publicKey }, refundPrecommitment: noteSecrets(seed64, { kind: "refund", l, j }).precommitment, epochStartMs, deadlineMs: epochStartMs + EVM_LIFE_MS });
      const p = await kit.poolProveWithdraw(prover, {
        stateTree: trees.stateTree, labelTree: trees.labelTree, newestStateRoot: trees.stateRoot, newestLabelRoot: trees.labelRoot,
        note: { value: note.value, label: l, nullifier: s.nullifier, secret: s.secret }, newNullifier: c.nullifier, newSecret: c.secret, withdrawn, context: b.context,
      });
      console.log(`run: proof for ${note.ref.kind} note (label ${l}) made in ${p.proveMs} ms; W ${lower(W.address)}`);
      const nullifier = BigInt(p.publicSignals[1]);
      const relay = hex(evmRelayDataBytes(b.request.relay));
      const proof = proofArg(p.proof, p.publicSignals);
      const fee = b.feeCap;
      let r, step;
      if (v) {
        const route = v === "v4"
          ? { venue: "uniswap-v4", currencyIn: ZERO, hops: [{ currency: token, fee: net.v4.fee, tickSpacing: net.v4.tickSpacing, hooks: net.v4.hooks, hookData: "0x" }] }
          : { venue: "uniswap-v3", tokens: [weth, token], fees: [net.v3.fee] };
        // the device's own quote of the route; one it refuses below its own best (below_reference, native_first) is
        // quoted again on that best route, which may be the other venue's
        const ask = (rt) => buyQuote({ chain, token, amountIn: withdrawn - fee, slippageBps: SLIPPAGE_BPS, route: rt });
        const { q, built } = await fresh(
          () => ask(route).catch((e) => (e instanceof kit.EvmQuoteError && e.reference ? (console.log(`run: the device refused the ${v} route (${e.code}); quoting its own best`), ask(e.reference.route)) : Promise.reject(e))),
          (q) => kit.evmPoolBuildQuoted(adapters[q.route.venue === "uniswap-v4" ? "v4" : "v3"], q),
        );
        const got = q.route.venue === "uniswap-v4" ? "v4" : "v3";
        const sig = kit.evmPoolSignBuy(W.secretKey, chain, pool, built, { nullifier, context: b.context, value: withdrawn });
        v = got;
        step = `buy through ${v}`;
        r = await send(step, { to: pool, data: buyData(pool, relay, proof, fee, built, sig) }, { kind: "buy", venue: v, w: lower(W.address), nullifier: String(nullifier), minOut: String(built.minOut), quoted: String(q.amountOut), quoteBlock: String(q.block.number), coin: token });
        const ev = poolLog(r, T.Bought);
        if (!ev) throw new Error(`${step}: no Bought event`);
        const d = words(ev.data);
        bought.push({ l, j, w: lower(W.address), out: d[6], ref: note.ref, v, route: q.route });
        Object.assign(steps.at(-1), { out: String(d[6]), newCommitment: String(d[4]), value: String(withdrawn), fee: String(fee) });
      } else {
        const sig = sign65(withdrawDigest(chainId, pool, nullifier, b.context, withdrawn), W.secretKey);
        step = "withdraw";
        r = await send(step, { to: pool, data: withdrawData(pool, relay, proof, fee, sig) }, { kind: "withdraw", w: lower(W.address), nullifier: String(nullifier), value: String(withdrawn), fee: String(fee) });
        const ev = poolLog(r, T.Withdrawn);
        if (!ev) throw new Error("withdraw: no Withdrawn event");
        steps.at(-1).newCommitment = String(words(ev.data)[4]);
        wallets.add(cref.l.toString() + ":" + j);
      }
      note.spent = true;
      notes.push({ ref: cref, value: note.value - withdrawn, label: l, commitment: BigInt(steps.at(-1).newCommitment), block: BigInt(r.blockNumber), spent: false });
    } finally {
      W.secretKey.fill(0);
    }
  };

  /** W's sell of all its token back into the pool, as the return note (evm, l, j), from the device's own sell quote:
   *  the device picks the pool among its own candidates (a v4 pool through the pinned PoolManager, a v3 pool through
   *  the pinned router), sets minOut and probes the token, on two providers; the run names no route. */
  const sellOf = async (b) => {
    const W = freshWallet(seed64, "evm", b.l, b.j);
    try {
      // W is fresh: it holds exactly what its buy paid. Read again while the RPC has not caught up with the buy's block
      // (Robinhood testnet's own RPC answered 0 for W's balance right after the buy landed, 4 Nov 14:13Z, and the sell
      // quote refused an amount of 0)
      let amount = 0n;
      for (let t = 0; t < 30; t++) {
        amount = BigInt(await call("eth_call", [{ to: token, data: balanceOfData(W.address) }, "latest"]));
        if (amount === BigInt(b.out)) break;
        await sleep(2000);
      }
      if (amount !== BigInt(b.out)) throw new Error(`W ${W.address} holds ${amount} of the token, not the ${b.out} its buy paid, after 60 s`);
      // the sender's fee for a sell: the fee step at least (the kit refuses a fee cap of 0)
      const f0 = epochFee({ baseFeePerGas: BigInt((await call("eth_getBlockByNumber", ["latest", false])).baseFeePerGas), depth: 0 });
      const fee = f0 > FEE_STEP ? f0 : FEE_STEP;
      const ref = { kind: "return", c: "evm", l: b.l, j: b.j };
      const { q, built } = await fresh(
        // `bought`: the route of the buy that paid W the token, which the sell quote requires
        () => sellQuote({ chain, token, w: W.address, amountIn: amount, slippageBps: SLIPPAGE_BPS, bought: b.route }),
        (q) => kit.evmPoolBuildSell(q, { precommitment: noteSecrets(seed64, ref).precommitment, feeCap: fee, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n }),
      );
      const sv = q.route.venue === "uniswap-v4" ? "v4" : "v3";
      const sig = kit.evmPoolSignSell(W.secretKey, chain, built);
      const auth = kit.evmPoolSignSellAuthorization(W.secretKey, chain, BigInt(await call("eth_getTransactionCount", [W.address, "latest"])));
      console.log(`run: the device's sell quote for W ${lower(W.address)}: ${q.amountOut} wei through ${sv} (${JSON.stringify(q.route, (_, x) => (typeof x === "bigint" ? String(x) : x))}) at block ${q.block.number}, minOut ${q.minOut}`);
      const r = await send("sell through SellDelegate", { to: lower(W.address), data: sellData(built, fee, sig), authorizations: [auth] }, { kind: "sell", venue: sv, target: lower(built.target), w: lower(W.address), amount: String(amount), minOut: String(built.minOut), quoted: String(q.amountOut), quoteBlock: String(q.block.number), fee: String(fee), coin: token });
      const ev = poolLog(r, T.Deposited);
      if (!ev || lower(`0x${ev.topics[1].slice(26)}`) !== lower(W.address)) throw new Error("sell: no Deposited event from W");
      const d = words(ev.data);
      Object.assign(steps.at(-1), { commitment: String(d[0]), label: String(d[1]), value: String(d[2]), precommitment: String(d[3]) });
      notes.push({ ref, value: d[2], label: d[1], commitment: d[0], block: BigInt(r.blockNumber), spent: false });
    } finally {
      W.secretKey.fill(0);
    }
  };

  /** The W of a withdraw sends what it holds, less its fee bound, to --return. */
  const sweepW = async (key) => {
    const [l, j] = key.split(":");
    const W = freshWallet(seed64, "evm", BigInt(l), Number(j));
    try {
      const bal = BigInt(await call("eth_getBalance", [W.address, "latest"]));
      const f = await fees();
      const reserve = GAS.sweep * f.maxFee + 2n * (await l1Bound(200n));
      if (bal <= 2n * reserve) return;
      await send("sweep (a W's ETH back)", { to: ret, value: bal - reserve, maxFeePerGas: f.maxFee, maxPriorityFeePerGas: f.tip, gas: 21_000n }, { kind: "sweep", w: lower(W.address) }, W.secretKey);
    } finally {
      W.secretKey.fill(0);
    }
  };

  let stopped = null;
  const onSignal = (s) => {
    if (stopped) return console.error(`run: ${s} again: the sweep finishes first`);
    stopped = s;
    console.error(`run: ${s}: stopping at the next step, then withdrawing and sweeping`);
  };
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of SIGNALS) process.on(s, onSignal);
  const go = () => {
    if (stopped) throw new Error(`stopped by ${stopped}`);
  };

  let done = false, funded = false, restored = null;
  // both syncs read the pool from its deploy block while the run waits for its funding (a pool with no leaf yet
  // refuses trees after the read, which is kept)
  const t0 = Date.now();
  const warm = Promise.all([relaySync.events(), evmNow(rpcs).then((n) => device.trees(n)).catch((e) => (/no leaf before/.test(e.message) ? null : Promise.reject(e)))]);
  warm.catch(() => {});
  try {
    console.log(`run: waiting for ${need} wei (${eth(need)}) at ${relayer} on ${chain}`);
    while ((go(), BigInt(await call("eth_getBalance", [relayer, "latest"]))) < need) await sleep(5000);
    funded = true;
    console.log("run: funded");
    await warm;
    console.log(`run: both syncs hold the pool from block ${fromBlock} (${Math.round((Date.now() - t0) / 1000)} s after the start)`);

    // 3. the deposit: the deposit note (deposit, scope, 0)
    const dref = { kind: "deposit", s: scope, i: 0 };
    const value = CHUNK * BigInt(venues.length + 1);
    const r = await send("deposit", { to: pool, value, data: depositData(value, noteSecrets(seed64, dref).precommitment) }, { kind: "deposit" });
    const ev = poolLog(r, T.Deposited);
    if (!ev) throw new Error("deposit: no Deposited event");
    const d = words(ev.data);
    Object.assign(steps.at(-1), { commitment: String(d[0]), label: String(d[1]), value: String(d[2]), precommitment: String(d[3]) });
    notes.push({ ref: dref, value, label: d[1], commitment: d[0], block: BigInt(r.blockNumber), spent: false });

    // 4. a buy through each venue, each from the newest change
    for (const v of venues) {
      go();
      await release(notes.findLast((n) => !n.spent && n.ref.kind !== "return"), CHUNK, v);
    }
    // 5. each W sells what it bought back into the pool, on the venue it bought through
    for (const b of bought) {
      go();
      await sellOf(b);
    }
    done = true;
  } finally {
    try {
      // 6. every note left is withdrawn to its W, each tried again with a fresh release until it lands (the pool has
      // no ragequit), then each W swept
      if (!(await withdrawLeft(notes, (n) => release(n, n.value, null), (m) => console.error(m)))) done = false;
      for (const w of wallets) await sweepW(w).catch((e) => console.error(`run: a W's sweep failed: ${e.message}`));
      // 7. the restore from the words: every note of the run, found by the wallet's own restore
      if (done && !dryRun) {
        restored = await evmRestoreNotes({ seed64, pin, rpcs, walletRpcs: net.walletRpcs.map(evmRpc) });
        const want = notes.map((n) => `${n.commitment}:${n.spent ? "SPENT" : "UNSPENT"}`).sort();
        const got = restored.notes.map((n) => `${n.leaf.commitment}:${n.state}`).sort();
        const missing = want.filter((x) => !got.includes(x));
        console.log(`run: restore from the words: ${restored.notes.length} notes, ${restored.spends.length} spends, ${restored.wallets.length} Ws at block ${restored.block}${missing.length ? `; MISSING ${missing.join(", ")}` : "; every note of the run found"}`);
        if (missing.length) done = false;
        for (const b of bought) {
          const w = restored.wallets.find((x) => x.w === b.w);
          if (!w?.tokens?.includes(token)) (done = false), console.error(`run: the restore does not list ${token} for W ${b.w}`);
        }
      }
    } catch (e) {
      done = false;
      console.error(`run: ${e.message.split("\n")[0]}`);
    } finally {
      seed64.fill(0);
      seed64 = null;
      prover.close();
      // 8. the run key's rest back (stopped before the funding: a transfer in flight lands first, then is swept too)
      try {
        if (!funded) {
          console.log(`run: stopped before funding; watching ${relayer}'s balance for 60 s`);
          await sleep(60_000);
        }
        const latest = BigInt(await call("eth_getTransactionCount", [relayer, "latest"]));
        if (latest < nonce) console.error(`run: the run key has ${nonce - latest} transaction(s) pending; sweeping at nonce ${latest}`);
        const bal = BigInt(await call("eth_getBalance", [relayer, "latest"]));
        const f = await fees();
        const reserve = GAS.sweep * f.maxFee + 2n * (await l1Bound(200n));
        if (bal > 2n * reserve) {
          nonce = latest;
          await send("sweep (the run key's rest back)", { to: ret, value: bal - reserve, maxFeePerGas: f.maxFee, maxPriorityFeePerGas: f.tip, gas: 21_000n }, { kind: "sweep" });
        } else console.log(`run: run key keeps ${bal} wei, under two sweeps' fee bound`);
      } catch (e) {
        done = false;
        console.error(`run: SWEEP FAILED: ${e.message}; the run key ${relayer} still holds its balance`);
      }
      for (const s of SIGNALS) process.off(s, onSignal);
      const landed = steps.filter((s) => s.landed).map(({ landed, ...s }) => s);
      writeFileSync(out, JSON.stringify({
        key: KEY, chain, chainId: Number(chainId), dryRun, at: new Date().toISOString(), pool, coin: token, venues: [...new Set(steps.filter((t) => t.kind === "buy").map((t) => t.venue))], asked: venues, relayer, return: ret, need: need.toString(),
        restore: restored && { notes: restored.notes.length, spends: restored.spends.length, wallets: restored.wallets.map((w) => ({ w: w.w, tokens: w.tokens })), block: String(restored.block) },
        txs: landed,
      }, null, 2) + "\n");
      console.log(`run: wrote ${out}`);
    }
  }
  if (!done) throw new Error("the run did not finish; the record lists what landed");
  console.log(`run: done. Next: node scripts/live-checks/${KEY}.mjs${dryRun ? ` --record-file ${out} --rpc ${urls.join(",")}` : " --write-record"}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`run: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  });
}
