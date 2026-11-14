#!/usr/bin/env node
// Live check of card evm-pool-amounts-are-standard-sizes (release 142, the pin): every new sale on Base and Robinhood
// mainnet signs W's EIP-7702 authorization to SellDelegate v2 (a sale deposits the largest 1-2-5 rung of its ETH less
// the fee, W keeps the rest), the owner's paste of 14 Nov, its records contracts/pool-evm/deployments/<chain>.sell-delegate-2.json.
//   - SIGN_HOST's bundle (https://confidential.unrealized.trade/: the /app.js its index pins, the code the device
//     runs) names each chain's v2 address, and
//     names neither first-set delegate (pool-evm-deploy.build.json frozen SellDelegate.mainnet-1), so the kit's pin
//     the page signs with is v2 on both chains;
//   - on each chain's two RPCs of two operators (pool-evm-deploy.mjs MAINNETS), the v2 address holds the current
//     build's runtime with its two immutables the chain's WETH and v4 PoolManager, no proxy slot and no owner(), and the
//     paste's transactions succeeded (pool-amounts-are-standard-sizes-evm.mjs checkChain, with the bundle's pin).
// A sale signed on the first set's delegate before this pin still resolves: the page's read-back reads W's own
// transaction and the pool's events, never the pin (packages/signpage/src/pool-sell-evm.ts watch).
// The money run (the owner's canary sell on v2, after the release that ships this pin deploys) goes in the card's run
// record scripts/live-checks/evm-pool-amounts-are-standard-sizes.md: a "Money path: yes" line and one Tx line per
// transaction. None is written before it: the money gate refuses a money-path record that lists no Tx.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-sell-delegate-v2-pinned.mjs [--bundle <file>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (an RPC that gives no answer after its retries)
// --bundle <file> judges that file in place of SIGN_HOST's script (a local build before its deploy). --record writes the
// good run (the bundle's facts and every RPC answer) and, as the bad run, SIGN_HOST's bundle facts read now when they
// fail (the release before this pin, which names the first set's delegates), to <file>: the test's replay
// (evm-sell-delegate-v2-pinned.answers.json). The bundle half alone reads only what SIGN_HOST serves, so
// scripts/ci/bundle-checks.mjs runs it on a pull request's build.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signBundle } from "./evm-deposit-note-stays-incoming.mjs";
import { recorder } from "./evm-pool-pins.mjs";
import { checkChain, recordOf, V1 } from "./pool-amounts-are-standard-sizes-evm.mjs";
import { BUILD, MAINNETS } from "./pool-evm-deploy.mjs";
import { EXIT, verdictOf } from "./provider-answer.mjs";

export const KEY = "evm-sell-delegate-v2-pinned";
export const CHAINS = Object.freeze(["base", "robinhood"]);
const lower = (a) => String(a ?? "").toLowerCase();

/** Each chain's delegates: v2 from the paste's record, v1 the first set's (the build file's frozen entry). */
export function delegatesOf(read = (c) => JSON.parse(readFileSync(recordOf(c), "utf8")), build = BUILD) {
  return Object.fromEntries(
    CHAINS.map((c) => {
      const d = read(c);
      if (d?.chain !== c || d.dryRun !== false) throw new Error(`${recordOf(c)} is not ${c}'s real run`);
      return [c, { v2: lower(d.contracts?.SellDelegate?.address), v1: lower(build.frozen?.[V1]?.at?.[c]) }];
    }),
  );
}

/** What the check reads of a bundle: its hash, its size, and whether it names each chain's v2 and v1 delegate. */
export function bundleFacts(text, ds = delegatesOf()) {
  const t = text.toLowerCase();
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: text.length,
    names: Object.fromEntries(CHAINS.map((c) => [c, { v2: t.includes(ds[c].v2), v1: t.includes(ds[c].v1) }])),
  };
}

/** The bundle half's verdict: { ok, lines }. A bundle read from SIGN_HOST (its index) must be the /app.js the index
 *  pins by its integrity hash; a local file (--bundle) has no index. */
export function judgeBundle(b, ds = delegatesOf()) {
  const lines = [];
  let ok = true;
  if (b?.index !== undefined) {
    const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(b.index)?.[1];
    if (!pin) return { ok: false, lines: ["BAD SIGN_HOST's index.html pins no /app.js"] };
    if (pin !== b.sha384) return { ok: false, lines: ["BAD SIGN_HOST's served /app.js is not the one index.html pins"] };
  }
  for (const c of CHAINS) {
    const n = b?.names?.[c];
    const good = n?.v2 === true && n?.v1 === false;
    ok &&= good;
    lines.push(`${good ? "GOOD" : "BAD"} [${c}] the bundle ${b?.url ?? ""} (${String(b?.sha256 ?? "").slice(0, 16)}) ${n?.v2 ? "names" : "does not name"} SellDelegate v2 ${ds[c].v2} and ${n?.v1 ? "names" : "does not name"} the first set's ${ds[c].v1}`);
  }
  return { ok, lines };
}

/** SIGN_HOST's bundle facts (its index's script), or a local file's. */
export async function readBundle(fetchFn = fetch, file) {
  if (file) return { url: file.split("/").pop(), ...bundleFacts(readFileSync(file, "utf8")) };
  const got = await signBundle(fetchFn);
  return { url: got.url, index: got.html, sha384: `sha384-${createHash("sha384").update(got.text).digest("base64")}`, ...bundleFacts(got.text) };
}

/** Both halves: the bundle's facts `b` and each chain's code on two RPCs through `fetchFn`. { verdict, lines } */
export async function check({ b, fetchFn = fetch, rpcsOf = (c) => MAINNETS[c].rpcs, read = (c) => JSON.parse(readFileSync(recordOf(c), "utf8")), build = BUILD } = {}) {
  const ds = delegatesOf(read, build);
  const j = judgeBundle(b, ds);
  const lines = [...j.lines];
  let bad = !j.ok;
  let quiet = false;
  for (const c of CHAINS) {
    const r = await checkChain({ chain: c, deployment: read(c), pin: b?.names?.[c]?.v2 ? ds[c].v2 : ds[c].v1, fetchFn, rpcs: rpcsOf(c), build });
    for (const l of r.lines) lines.push(`[${c}] ${l}`);
    bad ||= r.verdict === "FAIL";
    quiet ||= r.verdict === "INCONCLUSIVE";
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): the bundle half alone. */
export async function bundle(f) {
  return judgeBundle(await readBundle(f));
}

async function main(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const b = await readBundle(fetch, opt("--bundle"));
  const rec = recorder();
  const r = await check({ b, fetchFn: opt("--record") ? rec.fetchFn : fetch });
  for (const l of r.lines) console.log(`live-check ${KEY} ${l}`);
  if (opt("--record")) {
    if (r.verdict !== "PASS") throw new Error(`the good run is ${r.verdict}: nothing recorded`);
    const live = await readBundle(fetch);
    if (judgeBundle(live).ok) throw new Error("SIGN_HOST's bundle already passes: no bad run to record");
    const rpcs = Object.fromEntries(CHAINS.map((c) => [c, MAINNETS[c].rpcs.slice(0, 2)]));
    const deployments = Object.fromEntries(CHAINS.map((c) => [c, JSON.parse(readFileSync(recordOf(c), "utf8"))]));
    const notes = [`Recorded ${new Date().toISOString()}: good, this checkout's build (${opt("--bundle") ? "--bundle " + b.url : "SIGN_HOST"}) and the mainnets' answers; bad, SIGN_HOST's bundle read then (${live.url}), the release before the pin.`];
    writeFileSync(opt("--record"), `${JSON.stringify({ key: KEY, notes, good: { bundle: b, rpcs, deployments, log: rec.log }, bad: { bundle: live } }, null, 1)}\n`);
    console.log(`live-check ${KEY}: recorded ${opt("--record")}`);
  }
  console.log(`live-check ${KEY}: ${r.verdict}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`live-check ${KEY}: ERROR: ${e?.message ?? e}`), process.exit(EXIT.ERROR)));
