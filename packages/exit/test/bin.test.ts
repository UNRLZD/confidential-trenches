// Card exit-refuses-when-the-words-never-come: the exit command (src/bin.ts) as a user runs it, its input closed before
// the 12 words are read (a script's pipe, a broken terminal): it refuses with exit code 2 and one plain line saying no
// words were read, never exit code 0 with nothing said (found by the unplug drill's smoke, card vault-drill-script).
// No network: the run ends at the prompts, before any chain reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function run(input: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const c = spawn(process.execPath, [BIN, "--chains", "near"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.setEncoding("utf8");
    c.stderr.on("data", (d: string) => (stderr += d));
    c.on("close", (code) => done({ code, stderr }));
    c.stdin.end(input);
  });
}

const LINE = /^no words were read: the input closed before the 12 words were typed, so nothing was read or sent$/m;

test("stdin closed before any prompt: exit code 2 and one line saying no words were read", async () => {
  const r = await run("");
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, LINE);
});

test("stdin closed after the payout address, before the words: exit code 2 and the same line", async () => {
  const r = await run("you.near\n");
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, LINE);
  assert.equal(r.stderr.match(/no words were read/g)?.length, 1);
});

test("runCli: a reader's InputClosed is the refusal (code 2, the line, no chain run); any other reader fault is not taken for it", async () => {
  const { InputClosed, NO_WORDS, runCli } = await import("../src/cli.ts");
  const said: string[] = [];
  let ran = 0;
  const chains = { near: { run: async () => (ran++, { chain: "near" as const, txs: [], sent: "0", left: "0" }), rpcs: ["a", "b"] as [string, string], asks: "x" } };
  const closed = { argv: [], line: async () => "you.near", hidden: async () => Promise.reject(new InputClosed()), say: (l: string) => said.push(l), chains };
  assert.equal(await runCli(closed), 2);
  assert.deepEqual(said, [NO_WORDS]);
  assert.equal(ran, 0);
  await assert.rejects(runCli({ ...closed, hidden: async () => Promise.reject(new Error("tty lost")) }), /tty lost/);
});
