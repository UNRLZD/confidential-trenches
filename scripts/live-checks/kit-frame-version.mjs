#!/usr/bin/env node
// Live check of card kit-frame-version on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and its code, as minified, sends an app on an
// older kit only what that kit reads (packages/signpage/src/kit-version.ts):
//   - it reads the kit's hello ({ v: 1, type: "hello", kit }, packages/kit/src/signpage/messages.ts HelloMessage), the
//     version an app names, and reads an app that names none as kit-v1.4 (kit-v1 to kit-v1.4 are public tags);
//   - its deposit stage map for kit-v1.4 is exactly MAP: the eight stages kit-v1.4 has as they are, failed and short as
//     halted, expired as quote_checked, refund_move as refunded (never done: a refund still moving is not in the vault),
//     every value one of kit-v1.4's eight;
//   - its kit-v1.4 state fields are exactly kit-v1.4's twelve (no pools, no deposit_wallets).
// A page without them sends a kit-v1.4 app a state with a stage or field that kit refuses whole, so that app stops
// receiving states. That the page applies them to every state, answer and event it posts is
// packages/signpage/test/kit-version.test.ts's, against kit-v1.4's own schema, with its mutant sweep.
// The recorded answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg) of each tree (mainnet, as
// SIGN_HOST serves; this file reaches no package code: the import check holds it).
//   node scripts/live-checks/kit-frame-version.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "kit-frame-version";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** kit-v1.4's deposit stages, and what the page must send it for each stage the kit has now. */
export const V1_4 = ["quote_checked", "waiting", "in_transit", "into_vault", "done", "refunded", "held", "halted"];
export const MAP = { ...Object.fromEntries(V1_4.map((s) => [s, s])), failed: "halted", short: "halted", expired: "quote_checked", refund_move: "refunded" };
/** kit-v1.4's state fields (kit-v1.4:packages/kit/src/signpage/schema.ts state). */
export const V1_4_KEYS = ["release", "api", "signed_in", "way", "code_saved", "signin_failed", "vault_balance", "wallets", "positions", "orders", "held", "ops"];

/** Every object literal of plain `key:\`value\`` pairs in the bundle. */
const PAIRS = /\{((?:[a-z_]+:`[a-z_]+`,)+[a-z_]+:`[a-z_]+`)\}/g;
/** Every array literal of plain backtick strings in the bundle. */
const ARRAYS = /\[((?:`[^`$\\]*`,)*`[^`$\\]*`)\]/g;

/** What the check keeps of the reads: the index, the served bundle's sha384, the stage maps, the key lists, the hello. */
export function facts(index, js) {
  const maps = [...js.matchAll(PAIRS)]
    .map((m) => Object.fromEntries(m[1].split(",").map((p) => p.split(":").map((s) => s.replace(/`/g, "")))))
    .filter((o) => Object.hasOwn(o, "quote_checked") && Object.hasOwn(o, "halted"));
  const keys = [...js.matchAll(ARRAYS)].map((m) => m[1].split(",").map((s) => s.slice(1, -1))).filter((l) => l[0] === "release" && l.includes("ops"));
  return { index, sha384: sha384(js), maps, keys, hello: js.includes("`hello`") && /`1\.4`/.test(js) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The verdict on an answer { index, sha384, maps, keys, hello }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.hello !== true) bad("the bundle reads no kit hello: an app on any kit is sent everything, which kit-v1.4 refuses whole");
  const maps = a?.maps ?? [];
  const map = maps.find((m) => same(Object.keys(m).sort(), Object.keys(MAP).sort()));
  if (!map) bad("the bundle has no kit-v1.4 deposit stage map over every deposit stage");
  else {
    for (const [from, to] of Object.entries(map)) if (!V1_4.includes(to)) bad(`the map sends kit-v1.4 ${from} as ${to}, a stage it does not have`);
    if (map.refund_move === "done") bad("the map sends a refund still moving as done");
    for (const [from, to] of Object.entries(MAP)) if (map[from] !== to) bad(`the map sends kit-v1.4 ${from} as ${map[from]}, not ${to}`);
  }
  if (!(a?.keys ?? []).some((l) => same([...l].sort(), [...V1_4_KEYS].sort()))) bad("the bundle has no kit-v1.4 state field list of exactly its twelve fields");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
