#!/usr/bin/env node
// Live check of card evm-pools-on-mainnet: SIGN_HOST's build pins the Base and the Robinhood mainnet pool (the wallet's
// EVM_POOLS, which packages/wallet/test/evm-pool-pins.test.ts holds equal to PINS here), and each pin is what is
// deployed and served. A wrong pin sends a deposit to a contract that is not ours, or makes notes no relayer can spend.
//   - SIGN_HOST (https://confidential.unrealized.trade): the served /app.js is the one index.html pins (its sha384), and
//     the pool pins in it are exactly PINS: both mainnet pools with their fee recipient and deploy block, no testnet pool.
//   - On both RPCs of each mainnet (pool-evm-deploy.mjs MAINNETS, two operators), through evm-pool-pins.mjs checkPin: the
//     chain id; the pool's deploy tx (contracts/pool-evm/deployments/<chain>.json) succeeded, made the pinned pool, in the
//     pinned deploy block (where the device's pool sync starts); the pool's code is its build. And the fee recipient has
//     no code on either (an EIP-7702 delegation there would run inside every fee a proof pays it).
//   - On the deployed helper (https://ct-api.unrealized.trade), GET /v1/pool/fee for each pool names the pin's network,
//     pool and fee recipient (the withdraw sender whose address every proof binds): a helper deploy that changes its
//     sender fails here.
// Each chain read goes through provider-answer.mjs rpcAnswer: a provider's no-answer is QUIET, the run INCONCLUSIVE
// (never PASS) unless a wrong answer fails it. scripts/ci/bundle-checks.mjs runs read and judge (SIGN_HOST's part) on a
// pull request's own build.
// After: sign
// After: helper --part helper
// Bundle: read sign
//   node scripts/live-checks/evm-pools-on-mainnet.mjs [--part helper] [--record <file>]
//     PASS exit 0, FAIL 1, error 2, INCONCLUSIVE 3. --part helper reads the chain and the helper only, the run after a
//     helper deploy, which changes nothing SIGN_HOST serves (so a helper deploy is never undone over SIGN_HOST's part).
// --record writes { sign: { good, bad }, chain: { good, bad } } to <file> (evm-pools-on-mainnet.answers.json), replayed
// by evm-pools-on-mainnet.test.mjs: SIGN_HOST's good answer is this card's build, its bad one SIGN_HOST as served
// before it (release b19f7723: no mainnet pin); the chain's bad run is the pins with each sell sender typed as the fee
// recipient (an address the helper's fee answer does not name).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkPin, deployTxOf, recorder } from "./evm-pool-pins.mjs";
import { chainOf } from "./pool-evm-deploy.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const KEY = "evm-pools-on-mainnet";
export const SIGN = "https://confidential.unrealized.trade";

/** The pins SIGN_HOST's build carries (the wallet's EVM_POOLS on mainnet). Each pool and its deploy tx are
 *  contracts/pool-evm/deployments/<chain>.json's; each deploy block is that tx's receipt, the same block, contract and
 *  status 0x1 on both MAINNETS RPCs (read 2026-11-11 15:0xZ: base 54,325,671 on mainnet.base.org and
 *  base-rpc.publicnode.com, robinhood 108,420,674 on rpc.mainnet.chain.robinhood.com, robinhood-rpc.publicnode.com and
 *  robinhood.drpc.org); each fee recipient the helper's withdraw sender as GET /v1/pool/fee names it for the pool (read
 *  2026-11-11 14:3xZ), as the testnet pins were taken (evm-pool-pins.mjs), with no code and nonce 0 on two RPCs. */
export const PINS = Object.freeze({
  base: Object.freeze({ network: "base", pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf", feeRecipient: "0x4611338bf66389a2d2d3e67301dbb7ac9fb1fb9d", fromBlock: "54325671" }),
  robinhood: Object.freeze({ network: "robinhood", pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db", feeRecipient: "0x63c4b707b319d3f1643a7d0d61c188d76ec8f23d", fromBlock: "108420674" }),
});
/** The bad chain run: each pin with the chain's sell sender (the kit's evmPoolVenues sellSender) as its fee recipient. */
export const TYPED = Object.freeze({
  base: Object.freeze({ ...PINS.base, feeRecipient: "0x2139756ab61ad861b4e25a009f092683e7454ee9" }),
  robinhood: Object.freeze({ ...PINS.robinhood, feeRecipient: "0x92874bbc2638f644872d911d8b72d734978e24ae" }),
});

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** A pool pin as the minifier writes the wallet's EvmPoolPin literal (any quote): network, pool, fee recipient, block. */
const PIN = /network:(["'`])([\w-]+)\1,pool:(["'`])(0x[0-9a-f]{40})\3,feeRecipient:(["'`])(0x[0-9a-f]{40})\5,fromBlock:(\d+)n/g;

/** What the check keeps of SIGN_HOST: the index, the served bundle's sha384, and each pool pin in it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), pins: [...js.matchAll(PIN)].map((m) => ({ network: m[2], pool: m[4], feeRecipient: m[6], fromBlock: m[7] })) };
}

/** SIGN_HOST's index and /app.js, read through `fetchFn`. */
export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

/** The verdict on SIGN_HOST's answer { index, sha384, pins }: { ok, lines }. */
export function judge(a, pins = PINS) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const got = Array.isArray(a?.pins) ? a.pins : [];
  const want = Object.values(pins);
  for (const w of want) {
    const n = got.filter((g) => g.network === w.network);
    if (n.length !== 1) bad(`the bundle pins ${n.length} pools on ${w.network}, not one`);
    else if (n[0].pool !== w.pool || n[0].feeRecipient !== w.feeRecipient || n[0].fromBlock !== w.fromBlock)
      bad(`the bundle's ${w.network} pin is ${n[0].pool}, fee recipient ${n[0].feeRecipient}, block ${n[0].fromBlock}; the pin: ${w.pool}, ${w.feeRecipient}, ${w.fromBlock}`);
    else lines.push(`ok   the bundle pins ${w.network}'s pool ${w.pool}, fee recipient ${w.feeRecipient}, from block ${w.fromBlock}`);
  }
  for (const g of got) if (!want.some((w) => w.network === g.network)) bad(`the bundle pins a pool on ${g.network}, which SIGN_HOST's build must not`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** Each pin on its chain and the helper (checkPin), and its fee recipient's code on both RPCs: { verdict, lines }. */
export async function checkChain(fetchFn, { pins = PINS, epochMs } = {}) {
  const lines = [];
  let bad = Object.keys(pins).join() !== "base,robinhood";
  let quiet = false;
  if (bad) lines.push(`FAIL the pins name ${Object.keys(pins).join(", ")}, not base and robinhood`);
  for (const [net, pin] of Object.entries(pins)) {
    const tx = deployTxOf(net);
    if (!tx) {
      bad = true;
      lines.push(`FAIL ${net}: no deploy tx of its pool in its deployment record`);
      continue;
    }
    const r = await checkPin(fetchFn, net, pin, tx, epochMs);
    bad ||= r.bad;
    quiet ||= r.quiet;
    lines.push(...r.lines);
    for (const url of chainOf(net).rpcs) {
      const a = await rpcAnswer(url, "eth_getCode", [pin.feeRecipient, "latest"], { fetchFn });
      if (a.noAnswer !== undefined) {
        quiet = true;
        lines.push(`QUIET ${net}: ${a.noAnswer} (eth_getCode of the fee recipient)`);
        continue;
      }
      const none = a.error === undefined && a.result === "0x";
      bad ||= !none;
      lines.push(`${none ? "ok  " : "FAIL"} ${net}: the fee recipient ${pin.feeRecipient} has ${none ? "no code" : `code or no read (${JSON.stringify(a.error ?? a.result).slice(0, 60)})`} on ${new URL(url).hostname}`);
    }
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

/** The whole verdict: SIGN_HOST's judge and the chain's, FAIL over INCONCLUSIVE over PASS. */
export function verdictOfBoth(sign, chain) {
  if (!sign.ok || chain.verdict === "FAIL") return "FAIL";
  return chain.verdict;
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--record");
  try {
    const epochMs = Math.floor(Date.now() / 60_000) * 60_000;
    const s = argv.includes("--part") && argv[argv.indexOf("--part") + 1] === "helper" ? { ok: true, lines: [] } : judge(await read());
    const chain = recorder();
    const c = await checkChain(chain.fetchFn, { epochMs });
    for (const l of [...s.lines, ...c.lines]) console.log(l);
    const verdict = verdictOfBoth(s, c);
    console.log(`${verdict} ${KEY}`);
    if (at >= 0) {
      // SIGN_HOST's good answer: this tree's build (scripts/signpage-built.mjs), read from its folder as the host serves it
      const { signBuilt } = await import("../signpage-built.mjs");
      const dir = signBuilt();
      const built = facts(readFileSync(`${dir}/index.html`, "utf8"), readFileSync(`${dir}/public/app.js`, "utf8"));
      const typed = recorder();
      const b = await checkChain(typed.fetchFn, { pins: TYPED, epochMs });
      for (const l of judge(built).lines) console.log(`build: ${l}`);
      for (const l of b.lines) console.log(`bad run: ${l}`);
      writeFileSync(argv[at + 1], JSON.stringify({ key: KEY, recorded: new Date().toISOString(), epochMs, sign: { good: built, bad: await read() }, chain: { good: chain.log, bad: typed.log } }, null, 1) + "\n");
    }
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
