#!/usr/bin/env node
// Live check of card pool-evm-testnet-run: the EVM pool's whole money path ran on a testnet (a deposit, a private buy
// through each pinned adapter, each W's sell back into the pool through the pinned SellDelegate under EIP-7702, the
// withdraws, the sweeps), read back from the run's record (pool-evm-testnet-run.<chain>.json, written by
// contracts/pool-evm/script/testnet-run.mjs) on the chain's two RPCs of two operators (the money gate's). It reads:
//   - every transaction: its receipt on both RPCs, status 1, one block number and hash on both, sent by the record's
//     sender; and its pool event, field by field against the record:
//       deposit:  Deposited(depositor the run key, commitment, label, value, precommitment);
//       buy:      Bought(W, fee recipient the run key, value, fee, nullifier, new commitment, token, out), out at least
//                 the signed minOut, and the token's Transfer of out to W in the same receipt;
//       sell:     a type 4 transaction to W whose one authorization names the pinned SellDelegate on this chain, and
//                 Deposited(depositor W, commitment, label, value, precommitment) with value at least minOut less fee;
//                 a v4 sell's target is the pinned PoolManager and its receipt holds one Swap from that PoolManager
//                 whose sender is W (the SellDelegate code at W swapped there itself), a v3 sell's is the pinned router;
//       withdraw: Withdrawn(W, fee recipient the run key, value, fee, nullifier, new commitment);
//       sweep:    to the record's return address;
//   - the pool at one block both RPCs hold with one hash (the lower of their latest): currentRoot, currentTreeSize,
//     currentLabelRoot and currentLabelTreeSize equal on both, stateRootTimes(currentRoot) above 0, every nullifier
//     the run spent marked in nullifierHashes and every precommitment it used in usedPrecommitments, on both;
//   - each W that sold: its code on both RPCs is the EIP-7702 designator 0xef0100 ‖ the pinned SellDelegate;
//   - the run key: no more than DUST wei left, and its nonce the number of transactions it sent.
// The pins: the pool from card pool-evm-deploy's record, the sell delegate from card evm-sell-v4's (the one that sells
// through the v4 PoolManager), the PoolManager and the router from pool-evm-deploy.mjs's CHAINS; nothing else is taken
// from the run's record but what it claims, and each claim is read back. Every chain's run has a sell.
// A run that stopped part way (its record names why in `stopped`, pool-evm-testnet-run.<chain>.stopped.json) is read
// back the same way, every transaction and the run key's rest, and needs only its deposit: its Tx lines go into the run
// record with the others, so the money gate reads them too.
//   node scripts/live-checks/pool-evm-testnet-run.mjs [--record-file <file>] [--rpc <url>,<url>] [--record <answers>]
//     [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// With no --record-file it checks every chain's record that exists (CHAINS). --record writes every answer read, per
// run, as a good run, and its bad run: the same answers with every nullifierHashes read false on both RPCs (a spend
// the pool never marked), which must fail. --write-record, on PASS, writes the run record pool-evm-testnet-run.md
// (Money path: yes, one Tx line per transaction of every run).
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recorder } from "./notes-per-pool-evm.mjs";
import { CHAINS as DEPLOYED } from "./pool-evm-deploy.mjs";

const KEY = "pool-evm-testnet-run";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORD = path.join(HERE, `${KEY}.md`);
export const recordFileOf = (chain) => path.join(HERE, `${KEY}.${chain}.json`);
export const stoppedFileOf = (chain) => path.join(HERE, `${KEY}.${chain}.stopped.json`);
/** Every record file there is, in the run record's order: each chain's run, then its stopped run if it has one. */
export const recordFiles = () => CHAINS.flatMap((c) => [recordFileOf(c), stoppedFileOf(c)]).filter((f) => existsSync(f));
// What a run key may keep: pool-evm-deploy.mjs's DUST (1e13 wei, a transfer's cost many times over)
export const DUST = 10n ** 13n;
/** The testnets a run may have a record for, in the run record's order. */
export const CHAINS = Object.freeze(["base-sepolia", "robinhood-testnet"]);

// @noble/hashes from the helper's own dependencies (apps/ is outside Blindfill), for the selectors and topics
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");
const k256 = (s) => `0x${Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex")}`;
const sel = (s) => k256(s).slice(0, 10);
export const TOPICS = Object.freeze({
  Deposited: k256("Deposited(address,uint256,uint256,uint256,uint256)"),
  Withdrawn: k256("Withdrawn(address,address,uint256,uint256,uint256,uint256)"),
  Bought: k256("Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)"),
  Transfer: k256("Transfer(address,address,uint256)"),
  // Uniswap v4 IPoolManager.Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
  // uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
  Swap: k256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
});
export const VIEWS = Object.freeze({
  currentRoot: sel("currentRoot()"), currentTreeSize: sel("currentTreeSize()"), currentLabelRoot: sel("currentLabelRoot()"),
  currentLabelTreeSize: sel("currentLabelTreeSize()"), stateRootTimes: sel("stateRootTimes(uint256)"),
  nullifierHashes: sel("nullifierHashes(uint256)"), usedPrecommitments: sel("usedPrecommitments(uint256)"),
});

// Each chain: its two RPCs (scripts/ci/money-gate.mjs RPCS), and its pins (see the header)
const pinsOf = (chain) => {
  const d = JSON.parse(readFileSync(path.join(HERE, `pool-evm-deploy.${chain}.json`), "utf8"));
  const s = JSON.parse(readFileSync(path.join(HERE, `evm-sell-v4.${chain}.json`), "utf8"));
  const c = DEPLOYED[chain];
  return {
    pool: d.contracts.PrivacyPoolSimple.address.toLowerCase(),
    sellDelegate: s.contracts.SellDelegate.address.toLowerCase(),
    poolManager: c.poolManager.address.toLowerCase(),
    router: c.router?.address ? c.router.address.toLowerCase() : null,
  };
};
export const RPCS = Object.freeze({
  "base-sepolia": ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
  "robinhood-testnet": ["https://rpc.testnet.chain.robinhood.com", "https://robinhood-sepolia-rpc.publicnode.com"],
});

const lower = (a) => String(a).toLowerCase();
const words = (data) => (String(data).slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`));
const addrOf = (w) => `0x${w.toString(16).padStart(40, "0")}`;
const topicAddr = (t) => lower(`0x${String(t).slice(26)}`);
const word = (x) => BigInt(x).toString(16).padStart(64, "0");

/** The check of one run record: { ok, lines }. `transport(url, method, params)` answers { result } or { error }. */
export async function check(rec, transport, urls = RPCS[rec.chain]) {
  const lines = [];
  const both = async (method, params) => {
    const rs = await Promise.all(urls.map((u) => transport(u, method, params)));
    rs.forEach((r, k) => {
      if ("error" in r) throw new Error(`${method} on rpc ${k}: ${r.error}`);
    });
    return rs.map((r) => r.result);
  };
  const one = async (method, params, what) => {
    const [a, b] = await both(method, params);
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: the two RPCs answer ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
    return a;
  };
  // A transaction as both RPCs answer it, but blockTimestamp: Robinhood's own RPC adds it to the object (read 4 Nov) and
  // PublicNode's does not; it is the block's, which the receipts' one block hash already pins. Any other field differs:
  // the read fails.
  const oneTx = async (hash, what) => {
    const [a, b] = (await both("eth_getTransactionByHash", [hash])).map((x) => (x && typeof x === "object" ? (({ blockTimestamp, ...rest }) => rest)(x) : x));
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: the two RPCs answer ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
    return a;
  };
  try {
    if (!urls || urls.length !== 2) throw new Error(`no two RPCs for ${rec.chain}`);
    const pins = pinsOf(rec.chain);
    if (lower(rec.pool) !== pins.pool) throw new Error(`the record's pool ${rec.pool} is not ${rec.chain}'s pinned pool ${pins.pool}`);
    const ids = await both("eth_chainId", []);
    if (ids.some((x) => BigInt(x) !== BigInt(rec.chainId))) throw new Error(`chain ids ${ids.join(", ")}, not ${rec.chainId}`);
    if (!Array.isArray(rec.txs) || rec.txs.length === 0) throw new Error("the record lists no transaction");
    const relayer = lower(rec.relayer);
    const kinds = new Set(rec.txs.map((t) => t.kind));
    if ("stopped" in rec && (typeof rec.stopped !== "string" || rec.stopped.length === 0)) throw new Error("a stopped run's record names why it stopped");
    for (const k of rec.stopped ? ["deposit"] : ["deposit", "buy", "sell", "withdraw"]) if (!kinds.has(k)) throw new Error(`the record has no ${k}`);
    const nullifiers = [], precommitments = [], sellers = [];
    let sent = 0;
    for (const t of rec.txs) {
      const rs = await both("eth_getTransactionReceipt", [t.hash]);
      for (const [k, r] of rs.entries()) {
        if (!r) throw new Error(`${t.step} ${t.hash}: no receipt on rpc ${k}`);
        if (r.status !== "0x1") throw new Error(`${t.step} ${t.hash}: status ${r.status} on rpc ${k}`);
      }
      const [r, r2] = rs;
      if (r.blockHash !== r2.blockHash || r.blockNumber !== r2.blockNumber) throw new Error(`${t.step} ${t.hash}: two blocks on the two RPCs`);
      if (lower(r.from) !== lower(t.from)) throw new Error(`${t.step} ${t.hash}: sent by ${r.from}, not ${t.from}`);
      if (lower(r.from) === relayer) sent++;
      const log = (topic, from = rec.pool) => {
        const ls = r.logs.filter((l) => lower(l.address) === lower(from) && l.topics[0] === topic);
        if (ls.length !== 1) throw new Error(`${t.step} ${t.hash}: ${ls.length} ${Object.keys(TOPICS).find((n) => TOPICS[n] === topic)} events from ${from}, not 1`);
        return ls[0];
      };
      const same = (what, got, want) => {
        if (String(got) !== String(want)) throw new Error(`${t.step} ${t.hash}: ${what} is ${got}, the record says ${want}`);
      };
      let said;
      if (t.kind === "deposit" || t.kind === "sell") {
        const l = log(TOPICS.Deposited);
        const [commitment, label, value, pre] = words(l.data);
        same("the depositor", topicAddr(l.topics[1]), t.kind === "deposit" ? relayer : lower(t.w));
        same("the commitment", commitment, t.commitment), same("the label", label, t.label), same("the value", value, t.value), same("the precommitment", pre, t.precommitment);
        precommitments.push(pre);
        said = `Deposited ${value} wei, label ${label}`;
        if (t.kind === "sell") {
          const tx = await oneTx(t.hash, `${t.step} ${t.hash}`);
          if (tx.type !== "0x4") throw new Error(`${t.step} ${t.hash}: type ${tx.type}, not 4 (EIP-7702)`);
          if (lower(tx.to) !== lower(t.w)) throw new Error(`${t.step} ${t.hash}: sent to ${tx.to}, not W ${t.w}`);
          const auths = tx.authorizationList ?? [];
          if (auths.length !== 1 || lower(auths[0].address) !== pins.sellDelegate || BigInt(auths[0].chainId) !== BigInt(rec.chainId)) throw new Error(`${t.step} ${t.hash}: its authorization is not this chain's pinned SellDelegate ${pins.sellDelegate}`);
          if (value < BigInt(t.minOut) - BigInt(t.fee)) throw new Error(`${t.step} ${t.hash}: deposited ${value}, under minOut ${t.minOut} less the fee ${t.fee}`);
          const through = t.venue === "v4" ? pins.poolManager : t.venue === "v3" ? pins.router : null;
          if (!through || lower(t.target) !== through) throw new Error(`${t.step} ${t.hash}: a ${t.venue} sell through ${t.target}, not this chain's pinned ${t.venue === "v4" ? "PoolManager" : "router"} ${through}`);
          if (t.venue === "v4") {
            const sw = log(TOPICS.Swap, pins.poolManager);
            if (topicAddr(sw.topics[2]) !== lower(t.w)) throw new Error(`${t.step} ${t.hash}: the PoolManager's Swap names sender ${topicAddr(sw.topics[2])}, not W ${t.w}`);
          }
          sellers.push(lower(t.w));
          said = `type 4 to W ${lower(t.w)} authorizing SellDelegate ${pins.sellDelegate}, ${t.venue === "v4" ? `Swap by W on the PoolManager ${through}` : `through the router ${through}`}, ${said}`;
        }
      } else if (t.kind === "buy" || t.kind === "withdraw") {
        const l = log(t.kind === "buy" ? TOPICS.Bought : TOPICS.Withdrawn);
        const d = words(l.data);
        same("W", topicAddr(l.topics[1]), lower(t.w));
        same("the fee recipient", addrOf(d[0]), relayer);
        same("the value", d[1], t.value), same("the fee", d[2], t.fee), same("the nullifier", d[3], t.nullifier), same("the new commitment", d[4], t.newCommitment);
        nullifiers.push(d[3]);
        said = `W ${lower(t.w)}, value ${d[1]}, fee ${d[2]}, nullifier ${d[3]}`;
        if (t.kind === "buy") {
          same("the token", addrOf(d[5]), lower(t.coin)), same("out", d[6], t.out);
          if (d[6] < BigInt(t.minOut)) throw new Error(`${t.step} ${t.hash}: out ${d[6]} under the signed minOut ${t.minOut}`);
          const tr = r.logs.filter((x) => lower(x.address) === lower(t.coin) && x.topics[0] === TOPICS.Transfer && topicAddr(x.topics[2]) === lower(t.w));
          if (tr.length !== 1 || words(tr[0].data)[0] !== d[6]) throw new Error(`${t.step} ${t.hash}: no Transfer of ${d[6]} ${t.coin} to W`);
          said = `Bought ${d[6]} of ${lower(t.coin)} (minOut ${t.minOut}) for ${said}`;
        } else said = `Withdrawn to ${said}`;
      } else if (t.kind === "sweep") {
        const tx = await oneTx(t.hash, `${t.step} ${t.hash}`);
        if (lower(tx.to) !== lower(rec.return)) throw new Error(`${t.step} ${t.hash}: to ${tx.to}, not the return address ${rec.return}`);
        said = `${BigInt(tx.value)} wei to ${lower(rec.return)}`;
      } else throw new Error(`${t.hash}: unknown kind ${t.kind}`);
      lines.push(`${rec.chain}: ${t.step} ${t.hash} in block ${BigInt(r.blockNumber)} on both: ${said}`);
    }

    // the pool at one block both hold with one hash
    const tops = await both("eth_getBlockByNumber", ["latest", false]);
    const n = tops.map((b) => BigInt(b.number)).reduce((a, b) => (a < b ? a : b));
    const at = await both("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
    if (at[0]?.hash !== at[1]?.hash) throw new Error(`block ${n}: two hashes on the two RPCs`);
    const hash = at[0].hash;
    const view = async (s, arg = "") => BigInt(await one("eth_call", [{ to: rec.pool, data: s + arg }, { blockHash: hash }], `${s} at ${hash}`));
    const root = await view(VIEWS.currentRoot), size = await view(VIEWS.currentTreeSize);
    const labelRoot = await view(VIEWS.currentLabelRoot), labelSize = await view(VIEWS.currentLabelTreeSize);
    const leaves = rec.txs.filter((t) => ["deposit", "sell", "buy", "withdraw"].includes(t.kind)).length;
    if (size < BigInt(leaves)) throw new Error(`currentTreeSize ${size}, under the run's ${leaves} leaves`);
    if ((await view(VIEWS.stateRootTimes, word(root))) === 0n) throw new Error(`stateRootTimes(${root}) is 0: not a root the pool recorded`);
    lines.push(`${rec.chain}: at block ${n} (${hash}) on both: currentRoot ${root}, currentTreeSize ${size}, currentLabelRoot ${labelRoot}, currentLabelTreeSize ${labelSize}; stateRootTimes(currentRoot) set`);
    for (const x of nullifiers) if ((await view(VIEWS.nullifierHashes, word(x))) !== 1n) throw new Error(`nullifierHashes(${x}) is not set on both: a spend the pool did not mark`);
    for (const x of precommitments) if ((await view(VIEWS.usedPrecommitments, word(x))) !== 1n) throw new Error(`usedPrecommitments(${x}) is not set on both`);
    lines.push(`${rec.chain}: the ${nullifiers.length} nullifiers spent and the ${precommitments.length} precommitments used are marked in the pool on both`);
    for (const w of sellers) {
      const code = await one("eth_getCode", [w, { blockHash: hash }], `W ${w}'s code`);
      if (lower(code) !== `0xef0100${pins.sellDelegate.slice(2)}`) throw new Error(`W ${w}'s code is ${code}, not the EIP-7702 designator of ${pins.sellDelegate}`);
    }
    lines.push(`${rec.chain}: each W that sold (${sellers.length}) is delegated to the pinned SellDelegate (0xef0100 designator) on both`);
    const bal = BigInt(await one("eth_getBalance", [relayer, { blockHash: hash }], "the run key's balance"));
    const nonce = BigInt(await one("eth_getTransactionCount", [relayer, { blockHash: hash }], "the run key's nonce"));
    if (bal > DUST) throw new Error(`the run key ${relayer} holds ${bal} wei, more than ${DUST}`);
    if (nonce !== BigInt(sent)) throw new Error(`the run key's nonce is ${nonce}, not the ${sent} transactions it sent`);
    lines.push(`${rec.chain}: the run key ${relayer} keeps ${bal} wei (at most ${DUST}) after its ${sent} transactions`);
    return { ok: true, lines };
  } catch (e) {
    lines.push(`${rec.chain}: ${e?.message ?? e}`);
    return { ok: false, lines };
  }
}

/** The bad run kept beside a good one: every nullifierHashes read answers false on both RPCs. */
export function spoil(log) {
  return log.map((e) =>
    e.method === "eth_call" && String(e.params?.[0]?.data).startsWith(VIEWS.nullifierHashes) && typeof e.result === "string" ? { ...e, result: `0x${"0".repeat(64)}` } : e,
  );
}

/** pool-evm-testnet-run.md: Money path: yes, one Tx line per transaction of every run, and what each one is. */
export function runRecord(recs) {
  return [
    `CARD ${KEY} / live: PASS`,
    "Money path: yes",
    ...recs.flatMap((rec) => rec.txs.map((t) => `Tx: ${rec.chain} ${t.hash}`)),
    "",
    ...recs.flatMap(runLines),
  ].join("\n");
}
const runLines = (rec) => [
    `${rec.chain} (chain id ${rec.chainId}), contracts/pool-evm/script/testnet-run.mjs at ${rec.at}, the pool ${rec.pool}, the token ${rec.coin}, venues ${rec.venues.join(" and ")}. Its steps, in the order of its Tx lines above: ${rec.txs.map((t) => t.step).join(", ")}.`,
    `The run key ${rec.relayer} lived only in the run, sent every transaction but the Ws' own sweeps as the relayer, was funded with ${rec.need} wei (the printed need) and swept back to ${rec.return}. The run's 12 words lived only in the run; every note came from them.`,
    ...(rec.stopped ? [rec.stopped] : []),
    rec.restore ? `The restore from the words (packages/wallet evmRestoreNotes) at block ${rec.restore.block}: ${rec.restore.notes} notes, ${rec.restore.spends} spends, the Ws ${rec.restore.wallets.map((w) => `${w.w} (${(w.tokens ?? ["unread"]).join(", ") || "no token"})`).join(", ")}.` : "No restore was run.",
    "",
];

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const files = at("--record-file") ? [at("--record-file")] : recordFiles();
  if (files.length === 0) throw new Error("no run record");
  const runs = [];
  let ok = true;
  for (const file of files) {
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const urls = at("--rpc")?.split(",") ?? RPCS[rec.chain];
    const r0 = recorder();
    const r = await check(rec, r0.transport, urls);
    for (const l of r.lines) console.log(`${r.ok ? "PASS" : "FAIL"} ${l}`);
    ok &&= r.ok;
    runs.push({ record: rec, urls, good: r0.log, bad: spoil(r0.log) });
  }
  if (at("--record")) {
    writeFileSync(at("--record"), `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), runs }, null, 1)}\n`);
    console.log(`recorded ${at("--record")}`);
  }
  if (ok && argv.includes("--write-record")) {
    writeFileSync(RECORD, runRecord(runs.map((r) => r.record)));
    console.log(`wrote ${path.relative(process.cwd(), RECORD)}`);
  }
  console.log(ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
