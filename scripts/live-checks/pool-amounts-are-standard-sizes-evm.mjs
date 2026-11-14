#!/usr/bin/env node
// Live check of card pool-amounts-are-standard-sizes-evm: the sell delegate that deposits the largest 1-2-5 rung of a
// sale (SellDelegate v2), deployed alone on Base and Robinhood by the owner's paste (contracts/pool-evm/script/
// mainnet-deploy.sh <chain> <address> --only SellDelegate, its record contracts/pool-evm/deployments/<chain>.sell-delegate-2.json),
// and until then today's sale path. For each mainnet, on two RPCs of two operators:
//   - its record present: the delegate's code is the current build (not one the build file froze), its two immutables
//     the chain's WETH and v4 PoolManager and its getters returning them, no proxy slot and no owner(), the pinned WETH
//     and PoolManager code, the run's transactions succeeded from the run key, which sent exactly them and keeps at most
//     DUST (evm-sell-v4.mjs's reads, here through provider-answer.mjs); and the kit pins either it or the first set's
//     delegate (pool-evm-deploy.build.json frozen SellDelegate.mainnet-1), never another;
//   - no record yet: today's sale path holds: the kit pins the first set's delegate, and its code there is that frozen
//     build on both RPCs, so every sale signs and lands as it does today.
// Every read goes through provider-answer.mjs rpcAnswer: a provider's no-answer is QUIET and the run INCONCLUSIVE.
//   node scripts/live-checks/pool-amounts-are-standard-sizes-evm.mjs [--deployment <file>[,<file>]] [--rpc <url>,<url>]
//     [--record <file>] [--write-record]
//     PASS exit 0, FAIL 1, error 2, INCONCLUSIVE 3. --rpc applies to a single record (the rehearsal's loopback forks).
//     --record writes { notes, rpcs, deployments, pins, log } to <file>, the shape the test replays
//     (pool-amounts-are-standard-sizes-evm.answers.json). --write-record, on PASS with every record a mainnet's, writes
//     the run record pool-amounts-are-standard-sizes-evm.md (Money path: yes, one Tx line per transaction of each
//     redeploy), which the money gate reads back.
// Runs: once, a contract deploy's read-back: mainnet-deploy.sh runs it on the owner's paste's record, and no host deploy changes what it reads
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { recorder } from "./evm-pool-pins.mjs";
import { runRecordFor } from "./evm-sell-v4.mjs";
import { BUILD, DUST, EIP1967, keccak, MAINNETS, operatorProblems, pinnedBuild, runtimeOf, selector } from "./pool-evm-deploy.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const KEY = "pool-amounts-are-standard-sizes-evm";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
/** The owner's paste's record on `chain` (deploy.mjs aloneRecord of deployments/<chain>.json) */
export const recordOf = (chain) => path.join(REPO, "contracts/pool-evm/deployments", `${chain}.sell-delegate-2.json`);
/** The first mainnet set's delegate, frozen in the build file at its two addresses */
export const V1 = "SellDelegate.mainnet-1";
const RUN_RECORD = path.join(HERE, `${KEY}.md`);
const lower = (a) => String(a ?? "").toLowerCase();
const word = (a) => "0x" + lower(a).replace(/^0x/, "").padStart(64, "0");
const QUIET = Symbol("quiet");

/**
 * One mainnet's end state: { verdict, lines }. `deployment`: its v2 record, or null before the paste. `pin`: the kit's
 * sellDelegate pin for the chain. `rpcs`: two RPCs (the chain's own two when not given). The build file is `build`.
 */
export async function checkChain({ chain, deployment: d, pin, fetchFn = fetch, rpcs, build = BUILD }) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const say = (pass, text) => {
    bad ||= !pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  const c = MAINNETS[chain];
  if (!c) return { verdict: "FAIL", lines: [`FAIL ${chain} is one of ${Object.keys(MAINNETS).join(", ")}`] };
  rpcs ??= c.rpcs;
  const v1 = build.frozen?.[V1];
  const v1At = lower(v1?.at?.[chain]);
  const p = lower(pin);
  const a = lower(d?.contracts?.SellDelegate?.address);
  const deployer = lower(d?.deployer);
  const txs = d?.txs ?? [];
  const cur = build.contracts.SellDelegate;
  if (d) {
    if (d.chain !== chain) say(false, `the record is ${chain}'s: ${d.chain}`);
    const names = Object.keys(d.contracts ?? {});
    say(names.length === 1 && /^0x[0-9a-f]{40}$/.test(a), `the record names SellDelegate alone: ${names.join(", ") || "none"}`);
    say(txs.filter((t) => t.contract).length === 1 && txs.some((t) => t.contract === "SellDelegate"), `the record lists the run's transactions, one deploy, SellDelegate's: ${txs.map((t) => t.step).join(", ") || "none"}`);
    say(pinnedBuild(chain, "SellDelegate", a, build) === cur, `SellDelegate ${a} is not an address the build file froze to an older build`);
    say(p === a || (p !== "" && p === v1At), `the kit pins ${chain}'s sell delegate ${pin ?? "(none)"}: the record's ${a} or the first set's ${v1At || "(none frozen)"}`);
  } else {
    say(!!v1 && /^0x[0-9a-f]{40}$/.test(v1At) && p === v1At, `no v2 record on ${chain}: the kit pins the first set's delegate ${v1At || "(none frozen)"}: ${pin ?? "(none)"}`);
  }
  for (const x of operatorProblems(rpcs, d ?? { chain, dryRun: false })) say(false, x);
  for (const url of rpcs.slice(0, 2)) {
    const on = `on ${url}`;
    // one read: its result; a no-answer ends this RPC's reads QUIET; a JSON-RPC error is `{ error }` when `allowError`,
    // else a FAIL ending this RPC's reads
    const read = async (method, params, allowError = false) => {
      const r = await rpcAnswer(url, method, params, { fetchFn });
      if (r.noAnswer !== undefined) {
        quiet = true;
        lines.push(`QUIET ${chain}: ${r.noAnswer} (${method}) ${on}`);
        throw QUIET;
      }
      if (r.error !== undefined) {
        if (allowError) return { error: r.error };
        throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 160)}`);
      }
      return r.result;
    };
    try {
      const id = await read("eth_chainId", []);
      say(id === c.chainId, `chain id ${id} is ${chain}'s ${c.chainId} ${on}`);
      if (!d) {
        const code = await read("eth_getCode", [v1At, "latest"]);
        const r = runtimeOf(code, v1?.immutables ?? []);
        say(!!v1 && r.length === v1.length && r.masked === v1.masked, `the first set's delegate ${v1At} holds that frozen build: ${r.length} bytes (frozen ${v1?.length}), immutables zeroed keccak256 ${r.masked} ${on}`);
        continue;
      }
      const getters = [["WETH()", word(c.weth.address)], ["POOL_MANAGER()", word(c.poolManager.address)]];
      const code = await read("eth_getCode", [a, "latest"]);
      const r = runtimeOf(code, cur.immutables);
      say(r.length === cur.length && r.masked === cur.masked, `SellDelegate ${a} code is the current build: ${r.length} bytes (build ${cur.length}), immutables zeroed keccak256 ${r.masked} (build ${cur.masked}) ${on}`);
      const held = r.words.map((w) => (w.length === 1 ? w[0] : `${w.length} words`)).sort();
      say(JSON.stringify(held) === JSON.stringify(getters.map(([, w]) => w).sort()), `SellDelegate's ${cur.immutables.length} immutables each hold one word, the chain's WETH and PoolManager ${on}: ${held.join(", ") || "none"}`);
      for (const [sig, w] of getters) {
        const got = await read("eth_call", [{ to: a, data: selector(sig) }, "latest"], true);
        say(got === w, `SellDelegate.${sig} returns ${w} ${on}: ${typeof got === "string" ? got : JSON.stringify(got)}`);
      }
      for (const [slot, s] of Object.entries(EIP1967)) {
        const v = await read("eth_getStorageAt", [a, s, "latest"]);
        say(BigInt(v) === 0n, `SellDelegate's EIP-1967 ${slot} slot is 0 ${on}: ${v}`);
      }
      const owner = await read("eth_call", [{ to: a, data: selector("owner()") }, "latest"], true);
      say(owner?.error !== undefined || owner === "0x", `SellDelegate has no owner(): ${owner?.error !== undefined ? "reverts" : owner} ${on}`);
      for (const [label, x] of [["PoolManager", c.poolManager], ["WETH", c.weth]]) {
        const xc = await read("eth_getCode", [x.address, "latest"]);
        say(xc !== "0x" && keccak(xc) === x.codehash, `${label} ${x.address} code hash ${xc === "0x" ? "(no code)" : keccak(xc)} is the pinned ${x.codehash} ${on}`);
      }
      for (const t of txs) {
        const rc = await read("eth_getTransactionReceipt", [t.hash]);
        const made = t.contract ? lower(d.contracts?.[t.contract]?.address) : null;
        say(!!rc && rc.status === "0x1" && lower(rc.from) === deployer && (made === null ? !rc.contractAddress : lower(rc.contractAddress) === made),
          `${t.step} ${t.hash} succeeded, from the deployer${made !== null ? `, made ${t.contract} ${made}` : ""} ${on}${rc ? `: status ${rc.status}, from ${rc.from}, contract ${rc.contractAddress ?? "none"}` : ": no receipt"}`);
      }
      const dcode = await read("eth_getCode", [deployer, "latest"]);
      const nonce = BigInt(await read("eth_getTransactionCount", [deployer, "latest"]));
      const bal = BigInt(await read("eth_getBalance", [deployer, "latest"]));
      say(dcode === "0x" && nonce === BigInt(txs.length) && bal <= DUST,
        `deployer ${deployer} has no code, sent exactly the record's ${txs.length} transactions and keeps at most ${DUST} wei ${on}: code ${dcode.length > 2 ? "yes" : "none"}, nonce ${nonce}, ${bal} wei`);
    } catch (e) {
      if (e !== QUIET) say(false, `read ${on}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

/** Every mainnet: its record if present, else today's path. `read(chain)`: the record or null. */
export async function checkAll({ read = (ch) => (existsSync(recordOf(ch)) ? JSON.parse(readFileSync(recordOf(ch), "utf8")) : null), venues = evmPoolVenues(), rpcsOf = (ch) => MAINNETS[ch].rpcs, fetchFn = fetch, build = BUILD, chains = Object.keys(MAINNETS) } = {}) {
  const lines = [];
  let bad = false;
  let quiet = false;
  for (const chain of chains) {
    const r = await checkChain({ chain, deployment: read(chain), pin: venues[chain]?.sellDelegate, fetchFn, rpcs: rpcsOf(chain), build });
    for (const l of r.lines) lines.push(`${chain}: ${l}`);
    bad ||= r.verdict === "FAIL";
    quiet ||= r.verdict === "INCONCLUSIVE";
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

/** A command-line argument as the replay file's note names it: a path in the repository relative to it, another path by
 *  its file name (no machine's own folders in a committed file) */
const shown = (arg) => arg.split(",").map((x) => (path.isAbsolute(x) ? (x.startsWith(REPO + path.sep) ? path.relative(REPO, x) : path.basename(x)) : x)).join(",");

async function cli() {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const given = opt("--deployment") ? opt("--deployment").split(",").map((f) => JSON.parse(readFileSync(f, "utf8"))) : null;
    const chains = given ? given.map((d) => d.chain) : Object.keys(MAINNETS);
    const recordAt = (ch) => (existsSync(recordOf(ch)) ? JSON.parse(readFileSync(recordOf(ch), "utf8")) : null);
    const read = given ? (ch) => given.find((d) => d.chain === ch) ?? null : recordAt;
    const rpcsOf = (ch) => (opt("--rpc") && chains.length === 1 ? opt("--rpc").split(",") : MAINNETS[ch]?.rpcs ?? []);
    const rec = recorder();
    const venues = evmPoolVenues();
    const r = await checkAll({ read, venues, rpcsOf, fetchFn: opt("--record") ? rec.fetchFn : fetch, chains });
    for (const l of r.lines) console.log(`live-check ${KEY} ${l}`);
    if (opt("--record")) {
      const deployments = Object.fromEntries(chains.map((ch) => [ch, read(ch)]));
      const out = {
        notes: [`Recorded ${new Date().toISOString()} by: node scripts/live-checks/${KEY}.mjs ${args.map(shown).join(" ")}; ${Object.values(deployments).some((d) => d?.dryRun) ? "a dry run (anvil forks of the mainnets, loopback RPCs)" : "the mainnets"}; verdict ${r.verdict}. The good answers; ${KEY}.test.mjs makes each bad answer from them.`],
        rpcs: Object.fromEntries(chains.map((ch) => [ch, rpcsOf(ch).slice(0, 2)])),
        deployments,
        pins: Object.fromEntries(chains.map((ch) => [ch, venues[ch]?.sellDelegate ?? null])),
        log: rec.log,
      };
      writeFileSync(opt("--record"), JSON.stringify(out) + "\n");
    }
    console.log(`live-check ${KEY}: ${r.verdict}`);
    if (r.verdict === "PASS" && args.includes("--write-record")) {
      const ds = chains.map(read).filter(Boolean);
      if (ds.length === 0) throw new Error("no v2 record: no run record to write");
      writeFileSync(RUN_RECORD, runRecordFor(KEY, ds));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RUN_RECORD)}`);
    }
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(EXIT.ERROR);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
