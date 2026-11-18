#!/usr/bin/env node
// blindfill-exit (card exit-with-only-the-words): the exit command on a terminal. ./cli.ts holds the run; this file
// gives it the real prompts and the chains this build carries, each on its release's two public RPCs on mainnet.
//   node packages/exit/src/bin.ts [--chains near,solana]
import { createInterface } from "node:readline";
import { EXIT_NETWORKS } from "./rpc.ts";
import { InputClosed, runCli, type CliIo } from "./cli.ts";
import { nearExit } from "./near-out.ts";
import { solExit } from "./sol-out.ts";
import { EXIT_SOL_CLUSTERS } from "./sol-rpc.ts";

/** One line from the terminal with nothing echoed (raw mode). Ctrl-C ends the run; ^D on an empty line, or the terminal
 *  gone, is the input closed (InputClosed). */
function hidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  return new Promise((done, fail) => {
    let got = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = (): void => {
      input.setRawMode(false);
      input.pause();
      input.off("data", on);
      input.off("end", ended);
      process.stderr.write("\n");
    };
    const ended = (): void => {
      finish();
      fail(new InputClosed());
    };
    const on = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u0004" && got === "") return ended();
        if (ch === "\r" || ch === "\n") {
          finish();
          return done(got);
        }
        got = ch === "\u007f" || ch === "\b" ? got.slice(0, -1) : got + ch;
      }
    };
    input.on("data", on);
    input.once("end", ended);
  });
}

/** One echoed line. Once the input has ended, a prompt with no line left rejects with InputClosed: never an empty
 *  answer, and never a wait no line can end (card exit-refuses-when-the-words-never-come). */
let rl: ReturnType<typeof createInterface> | null = null;
let queued: string[] = [];
let waiting: { ok: (s: string) => void; fail: (e: Error) => void } | null = null;
let ended = false;
function line(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  if (rl === null && !ended) {
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => (waiting ? (waiting.ok(l), (waiting = null)) : queued.push(l)));
    rl.on("close", () => {
      ended = true;
      // the prompt's line ends here, so what the command says next starts on its own
      if (waiting) process.stderr.write("\n");
      waiting?.fail(new InputClosed());
      waiting = null;
    });
  }
  if (queued.length) return Promise.resolve(queued.shift()!);
  if (ended) {
    process.stderr.write("\n");
    return Promise.reject(new InputClosed());
  }
  return new Promise((ok, fail) => (waiting = { ok, fail }));
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
    solana: { run: solExit, rpcs: [...EXIT_SOL_CLUSTERS.mainnet.rpcs] as [string, string], asks: "a Solana address" },
  },
};
runCli(io).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`exit stopped: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
