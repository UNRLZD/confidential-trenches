#!/usr/bin/env node
// Card quote-speed-before-merge: a change that slows the EVM quote past the KPI (a warm quote under a second at p95) is
// refused before it merges. Card evm-quote-read-gas-starve merged at 206d625f with CI green, then the live check
// evm-quote-warm-round failed after the deploy (live run 42521476520: base-partial-v4 warm p95 1440 ms, over 1000) and
// both hosts were rolled back.
//
// The rule: when a change touches a file of PATHS (the change from the merge base, base...head, as money-gate and
// vault-sandbox read it: a pull request branched before main changed the quote is judged on its own files, never on
// main's), ci.yml's deep-import job runs CHECK on the runner, against the
// checkout's own kit (one cold and 20 warm quotes of each case through the kit's public evmPoolBuyQuote on its pinned
// providers). A try passes only when the run exits 0 and writes a record that the check's own check() passes, read here:
// a run that writes no record (skipped, cut off, its main block never ran) is refused, so is a record whose verdict and
// exit code disagree. Public RPCs are noisy, so a refused try is run once more before the gate refuses: TRIES, never
// more. A try past TRY_MS is killed and refused. quote-speed.test.mjs traces every file node loads for the quote and fails
// on one outside PATHS that is not a package the kit's package.json and pnpm-lock.yaml (both in PATHS) pin.
//
// What it holds: honest slowdowns. A hostile pull request's kit runs inside the measured process and can fake its own
// times, and on pull_request GitHub runs the pull request's own ci.yml, which could drop the step: as with the verify
// and money gates, the review of a change to ci.yml or the kit is what stands against that.
//
// What it measures: the two Base buy cases of CHECK. A Robinhood buy and the cbBTC two-hop are out of CHECK until their
// cards bring them under a second (its CASES); a sell quote needs a wallet holding the token and its buy's block
// (EvmPoolSellQuoteRequest's w and boughtBlock), so no fixed public case exists for it. A slowdown only those paths
// take passes here.
//
// On a pull request ci.yml runs this file and CHECK as main has them (the base's scripts/ tree in $RUNNER_TEMP/base, as
// verify-gate runs), so a pull request cannot loosen the KPI, the cases or the rerun; the quote it measures is the
// checkout's: ROOT/packages is made a link to the checkout's packages/ when ROOT is not the checkout.
//
// The Solana quote (packages/kit/src/trade/solana/) has no warm-round check of the kit alone: solana-quote-under-1s
// quotes through the deployed helper and is pending (its Runs line), so it is not run here.
//
//   node scripts/ci/quote-speed.mjs <base> <head>   the change base...head, read in the working directory
//   node scripts/ci/quote-speed.mjs --all           measures whatever changed (a push with no before, a dispatch)
// PASS exit 0 (measured under the KPI, or no file under PATHS changed), FAIL exit 1, error exit 2.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The quote's code: every file evmPoolBuyQuote and evmPoolVenues import is under one of these (the test holds it). */
// A path ending in "/" is a folder; any other is one file. The two files pin the npm packages the quote loads (@noble).
export const PATHS = ["packages/kit/src/checks/evm/", "packages/kit/src/trade/evm/", "packages/kit/package.json", "pnpm-lock.yaml"];
export const CHECK = "scripts/live-checks/evm-quote-warm-round.mjs";
export const TRIES = 2;
/** A try's bound: CHECK's runner jobs took 98 to 128 s, setup included (live runs 42500836732 to 42522703562,
 *  8 Nov), so 300 s is over twice the slowest; a cold quote's scan may stall 60 s (the quote's own bound) and still fit. */
export const TRY_MS = 300_000;

/** The changed files the quote reads. */
export const watched = (files) => files.filter((f) => PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));

/** Every path head adds, changes or removes since its merge base with base (a rename as its two paths). */
export function changedFiles(base, head, cwd = process.cwd()) {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\n").filter(Boolean);
}

/** One try's verdict: the run exited 0 and its record passes the check's own judge. */
export function judgeTry({ status, record, killed = false }, check) {
  if (killed) return { ok: false, lines: [`FAIL the try ran past ${TRY_MS / 1000} s and was killed`] };
  if (record === null) return { ok: false, lines: [`FAIL no record: the run exited ${status} and wrote none (skipped, cut off or its main block never ran)`] };
  const r = check(record);
  const lines = [...r.lines];
  if (status !== 0) lines.push(`FAIL the run exited ${status}`);
  return { ok: r.ok && status === 0, lines };
}

/** The gate: 0 to pass, 1 to refuse. runTry(i) runs try i and gives { status, record | null }. */
export async function gate({ files = [], all = false, runTry, check, log = console.log }) {
  if (!all) {
    const hits = watched(files);
    if (hits.length === 0) {
      log(`quote-speed: PASS (skip: none of ${files.length} changed file(s) is under ${PATHS.join(" or ")})`);
      return 0;
    }
    log(`quote-speed: ${hits.length} changed file(s) the quote reads: ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ", ..." : ""}`);
  } else log("quote-speed: measuring (--all)");
  for (let i = 1; i <= TRIES; i++) {
    const v = judgeTry(await runTry(i), check);
    for (const l of v.lines) log(`  ${l}`);
    if (v.ok) {
      log(`quote-speed: PASS (try ${i} of ${TRIES})`);
      return 0;
    }
    log(`quote-speed: try ${i} of ${TRIES} refused${i < TRIES ? "; once more, since public RPCs are noisy" : ""}`);
  }
  log(`quote-speed: FAIL (${TRIES} tries refused: the EVM quote misses the KPI on this change)`);
  return 1;
}

/** ROOT/packages as the checkout's packages/, so ROOT's CHECK quotes with the checkout's kit. */
export function linkKit(root = ROOT, cwd = process.cwd()) {
  if (realpathSync(root) === realpathSync(cwd)) return;
  const want = path.join(cwd, "packages");
  const at = path.join(root, "packages");
  if (!existsSync(at)) symlinkSync(want, at, "dir");
  if (realpathSync(at) !== realpathSync(want)) throw new Error(`${at} is not the checkout's packages/ (${want})`);
}

/** A try: CHECK as a child, its record in a fresh dir, so no earlier try's record is ever read; killed past killMs. */
export function runCheck(root = ROOT, cwd = process.cwd(), killMs = TRY_MS) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quote-speed-"));
    const file = path.join(dir, "run.json");
    try {
      let killed = false;
      const status = await new Promise((resolve) => {
        const c = spawn(process.execPath, [realpathSync(path.join(root, CHECK)), "--record", file], { cwd, stdio: "inherit" });
        const t = setTimeout(() => {
          killed = true;
          c.kill("SIGKILL");
        }, killMs);
        c.on("error", () => resolve(127));
        c.on("close", (code) => {
          clearTimeout(t);
          resolve(code ?? 128);
        });
      });
      if (killed) return { status, record: null, killed };
      let record = null;
      try {
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      return { status, record };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const all = args.length === 1 && args[0] === "--all";
    if (!all && args.length !== 2) throw new Error("usage: quote-speed.mjs <base> <head> | --all");
    const files = all ? [] : changedFiles(args[0], args[1]);
    let check = null;
    const lazy = (record) => check(record);
    const runTry = runCheck();
    process.exit(
      await gate({
        files,
        all,
        check: lazy,
        runTry: async (i) => {
          if (check === null) {
            linkKit();
            // CHECK, as a static path (kit-reach refuses an import it cannot read); loaded once the kit is linked
            ({ check } = await import("../live-checks/evm-quote-warm-round.mjs"));
          }
          return runTry(i);
        },
      }),
    );
  } catch (e) {
    console.log(`quote-speed: ERROR ${e?.message ?? e}`);
    process.exit(2);
  }
}
