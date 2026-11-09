#!/usr/bin/env node
// Live check of card exit-pool-notes: with our servers off, the exit tool restores the Solana pool's notes from the 12
// words on public RPCs alone. It runs the tool's own live read (packages/exit/scripts/sol-live.ts) as its own process,
// as a user runs the tool: a file outside packages/ may import only the kit's public entry. For each cluster's deployed
// pool (devnet and mainnet, packages/exit/src/sol-rpc.ts EXIT_SOL_CLUSTERS) the tool scans with the wallet's A.8 test
// words (public, holding nothing) on the release's lister and two RPCs, and the check passes when:
//   - the lister (getProgramAccounts) listed the marks, and the two RPCs read every listed mark and every page by address
//     (getMultipleAccounts) with the same bytes, at or past the lister's slot;
//   - the pages, read on both RPCs, count exactly the listed deposits and releases (the scan's leaf count), so no mark
//     is hidden;
//   - getProgramAccounts went to the lister alone, every other call was getMultipleAccounts, and no request went to a
//     host but the cluster's.
//   node scripts/live-checks/exit-pool-notes.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay.
// Runs: once, the exit tool's read of the deployed Solana pools on public RPCs; no host deploy changes it
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const KEY = "exit-pool-notes";
const TOOL = fileURLToPath(new URL("../../packages/exit/scripts/sol-live.ts", import.meta.url));

/** Runs the tool's live read with `args`; { ok, lines, code }: ok only on exit 0 with its last line PASS. */
export function check(args = []) {
  return new Promise((done) => {
    execFile(process.execPath, ["--import", fileURLToPath(new URL("../net-window.mjs", import.meta.url)), TOOL, ...args], { timeout: 600_000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      const lines = stdout.split("\n").filter(Boolean);
      const code = err ? (typeof err.code === "number" ? err.code : 2) : 0;
      if (stderr.trim()) lines.push(...stderr.trim().split("\n").map((l) => `FAIL ${l}`));
      done({ ok: code === 0 && lines.at(-1) === "PASS", lines, code });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await check(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
  process.exit(r.ok ? 0 : r.code === 1 ? 1 : 2);
}
