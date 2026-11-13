#!/usr/bin/env node
// blindfill-exit (card exit-with-only-the-words): the exit command on a terminal. ./cli.ts holds the run; this file
// gives it the real prompts and the chains this build carries, each on its release's two public RPCs on mainnet.
//   node packages/exit/src/bin.ts [--chains near]
import { createInterface } from "node:readline";
import { EXIT_NETWORKS } from "./rpc.ts";
import { runCli, type CliIo } from "./cli.ts";
import { nearExit } from "./near-out.ts";

/** One line from the terminal with nothing echoed (raw mode). Ctrl-C ends the run. */
function hidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  return new Promise((done) => {
    let got = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const on = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", on);
          process.stderr.write("\n");
          return done(got);
        }
        got = ch === "\u007f" || ch === "\b" ? got.slice(0, -1) : got + ch;
      }
    };
    input.on("data", on);
  });
}

/** One echoed line. */
let rl: ReturnType<typeof createInterface> | null = null;
let queued: string[] = [];
let waiting: ((s: string) => void) | null = null;
function line(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  if (rl === null) {
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : queued.push(l)));
    rl.on("close", () => waiting?.(""));
  }
  if (queued.length) return Promise.resolve(queued.shift()!);
  return new Promise((ok) => (waiting = ok));
}

const io: CliIo = {
  argv: process.argv.slice(2),
  hidden: async (p) => {
    // the pipe's lines are read by one reader: the words are its next line
    if (!process.stdin.isTTY) return line(p);
    rl?.close();
    rl = null;
    queued = [];
    return hidden(p);
  },
  line,
  say: (l) => process.stderr.write(`${l}\n`),
  chains: {
    near: { run: nearExit, rpcs: [...EXIT_NETWORKS.mainnet.rpcs] as [string, string], asks: "a NEAR account, such as you.near" },
  },
};
runCli(io).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`exit stopped: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
