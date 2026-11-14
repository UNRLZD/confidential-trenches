// Card exit-with-only-the-words: the exit command (src/cli.ts runCli) for the vault's sandbox test
// (contracts/vault/tests/exit_words.rs): the same run as src/bin.ts, its NEAR chain the same nearExitWith, but its two
// RPCs, NAMED as the mainnet release pair (EXIT_NETWORKS.mainnet.rpcs) so every pair check holds, both read the
// near-sandbox at the loopback URL given as the one argument. Everything else is the command's own: the payout account
// and the 12 words read from stdin lines (a pipe, as the bin reads one), the scan, the fee wait, the proof on the
// hash-checked setup files, the sends.
//   node packages/exit/test/exit-cli.ts http://127.0.0.1:<port>     stdin: "<typed NEAR account>\n<the 12 words>\n"
// Lines go to stderr as the bin's do; exit code as runCli's.
//   node packages/exit/test/exit-cli.ts --ids      prints {"vault", "token"} of the release and nothing else
import { createInterface } from "node:readline";
import { entropyToWords, moveOutRpc, noteSecrets, wordsToSeed64, type MoveOutRpc } from "@blindfill/kit/core";
import type { VaultSyncRpc } from "@blindfill/kit";
import { runCli } from "../src/cli.ts";
import { nearExitWith } from "../src/near-out.ts";
import { EXIT_NETWORKS, exitRpc } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";

const arg = process.argv[2];
if (arg === "--ids") {
  console.log(JSON.stringify({ vault: EXIT_NETWORKS.mainnet.vault, token: EXIT_TOKENS.mainnet }));
  process.exit(0);
}
if (arg === "--precommitment") {
  // the all-zero vector's deposit note (scope, 0): the note a deposit on lane 0 makes, which the restore finds
  const scope = BigInt(process.argv[3] ?? "x");
  const seed64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
  console.log(JSON.stringify({ precommitment: noteSecrets(seed64, { kind: "deposit", s: scope, i: 0 }).precommitment.toString() }));
  process.exit(0);
}
const url = new URL(arg ?? "");
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("exit-cli: a loopback http URL (the sandbox), never a real network");
// every request, whatever address it names, goes to the sandbox
const toSandbox: typeof fetch = (_input, init) => fetch(url.href, init);
const pair = EXIT_NETWORKS.mainnet.rpcs;
const rpcs = pair.map((name) => exitRpc(name, toSandbox)) as unknown as readonly [VaultSyncRpc, VaultSyncRpc];
const moveRpcs = pair.map((name): MoveOutRpc => ({ ...moveOutRpc(url.href, toSandbox), name })) as unknown as readonly [MoveOutRpc, MoveOutRpc];

const lines: string[] = [];
const waiting: ((s: string) => void)[] = [];
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
rl.on("close", () => waiting.splice(0).forEach((w) => w("")));
const next = (prompt: string) => {
  process.stderr.write(`${prompt}\n`);
  return lines.length ? Promise.resolve(lines.shift()!) : new Promise<string>((ok) => waiting.push(ok));
};

const code = await runCli({
  argv: [],
  hidden: next,
  line: next,
  say: (l) => process.stderr.write(`${l}\n`),
  chains: { near: { run: nearExitWith({ rpcs, moveRpcs, sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 5_000))) }), rpcs: [...pair] as [string, string], asks: "a NEAR account" } },
});
process.exit(code);
