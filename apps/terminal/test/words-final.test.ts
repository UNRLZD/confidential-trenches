// The owner's final words (card words-final-nov2): test/words-final.json lists every word the owner picked on the Nov 2
// words page (owner 2 Nov 06:08Z, all approved; with the five that page left out as already kept or signed) and the
// new draft words kept on 1 Nov 16:45Z, each with its screen, key, text and pick. Each must read its text byte for byte,
// be no draft (so no data-draft-copy on its element) and name its pick in its source. The trade box's own words are not
// on the list and stay drafts until the next words page; the ones it shares with Portfolio (Sending, Landing) are
// Portfolio's approved entries themselves, so an approved word never goes back to draft.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as deposit from "../src/screens/deposit/words.ts";
import * as discover from "../src/screens/discover/words.ts";
import * as portfolio from "../src/screens/portfolio/words.ts";
import * as signin from "../src/screens/signin/words.ts";
import * as token from "../src/screens/token/words.ts";
import * as trade from "../src/screens/trade/words.ts";
import * as verify from "../src/screens/verify/words.ts";
import * as withdraw from "../src/screens/withdraw/words.ts";

interface Word { text: string; source: string; draft: boolean }
interface Row { screen: string; key: string; text: string; pick: string }

const SCREENS: Record<string, { WORDS: Record<string, Word>; DRAFTS: readonly string[] }> = { deposit, discover, portfolio, signin, token, verify, withdraw };
const ROWS = JSON.parse(readFileSync(new URL("./words-final.json", import.meta.url), "utf8")) as Row[];
const PICKS = ["owner 2 Nov 06:08Z, all approved", "owner 1 Nov 16:45Z, keep"];
// the screens' words not on the list, still drafts: Portfolio's overflow button's accessible name
const STILL_DRAFT: Record<string, string[]> = { deposit: [], discover: [], portfolio: ["more"], signin: [], token: [], verify: [], withdraw: [] };

test("the list: 98 words on these screens, each once, each with a pick", () => {
  assert.equal(ROWS.length, 98);
  assert.equal(new Set(ROWS.map((r) => `${r.screen}.${r.key}`)).size, ROWS.length);
  const per: Record<string, number> = {};
  for (const r of ROWS) per[r.screen] = (per[r.screen] ?? 0) + 1;
  assert.deepEqual(per, { deposit: 13, withdraw: 6, verify: 17, portfolio: 46, signin: 10, discover: 3, token: 3 });
  for (const r of ROWS) assert.ok(PICKS.includes(r.pick), `${r.screen}.${r.key}: ${r.pick}`);
});

test("every listed word: its text unchanged, no draft, its source naming its pick", () => {
  const bad: string[] = [];
  for (const r of ROWS) {
    const w = SCREENS[r.screen]?.WORDS[r.key];
    if (!w) bad.push(`${r.screen}.${r.key}: missing`);
    else if (w.text !== r.text) bad.push(`${r.screen}.${r.key}: text ${JSON.stringify(w.text)}, want ${JSON.stringify(r.text)}`);
    else if (w.draft) bad.push(`${r.screen}.${r.key}: still a draft`);
    else if (!w.source.startsWith(`${r.pick}; `)) bad.push(`${r.screen}.${r.key}: source does not name its pick: ${w.source}`);
  }
  assert.deepEqual(bad, [], `${bad.length} of ${ROWS.length} words not final:\n${bad.join("\n")}`);
});

test("each screen's drafts: only the words not on the list", () => {
  for (const [s, m] of Object.entries(SCREENS)) {
    assert.deepEqual([...m.DRAFTS].sort(), STILL_DRAFT[s], s);
    for (const k of STILL_DRAFT[s]) assert.ok(!ROWS.some((r) => r.screen === s && r.key === k), `${s}.${k} is on the list`);
  }
});

test("the trade box's own words stay drafts: none names a pick unless it is Portfolio's approved entry itself", () => {
  assert.ok(trade.DRAFTS.length > 0);
  const shared = new Set(Object.values(portfolio.WORDS as Record<string, Word>).filter((w) => !w.draft));
  for (const [k, w] of Object.entries(trade.WORDS as Record<string, Word>)) {
    if (shared.has(w)) continue;
    for (const p of PICKS) assert.ok(!w.source.includes(p), `trade.${k}`);
  }
  assert.deepEqual(Object.entries(trade.WORDS as Record<string, Word>).filter(([, w]) => shared.has(w)).map(([k]) => k), ["sending", "landing"]);
});

test("data-draft-copy is drawn only for a word whose draft flag is set, on every listed screen", () => {
  // each screen's word helper; no other code line in these screens writes the attribute (comments aside)
  const helpers: Record<string, string> = {
    deposit: "deposit/DepositSheet.tsx", discover: "discover/Discover.tsx", portfolio: "portfolio/W.tsx", signin: "signin/Word.tsx",
    token: "token/TokenPage.tsx", verify: "verify/Verify.tsx", withdraw: "withdraw/WithdrawProgress.tsx",
  };
  for (const [s, f] of Object.entries(helpers)) {
    const dir = new URL(`../src/screens/${s}/`, import.meta.url);
    const at = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((p) => /\.tsx?$/.test(p))
      .flatMap((p) => readFileSync(new URL(p, dir), "utf8").split("\n").filter((l) => l.includes("draft-copy") && !/^\s*(\/\/|\/?\*)/.test(l)).map((l) => `${s}/${p}: ${l.trim()}`));
    assert.equal(at.length, 1, `${s}: ${at.length} places write data-draft-copy:\n${at.join("\n")}`);
    assert.match(at[0], new RegExp(`^${f.replace(".", "\\.")}: return w\\.draft \\? <span data-draft-copy=\\{(id|w\\.text)\\}>\\{w\\.text\\}</span> : <>\\{w\\.text\\}</>;$`), s);
  }
});
