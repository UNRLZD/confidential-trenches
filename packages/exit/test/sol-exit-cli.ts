// Card exit-with-only-the-words: the exit command (src/cli.ts runCli) for the Solana pool's run on a local copy of
// mainnet (scripts/sol-exit-copy.mjs): the same run as src/bin.ts, its Solana chain the same solExitWith, but its two
// RPCs, NAMED as the mainnet release pair (EXIT_SOL_CLUSTERS.mainnet.rpcs) so every pair check holds, both read the
// solana-test-validator at the loopback URL given as the one argument; the restore lists its marks on that copy too
// (the release's lister is mainnet's). Everything else is the command's own: the payout address and the 12 words read
// from stdin lines, the scan, the fee wait, the proof on the hash-checked setup files, the sends.
//   node packages/exit/test/sol-exit-cli.ts http://127.0.0.1:<port>     stdin: "<typed Solana address>\n<the 12 words>\n"
// Lines go to stderr as the bin's do; exit code as runCli's.
import { createInterface } from "node:readline";
import { RESTORE_GAP, solanaRestoreNotes } from "@blindfill/kit/core";
import type { SolanaRpc } from "@blindfill/kit";
import { runCli } from "../src/cli.ts";
import { solExitWith } from "../src/sol-out.ts";
import { EXIT_SOL_CLUSTERS, exitSolRpc } from "../src/sol-rpc.ts";

const url = new URL(process.argv[2] ?? "");
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("sol-exit-cli: a loopback http URL (the copy), never a real network");
// every request, whatever address it names, goes to the copy
const toCopy: typeof fetch = (_input, init) => fetch(url.href, init);
const pair = EXIT_SOL_CLUSTERS.mainnet.rpcs;
const rpcs = pair.map((name) => exitSolRpc(name, toCopy)) as unknown as readonly [SolanaRpc, SolanaRpc];

const lines: string[] = [];
const waiting: ((s: string) => void)[] = [];
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
rl.on("close", () => waiting.splice(0).forEach((w) => w("")));
const next = (prompt: string) => {
  process.stderr.write(`${prompt}\n`);
  return lines.length ? Promise.resolve(lines.shift()!) : new Promise<string>((ok) => waiting.push(ok));
};

const run = solExitWith({
  rpcs,
  scan: (seed64, _cluster, r) => solanaRestoreNotes({ seed64, program: EXIT_SOL_CLUSTERS.mainnet.program, rpcs: r, lister: r[0], gap: RESTORE_GAP }),
  sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 2_000))),
});
const code = await runCli({
  argv: [],
  hidden: next,
  line: next,
  say: (l) => process.stderr.write(`${l}\n`),
  chains: { solana: { run, rpcs: [...pair] as [string, string], asks: "a Solana address" } },
});
process.exit(code);
