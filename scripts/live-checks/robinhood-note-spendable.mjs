#!/usr/bin/env node
// Live check of card robinhood-note-spendable on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and
// only that: the served /app.js is the one index.html pins (its sha384), and that bundle runs the device's one proving
// tab (packages/signpage/src/proof-front.ts): it names the Web Lock PROOF_FRONT_LOCK ("blindfill-proof-front") and asks
// it both ways the rule needs (steal, for the tab in use and for a tap; ifAvailable, for a shown tab without focus), and
// it names PROOF_QUEUES_LOCK ("blindfill-proof-queues"), the lock a tab holds while its queues are open: a tap in a tab
// without the front takes it and waits for the tab before it to close its queues, and that tab closes them only once
// its own buy's take is done. Without the first, a note one tab proved stayed HELD by that tab, and the tab in use read
// it in its balance with no Max (the owner's Robinhood return note, 13 Nov 21:26Z: $3.63 available, Max $0); without
// the second, a buy tapped in a tab without the front was refused that time, and a window switch mid-buy refused it.
// It does not prove the hand-over itself (a hidden tab closes its queues, the tab in use proves the note, a tap waits):
// that is packages/signpage/test/proof-front.test.ts (two tabs on one store, Base, Robinhood and Solana, red on main
// f7f20cda and, for the tap and the buy under way, on this card's first build d638031c).
// The recorded good answer is facts() over this card's mainnet build (node packages/signpage/scripts/build-app.mjs);
// bad is SIGN_HOST as it served before this card (13 Nov 21:55Z); bad_tap is the build of d638031c (the front, with no
// queues lock).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/robinhood-note-spendable.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "robinhood-note-spendable";
export const SIGN = "https://confidential.unrealized.trade";
/** The lock the page's proof queues run under (src/proof-front.ts PROOF_FRONT_LOCK). */
export const LOCK = "blindfill-proof-front";
/** The lock a tab holds while its proof queues are open (src/proof-front.ts PROOF_QUEUES_LOCK). */
export const QUEUES = "blindfill-proof-queues";
const named = (js, name) => ["\"", "'", "`"].some((q) => js.includes(`${q}${name}${q}`));
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), lock: named(js, LOCK), steal: /\bsteal\s*:/.test(js), ifAvailable: /\bifAvailable\s*:/.test(js), queues: named(js, QUEUES) };
}

/** The verdict on an answer { index, sha384, lock, steal, ifAvailable, queues }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.lock !== "boolean" || typeof a?.steal !== "boolean" || typeof a?.ifAvailable !== "boolean" || typeof a?.queues !== "boolean") bad("the bundle's facts are not read");
  else {
    if (!a.lock) bad(`the bundle names no ${LOCK} lock: every tab runs its own proof queue, and a note another tab proved is never spendable in the tab in use`);
    if (a.lock && !(a.steal && a.ifAvailable)) bad("the bundle does not ask the proving lock both ways (steal for the tab in use, ifAvailable for a shown tab without focus)");
    if (a.lock && !a.queues) bad(`the bundle names no ${QUEUES} lock: a buy tapped in a tab without the front is refused, and a window switch mid-buy refuses it`);
  }
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
