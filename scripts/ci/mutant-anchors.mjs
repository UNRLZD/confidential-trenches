#!/usr/bin/env node
// Card mutants-anchor-exactly-once: every mutant of the sweeps changes the code it names. A sweep plants a mutant by
// replacing its anchor, a piece of the source's text, which must be found in that file exactly once; one found zero
// times (the code moved or changed under it) is skipped, or stops the sweep, and a kill rate is read on code no mutant
// changed; one found twice plants the first place only. This gate reads every mutant of every sweep file, without
// running a test or writing a source, and refuses each anchor found zero times or more than once, naming the mutant
// and the file.
//   node scripts/ci/mutant-anchors.mjs [root]      (exit 1 and one line per refusal)
// The sweep files: every tracked *-mutants.mjs and mutants.mjs (MUTANT_FILE); each has an entry in SWEEPS below, which
// reads its list as its own runner does (where it plants, in which file, one edit after another or each on the
// source as it is). A sweep file with no entry is refused, so a new sweep is read from its first commit.
// Each list is read by evaluating its file's text up to the list's end (imports and the constants above it, never the
// runner), from a copy beside it that is removed at once.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSync } from "../group-run.mjs";

export const MUTANT_FILE = /(^|\/)([\w.-]+-)?mutants\.mjs$/;

const W = (rel) => (root) => path.join(root, rel);

/**
 * Per sweep file: `list`, the name of its mutant list; `vars`, the other names the reader needs from the same text;
 * `read(entry, g, root)`, each plant of an entry: { name, file (absolute), finds: anchors, seq: each anchor's
 * replacement when the runner reads each anchor in the text the previous ones planted, as it plants them }.
 */
export const SWEEPS = {
  "apps/helper/test/pool-evm/release-mutants.mjs": { list: "MUTANTS", read: ([file, find, , t], _g, r) => [{ name: `${t ?? ""} ${find}`, file: path.join(r, "apps/helper", file), finds: [find] }] },
  "apps/helper/test/pool-evm/sell-mutants.mjs": { list: "MUTANTS", read: ([file, find, , t], _g, r) => [{ name: `${t ?? ""} ${find}`, file: path.join(r, "apps/helper", file), finds: [find] }] },
  "contracts/pool-evm/test/mutants.mjs": { list: "MUTANTS", read: ([file, find, , t], _g, r) => [{ name: `${t} ${find}`, file: path.join(r, "contracts/pool-evm", file), finds: [find] }] },
  "contracts/pool-solana/scripts/mutants.mjs": {
    list: "MUTANTS",
    read: ([name, file, from, , , extra], _g, r) => [{ name, file: path.join(r, "contracts/pool-solana", file), finds: [from] }, ...(extra ? [{ name: `${name} (its second edit)`, file: path.join(r, "contracts/pool-solana", extra[0]), finds: [extra[1]] }] : [])],
  },
  "packages/kit/test/evm-pool-buy-mutants.mjs": { list: "MUTANTS", vars: ["SRC"], read: ([find, , t], g) => [{ name: `${t} ${find}`, file: g.SRC, finds: [find] }] },
  "packages/kit/test/evm-pool-index-mutants.mjs": { list: "MUTANTS", vars: ["SRC"], read: ([find, , t], g) => [{ name: `${t} ${find}`, file: g.SRC, finds: [find] }] },
  "packages/kit/test/evm-pool-sell-mutants.mjs": { list: "MUTANTS", read: ([file, find, , t]) => [{ name: `${t} ${find}`, file, finds: [find] }] },
  "packages/kit/test/evm-quote-mutants.mjs": { list: "MUTANTS", read: ([file, find, , , t], _g, r) => [{ name: `${t} ${find}`, file: path.join(r, "packages/kit", file), finds: [find] }] },
  "packages/kit/test/pool-usd-mutants.mjs": { list: "MUTANTS", read: ([file, find, , t]) => [{ name: `${t} ${find}`, file, finds: [find] }] },
  "packages/kit/test/near-rhea-mutants.mjs": { list: "M", read: ([name, from], _g, r) => [{ name, file: path.join(r, "packages/kit/src/near/rhea.ts"), finds: [from] }] },
  "packages/kit/test/near-swap-mutants.mjs": { list: "M", read: ([name, from], _g, r) => [{ name, file: path.join(r, "packages/kit/src/trade/near/swap.ts"), finds: Array.isArray(from) ? from : [from] }] },
  "packages/kit/test/pool-deposit-mutants.mjs": { list: "M", read: ([name, from], _g, r) => [{ name, file: path.join(r, "packages/kit/src/trade/solana/pool-deposit.ts"), finds: [from] }] },
  "packages/kit/test/vault-settle-mutants.mjs": { list: "M", read: ([name, from], _g, r) => [{ name, file: path.join(r, "packages/kit/src/vault/settle.ts"), finds: [from] }] },
  "packages/signpage/scripts/held-mutants.mjs": { list: "M", read: ([name, file, , from]) => [{ name, file, finds: [from] }] },
  "packages/signpage/scripts/rent-back-mutants.mjs": { list: "M", read: ([name, file, , from]) => [{ name, file, finds: Array.isArray(from) ? from.map(([f]) => f) : [from] }] },
  "packages/signpage/test/kit-version-mutants.mjs": { list: "MUTANTS", vars: ["FILES", "PKG"], read: ([k, text], g) => [{ name: `${k} ${text}`, file: `${g.PKG}${g.FILES[k]}`, finds: [text] }] },
  "packages/signpage/test/pool-deposit-mutants.mjs": { list: "MUTANTS", read: ([{ src }, edits, name], _g, r) => [{ name, file: path.join(r, "packages/signpage/src", src), finds: edits.map(([f]) => f), seq: edits.map(([, t]) => t) }] },
  "packages/signpage/test/pool-price-mutants.mjs": { list: "MUTANTS", vars: ["SRC"], read: ([text, , name], g) => [{ name: name ?? text, file: g.SRC, finds: [text] }] },
  "packages/signpage/test/rules-pool-mutants.mjs": { list: "MUTANTS", vars: ["POOL"], read: ([text, , name], g) => [{ name: `${name} ${text}`, file: g.POOL, finds: [text] }] },
  "packages/signpage/test/rules-refund-mutants.mjs": { list: "MUTANTS", vars: ["SRC"], read: ([text, , name], g) => [{ name: `${name} ${text}`, file: g.SRC, finds: [text] }] },
  "packages/wallet/scripts/exit-scan-mutants.mjs": { list: "M", read: ([name, reps], _g, r) => [{ name, file: path.join(r, "packages/wallet/src/notes/restore.ts"), finds: reps.map(([f]) => f) }] },
  "packages/wallet/scripts/held-moveout-mutants.mjs": {
    list: "ALL",
    read: ([file, , [name, ...pairs]]) => [{ name, file, finds: pairs.filter((_, k) => k % 2 === 0), seq: pairs.filter((_, k) => k % 2 === 1) }],
  },
  "packages/wallet/scripts/near-prepay-taken-mutants.mjs": { list: "M", read: ([name, file, find]) => [{ name, file, finds: [find] }] },
  "packages/wallet/scripts/note-restore-refund-mutants.mjs": { list: "M", vars: ["PICK"], once: true, read: ([name], g, r) => [{ name, file: path.join(r, "packages/wallet/src/notes/restore.ts"), finds: [g.PICK] }] },
  "packages/wallet/scripts/refund-move-mutants.mjs": { list: "M", vars: ["P"], read: ([name, file, edits], g) => [{ name, file: path.join(g.P, file), finds: edits.map(([f]) => f), seq: edits.map(([, t]) => t) }] },
  "packages/wallet/scripts/restore-wallets-mutants.mjs": { list: "M", vars: ["P"], read: ([name, file, edits], g) => [{ name, file: path.join(g.P, file), finds: edits.map(([f]) => f), seq: edits.map(([, t]) => t) }] },
};

/** Sweep files no sweep runs (no package's test:mutants names them, scripts/ci/test-shards.mjs mutantCommands, and no CI
 *  line): their plants change nothing a kill rate is read on, so they are not read here. Each is a removal to make, not
 *  a sweep (card mutant-sweep-no-orphans's). */
export const NOT_SWEPT = {
  "packages/wallet/scripts/pool-evm-restore-mutants.mjs": "no test:mutants or CI line runs it",
  "packages/wallet/scripts/pool-evm-sell-bans-mutants.mjs": "no test:mutants or CI line runs it",
  "packages/wallet/scripts/pool-solana-mutants.mjs": "no test:mutants or CI line runs it",
  "packages/wallet/scripts/pool-solana-review-mutants.mjs": "no test:mutants or CI line runs it",
};

/**
 * Stale plants left to the cards that change their file, each named by its anchor's first line as this gate prints it:
 * a listed anchor still stale passes; any other stale anchor in the file is refused, so no new one enters; a listed one
 * found once again is said, to be taken off the list. The kit's evm-quote sweep and evm-quote.ts are changed by cards
 * evm-unreachable-moves-on and evm-5xx-holds-the-provider-for-the-round, still on their branches (each re-anchors the
 * ask's, the scan's 5xx's and the transport's plants), so this card leaves that file to them.
 */
export const KNOWN_STALE = {
  "packages/kit/test/evm-quote-mutants.mjs": {
    why: "re-anchored on cards evm-unreachable-moves-on and evm-5xx-holds-the-provider-for-the-round, not on main yet",
    // SL1, T7b (three), TH9 and T7 (two): the plants those two branches re-anchor
    anchors: new Set([
      "if (spareNext && /^the provider answered HTTP 5",
      'if (e instanceof TypeError && (cause === undefined || (typeof code === "string" && CONNECT',
      "if (e instanceof Unreachable) {",
      "if (res.status === 429) throw new RateLimited(",
      "if (!(e instanceof RateLimited || e instanceof Unreachable) || i === 3) {",
    ]),
  },
};

/** The text of `file` up to the end of its `list` declaration, then an export of the list and `vars`. */
export function listModule(text, list, vars = []) {
  const head = new RegExp(`^(?:export )?const ${list} = \\[`, "m").exec(text);
  if (!head) throw new Error(`no "const ${list} = [" in it`);
  // the list's "];" on a line of its own, or, for a list declared on one line, that line's end
  const own = text.indexOf("\n];", head.index);
  const line = text.indexOf("\n", head.index);
  const end = /\];\s*$/.test(text.slice(head.index, line)) ? line - 2 : own;
  if (end < 0) throw new Error(`no "];" ends its ${list}`);
  return `${text.slice(0, end + 3)}\nexport const __ANCHORS = { list: ${list}${vars.map((v) => `, ${v}`).join("")} };\n`;
}

/** How many times `find` is in `text`. */
const count = (text, find) => (typeof find !== "string" || find === "" ? 0 : text.split(find).length - 1);

/** The refusals in one sweep's plants: one line per anchor not found exactly once. */
export function anchorRefusals(rel, plants, read = (f) => readFileSync(f, "utf8"), keyed = false) {
  const out = [];
  const push = (line, anchor) => out.push(keyed ? { line, anchor } : line);
  const texts = new Map();
  const textOf = (f) => (texts.has(f) ? texts.get(f) : (texts.set(f, read(f)), texts.get(f)));
  for (const { name, file, finds, seq } of plants) {
    let text;
    try {
      text = textOf(file);
    } catch {
      push(`${rel}: mutant ${JSON.stringify(short(name))}: its file ${file} cannot be read`, null);
      continue;
    }
    for (const [i, find] of finds.entries()) {
      const n = count(text, find);
      if (n !== 1) push(`${rel}: mutant ${JSON.stringify(short(name))}: its anchor is in ${path.basename(file)} ${n} times, not once: ${JSON.stringify(short(String(find)))}`, short(String(find)));
      // a sequential sweep plants each edit before it reads the next anchor, so the next is counted in the planted text
      else if (seq) text = text.replace(find, () => seq[i]);
    }
  }
  return out;
}

const short = (s) => s.split("\n")[0].trim().slice(0, 90);

/**
 * Each sweep file's list (and its `vars`), by repo path: { g: { list, ...vars } } or { error }. Each file's text up to
 * its list's end (listModule) is written to a copy beside it, so its own imports resolve, and the copies are evaluated
 * in one node child run through scripts/group-run.mjs, which prints them as JSON (a bigint as its digits); the copies
 * are removed at once. The child imports them, never this gate: a sweep file sits inside packages/ or contracts/,
 * which nothing outside them reaches but the kit's entry (scripts/ci/kit-reach.mjs), and the list's text alone is read
 * here. Evaluated as a module of its own (not the sweep's main), no sweep's runner part runs.
 */
export function readLists(root, rels) {
  const copies = [];
  const out = {};
  try {
    for (const rel of rels) {
      const abs = path.join(root, rel);
      const copy = path.join(path.dirname(abs), `.mutant-anchors-${process.pid}-${path.basename(abs)}`);
      try {
        writeFileSync(copy, listModule(readFileSync(abs, "utf8"), SWEEPS[rel].list, SWEEPS[rel].vars));
        copies.push([rel, pathToFileURL(copy).href, copy]);
      } catch (e) {
        out[rel] = { error: String(e?.message ?? e).split("\n")[0] };
      }
    }
    if (copies.length === 0) return out;
    const r = runSync(process.execPath, ["--input-type=module", "-e", CHILD], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MUTANT_ANCHOR_COPIES: JSON.stringify(copies.map(([rel, url]) => [rel, url])) },
      timeoutMs: 120_000,
    });
    if (r.status !== 0) throw new Error(`mutant-anchors: the lists' reader exited ${r.status}${r.timedOut ? " (timed out)" : ""}: ${String(r.stderr).split("\n").slice(0, 3).join(" ")}`);
    return { ...out, ...JSON.parse(r.stdout) };
  } finally {
    for (const [, , copy] of copies) rmSync(copy, { force: true });
  }
}

// the lists' reader: each copy imported in turn, its __ANCHORS printed; a copy that throws is named with its error
const CHILD = `
const out = {};
for (const [rel, url] of JSON.parse(process.env.MUTANT_ANCHOR_COPIES)) {
  try {
    out[rel] = { g: (await import(url)).__ANCHORS };
  } catch (e) {
    out[rel] = { error: String(e?.message ?? e).split("\\n")[0] };
  }
}
process.stdout.write(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
`;

/** Every sweep file's plants read and counted: { refusals, plants, files }. */
export async function mutantAnchors(root) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }).split("\0").filter((f) => MUTANT_FILE.test(f));
  const refusals = [];
  const listed = []; // stale plants KNOWN_STALE names
  const anchored = []; // KNOWN_STALE entries no longer stale
  let plants = 0;
  const swept = [];
  for (const rel of tracked) {
    if (Object.hasOwn(NOT_SWEPT, rel)) continue;
    if (!SWEEPS[rel]) refusals.push(`${rel}: a sweep file this gate has no reader for: add it to SWEEPS in scripts/ci/mutant-anchors.mjs`);
    else swept.push(rel);
  }
  const lists = readLists(root, swept);
  for (const rel of swept) {
    const sweep = SWEEPS[rel];
    const got = lists[rel];
    if (!got || "error" in got) {
      refusals.push(`${rel}: its mutant list cannot be read (${got?.error ?? "no answer for it"})`);
      continue;
    }
    const g = got.g;
    const entries = sweep.once ? g.list.slice(0, 1) : g.list;
    const mine = entries.flatMap((e) => sweep.read(e, g, root));
    plants += mine.length;
    const known = KNOWN_STALE[rel];
    const found = anchorRefusals(rel, mine, undefined, true);
    for (const r of found) {
      if (known?.anchors.has(r.anchor)) listed.push(r);
      else refusals.push(r.line);
    }
    if (known) for (const a of known.anchors) if (!found.some((r) => r.anchor === a)) anchored.push(`${rel}: ${JSON.stringify(a)} is found once now: take it off KNOWN_STALE`);
  }
  return { refusals, plants, files: tracked.length, listed, anchored };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const { refusals, plants, files, listed, anchored } = await mutantAnchors(root);
  for (const r of listed) console.log(`mutant-anchors: listed in KNOWN_STALE: ${r.line}`);
  for (const a of anchored) console.log(`mutant-anchors: ${a}`);
  for (const r of refusals) console.error(`mutant-anchors: REFUSED: ${r}`);
  if (refusals.length) {
    console.error(`mutant-anchors: ${refusals.length} refusal(s) in ${files} sweep file(s), ${plants} plant(s) read`);
    process.exit(1);
  }
  console.log(`mutant-anchors: OK (${plants} plant(s) in ${files} sweep file(s), each anchor found exactly once)`);
}
