#!/usr/bin/env node
// Live check of card vault-setup-files: the six Privacy Pools v1 setup files sit in the kit, pinned by sha256.
// It reads packages/kit/zk/ from GitHub (main, then the freeze tag given by --tag) and checks, against pins written out
// here from docs/plan1/vault.md 2.6 (research ffcba5e, V:522-527), and not read from the kit:
//   - each of the six files: its size and sha256;
//   - the two licence texts beside them: their sha256 (gnu.org, read 2026-11-01 01:03Z);
//   - the NOTICE: it names the source commit and the Apache-2.0, GPL-3.0 and LGPL-3.0 licences;
//   - the kit's constants (packages/kit/src/zk/setup-files.ts): the same six sizes and hashes and the same source commit.
//   node scripts/live-checks/vault-setup-files.mjs [--tag <freeze tag>] [--base <url>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --base reads one tree from <url> (a local server of a checkout) instead of GitHub; --record writes what the run read
// to <file>, so the check's test can replay it through judge().
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "vault-setup-files";
const REPO = "UNRLZD/confidential-trenches";
const DIR = "packages/kit/zk/";
const CONSTANTS = "packages/kit/src/zk/setup-files.ts";
export const baseOf = (ref) => `https://raw.githubusercontent.com/${REPO}/${ref}/`;

// ---------- pinned ----------
// Privacy Pools v1 at tag v1.3.0 (vault.md:15)
export const SOURCE_COMMIT = "c312dcd58f6ad085204be61923c49f8065e4e9ae";
// vault.md 2.6, the table's six rows: name, bytes, sha256
export const PINS = [
  ["withdraw.wasm", 2607967, "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10"],
  ["withdraw.zkey", 17793015, "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677"],
  ["withdraw.vkey", 4208, "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e"],
  ["commitment.wasm", 2380442, "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8"],
  ["commitment.zkey", 901233, "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3"],
  ["commitment.vkey", 3477, "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8"],
];
// https://www.gnu.org/licenses/gpl-3.0.txt and lgpl-3.0.txt
export const LICENCES = [
  ["LICENSE-GPL-3.0.txt", 35149, "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"],
  ["LICENSE-LGPL-3.0.txt", 7652, "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118"],
];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---------- the verdict ----------
// One line per kit entry: "withdraw.wasm": Object.freeze({ bytes: 2607967, sha256: "<64 hex>", ...
const ENTRY = /"([\w-]+\.(?:wasm|zkey|vkey))":\s*(?:Object\.freeze\()?\{\s*bytes:\s*(\d+),\s*sha256:\s*"([0-9a-f]{64})"/g;

export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const reads = rec.reads ?? [];
  say(reads.length > 0, `${reads.length} tree(s) read`);
  for (const r of reads) {
    const at = r.ref;
    const files = new Map((r.files ?? []).map((f) => [f.name, f]));
    for (const [name, bytes, hash] of [...PINS, ...LICENCES]) {
      const f = files.get(name);
      if (!f || f.status !== 200) say(false, `${at} ${name}: not served (${f ? `HTTP ${f.status}` : "not read"})`);
      else {
        const bad = [];
        if (f.bytes !== bytes) bad.push(`${f.bytes} B, pinned ${bytes} B`);
        if (f.sha256 !== hash) bad.push(`sha256 ${f.sha256}, pinned ${hash}`);
        say(bad.length === 0, `${at} ${name}: ${bad.length ? bad.join("; ") : `${bytes} B, sha256 ${hash.slice(0, 12)}... equal`}`);
      }
    }

    const notice = r.notice?.status === 200 ? r.notice.text : null;
    const missing = notice === null ? ["the file"] : [SOURCE_COMMIT, "Apache License 2.0", "GPL-3.0", "LGPL-3.0"].filter((s) => !notice.includes(s));
    say(missing.length === 0, `${at} NOTICE: ${missing.length ? `missing ${missing.join(", ")}` : "names the source commit and the Apache-2.0, GPL-3.0 and LGPL-3.0 licences"}`);

    const src = r.constants?.status === 200 ? r.constants.text : null;
    if (src === null) say(false, `${at} kit constants: not served (HTTP ${r.constants?.status ?? "not read"})`);
    else {
      const got = new Map([...src.matchAll(ENTRY)].map((m) => [m[1], [Number(m[2]), m[3]]]));
      const bad = [];
      if (got.size !== PINS.length) bad.push(`${got.size} entries, pinned ${PINS.length}`);
      for (const [name, bytes, hash] of PINS) {
        const g = got.get(name);
        if (!g) bad.push(`${name} missing`);
        else if (g[0] !== bytes || g[1] !== hash) bad.push(`${name} ${g[0]} B ${g[1]}`);
      }
      if (!src.includes(`commit: "${SOURCE_COMMIT}"`)) bad.push("source commit differs");
      say(bad.length === 0, `${at} kit constants: ${bad.length ? bad.join("; ") : "the six sizes and hashes and the source commit equal the pins"}`);
    }
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---------- the live read ----------
async function readTree(ref, base, fetchFn) {
  const r = { ref, base, files: [], notice: null, constants: null };
  for (const [name] of [...PINS, ...LICENCES]) {
    const res = await fetchFn(base + DIR + name);
    if (res.status !== 200) {
      r.files.push({ name, status: res.status });
      continue;
    }
    const b = Buffer.from(await res.arrayBuffer());
    r.files.push({ name, status: 200, bytes: b.length, sha256: sha256(b) });
  }
  for (const [k, p] of [["notice", `${DIR}NOTICE`], ["constants", CONSTANTS]]) {
    const res = await fetchFn(base + p);
    r[k] = { status: res.status, text: res.status === 200 ? await res.text() : null };
  }
  return r;
}

export async function collect({ tag = null, base = null, fetchFn = fetch } = {}) {
  const rec = { at: new Date().toISOString(), reads: [] };
  const trees = base ? [[`local ${base}`, base]] : [["main", baseOf("main")], ...(tag ? [[tag, baseOf(tag)]] : [])];
  for (const [ref, b] of trees) rec.reads.push(await readTree(ref, b, fetchFn));
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ tag: opt("--tag", null), base: opt("--base", null) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
