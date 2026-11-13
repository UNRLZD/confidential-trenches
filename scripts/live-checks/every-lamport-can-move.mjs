#!/usr/bin/env node
// Live check of card every-lamport-can-move on SIGN_HOST (https://confidential.unrealized.trade). No step leaves money in
// the Solana pool that cannot move: every note the device makes is a whole 0.001 SOL and at least 0.005 SOL, and every
// piece that leaves the pool is one of a closed public list (the 1-2-5 rungs from 0.005 SOL and 0.006 to 0.009 SOL).
// What it proves, and only that: the served /app.js is the one index.html pins (its sha384), and its text carries the
// card's rules, each found by a mark of the bundle's shape (the minifier renames, never restructures them):
//   - the piece rule's constants: the 0.001 SOL grid, the 0.005 SOL floor, four finishing sizes, the least note made
//     before the rule (off the grid) a buy still takes whole (2,950,240), and the Solana pool holding that rule with its
//     piece ladder (the floor its least rung);
//   - the closed list: a release size is a rung or the floor plus one to four grid steps;
//   - a note's chunk: the largest rung whose change is 0 or at least the floor, else the note when it is on the list or
//     off the grid (a note made before the rule, once); under the floor the note itself (made before the rule), down to
//     the least;
//   - the proof queue's chunk is the pool's piece rule's whenever the pool has one;
//   - a withdraw's parts: a whole note only when it is on the list, off the grid or under the floor, else a size of the list that leaves
//     at least the floor;
//   - a sale returns in one deposit: a full sell carries none (the rule refuses one, deposit_full) and is built bare,
//     checked as full with no reserve; a partial sell's deposit back is the note on the grid, none under the floor;
//   - W's sweep after a full sell: its note down to the grid, the rest under the grid one System transfer from W to the
//     pinned pool's account in the same transaction (none at a rest of 0, no compute budget), and its rule: the deposit
//     alone or then exactly that transfer of under the grid, a value on the grid and at least the floor, W's lamports
//     accounted to the lamport;
//   - the ride: a pass that carries it (a full sale's own rent back, or the backs run a withdraw's end or a deposit's
//     landed note books, never a plain load's), with no claim owed, W's rest under the floor and a gain once moved,
//     releases to W the least size of the closed list a spare note gives whose change still moves and that lifts W's
//     rest to a note, then sweeps.
// It does not prove those lines run: that is the tests at the released commit (packages/wallet/test/
// pool-every-lamport.test.ts, packages/signpage/test/pool-withdraw-every-lamport.test.ts, packages/signpage/test/
// pool-sell.test.ts, packages/signpage/test/rules-pool.test.ts). The served files being that
// commit's build is signpage-release's.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/every-lamport-can-move.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "every-lamport-can-move";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const I = "[\\w$]+"; // a minified name
const esc = (n) => n.replace(/\$/g, "\\$");
const re = (s) => new RegExp(s);
const R = String.raw;
/** A mark whose named groups name other code the bundle must hold too: `more(groups)` gives each further pattern. */
const tied = (main, more) => ({
  main,
  more,
  test(js) {
    const g = main.exec(js)?.groups;
    return Boolean(g) && more(g).every((p) => new RegExp(p).test(js));
  },
});

/** Each rule's mark in the bundle, by what it holds. */
export const MARKS = Object.freeze({
  "the piece rule's 0.001 SOL grid, 0.005 SOL floor, four finishing sizes and 2,950,240 least finish, held by the Solana pool with its piece ladder": tied(
    re(R`(?<g>${I})=1000000n,(?<f>${I})=5000000n,(?<h>${I})=4n,(?<z>${I})=2950240n;`),
    (g) => [R`(?<l>${I})=Object\.freeze\(\{one:1000000n,min:5000000n\}\),(?<p>${I})=Object\.freeze\(\{grid:${esc(g.g)},floor:${esc(g.f)},ladder:\k<l>,least:${esc(g.z)}\}\)[^]*?pieces:\k<p>`, R`Array\.from\(\{length:Number\(${esc(g.h)}\)\}`],
  ),
  "the closed list: a release size is a rung or the floor plus one to four grid steps": re(
    R`function (?<w>${I})\((${I})\)\{return Array\.from\(\{length:Number\(${I}\)\},\((${I}),(${I})\)=>\2\.floor\+BigInt\(\4\+1\)\*\2\.grid\)\}function (${I})\((${I}),(${I})\)\{return typeof \7==` + "`bigint`" + R`&&\(${I}\(\6\.ladder,\7\)\|\|\k<w>\(\6\)\.includes\(\7\)\)\}`,
  ),
  "a note's chunk: the largest rung leaving 0 or the floor, else the note on the list or off the grid; under the floor the note itself down to the least": re(
    R`if\((${I})<(${I})\.floor\)return \1>=\2\.least\?\1:null;for\(let (${I}) of ${I}\(\2\.ladder,\1\)\)\{let (${I})=\1-\3;if\(\4===0n\|\|\4>=\2\.floor\)return \3\}return ${I}\(\2,\1\)\|\|\1%\2\.grid!==0n\?\1:null\}`,
  ),
  "the proof queue's chunk is the pool's piece rule's whenever the pool has one": re(R`function ${I}\((${I}),(${I})\)\{return \1\.pieces===void 0\?${I}\(\1\.ladder,\2\):${I}\(\1\.pieces,\2\)\}`),
  "a withdraw part takes a whole note only on the list, off the grid or under the floor, else a size of the list leaving at least the floor": re(
    R`(?<a>${I})>=(?<c>${I})\.minPart&&\(${I}\((?<p>${I}),(?<n>${I})\.value\)\|\|\k<n>\.value%\k<p>\.grid!==0n\|\|\k<n>\.value<\k<p>\.floor\)&&(?<o>${I})\.push\(\[\k<a>,\k<a>\]\);for\(let (?<x>${I}) of \k<n>\.value-(?<f>${I})>=\k<p>\.floor\?${I}\(\k<p>,\k<n>\.value-\k<f>\):\[\]\)\k<x>-(?<k>${I})>=\k<c>\.minPart&&\k<o>\.push\(\[\k<x>-\k<k>,\k<x>-\k<k>\]\)`,
  ),
  "a full sell carries no deposit (its one note is the sweep) and the rule refuses one by name": re(
    R`if\((${I})\.full&&(${I})\.program===(${I})\.program\)return ${I}\(` + "`deposit_full`" + R`\);let (${I})=${I}\|\|\1\.full,`,
  ),
  "a full sell is built bare and checked as full: no reserve": re(R`if\(!${I}\)\{let\{wire:(${I})\}=${I}\(${I},0n\);return ${I}\(\1,[^;]*?,0n,\{full:!0,fee:${I},rent:${I}\}\),\{wire:\1,value:0n\}\}`),
  "a partial sell's deposit back is the note on the 0.001 SOL grid, none under 0.005 SOL": tied(
    re(R`return (${I})===(?<n>${I})\(${I}-${I}\)\?\(${I}\(${I}\),\{chain:` + "`solana`"),
    (g) => [R`function ${esc(g.n)}\((${I})\)\{if\(typeof \1!=` + "`bigint`" + R`\|\|\1<=0n\)return 0n;let (${I})=\1-\1%(1000000n|${I})\;return \2<(5000000n|${I})\?0n:\2\}`],
  ),
  // review P1-1 of 1d3b96d9c: the rest under the grid goes to the pin's fee payer (the relayer's account), not the pool's
  "the sweep's note: down to the grid, the rest under it one System transfer from W to the pin's fee payer in the same transaction, none at 0, no compute budget": tied(
    re(R`function (?<s>${I})\((${I})\)\{let (${I})=${I}\(\2\);return \3===0n\?\{value:0n,under:0n\}:\{value:\3,under:\2-\3\}\}`),
    (g) => [
      R`\{value:(${I}),under:(${I})\}=${esc(g.s)}\((${I})\)[^]{0,1200}?(${I})=\2===0n\?\[\]:\[${I}\((${I})\.address,(${I})\.solana\.feePayer,\2\)\],\{message:${I}\}=${I}\(\5\.address,\[${I}\([^\]]*?,\1\),\.\.\.\4\],`,
      R`(${I})=\((${I}),(${I}),(${I})\)=>\{let (${I})=new Uint8Array\(12\),(${I})=new DataView\(\5\.buffer\);return \6\.setUint32\(0,2,!0\),\6\.setBigUint64\(4,\4,!0\),\{program:${I},accounts:\[\{key:\2,signer:!0,writable:!0\},\{key:\3,signer:!1,writable:!0\}\],data:\5\}\}`,
    ],
  ),
  "the sweep's rule: the deposit alone or then one System transfer from W to an account of the pin's of under 0.001 SOL, its value on the grid and at least 0.005 SOL, W's lamports to the lamport": re(
    R`if\((${I})\.ixs\.length!==1&&\1\.ixs\.length!==2\)return ${I}\(` + "`instructions`" + R`\);let (${I})=${I}\(\1\.ixs\[0\],(${I}),[^;]*;if\(\1\.ixs\.length===2\)\{let (${I})=\1\.ixs\[1\];if\(\4\.program!==` + "`11111111111111111111111111111111`" + R`\|\|\4\.data\.length!==12\|\|[^;]*?getUint32\(0,!0\)!==2\)return ${I}\(` + "`transfer`" + R`\);if\(\4\.accounts\.length!==2\|\|!(${I})\(\4\.accounts\[0\],(${I})\.wallet,!0,!0\)\|\|!\5\(\4\.accounts\[1\],\3\.${I},!1,!0\)\)return ${I}\(` + "`transfer_to`" + R`\);if\((${I})=${I}\(\4\.data,4\),\7===0n\|\|\7>=1000000n\)return ${I}\(` + "`transfer_amount`" + R`\)\}[^]{0,400}?\2\+5000n\+\7\+${I}\([^)]*\)\+${I}\([^)]*\)===${I}\?\2%1000000n!=0n\|\|\2<5000000n\|\|`,
  ),
  "a pass that carries the ride, with no claim owed, W's rest under the floor and a gain once moved, rides before it ends at the floor": re(
    R`(${I})<(${I})&&(${I})===0&&(${I})>0n&&(${I})\.ride===!0&&!${I}&&(${I})\.ride!==void 0\)return\{end:` + "`ride`" + R`,rest:${I},lamports:${I},steady:${I}<\2\};if\(\1<\2\)return\{end:\3>0\?` + "`owed`:`floor`",
  ),
  "the ride's piece: the least size of the closed list whose change still moves and that lifts W's rest to a note": re(
    R`function ${I}\((${I}),(${I}),(${I})\)\{let (${I})=null;for\(let (${I}) of \2\)for\(let (${I}) of ${I}\(\1,\5\.value\)\.reverse\(\)\)if\(${I}\(\1,\6\)&&${I}\(\1,\5\.value-\6\)&&\3\(\6\)\)\{\(\4===null\|\|\6<\4\.chunk\|\|\6===\4\.chunk&&\5\.value<\4\.value\)&&\(\4=\{noteId:\5\.id,chunk:\6,value:\5\.value\}\);break\}`,
  ),
  // review P2-1 of 1d3b96d9c: the ride is a time (the next mark), taken only once due, and let go only once a pass rode
  // with nothing held; a booking never moves it earlier
  "a tap's ride is taken once it is due: the backs run that takes it rides, it is let go only when that run held nothing, and only it passes again a W that ended at the floor": tied(
    re(R`take\(\)\{return (?<n>${I})\|\|(?<e>${I})\(\)<(?<i>${I})\|\|\k<e>\(\)<(?<a>${I})&&!(?<s>${I})\(\)\?!1:\(\k<n>=!0,!0\)\}[^]{0,200}?ride\((?<b>${I})\)\{(?<r>${I})=\k<r>===void 0\?\k<b>:Math\.max\(\k<r>,\k<b>\)\},takeRide\(\)\{return \k<s>\(\)\?\k<r>:void 0\},rode\((?<c>${I})\)\{\k<r>===\k<c>&&\(\k<r>=void 0\)\}`),
    (g) => [
      R`[,; ]${esc(g.s)}=\(\)=>${esc(g.r)}!==void 0&&${esc(g.e)}\(\)>=${esc(g.r)}[,;}]`,
      R`let (${I})=(${I})\.takeRide\(\),(${I})=!1[^]{0,300}?await ${I}\(${I},${I},\1===void 0\?\{\}:\{ride:!0,held:\(\)=>void\(\3=!0\)\}\);return \1!==void 0&&!\3&&\(\2\.rode\(\1\),await Promise\.resolve\(${I}\(${I}\.store\)\.rode\?\.\(\1\)\)`,
      // the backs run tells it held a W (another pass's lock), so the ride is kept for the next run
      R`${I}=!0,(${I})\.held\?\.\(\);continue\}[^]{0,200}?${I}=!0,\1\.held\?\.\(\);break\}`,
      R`(?:let (${I})=${I}\.ride===!0&&${I}\.floor===!0;\(${I}===void 0\?${I}\.seen===void 0:${I}\.seen!==${I}\.seen\|\|\1\)&&|\?\(${I}\.ride===!0&&${I}\.floor===!0\|\|\(${I}===void 0\?${I}\.seen===void 0:${I}\.seen!==${I}\.seen\)\)&&)`,
    ],
  ),
  // review P2-1 of 1d3b96d9c: a ride at the tap's own next read would tie the sweep to the tap in time; it is booked at a
  // time drawn after it (the spacing's own 10 to 60 minutes), kept in the device's store, read back on the first state
  // read capped at 60 minutes on, and a booking only moves it later
  "a tap's ride is booked at a time drawn 10 to 60 minutes after it from the device's random source, kept on the device and read back capped at 60 minutes: a withdraw's end and a deposit's landed note book it": tied(
    re(R`(?<bk>${I})=\(\)=>\{let (?<t>${I})=(?<dr>${I})\(Date\.now\(\)\);(?<ks>${I})\.ride\(\k<t>\),Promise\.resolve\((?<ow>${I})\((?<h>${I})\.store\)\.bookRide\?\.\(\k<t>\)\)\.catch\(\(\)=>\{\}\)\}`),
    (g) => [
      // the drawn time: the booking's own draw is the tap's time plus the spacing's gap, 10 to 60 minutes uniform
      R`[,; ](${I})=6e5,(${I})=36e5,[^]*?[,; ](${I})=\(\)=>\1\+(${I})\(\2-\1\+1\),(${I})=\3;function \4\((${I})\)\{if\(\6<=1\)return 0;let (${I})=Math\.floor\(4294967296/\6\)\*\6,(${I})=new Uint32Array\(1\);for\(;;\)if\(globalThis\.crypto\.getRandomValues\(\8\),\8\[0\]<\7\)return \8\[0\]%\6\}[^]*?[,; ]${esc(g.dr)}=(${I})=>\9\+\5\(\)[,;]`,
      // read back on the first state read, never later than 60 minutes from then
      R`[,; ](${I})=36e5,[^]*?let (${I})=await Promise\.resolve\(${esc(g.ow)}\(${esc(g.h)}\.store\)\.rideAt\?\.\(\)\)\.catch\(\(\)=>void 0\);\2!==void 0&&${esc(g.ks)}\.ride\(Math\.min\(\2,Date\.now\(\)\+\1\)\)`,
      R`bookRide:async (${I})=>void await\(await ${I}\(\)\)\.update\(` + "`meta`" + R`,(${I}),(${I})=>Number\.isSafeInteger\(\3\)&&\3>=\1\?void 0:\1\)`,
      R`e\.state===` + "`INCOMING`" + R`&&e\.ref\.kind===` + "`deposit`" + R`[^]{0,200}?\.state===` + "`UNSPENT`" + R`\)&&${esc(g.bk)}\(\)`,
      R`${I}\(${I}\.stage,${I}\.txs,${I}\.pending,${I}\.arrived\),${esc(g.bk)}\(\)`,
    ],
  ),
  // review P1-1 of 1d3b96d9c: the sweep's rule takes the transfer only to the pin's fee payer (the pin the deposit is
  // checked against); the rest of the rule is the mark above
  "the sweep's rule takes the rest's transfer only to the pin's fee payer": re(
    R`let ${I}=${I}\((${I})\.ixs\[0\],(${I}),[^;]*;if\(\1\.ixs\.length===2\)\{let (${I})=\1\.ixs\[1\];[^]{0,200}?if\(\3\.accounts\.length!==2\|\|!(${I})\(\3\.accounts\[0\],${I}\.wallet,!0,!0\)\|\|!\4\(\3\.accounts\[1\],\2\.feePayer,!1,!0\)\)return ${I}\(` + "`transfer_to`" + R`\)`,
  ),
  // review P1-2 of 1d3b96d9c: tokens keep W whole only on W's own coins' accounts (every account of a found W's)
  "the sweep goes on around kept accounts but never around tokens on W's own coins' accounts, a found W's all": tied(
    re(R`function (?<k>${I})\((${I}),(${I})\)\{let (${I})=\2\.filter\((${I})=>\5\.cashback===!0\)\.length;return \4>2\|\|\2\.some\((${I})=>\6\.tokens===!0&&\3\(\6\.address\)\)\?null:\{owed:\4,kept:\2\.length-\4\}\}`),
    (g) => [
      R`(${I})=new Set\((${I})\.mints\.map\((${I})=>${I}\((${I})\.address,\3\.mint,\3\.program\)\)\),(${I})=(${I})=>\2\.bare===!0\|\|\1\.has\(\6\)[^]*?${esc(g.k)}\(${I}\.ok\.keep,\5\)[^]*?${esc(g.k)}\(${I}\.plan\.keep,\5\)`,
    ],
  ),
});

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle carries. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carries: Object.fromEntries(Object.entries(MARKS).map(([k, w]) => [k, w.test(js)])) };
}

/** The verdict on an answer { index, sha384, carries }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const k of Object.keys(MARKS)) if (a?.carries?.[k] !== true) bad(`the served bundle has no ${k}`);
  return { ok: lines.length === 0, lines };
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
