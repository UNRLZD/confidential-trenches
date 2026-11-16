#!/usr/bin/env node
// Live check of card robinhood-quote-answers-cold: a brand-new device's first Robinhood coin quote answers, since
//   - SIGN_HOST serves each EVM chain's pool index snapshot (/evm-index/<chain>.json, written by
//     packages/signpage/scripts/evm-index-snapshot.mjs at the release cut) byte for byte as the commit holds it (its
//     sha-256 the committed file's; packages/signpage/test/evm-index-snapshot.test.ts reads each committed file back
//     through the page's own check), through a block at or below the chain's head: the device starts its index sync from
//     it and reads only the blocks past it, never the chain's 10M-block depth at the scan's first provider's pace (about
//     one getLogs post a second).
// Each snapshot's size, pool count, block and blocks behind the head are printed, not judged: the tail grows between
// release cuts. Reads only: no key, no transaction, no money moves.
// After: sign
// Bundle: out the snapshots on SIGN_HOST and each chain's head
//   node scripts/live-checks/robinhood-quote-answers-cold.mjs [--sign <origin>] [--site <dir>] [--record <file>]
//     --site reads the snapshots from a build folder (deploy.mjs --build's) instead of SIGN_HOST: a commit's run before
//     its deploy. PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, for the test's replay
//     (robinhood-quote-answers-cold.answers.json).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { EXIT } from "./provider-answer.mjs";

export const SIGN = "https://confidential.unrealized.trade";
export const CHAINS = Object.freeze(["base", "robinhood"]);
const READ_MS = 30_000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (text) => createHash("sha256").update(text).digest("hex");
/** Each chain's committed snapshot's sha-256 (the bytes this commit ships). */
export const committed = () => Object.fromEntries(CHAINS.map((c) => [c, sha(readFileSync(path.join(REPO, "packages/signpage/data/evm-index", `${c}.json`), "utf8"))]));

/** The run's verdict ({ sign, snapshots: { chain: { status, bytes, sha?, through?, pools?, head } } }) against `want`,
 *  each chain's committed sha-256: { ok, lines }. */
export function check(run, want = committed()) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok " : "BAD"} ${text}`);
  };
  for (const chain of CHAINS) {
    const s = run?.snapshots?.[chain];
    const same = s?.status === 200 && s.sha === want[chain];
    say(same, `[${chain}] snapshot HTTP ${s?.status ?? "not read"}, ${s?.bytes ?? 0} bytes, sha-256 ${s?.sha?.slice(0, 12) ?? "none"} (the commit's ${want[chain]?.slice(0, 12)})${Number.isSafeInteger(s?.pools) ? `, ${s.pools} pools` : ""}`);
    if (same) say(Number.isSafeInteger(s.head) && Number.isSafeInteger(s.through) && s.through <= s.head, `[${chain}] snapshot through ${s.through}, head ${s.head ?? "not read"} (${Number.isSafeInteger(s.head) ? `${s.head - s.through} blocks behind` : "no head"})`);
  }
  return { ok, lines };
}

/** One run: each chain's snapshot (from SIGN_HOST, or `site`'s folder) and head (the first quote provider that names it). */
export async function read(sign = SIGN, site = null, venues = evmPoolVenues()) {
  const run = { sign, site: site === null ? null : "a build folder at SIGN_HOST's name", at: new Date().toISOString(), snapshots: {} };
  for (const chain of CHAINS) {
    const v = venues[chain];
    const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: sign }, body, signal: AbortSignal.timeout(READ_MS) });
    let head = null;
    for (const url of v.providers) {
      const j = await post(url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }))
        .then((r) => r.json())
        .catch(() => null);
      if (typeof j?.result === "string" && /^0x[0-9a-f]+$/i.test(j.result)) {
        head = Number(j.result);
        break;
      }
    }
    let status;
    let text;
    if (site !== null) {
      try {
        text = readFileSync(path.join(site, "evm-index", `${chain}.json`), "utf8");
        status = 200;
      } catch {
        status = 404;
      }
    } else {
      const r = await fetch(`${sign}/evm-index/${chain}.json`, { signal: AbortSignal.timeout(READ_MS) }).catch((e) => ({ status: `error ${e?.name ?? e}` }));
      status = r.status;
      text = typeof r.text === "function" && r.status === 200 ? await r.text() : undefined;
    }
    // the bytes' digest and the fields printed; the body itself (megabytes) is never recorded
    let json = null;
    try {
      json = text === undefined ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    run.snapshots[chain] = { status, bytes: text?.length ?? 0, ...(text !== undefined ? { sha: sha(text) } : {}), ...(Number.isSafeInteger(json?.through) ? { through: json.through } : {}), ...(Array.isArray(json?.pools) ? { pools: json.pools.length } : {}), head };
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = await read(arg("--sign") ?? SIGN, arg("--site") ?? null);
    const record = arg("--record");
    if (record !== undefined) writeFileSync(record, JSON.stringify(run, null, 1) + "\n");
    const { ok, lines } = check(run);
    for (const l of lines) console.log(l);
    console.log(`live-check robinhood-quote-answers-cold: ${ok ? "PASS" : "FAIL"} (${run.sign}${run.site ? `, ${run.site}` : ""})`);
    process.exit(ok ? EXIT.PASS : EXIT.FAIL);
  } catch (e) {
    console.error(`live-check robinhood-quote-answers-cold: error ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
