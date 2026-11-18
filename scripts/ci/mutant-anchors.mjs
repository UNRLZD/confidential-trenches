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
export function anchorRefusals(rel, plants, read = (f) => readFileSync(f, "utf8")) {
  const out = [];
  const texts = new Map();
  const textOf = (f) => (texts.has(f) ? texts.get(f) : (texts.set(f, read(f)), texts.get(f)));
  for (const { name, file, finds, seq } of plants) {
    let text;
    try {
      text = textOf(file);
    } catch {
      out.push(`${rel}: mutant ${JSON.stringify(short(name))}: its file ${file} cannot be read`);
      continue;
    }
    for (const find of finds) {
      const n = count(text, find);
      if (n !== 1) out.push(`${rel}: mutant ${JSON.stringify(short(name))}: its anchor is in ${path.basename(file)} ${n} times, not once: ${JSON.stringify(short(String(find)))}`);
      // a sequential sweep plants each edit before it reads the next anchor, so the next is counted in the planted text
      else if (seq) text = text.replace(find, () => seq[finds.indexOf(find)]);
    }
  }
  return out;
}

const short = (s) => s.split("\n")[0].trim().slice(0, 90);

/** Every sweep file's plants read and counted: { refusals, plants, files }. */
export async function mutantAnchors(root) {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*mutants.mjs"], { cwd: root, encoding: "utf8" }).split("\0").filter((f) => MUTANT_FILE.test(f));
  const refusals = [];
  let plants = 0;
  for (const rel of tracked) {
    if (Object.hasOwn(NOT_SWEPT, rel)) continue;
    const sweep = SWEEPS[rel];
    if (!sweep) {
      refusals.push(`${rel}: a sweep file this gate has no reader for: add it to SWEEPS in scripts/ci/mutant-anchors.mjs`);
      continue;
    }
    const abs = path.join(root, rel);
    const copy = path.join(path.dirname(abs), `.mutant-anchors-${process.pid}-${path.basename(abs)}`);
    let g;
    try {
      writeFileSync(copy, listModule(readFileSync(abs, "utf8"), sweep.list, sweep.vars));
      g = (await import(pathToFileURL(copy).href)).__ANCHORS;
    } catch (e) {
      refusals.push(`${rel}: its mutant list cannot be read (${String(e?.message ?? e).split("\n")[0]})`);
      continue;
    } finally {
      rmSync(copy, { force: true });
    }
    const entries = sweep.once ? g.list.slice(0, 1) : g.list;
    const mine = entries.flatMap((e) => sweep.read(e, g, root));
    plants += mine.length;
    refusals.push(...anchorRefusals(rel, mine));
  }
  return { refusals, plants, files: tracked.length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const { refusals, plants, files } = await mutantAnchors(root);
  for (const r of refusals) console.error(`mutant-anchors: REFUSED: ${r}`);
  if (refusals.length) {
    console.error(`mutant-anchors: ${refusals.length} refusal(s) in ${files} sweep file(s), ${plants} plant(s) read`);
    process.exit(1);
  }
  console.log(`mutant-anchors: OK (${plants} plant(s) in ${files} sweep file(s), each anchor found exactly once)`);
}
