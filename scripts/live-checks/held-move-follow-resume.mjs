#!/usr/bin/env node
// Live check of card held-move-follow-resume: a held deposit whose refund move went through, with its money not yet
// under U, is followed to its end. Nothing live can show that without a real held deposit and a refund in flight, so
// this reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - that /app.js holds the card's rules, as the minifier writes them (packages/wallet/src/deposit/follow.ts,
//     packages/signpage/src/main.ts):
//       held_followed: a held op moved, with no delivery and no end read, is followed on (heldFollowed), and the ended
//         rule (followEnded) leaves it out, so a landing's settle resumes it;
//       refund_back: a refund back under U is moved for such an op as for a refunded one (the REFUNDED scan takes it);
//       ends: such an op with the refund quote's address ends only on 1Click's final status of it (SUCCESS, REFUNDED,
//         FAILED), then U read again on both RPCs: arrived (U's USDC at MIN_DEPOSIT or more), held (anything under U the
//         way out moves) or left (all 0); one recorded before the address ends arrived, or left past the move's deadline
//         and the refund quote's 30 minutes on both RPCs with nothing under U to move, never on one read alone;
//       round_lock: U's own lock (FOLLOW_LOCK/<network>/<U>, the one the way out's tap takes only if free) is held only
//         around each round of U's follow, never across its waits; one follower per U across tabs holds its own lock;
//       tap_resumes: a way out that answers empty while U's money is still coming resumes U's follow and answers
//         unread, which the page draws as WITHDRAW_WORDS.busy (src/withdraw/held.ts), never Nothing to move.
// The marks are written out here, not read from the repo. The behaviour itself is proven by the tests named
// "held-move-follow-resume" in packages/wallet/test/deposit-follow.test.ts and packages/signpage/test/deposit-follow.test.ts.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/held-move-follow-resume.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY = "held-move-follow-resume";
export const SIGN = "https://confidential.unrealized.trade";
const I = "[\\w$]+"; // a minified name
/** A minified line as a pattern: `~` any name, `@n` a name bound as n, `#n` the name bound as n; the rest as written. */
const shape = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/@(\w+)|#(\w+)|~/g, (_, def, ref) => (def ? `(?<${def}>${I})` : ref ? `\\k<${ref}>` : I)));
// the end block of follow.ts (card held-move-follow-resume, the money review's FIX FIRST 2-4)
const ENDS = shape(
  "for(let[@id,@op]of await ~()){if(!~(#op)||#op.follow.move!==void 0)continue;let @a=#op.follow.moved_address;if(#a!==void 0){if(@mv||~()<(@at.get(#id)??0))continue;" +
    "let @s=await ~(#a,~,~,~,~());if(#s===null)continue;if(`retry_ms`in #s){let @r=#s.retry_ms??Math.min(Math.max((~.get(#id)??0)*2,2e3),6e4);~.set(#id,#r),#at.set(#id,~()+#r);continue}" +
    "if(~.delete(#id),#s.status!==`SUCCESS`&&#s.status!==`REFUNDED`&&#s.status!==`FAILED`)continue;" +
    "let @u=await ~(~,~,~),@h=~===null?[]:await Promise.all([#op.follow.origin,~].map(async @x=>(await ~(null,#x))?.held??null));if(#u===null||#h.some(@y=>#y===null))continue;" +
    "let @e=#u>=~.MIN_DEPOSIT?`arrived`:#u>0n||#h.some(@z=>#z>0n)?`held`:`left`;if(#e===`left`&&!await @p(~,(#op.follow.moved_ms??0)+18e5))continue;await ~(#id,`held`,~(#op),{move_end:#e})}" +
    "else @c!==null&&(#c>=~.MIN_DEPOSIT?await ~(#id,`held`,~(#op),{move_end:`arrived`}):!#mv&&(~===null||~.has(#op.follow.origin)&&~.has(~))&&await #p(~,(#op.follow.moved_ms??0)+18e5)&&await ~(#id,`held`,~(#op),{move_end:`left`}))}",
);
/** Each rule, as a test over the bundle's text: a pattern, or a pattern whose named groups name further code. */
export const MARKS = Object.freeze({
  // heldFollowed, and followEnded leaving it out (its name bound across the two)
  held_followed: { test: (js) => new RegExp(`(?<![\\w$])(?<hf>${I})=(?<o>${I})=>\\k<o>\\.stage===\`held\`&&\\k<o>\\.follow\\.moved===!0&&\\k<o>\\.follow\\.delivered===void 0&&\\k<o>\\.follow\\.move_end===void 0,${I}=(?<p>${I})=>\\k<p>\\.stage===\`held\`&&\\k<p>\\.follow\\.move===void 0&&!\\k<hf>\\(\\k<p>\\)\\|\\|\\k<p>\\.stage===\`done\`&&\\k<p>\\.follow\\.final===!0[,;]`).test(js) },
  // the REFUNDED scan takes a held op that heldFollowed keeps
  refund_back: { test: (js) => new RegExp(`follow\\.status===\`REFUNDED\`&&\\((?<o>${I})\\.stage!==\`held\`\\|\\|${I}\\(\\k<o>\\)\\)`).test(js) },
  // with the refund quote's address: a final status of it, then U's USDC and intents.near holdings read again, any
  // failed read ending nothing; arrived at MIN_DEPOSIT, held on anything else under U, left only on all 0. Without it:
  // arrived on U's USDC at MIN_DEPOSIT; left only past the move's deadline + 18e5 ms (REFUND_QUOTE_DEADLINE_MS) on both
  // RPCs, with nothing to move and U's holdings read
  ends: { test: (js) => ENDS.test(js) },
  // U's own lock only around each round (review M1 of 4723424c4): the follower's body under the follower lock; U's lock
  // (FOLLOW_LOCK) waited for in one place only, the roundLock handed to the follow; the follow runs each round through it
  round_lock: {
    test: (js) => {
      const x = (s) => s.replace(/\$/g, "\\$");
      const n = new RegExp(String.raw`(?<![\w$])(?<f>${I})=\`ct-wallet/deposit-follow/\`,(?<b>${I})=\`ct-wallet/deposit-follower/\``).exec(js)?.groups;
      if (!n) return false;
      const body = new RegExp(String.raw`\.request\(\`\$\{${x(n.b)}\}\$\{(?<k>${I})\}\`,\{mode:\`exclusive\`,signal:${I}\},${I}\)`).exec(js)?.groups;
      if (!body) return false;
      const round = new RegExp(String.raw`(?<![\w$])(?<r>${I})=(?<a>${I})=>(?<l>${I})\?\k<l>\.request\(\`\$\{${x(n.f)}\}\$\{${x(body.k)}\}\`,\{mode:\`exclusive\`,signal:${I}\},\k<a>\):\k<a>\(\)`).exec(js)?.groups;
      if (!round || !js.includes(`roundLock:${round.r},`)) return false;
      if ((js.match(new RegExp(String.raw`\.request\(\`\$\{${x(n.f)}\}[^\`]*\`,\{mode:\`exclusive\`,signal:`, "g")) ?? []).length !== 1) return false;
      const w = new RegExp(String.raw`(?<![\w$])(?<w>${I})=${I}\.roundLock\?\?\((?<a>${I})=>\k<a>\(\)\)`).exec(js)?.groups;
      return !!w && new RegExp(String.raw`await ${x(w.w)}\(${I}\),${I}=0\}catch`).test(js);
    },
  },
  // the tap: empty while U's follow resumes answers unread; the page draws unread as the busy words
  tap_resumes: { test: (js) => new RegExp(`return (?<a>${I})\\.kind===\`empty\`&&await ${I}\\?\\.resume\\(${I}\\)===!0\\?\\{kind:\`unread\`\\}:\\k<a>\\}`).test(js) && /kind===`unread`\?[\w$]+\.busy:/.test(js) },
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
  for (const m of MARKERS) if (!has.includes(m)) bad(`the served /app.js lacks the held moved deposit's rule ${m}`);
  if (!lines.length) lines.push(`OK the pinned /app.js follows a held deposit's moved money to its end (${MARKERS.length} rules)`);
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
