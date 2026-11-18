#!/usr/bin/env node
// Live check of card signpage-other-apps-connect: an app other than our terminal connects to SIGN_HOST only with the
// user's approval, kept per origin on the device and removable. It reads what SIGN_HOST serves:
//   - the served /app.js is the one index.html pins (its sha384);
//   - the gate (packages/signpage/src/api.ts admit): a request is refused not_allowed before its hash, the replay cache or
//     any state read; a state push is skipped the same way; and the gate fails closed (only an exact true passes, a throw
//     is a no);
//   - the approvals store (src/connections.ts): its own IndexedDB "ct-connections", bare origins only (a write of
//     anything else throws "not an origin", the list keeps only what new URL(o).origin gives back);
//   - Allow (src/main.ts) keeps the approval and only then binds the session (shell.allow in the write's then);
//   - Disconnect (src/connected-apps.ts), under "Connected apps": removes the approval, and drops the row only once the
//     remove's write completed;
//   - a sign out deletes the approvals' database: awaited in this tab's sign out once the store is dropped, and called
//     where another tab's sign out is heard.
// The facts are read from the minified bundle with patterns written out here, not read from the repo.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/signpage-other-apps-connect.mjs [--site <dir>] [--record <file>] [--answer <file>]
// --site reads a build folder (its index.html and public/app.js) in place of SIGN_HOST: the answer this tree's build
// gives, which the deployed page must match. PASS exit 0, FAIL exit 1, error exit 2. --record writes the answer read;
// --answer replays one (the test's).
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SIGN = "https://confidential.unrealized.trade";

const Q = "[`\"']";
/** Each fact the served /app.js must hold, as a pattern on the minified bundle. */
export const FACTS = {
  gate_before_any_read: new RegExp(`\\.admit&&!await \\w+\\(\\)\\)return \\w+\\(\\{v:1,id:\\w+,ok:!1,error:\\{code:${Q}not_allowed${Q}\\}\\}\\);let \\w+=\\w+\\(await crypto\\.subtle\\.digest\\(`),
  gate_on_state_push: /===null\|\|\w+\.admit&&!await \w+\(\)\)return;/,
  gate_fails_closed: /await \w+\.admit\(\w+\(\)\)===!0\}catch\{return!1\}/,
  store_own_database: new RegExp(`=${Q}ct-connections${Q}`),
  store_bare_origins_only: new RegExp(`throw TypeError\\(${Q}not an origin${Q}\\)[\\s\\S]{0,400}?getAllKeys\\(\\)\\),\\w+\\)\\)\\.filter\\(\\w+\\)\\.sort\\(\\)`),
  allow_keeps_then_binds: /\.add\((\w+)\)\.then\(\(\)=>\{[\s\S]{0,300}?\.allow\(\1\)/,
  disconnect_removes_then_drops: new RegExp(`=${Q}Connected apps${Q},\\w+=${Q}Disconnect${Q}[\\s\\S]{0,400}?\\.button\\(${Q}disconnect${Q},\\w+,\\(\\)=>\\{[\\s\\S]{0,60}?\\.store\\.remove\\((\\w+)\\)\\.then\\(\\(\\)=>\\{\\w+\\.remove\\(\\)`),
  // the function that deletes the ct-connections database, awaited by the sign out once the store is dropped, and called
  // where another tab's sign out is heard (closeHostLanes first, then quotesSignedOut, then it: test/quotes-signed-out
  // holds the quotes' stop right after the gate)
  signout_clears: {
    test(js) {
      const db = new RegExp(`(?:var |,)(\\w+)=${Q}ct-connections${Q}`).exec(js)?.[1];
      if (!db) return false;
      const fn = new RegExp(`function (\\w+)\\([^)]*\\)\\{return \\w+\\(new Promise\\(\\(\\w+,\\w+\\)=>\\{if\\(\\w+===void 0\\)return \\w+\\(\\);let \\w+=\\w+\\.deleteDatabase\\(${db}\\)`).exec(js)?.[1];
      if (!fn) return false;
      const own = new RegExp(`=null,\\w+\\(\\),await ${fn}\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\)`).test(js);
      const elsewhere = new RegExp(`\\|\\|\\(\\w+\\(\\),\\w+\\(\\),${fn}\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\)`).test(js);
      return own && elsewhere;
    },
  },
};
export const FACT_NAMES = Object.keys(FACTS);

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { index, app: { sha384, facts: { <name>: boolean } } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  if (!pin) bad("index.html pins no /app.js");
  else if (pin !== a.app?.sha384) bad("the served /app.js is not the one index.html pins");
  for (const f of FACT_NAMES) if (a.app?.facts?.[f] !== true) bad(`the served /app.js does not hold ${f}`);
  if (!lines.length) lines.push("OK the pinned /app.js gates outside apps on kept approvals, before any read, and removes them on Disconnect");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

const answerOf = (index, js) => ({ index, app: { sha384: sha384(js), facts: Object.fromEntries(FACT_NAMES.map((f) => [f, FACTS[f].test(js)])) } });

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
    console.log(v.ok ? "PASS signpage-other-apps-connect" : "FAIL signpage-other-apps-connect");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR signpage-other-apps-connect: ${e?.message ?? e}`);
    process.exit(2);
  }
}

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them. */
export async function bundle(f, { dirs }) {
  return judge(await read(dirs.sign));
}
