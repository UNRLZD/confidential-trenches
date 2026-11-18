#!/usr/bin/env node
// The unplug drill (card vault-drill-script; vault paper V4.4 and VT-R03, docs/plan1/vault.md at research 28b2f3c
// l.1154 and l.1233): every server of ours off, money out of Blindfill with only the 12 words on another device, and a
// record the money gate reads.
//   node scripts/drill/unplug.mjs --out <record.md> [--key <card>] [--chains near,solana]     the real drill
//   node scripts/drill/unplug.mjs --dry <answers.json> [--out <record.md>] [--key <card>]     a dry run on recorded answers
//   node scripts/drill/unplug.mjs --dry <run.json> --record-reads <reads.json>                 records the read back's answers once
// The drill writes no withdrawal of its own: it runs the exit tool's own command (packages/exit/src/bin.ts, card
// exit-with-only-the-words), which asks the payout address and the 12 words at its own prompts, typed by the person
// running the drill (the owner, on the mainnet drill), proves on this machine and sends every transaction itself. The
// drill never reads, holds or passes the words: the exit's stdin is the terminal's. A dry run sends nothing and reads
// only its recorded answers.
// The steps, each read back and written in the record:
//   1. servers off: the exit runs under ./net-guard.mjs, which refuses every request to a host of ours (the helper,
//      APP_HOST, SIGN_HOST and the setup mirror on it: all of unrealized.trade) and writes every request down; the step
//      passes when the exit asked none of ours.
//   2. the exit: its exit code, and each chain's last line (done, or stopped and why).
//   3. what was sent: each tx line the exit printed, as the chain names it; on NEAR each with its signer (a one-use
//      account A of the words), A's close (its DeleteAccount, whose gas refund to the deleted A fails by design) written
//      as a Deleted line, not a Tx line, as scripts/ci/money-gate.mjs reads a swept one-use account. The txs a chain's
//      done or stopped line lists must be exactly the ones its tx lines named.
//   4. read back: the record's Tx and Deleted lines read by the money gate itself (moneyGate: each tx succeeded on two
//      public RPCs of two operators, each Deleted account gone on two).
// The record: "CARD <key> / live: PASS|FAIL", "Money path: yes", one "Tx: <chain> <id> [<signer>]" line per
// transaction and one "Deleted: near <A>" per closed A, then one "Step <n> <name>: ok|FAIL <what was read>" line per
// step and one "Request: <url> ours|public" per request the exit made. PASS only when every step is ok.
import "../net-window.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { moneyGate, parseLive, RPCS } from "../ci/money-gate.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const GUARD = fileURLToPath(new URL("./net-guard.mjs", import.meta.url));
export const EXIT_BIN = `${ROOT}/packages/exit/src/bin.ts`;
const CHAINS = ["near", "solana", "base", "robinhood"];

/**
 * The exit's lines as the drill reads them: per chain, every tx it sent (NEAR's with its signer), the A accounts it
 * closed, its done or stopped line, and every line that could not be read as the exit prints it.
 */
export function parseExit(lines) {
  const txs = [];
  const deleted = [];
  const ends = new Map(); // chain -> { done: bool, why, listed: string[] | null }
  const named = new Map(); // chain -> every tx id its tx lines named, closes included
  const problems = [];
  const add = (chain, id) => named.set(chain, [...(named.get(chain) ?? []), id]);
  for (const raw of lines) {
    const m = raw.match(/^(near|solana|base|robinhood): (.*)$/);
    if (!m) continue;
    const [, chain, l] = m;
    const done = l.match(/^done: sent (\d+), left (\d+)(?:, txs (.+))?$/);
    if (done) {
      ends.set(chain, { done: true, why: `sent ${done[1]}, left ${done[2]}`, listed: done[3] ? done[3].split(" ") : [] });
      continue;
    }
    if (l.startsWith("stopped: ")) {
      const so = l.match(/\(txs so far: ([^)]*)\)/);
      ends.set(chain, { done: false, why: l.slice("stopped: ".length), listed: so ? (so[1] === "none" ? [] : so[1].split(" ")) : null });
      continue;
    }
    if (chain === "near") {
      const t = l.match(/^(withdraw|settle|close) tx (\S+) from (\S+)$/);
      if (t) {
        add(chain, t[2]);
        if (t[1] === "close") deleted.push({ chain, account: t[3], hash: t[2] });
        else txs.push({ chain, hash: t[2], signer: t[3], step: t[1] });
      } else if (/\btx\b/.test(l) && !/ failed: /.test(l)) problems.push(`near line not read as the exit prints a tx: ${raw}`);
      continue;
    }
    const t = l.match(/: tx (\S+)$/);
    if (t) {
      add(chain, t[1]);
      txs.push({ chain, hash: t[1], step: l.slice(0, l.indexOf(":")) });
    }
  }
  for (const [chain, end] of ends) {
    if (end.listed === null) continue;
    const a = [...(named.get(chain) ?? [])].sort().join(" ");
    const b = [...end.listed].sort().join(" ");
    if (a !== b) problems.push(`${chain}: its tx lines name ${a || "none"}, its ${end.done ? "done" : "stopped"} line lists ${b || "none"}`);
  }
  return { txs, deleted, ends, problems };
}

/** The guard's log: one { url, ours } per request, in order. */
export function parseRequests(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l);
      if (typeof r?.url !== "string" || typeof r?.ours !== "boolean") throw new Error(`a request log line is not { url, ours }: ${l.slice(0, 120)}`);
      return r;
    });
}

/** The record's text from a run's reads; `read` is the money gate's read back of the Tx and Deleted lines, or null before it. */
export function drillRecord({ key, chains, code, exit, requests, read }) {
  const steps = [];
  const ours = requests.filter((r) => r.ours);
  steps.push(["servers off", ours.length === 0 && requests.length > 0, ours.length ? `${ours.length} request(s) to a host of ours, refused: ${[...new Set(ours.map((r) => r.url))].join(", ")}` : `${requests.length} request(s), none to a host of ours`]);
  const missing = chains.filter((c) => !exit.ends.has(c));
  const stopped = [...exit.ends].filter(([, e]) => !e.done);
  const exitOk = code === 0 && missing.length === 0 && stopped.length === 0;
  steps.push(["the exit", exitOk, [`exit code ${code}`, ...chains.map((c) => (exit.ends.has(c) ? `${c} ${exit.ends.get(c).done ? "done" : "stopped"}: ${exit.ends.get(c).why}` : `${c} never ended`))].join("; ")]);
  steps.push(["what was sent", exit.problems.length === 0 && exit.txs.length > 0, exit.problems.length ? exit.problems.join("; ") : `${exit.txs.length} sent, ${exit.deleted.length} one-use account(s) closed`]);
  if (read !== null) steps.push(["read back", read.refusals.length === 0, read.refusals.length ? read.refusals.join("; ") : `${read.read.length} read(s) ok, ${read.proven.length} proven, ${read.gone.length} account(s) gone`]);
  const pass = read !== null && steps.every(([, ok]) => ok);
  return [
    `CARD ${key} / live: ${pass ? "PASS" : "FAIL"}`,
    "Money path: yes",
    ...exit.txs.map((t) => `Tx: ${t.chain} ${t.hash}${t.signer ? ` ${t.signer}` : ""}`),
    ...exit.deleted.map((d) => `Deleted: ${d.chain} ${d.account}`),
    "",
    "The unplug drill (scripts/drill/unplug.mjs): the exit tool's own command with every server of ours off, the 12 words typed at its hidden prompt.",
    ...steps.map(([name, ok, what], i) => `Step ${i + 1} ${name}: ${ok ? "ok" : "FAIL"} ${what}`),
    ...requests.map((r) => `Request: ${r.url} ${r.ours ? "ours" : "public"}`),
    "",
  ].join("\n");
}

/** Steps 3 to 4 on a finished run: the record, its parse by the money gate's own parser, then its read back. */
export async function finish({ key, chains, code, lines, requests, fetchFn = fetch, rpcs = RPCS, sleep }) {
  const exit = parseExit(lines);
  const first = drillRecord({ key, chains, code, exit, requests, read: null });
  const live = parseLive(first, key);
  const parsed = { refusals: live.problems.map((p) => `the record does not parse: ${p}`), read: [], proven: [], gone: [] };
  const read = parsed.refusals.length ? parsed : await moneyGate([{ path: `drill/${key}.md`, key, text: first }], fetchFn, rpcs, sleep ? { sleep } : {});
  const text = drillRecord({ key, chains, code, exit, requests, read });
  return { text, pass: text.startsWith(`CARD ${key} / live: PASS`) };
}

/** A fetch that answers only from recorded reads, by URL and body; any other request is refused (a dry run never reaches a network). */
export function replayFetch(reads) {
  const book = new Map(reads.map(([url, body, status, text]) => [`${url}\n${body}`, { status, text }]));
  return async (url, init = {}) => {
    const got = book.get(`${url}\n${init.body ?? ""}`);
    if (!got) throw new Error(`not recorded: ${url} ${String(init.body ?? "").slice(0, 200)}`);
    return new Response(got.text, { status: got.status, headers: { "content-type": "application/json" } });
  };
}

/**
 * Recorded reads as committed: every 64-byte ed25519 value (block and chunk signatures, approvals, a tx's signature) cut
 * to "ed25519:1". Each is public, and none is read by the read back (the money gate's tx, proof and gone reads), but it
 * has a NEAR secret key's shape, which gitleaks refuses anywhere in the tree or its history.
 */
export const cutKeyShaped = (reads) => reads.map(([url, body, status, text]) => [url, body, status, text.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}/g, "ed25519:1")]);

/** A fetch that records what `fetchFn` answers, for --record-reads. */
export function recordingFetch(reads, fetchFn = fetch) {
  return async (url, init = {}) => {
    const r = await fetchFn(url, init);
    const text = await r.text();
    reads.push([String(url), String(init.body ?? ""), r.status, text]);
    return new Response(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  };
}

/** The real drill's run: the exit's command under the guard, the terminal its stdin, its lines shown and kept. */
async function runExit(chains) {
  const dir = mkdtempSync(`${tmpdir()}/unplug-`);
  const log = `${dir}/requests.jsonl`;
  writeFileSync(log, "");
  try {
    const lines = [];
    const code = await new Promise((done, fail) => {
      const child = spawn(process.execPath, ["--import", GUARD, EXIT_BIN, "--chains", chains.join(",")], {
        cwd: ROOT,
        stdio: ["inherit", "inherit", "pipe"],
        env: { ...process.env, DRILL_HOSTS: log },
      });
      let rest = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (s) => {
        process.stderr.write(s);
        rest += s;
        const parts = rest.split("\n");
        rest = parts.pop();
        lines.push(...parts);
      });
      child.on("error", fail);
      child.on("close", (c) => {
        if (rest) lines.push(rest);
        done(c ?? 1);
      });
    });
    return { code, lines, requests: parseRequests(readFileSync(log, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function args(argv) {
  const o = { key: "unplug-drill", chains: ["near"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === "--out") o.out = v();
    else if (a === "--key") o.key = v();
    else if (a === "--dry") o.dry = v();
    else if (a === "--record-reads") o.recordReads = v();
    else if (a === "--chains") o.chains = v().split(",");
    // never echo an unknown argument: it may be the words
    else throw new Error(`argument ${i + 1} is not one of --out, --key, --dry, --record-reads, --chains: the 12 words are typed at the exit's own prompt, never given here`);
  }
  if (!/^[a-z0-9-]+$/.test(o.key)) throw new Error("--key: lowercase letters, digits and hyphens");
  for (const c of o.chains) if (!CHAINS.includes(c)) throw new Error(`--chains: ${JSON.stringify(c.slice(0, 20))} is not one of ${CHAINS.join(", ")}`);
  if (!o.dry && !o.out) throw new Error("the real drill needs --out <record.md>");
  return o;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try {
    o = args(process.argv.slice(2));
  } catch (e) {
    console.error(`unplug: ${e.message}`);
    process.exit(2);
  }
  let run;
  let fetchFn = fetch;
  const reads = [];
  if (o.dry) {
    const a = JSON.parse(readFileSync(o.dry, "utf8"));
    run = { code: a.exit.code, lines: a.exit.lines, requests: a.requests };
    o.chains = a.chains;
    // a dry run reads only its recorded answers; --record-reads with none recorded reads the public RPCs once to record them
    if (a.reads) fetchFn = replayFetch(a.reads);
    else if (!o.recordReads) {
      console.error("unplug: the answers file holds no recorded reads (record them with --record-reads <file>)");
      process.exit(2);
    }
  } else run = await runExit(o.chains);
  if (o.recordReads) fetchFn = recordingFetch(reads, fetchFn);
  // a replay has no rate limit to wait out
  const { text, pass } = await finish({ key: o.key, chains: o.chains, ...run, fetchFn, ...(o.dry && !o.recordReads ? { sleep: async () => {} } : {}) });
  if (o.recordReads) writeFileSync(o.recordReads, `${JSON.stringify(cutKeyShaped(reads), null, 1)}\n`);
  if (o.out) writeFileSync(o.out, text);
  process.stdout.write(text);
  process.exit(pass ? 0 : 1);
}
