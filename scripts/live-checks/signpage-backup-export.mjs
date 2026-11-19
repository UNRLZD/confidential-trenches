#!/usr/bin/env node
// Live check of card signpage-backup-export: after a sign deploy, SIGN_HOST (https://confidential.unrealized.trade)
// serves both of its key screens, the backup of the 12 words (backup.open) and the export of one key (export.open), in
// the files the newest committed release list names for it, byte for byte: the page "/" (index.html, whose script tag
// pins the bundle by its sha384) and the bundle "/app.js" that draws both screens (packages/signpage/src/main.ts, its
// pages in src/pages/), each read once over HTTPS with its status, size and sha384 equal to the list's. In the served
// bundle the backup screen is its 12 words' list (`dataset.words` = 12) and the export screen its export.open handler
// and the key's own element (`dataset.key`); a bundle that still refuses export.open has neither.
// After: sign
// Bundle: out SIGN_HOST's "/" and "/app.js" against the newest committed release list (the sign deploy refuses a build that list does not name)
//   node scripts/live-checks/signpage-backup-export.mjs [--release release-<N>] [--record <file> | --answer <file>]
//     SIGN_HOST against the newest committed release list, or against release-<N>; --record writes what the run read
//     (sizes, sha384s, the two screens found or not, and the list's entries it was judged against; no bodies), --answer
//     judges such a record instead of reading SIGN_HOST
//   PASS only when both files match the list and the bundle holds both screens. PASS exit 0, FAIL exit 1, error exit 2.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-backup-export";
const ORIGIN = "https://confidential.unrealized.trade";
const RELEASES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage/releases");
const TAG = /^release-[1-9][0-9]*$/;
export const PATHS = ["/", "/app.js"];
// the two screens in the minified bundle: the backup's 12 words' list, and the export's handler and key element
const BACKUP = /\.dataset\.words=[`"']12[`"']/;
const EXPORT = [/"export\.open":\(/, /\.dataset\.key=/];
const USAGE = "usage: node scripts/live-checks/signpage-backup-export.mjs [--release release-<N>] [--record <file> | --answer <file>]";

/** The newest committed release list's tag, by N. */
export function newestTag(dir = RELEASES) {
  const n = readdirSync(dir).map((f) => /^release-([1-9][0-9]*)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  if (!n.length) throw new Error(`no release list in ${dir}`);
  return `release-${Math.max(...n)}`;
}

/** The list's entries of the two files on SIGN_HOST: { path: { bytes, sha384 } }. */
export function listed(tag, dir = RELEASES) {
  if (!TAG.test(tag)) throw new Error(USAGE);
  const list = JSON.parse(readFileSync(path.join(dir, `${tag}.json`), "utf8"));
  const host = list.hosts?.SIGN_HOST;
  if (!host || host.origin !== ORIGIN) throw new Error(`${tag} names no SIGN_HOST at ${ORIGIN}`);
  const out = {};
  for (const p of PATHS) {
    const f = host.files?.find((x) => x.path === p);
    if (!f || typeof f.sha384 !== "string" || !Number.isSafeInteger(f.bytes)) throw new Error(`${tag} lists no ${p} with its sha384`);
    out[p] = { bytes: f.bytes, sha384: f.sha384 };
  }
  return out;
}

const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;

/** What one file's bytes give the record: size, sha384 and, for the bundle, the two screens found. */
export function readOf(p, status, bytes) {
  const r = { status, bytes: bytes.length, sha384: sha384(bytes) };
  if (p !== "/app.js") return r;
  const text = bytes.toString("utf8");
  return { ...r, screens: { backup: BACKUP.test(text), export: EXPORT.every((m) => m.test(text)) } };
}

/** The verdict on a record: { ok, lines }, each file against the list's entry, then the bundle's two screens. */
export function judge(record) {
  const lines = [];
  let ok = true;
  const bad = (l) => ((ok = false), lines.push(`BAD ${l}`));
  for (const p of PATHS) {
    const want = record.list?.[p];
    const got = record.files?.[p];
    if (!want || !got) {
      bad(`${p}: not read or not listed`);
      continue;
    }
    if (got.status !== 200) bad(`${p}: HTTP ${got.status}`);
    else if (got.bytes !== want.bytes || got.sha384 !== want.sha384) bad(`${p}: served ${got.bytes} bytes ${got.sha384}, listed ${want.bytes} bytes ${want.sha384}`);
    else lines.push(`OK ${p} ${got.sha384}`);
  }
  const s = record.files?.["/app.js"]?.screens;
  if (s?.backup !== true) bad("/app.js: no backup screen (the 12 words' list)");
  else lines.push("OK backup screen in /app.js");
  if (s?.export !== true) bad("/app.js: no export screen (export.open's handler and the key's element)");
  else lines.push("OK export screen in /app.js");
  return { ok, lines };
}

/** SIGN_HOST read now against `tag`'s list: the record. */
export async function read(tag, fetchImpl = fetch) {
  const list = listed(tag);
  const files = {};
  for (const p of PATHS) {
    const res = await fetchImpl(`${ORIGIN}${p}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(30_000) });
    files[p] = readOf(p, res.status, Buffer.from(await res.arrayBuffer()));
  }
  return { release: tag, origin: ORIGIN, read_at: new Date().toISOString(), list, files };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  try {
    const known = new Set(["--answer", "--release", "--record"]);
    if (a.some((x, i) => (i % 2 === 0 ? !known.has(x) : known.has(x))) || a.length % 2) throw new Error(USAGE);
    const [answer, release, recordTo] = [opt("--answer"), opt("--release"), opt("--record")];
    if ((release && !TAG.test(release)) || (answer && (recordTo || release))) throw new Error(USAGE);
    const record = answer ? JSON.parse(readFileSync(answer, "utf8")) : await read(release ?? newestTag());
    if (recordTo) writeFileSync(recordTo, `${JSON.stringify(record, null, 1)}\n`);
    const { ok, lines } = judge(record);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${record.release}, ${ORIGIN}${answer ? `, replay of ${answer}` : ""})`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exitCode = 2;
  }
}
