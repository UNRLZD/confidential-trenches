#!/usr/bin/env node
// Live check of card signpage-generated-merge-free: the signing page's bundle is build output, never committed, and
// SIGN_HOST serves the build of the deployed commit's own sources. It reads SIGN_HOST's / and /app.js and this
// checkout's build of its sources (scripts/signpage-built.mjs, build-app.mjs as the deploy runs it), and the checkout's
// git index (scripts/ci/no-tracked-build-output.mjs). PASS only when:
//   1. / pins /app.js with the sha384 of the /app.js SIGN_HOST serves (the integrity pin holds);
//   2. that /app.js and / are byte for byte this checkout's build of its sources (no bundle but a commit's build);
//   3. the checkout tracks none of the four build outputs and ignores each (no branch can conflict on them).
// After: sign
//   node scripts/live-checks/signpage-generated-merge-free.mjs [--record <file>]   read SIGN_HOST and this checkout
//   node scripts/live-checks/signpage-generated-merge-free.mjs --answer <file>     judge a recorded answer
// PASS exit 0, FAIL exit 1, error exit 2. A record holds hashes, sizes and the refusal lines, no bodies.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOutputProblems } from "../ci/no-tracked-build-output.mjs";
import { signBuilt } from "../signpage-built.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;
/** The integrity of the one module script that loads /app.js, or null. */
const pinOf = (html) => /<script\b[^>]*\ssrc="\/app\.js"[^>]*\sintegrity="([^"]+)"/.exec(html)?.[1] ?? /<script\b[^>]*\sintegrity="([^"]+)"[^>]*\ssrc="\/app\.js"/.exec(html)?.[1] ?? null;
const facts = (html, js) => ({ index: { bytes: Buffer.byteLength(html), sha256: sha256(html), pin: pinOf(html) }, app: { bytes: js.length, sha384: sha384(js) } });

/** What the check reads: SIGN_HOST's / and /app.js (through `fetchFn`), the checkout's build and its git index. */
export async function read(fetchFn = fetch, origin = SIGN_ORIGIN, repo = REPO) {
  const get = async (p) => {
    const r = await fetchFn(new URL(p, origin).href, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) throw new Error(`${origin}${p} answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const [html, js] = await Promise.all([get("/"), get("/app.js")]);
  const pkg = signBuilt();
  const built = facts(readFileSync(path.join(pkg, "index.html"), "utf8"), readFileSync(path.join(pkg, "public", "app.js")));
  return { at: new Date().toISOString(), origin, served: facts(html.toString("utf8"), js), built, tracked: buildOutputProblems(repo) };
}

/** The verdict on a record: { pass, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "ok" : "BAD"} ${line}`);
  const s = rec?.served;
  const b = rec?.built;
  if (!s?.index || !s?.app || !b?.index || !b?.app || !Array.isArray(rec?.tracked)) return { pass: false, lines: ["BAD the record lacks served, built or tracked"] };
  say(s.index.pin !== null && s.index.pin === s.app.sha384, `SIGN_HOST's / pins /app.js with the sha384 of the /app.js it serves (${s.index.pin} / ${s.app.sha384})`);
  say(s.app.sha384 === b.app.sha384 && s.app.bytes === b.app.bytes, `SIGN_HOST's /app.js is this commit's build of its sources (served ${s.app.sha384}, ${s.app.bytes} B; built ${b.app.sha384}, ${b.app.bytes} B)`);
  say(s.index.sha256 === b.index.sha256, `SIGN_HOST's / is this commit's build of its sources (served sha256 ${s.index.sha256}; built ${b.index.sha256})`);
  say(rec.tracked.length === 0, rec.tracked.length ? `the commit commits build output: ${rec.tracked.join("; ")}` : "the commit tracks none of the signing page's build outputs and ignores each");
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (n) => {
    const i = process.argv.indexOf(n);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  try {
    const rec = opt("--answer") ? JSON.parse(readFileSync(opt("--answer"), "utf8")) : await read();
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const { pass, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(pass ? "PASS signpage-generated-merge-free" : "FAIL signpage-generated-merge-free");
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`ERROR signpage-generated-merge-free: ${e.message}`);
    process.exit(2);
  }
}
