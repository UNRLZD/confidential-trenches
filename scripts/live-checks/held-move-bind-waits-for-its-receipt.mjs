#!/usr/bin/env node
// Live check of card held-move-bind-waits-for-its-receipt: a held deposit's tap never moves USDC that U's bind is about
// to take, and a round never binds USDC that a held op's move is about to take. U's key nonce moves at a call's own
// receipt; the token debits U at a later one, up to REFUND_HEIGHTS (3) heights after. Nothing live can show that without
// a real bind and a tap at once, so this reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - that /app.js holds the card's rules, as the minifier writes them (packages/wallet/src/deposit/moveout.ts bindOut,
//     packages/wallet/src/deposit/follow.ts moveOutLive):
//       tap_receipt: a bind call of U's whose nonce U's key passed is out until the lower final height is 3 past the
//         first height that read it passed, bounded by its max_block_height + LAPSE_MARGIN + 3; one not passed is out
//         until its max_block_height + LAPSE_MARGIN;
//       round_receipt: a held op's move whose nonce U's key passed is out until the lower final height is 3 past the
//         first height that read it passed, bounded by its block + MOVE_VALIDITY_BLOCKS + 3; one not passed is out
//         until its block + MOVE_VALIDITY_BLOCKS.
// The marks are written out here, not read from the repo. The behaviour itself is proven by BIND-RECEIPT* in
// packages/wallet/test/deposit-moveout.test.ts and MOVE-RECEIPT* and MOVE-OUT in packages/wallet/test/deposit-follow.test.ts.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/held-move-bind-waits-for-its-receipt.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY = "held-move-bind-waits-for-its-receipt";
export const SIGN = "https://confidential.unrealized.trade";
const I = "[\\w$]+"; // a minified name
/** A minified line as a pattern: `~` any name, `@n` a name bound as n, `#n` the name bound as n; the rest as written. */
const shape = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/@(\w+)|#(\w+)|~/g, (_, def, ref) => (def ? `(?<${def}>${I})` : ref ? `\\k<${ref}>` : I)));
// moveout.ts bindOut: U's bind calls from the note store, U read on both RPCs, each call out while it can still land or
// its debit can still show
const TAP = shape(
  "@m=new Map,~=async()=>{let @c=~.notes===void 0?[]:(await ~.notes.list()).flatMap(~=>(~.calls??[]).filter(~=>~.sender_id===~));if(#c.length===0)return!1;" +
    "let @u=await ~(~,~);if(#u===null)return null;let @l=#u.heights[0]<#u.heights[1]?#u.heights[0]:#u.heights[1];" +
    "return #c.some(@e=>{let @w=#e.max_block_height+~;return #e.nonce>#u.nonce?#l<=#w:(#m.has(#e.nonce)||#m.set(#e.nonce,#l),#l<=#w+3n&&#l<#m.get(#e.nonce)+3n)})}",
);
// follow.ts moveOutLive: every held op's move of U, U read on both RPCs, each move out while it can still land or its
// debit can still show
const ROUND = shape(
  "@m=new Map,~=async()=>{let @o=(await ~()).flatMap(([,@p])=>#p.follow.out!==void 0&&#p.follow.why!==`moved_out`?[#p.follow.out]:[]);if(#o.length===0)return!1;" +
    "let @u=await ~(~,~);if(#u===null)return!0;let @l=#u.heights[0]<#u.heights[1]?#u.heights[0]:#u.heights[1];" +
    "return #o.some(@e=>{let @w=BigInt(#e.height)+~;return #u.nonce<BigInt(#e.nonce)?#l<=#w:(#m.has(#e.hash)||#m.set(#e.hash,#l),#l<=#w+3n&&#l<#m.get(#e.hash)+3n)})}",
);
/** Each rule, as a test over the bundle's text. */
export const MARKS = Object.freeze({
  tap_receipt: { test: (js) => TAP.test(js) },
  round_receipt: { test: (js) => ROUND.test(js) },
});
export const MARKERS = Object.keys(MARKS);

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, markers } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  const has = a.app?.markers ?? [];
  for (const m of MARKERS) if (!has.includes(m)) bad(`the served /app.js lacks the receipt wait's rule ${m}`);
  if (!lines.length) lines.push(`OK the pinned /app.js waits out a used call's debit before a tap or a bind decides (${MARKERS.length} rules)`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export const answerOf = (index, js) => ({ index, app: { sha384: sha384(js), markers: MARKERS.filter((m) => MARKS[m].test(js)) } });

/** Reads SIGN_HOST, or a build folder. */
export async function read(site) {
  if (site) return answerOf(readFileSync(path.join(site, "index.html"), "utf8"), readFileSync(path.join(site, "public", "app.js"), "utf8"));
  const index = await (await fetch(`${SIGN}/`)).text();
  const js = await (await fetch(`${SIGN}/app.js`)).text();
  return answerOf(index, js);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--site"));
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

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `dirs` names the build
 *  folders. */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
