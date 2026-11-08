// The owner's final words (card words-final-nov2): test/words-final.json lists every word the owner picked on the Nov 2
// words page (owner 2 Nov 06:08Z, all approved; with the five that page left out as already kept or signed) and the
// new draft words kept on 1 Nov 16:45Z, the Portfolio pool rows' five kept on 3 Nov 09:17Z (card balances-per-chain) and
// the deposit sheet's Moved picked on 8 Nov 07:50Z (card held-move-forgotten-tx),
// each with its screen, key, text and pick. Each must read its text byte for byte,
// be no draft (so no data-draft-copy on its element) and name its pick in its source. The trade box's own words are not
// on the list and stay drafts until the next words page; the ones it shares with Portfolio (Sending, Landing) are
// Portfolio's approved entries themselves, so an approved word never goes back to draft.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as deposit from "../src/screens/deposit/words.ts";
import * as discover from "../src/screens/discover/words.ts";
import * as portfolio from "../src/screens/portfolio/words.ts";
import * as positions from "../src/screens/positions/words.ts";
import * as signin from "../src/screens/signin/words.ts";
import * as search from "../src/shell/search-words.ts";
import * as token from "../src/screens/token/words.ts";
import * as trade from "../src/screens/trade/words.ts";
import * as verify from "../src/screens/verify/words.ts";
import * as withdraw from "../src/screens/withdraw/words.ts";

interface Word { text: string; source: string; draft: boolean }
interface Row { screen: string; key: string; text: string; pick: string }

const SCREENS: Record<string, { WORDS: Record<string, Word>; DRAFTS: readonly string[] }> = { deposit, discover, portfolio, signin, token, verify, withdraw };
const ROWS = JSON.parse(readFileSync(new URL("./words-final.json", import.meta.url), "utf8")) as Row[];
// card words-nov8-final: the words kept on the 8 Nov words page (owner 8 Nov 07:55Z) and the night's two (8 Nov 19:40Z, kept
// as drawn), each with the text it had on main before the card made it final (recorded in words-nov8.json)
const NOV8 = JSON.parse(readFileSync(new URL("./words-nov8.json", import.meta.url), "utf8")) as Row[];
const NOV8_PICKS = ["owner 8 Nov 07:55Z, kept", "8 Nov 19:40Z, kept as drawn"];
const NOV8_SCREENS: Record<string, { WORDS: Record<string, Word>; DRAFTS: readonly string[] }> = { token, trade, positions, discover, deposit, portfolio, search };
const PICKS = ["owner 2 Nov 06:08Z, all approved", "owner 1 Nov 16:45Z, keep", "owner 3 Nov 09:17Z, keep", "owner 8 Nov 07:50Z, Moved"];
// the screens' words not on the list, still drafts: Portfolio's overflow button's accessible name and the lower panel's
// and About's words R5 marks as draft copy (card app-token-lower-panel, on the owner's next picks page). Discover's list
// age line and launchpad menu title, the chart menus' rows, the deposit sheet's To label, Portfolio's export label and
// wallets heading were kept on 8 Nov (words-nov8.json, below). Verify's pool words (card verify-pools, on the owner's
// next picks page).
const STILL_DRAFT: Record<string, string[]> = { deposit: [], discover: [], portfolio: ["more"], signin: [], token: ["about", "buys5m", "colAge", "colAmount", "colBs", "colPosition", "colShare", "colTotal", "colTrader", "colType", "creatorTag", "net5m", "sells5m", "vol5m"], verify: ["authority", "blockscout", "hoodscan", "owner", "pools", "proxy", "solanaExplorer"], withdraw: [] };

test("the list: 104 words on these screens, each once, each with a pick", () => {
  assert.equal(ROWS.length, 104);
  assert.equal(new Set(ROWS.map((r) => `${r.screen}.${r.key}`)).size, ROWS.length);
  const per: Record<string, number> = {};
  for (const r of ROWS) per[r.screen] = (per[r.screen] ?? 0) + 1;
  assert.deepEqual(per, { deposit: 14, withdraw: 6, verify: 17, portfolio: 51, signin: 10, discover: 3, token: 3 });
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
  const kept = new Set(NOV8.filter((r) => r.screen === "trade").map((r) => r.key));
  for (const [k, w] of Object.entries(trade.WORDS as Record<string, Word>)) {
    if (shared.has(w)) continue;
    if (kept.has(k)) assert.ok(!w.draft, `trade.${k} was kept on 8 Nov`);
    else for (const p of [...PICKS, ...NOV8_PICKS]) assert.ok(!w.source.includes(p), `trade.${k}`);
  }
  assert.deepEqual([...kept].sort(), ["poolBare", "poolSuffix", "proofMaking", "proofReady"]);
  assert.deepEqual(Object.entries(trade.WORDS as Record<string, Word>).filter(([, w]) => shared.has(w)).map(([k]) => k), ["sending", "landing", "privateBalance"]);
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

test("words-nov8-final: 18 words kept as drafted, each text unchanged, no draft, its source naming its pick", () => {
  assert.equal(NOV8.length, 18);
  assert.equal(new Set(NOV8.map((r) => `${r.screen}.${r.key}`)).size, NOV8.length);
  const bad: string[] = [];
  for (const r of NOV8) {
    assert.ok(NOV8_PICKS.includes(r.pick), `${r.screen}.${r.key}: ${r.pick}`);
    const w = NOV8_SCREENS[r.screen]?.WORDS[r.key];
    if (!w) bad.push(`${r.screen}.${r.key}: missing`);
    else if (w.text !== r.text) bad.push(`${r.screen}.${r.key}: text ${JSON.stringify(w.text)}, want ${JSON.stringify(r.text)}`);
    else if (w.draft) bad.push(`${r.screen}.${r.key}: still a draft`);
    else if (!w.source.startsWith(`${r.pick}; `)) bad.push(`${r.screen}.${r.key}: source does not name its pick: ${w.source}`);
  }
  assert.deepEqual(bad, [], `${bad.length} of ${NOV8.length} words not final:\n${bad.join("\n")}`);
  // the night's two, and the rest from the 8 Nov page
  assert.deepEqual(NOV8.filter((r) => r.pick === NOV8_PICKS[1]).map((r) => `${r.screen}.${r.key}`), ["discover.padMenuTitle", "search.placeholder"]);
});

test("words-nov8-final: the 8 Nov page's texts, byte for byte, as the page lists them", () => {
  // the page's own strings (research board/words-nov8.html): the label each key draws, the data in {braces}
  const page: Record<string, string> = {
    "token.gridLines": "Grid lines", "token.lastLine": "Last price line", "token.indMA": "MA", "token.indEMA": "EMA", "token.indBOLL": "BOLL",
    "token.indRSI": "RSI", "token.indMACD": "MACD", "trade.proofReady": "Proof ready", "trade.proofMaking": "Making proof", "trade.poolBare": "Pool",
    "trade.poolSuffix": "pool", "positions.toPool": "Back to Cash", "discover.updated": "Updated {age} ago", "deposit.to": "To",
    "portfolio.exportKey": "Export key", "portfolio.wallets": "Wallets", "discover.padMenuTitle": "Launchpads by tokens now",
    "search.placeholder": "Name, symbol or address",
  };
  assert.deepEqual(Object.keys(page).sort(), NOV8.map((r) => `${r.screen}.${r.key}`).sort());
  for (const r of NOV8) assert.equal(NOV8_SCREENS[r.screen]!.WORDS[r.key]!.text, page[`${r.screen}.${r.key}`], `${r.screen}.${r.key}`);
});

test("words-nov8-final: no screen lists one of them among its drafts", () => {
  for (const [s, m] of Object.entries(NOV8_SCREENS)) for (const r of NOV8.filter((x) => x.screen === s)) assert.ok(!m.DRAFTS.includes(r.key), `${s}.${r.key}`);
});

test("words-nov8-final: the search placeholder writes data-draft-copy only for a draft word", () => {
  const src = readFileSync(new URL("../src/shell/Search.tsx", import.meta.url), "utf8");
  assert.ok(src.includes('const draftAttr = (id: WordId) => (WORDS[id].draft ? { "data-draft-copy": WORDS[id].text } : {});'));
  assert.equal(search.WORDS.placeholder.draft, false);
});
