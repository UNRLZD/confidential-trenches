// The exit command (card exit-with-only-the-words; Blindfill v2 lite paper §5: "The helper can only refuse. If it does,
// any other sender, or the phone itself, can send."): money out of the vault and the pools with only the 12 words and
// public RPCs, on mainnet unless told otherwise.
//
// - The words: read from a hidden prompt only (no echo on a terminal; a pipe's first line otherwise), never from the
//   command line or the environment: argv is in the shell's history and in every process listing, the environment in
//   every child's. Any word on the command line that is not one of the flags below refuses the run before anything is
//   read. They become seed64 by the wallet's own rule (./scan.ts withSeed64: the BIP-39 checksum, NFKD, 12 words), and
//   seed64 is zeroed once every chain has run, on every path.
// - The chains: --chains near,solana,base,robinhood (default: every chain this build carries), each run through its
//   ExitChain (./chain.ts) one after another, each with its own payout address, typed at a visible prompt, and its own
//   pair of public RPCs. A chain that stops is said, and the next chain still runs.
import { withSeed64 } from "./scan.ts";
import type { ExitChain, ExitResult } from "./chain.ts";

export type ChainName = ExitResult["chain"];
export const CHAIN_NAMES: readonly ChainName[] = Object.freeze(["near", "solana", "base", "robinhood"]);

/** One chain the command can run: its ExitChain, its default RPC pair, and what the user types as its payout address. */
export type ChainEntry = { run: ExitChain; rpcs: [string, string]; asks: string };

/** What the command runs on: the prompts, the line writer and the chains it carries. Tests give their own. */
export type CliIo = {
  argv: readonly string[];
  /** a prompt whose answer is not echoed */
  hidden(prompt: string): Promise<string>;
  /** a prompt whose answer is echoed */
  line(prompt: string): Promise<string>;
  say(line: string): void;
  chains: Partial<Record<ChainName, ChainEntry>>;
};

export class CliRefused extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CliRefused";
  }
}

const USAGE = "usage: blindfill-exit [--chains near,solana,base,robinhood]  (the 12 words are asked at a hidden prompt, never taken from the command line)";

/** The chains argv asks for, or a refusal: only --chains <list> (or --chains=<list>) and --help are taken. */
export function parseArgs(argv: readonly string[], carried: readonly ChainName[]): { chains: ChainName[] } | { help: true } {
  let chains: ChainName[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return { help: true };
    let list: string | undefined;
    if (a === "--chains") list = argv[++i];
    else if (a.startsWith("--chains=")) list = a.slice("--chains=".length);
    // never echo an unknown argument: it may be the words
    else throw new CliRefused(`argument ${i + 1} is not --chains: the 12 words are never taken from the command line. ${USAGE}`);
    if (list === undefined || list === "" || chains !== null) throw new CliRefused(USAGE);
    chains = [];
    for (const c of list.split(",")) {
      if (!(CHAIN_NAMES as readonly string[]).includes(c)) throw new CliRefused(`--chains: ${JSON.stringify(c.slice(0, 20))} is not one of ${CHAIN_NAMES.join(", ")}`);
      if (!carried.includes(c as ChainName)) throw new CliRefused(`--chains: this build has no exit for ${c} yet (it carries ${carried.join(", ")})`);
      if (!chains.includes(c as ChainName)) chains.push(c as ChainName);
    }
  }
  return { chains: chains ?? [...carried] };
}

/** The run: exit code 0 when every chain asked for ran to its end, 1 when one stopped, 2 on a refusal before any read. */
export async function runCli(io: CliIo): Promise<number> {
  const carried = CHAIN_NAMES.filter((c) => io.chains[c] !== undefined);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(io.argv, carried);
  } catch (e) {
    io.say(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if ("help" in parsed) {
    io.say(USAGE);
    return 0;
  }
  // every payout address first, so nothing waits on the user once money moves
  const to = new Map<ChainName, string>();
  for (const c of parsed.chains) to.set(c, (await io.line(`Pay ${c} out to (${io.chains[c]!.asks}): `)).trim());
  const words = await io.hidden("The 12 words (hidden): ");
  let failed = false;
  try {
    await withSeed64(words, async (seed) => {
      for (const c of parsed.chains) {
        const entry = io.chains[c]!;
        const say = (l: string) => io.say(`${c}: ${l}`);
        try {
          const r = await entry.run({ seed, to: to.get(c)!, rpcs: [...entry.rpcs], say });
          say(`done: sent ${r.sent}, left ${r.left}${r.txs.length ? `, txs ${r.txs.join(" ")}` : ""}`);
        } catch (e) {
          failed = true;
          say(`stopped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
  } catch (e) {
    // the words' own refusal (not 12 BIP-39 words): never echo them
    io.say(`the words are refused: ${e instanceof Error ? e.name : "not 12 words"}`);
    return 2;
  }
  return failed ? 1 : 0;
}
