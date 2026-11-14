// The launchpad and chain table (card app-launchpad-chain-badges, src/screens/market/pads.ts): every id the helper's
// lists served on 3 Nov (and NEAR's on 14 Nov) maps to its pad's own name and a logo file in the app; null, an unknown id and a pad with no
// cited logo draw no badge; every chain has its mark. The coverage case replays a live answer recorded 2026-11-03
// 12:43Z (test/pads/lists-solana-2026-11-03.json, each row cut to its id, chain and launchpad, in columns): an id the lists serve
// with no row in the table fails it, so a new pad shows up here, not as a missing badge.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { badgeSize, CHAINS, chainOf, NO_LOGO, PADS, padOf } from "../src/screens/market/pads.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The ids the lists served on 3 Nov: a read at 12:30Z, the card's, and this card's read at 12:43Z (Raydium). */
const SOLANA = ["pump.fun", "stonkfun", "raydium-launchlab", "Raydium", "met-dbc", "letsbonk.fun", "metadao", "jup-studio", "bags.fun", "grainpad"];
/** The factory table's pads (apps/helper/src/data/evm/lists.ts FACTORIES, card market-data-evm-lists at 8d6e279; torch from card pad-torch-robinhood). */
const EVM = ["zora", "clanker", "doppler", "flaunch", "virtuals", "pons", "bags", "torch"];
/** The engine's NEAR pad ids the helper served on 14 Nov 06:19Z (test/pads/lists-near-2026-11-14.json) with a cited logo;
 *  GayPad and token0, also served, have none (NO_LOGO). tkn: served from 14 Nov 10:35Z (app live run 43585050672). */
const NEAR = ["hoot", "nearlytrade", "qlyphs", "memecooking", "nearpaid", "tkn"];
const NAMES: Record<string, string> = {
  "pump.fun": "pump.fun", stonkfun: "StonkFun", "raydium-launchlab": "LaunchLab", Raydium: "Raydium", "met-dbc": "Meteora", "letsbonk.fun": "bonk.fun",
  metadao: "MetaDAO", "jup-studio": "Jupiter Studio", "bags.fun": "Bags", grainpad: "grainpad", zora: "Zora", clanker: "Clanker", doppler: "Doppler",
  flaunch: "Flaunch", virtuals: "Virtuals", pons: "Pons", bags: "Bags", torch: "Torch",
  hoot: "Hoot", nearlytrade: "Nearly.trade", qlyphs: "Qlyphs", memecooking: "meme.cooking", nearpaid: "NearPaid", tkn: "TKN",
};

/** A logo the table names: a file in src/screens/market/logos, a real PNG of 64 px or less or an SVG with no script. */
function logoFault(href: string): string | null {
  const file = fileURLToPath(href);
  if (path.dirname(file) !== path.resolve(HERE, "../src/screens/market/logos")) return `outside logos/: ${file}`;
  if (!existsSync(file)) return `missing ${file}`;
  const b = readFileSync(file);
  if (file.endsWith(".png")) {
    if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return "not a PNG";
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    if (w !== h || w < 32 || w > 64) return `${w}x${h}, not square 32-64 px`;
  } else if (file.endsWith(".svg")) {
    const t = b.toString("utf8");
    if (!/<svg[\s>]/.test(t) || /<script|\son[a-z]+=|<foreignObject|<image|href="(?!#)/i.test(t)) return "not a plain SVG";
  } else return "neither PNG nor SVG";
  if (statSync(file).size > 8192) return `${statSync(file).size} bytes, over 8 KB`;
  return null;
}

/** The ids a lists answer serves that the table has no row for (null is "no launchpad", not an id). */
function missingPads(lists: Record<string, { launchpad: string | null }[]>): string[] {
  const ids = new Set(Object.values(lists).flat().map((r) => r.launchpad).filter((x): x is string => x !== null));
  return [...ids].filter((id) => padOf(id) === null && !NO_LOGO.includes(id)).sort();
}

test("every id served on 3 Nov (Solana, EVM) and 14 Nov (NEAR) maps to its pad's own name and a logo file in the app, with its source cited", () => {
  for (const id of [...SOLANA, ...EVM, ...NEAR]) {
    const p = padOf(id);
    assert.ok(p, `${id} has no row`);
    assert.equal(p.name, NAMES[id], id);
    assert.equal(logoFault(p.logo), null, `${id}: ${logoFault(p.logo)}`);
    assert.match(p.src, /^https:\/\//, `${id}: source not cited`);
  }
  assert.deepEqual(Object.keys(PADS).sort(), [...SOLANA, ...EVM, ...NEAR].sort(), "a row with no test, or a test id with no row");
});

test("null, undefined, an unknown id, an Object prototype key and a pad with no cited logo draw no launchpad badge", () => {
  for (const id of [null, undefined, "", "unknown-pad", "PUMP.FUN", "__proto__", "toString", "constructor", ...NO_LOGO]) assert.equal(padOf(id), null, String(id));
  assert.deepEqual(NO_LOGO, ["spawn", "gaypad", "token0"]);
});

test("every chain a row can carry has its mark, with its source cited; an unknown chain none", () => {
  for (const [c, name] of [["solana", "Solana"], ["base", "Base"], ["robinhood", "Robinhood"], ["near", "NEAR"]] as const) {
    const m = chainOf(c);
    assert.ok(m, c);
    assert.equal(m.name, name);
    assert.equal(logoFault(m.logo), null, `${c}: ${logoFault(m.logo)}`);
    assert.match(m.src, /^https:\/\//);
    assert.ok(m.inset >= 0 && m.inset < 0.5);
  }
  assert.deepEqual(Object.keys(CHAINS).sort(), ["base", "near", "robinhood", "solana"]);
  for (const c of [null, undefined, "", "ethereum", "eip155:4663", "__proto__"]) assert.equal(chainOf(c), null, String(c));
});

test("the live lists recorded 2026-11-03 12:43Z: every launchpad id they serve has a row; a planted new id is caught", () => {
  const rec = JSON.parse(readFileSync(path.join(HERE, "pads/lists-solana-2026-11-03.json"), "utf8")) as { fields: string[]; lists: Record<string, [string, string, string | null][]> };
  assert.deepEqual(rec.fields, ["token", "chain", "launchpad"]);
  const lists = Object.fromEntries(Object.entries(rec.lists).map(([k, rs]) => [k, rs.map(([id, chain, launchpad]) => ({ id, chain, launchpad }))]));
  const rows = Object.values(lists).flat();
  assert.ok(rows.length > 300 && rows.some((r) => r.launchpad === null) && rows.some((r) => r.launchpad === "Raydium"));
  assert.deepEqual(missingPads(lists), []);
  for (const r of rows) assert.ok(chainOf(r.chain), `${r.id}: chain ${r.chain} has no mark`);
  const planted = structuredClone(lists);
  planted.new![0]!.launchpad = "moonshot";
  assert.deepEqual(missingPads(planted), ["moonshot"]);
});

// Card every-cell-shows-a-value: NEAR's rows carry the engine's pad id (apps/helper/src/data/near/engine.ts) since the
// helper reads NEAR from the engine; app live run 43564810887 (release 134) found "hoot" and "nearlytrade" with no row.
test("the live NEAR lists recorded 2026-11-14 06:19Z: every launchpad id they serve has a row or is NO_LOGO", () => {
  const rec = JSON.parse(readFileSync(path.join(HERE, "pads/lists-near-2026-11-14.json"), "utf8")) as { fields: string[]; lists: Record<string, [string, string, string | null][]> };
  assert.deepEqual(rec.fields, ["token", "chain", "launchpad"]);
  const lists = Object.fromEntries(Object.entries(rec.lists).map(([k, rs]) => [k, rs.map(([id, chain, launchpad]) => ({ id, chain, launchpad }))]));
  const rows = Object.values(lists).flat();
  const served = new Set(rows.map((r) => r.launchpad));
  assert.ok(rows.length > 90 && rows.every((r) => r.chain === "near") && served.has(null));
  assert.deepEqual([...served].filter((x) => x !== null).sort(), ["gaypad", "hoot", "memecooking", "nearlytrade", "nearpaid", "qlyphs", "token0"]);
  assert.deepEqual(missingPads(lists), []);
});

// once card market-data-evm-lists is on this tree, every pad its factory table can tag must have a row (or be NO_LOGO)
const EVM_SRC = path.resolve(HERE, "../../helper/src/data/evm/lists.ts");
test("the EVM factory table's pads all have rows", { skip: !existsSync(EVM_SRC) && "apps/helper/src/data/evm/lists.ts is not on this tree yet (card market-data-evm-lists)" }, () => {
  const pads = new Set([...readFileSync(EVM_SRC, "utf8").matchAll(/\{ pad: "([^"]+)"/g)].map((m) => m[1]!));
  assert.ok(pads.size > 0);
  assert.deepEqual([...pads].filter((p) => padOf(p) === null && !NO_LOGO.includes(p)), []);
});

// Card near-tkn-launchpad-badge: the helper serves a NEAR row's launchpad as the engine names it (apps/helper/src/data/
// near/engine.ts engineRow: any id LAUNCHPAD admits, no table of its own), so the ids it can serve are the engine's
// registry of pads, GET /v1/launchpads (test/pads/launchpads-near-2026-11-14.json). App live run 43585050672 (release
// 137) found "tkn" served with no row; the registry held it all along.
/** Registry pads that no list served when it was recorded (10:45Z), each still owed its row (a cited logo) or its NO_LOGO
 *  reason: the live check app-launchpad-badges still fails the deploy the moment a list serves one. This list only
 *  shrinks: a pad that gets its row or NO_LOGO entry must leave it. */
const NEAR_OWED = [
  "shardsmarket", "nearpad", "umbrafun", "nearrr", "nearafun", "intear", "wholemarket", "portalpad", "onetokenhub", "nucleusbroker", "shardpad",
  "terminalpad", "rheameme", "chipfi", "npad", "dragonpad", "tknx", "tknprimitives", "runeshot", "jumplab", "shore", "nearbased", "nearfun",
  "revshare", "patata", "nira", "vista", "nearmemefun", "kelytra",
];

/** The engine's registered pad ids that the table has no row, NO_LOGO entry or owed entry for. */
function unregistered(slugs: string[]): string[] {
  return slugs.filter((id) => padOf(id) === null && !NO_LOGO.includes(id) && !NEAR_OWED.includes(id)).sort();
}

test("every NEAR pad the engine registers (all the helper can serve) has a row, a NO_LOGO reason or is owed one; a new pad is caught", () => {
  const rec = JSON.parse(readFileSync(path.join(HERE, "pads/launchpads-near-2026-11-14.json"), "utf8")) as { fields: string[]; launchpads: [string, string, string | null, string][] };
  assert.deepEqual(rec.fields, ["slug", "name", "website", "kind"]);
  const slugs = rec.launchpads.map(([slug]) => slug);
  assert.ok(slugs.length >= 37 && slugs.includes("tkn") && slugs.includes("hoot"));
  assert.deepEqual(unregistered(slugs), []);
  // the owed list holds only registry pads still without a row or a reason
  for (const id of NEAR_OWED) {
    assert.ok(slugs.includes(id), `${id} owed but not in the registry`);
    assert.ok(padOf(id) === null && !NO_LOGO.includes(id), `${id} has its row or reason: take it off NEAR_OWED`);
  }
  // every id the recorded NEAR lists served is one the registry holds
  const lists = JSON.parse(readFileSync(path.join(HERE, "pads/lists-near-2026-11-14.json"), "utf8")) as { lists: Record<string, [string, string, string | null][]> };
  for (const rows of Object.values(lists.lists)) for (const [, , pad] of rows) assert.ok(pad === null || slugs.includes(pad), `${pad} served but not registered`);
  assert.deepEqual(unregistered([...slugs, "nextpad"]), ["nextpad"]);
});

test("badge size: 36% of the avatar, 10 to 16 px (design-lock-r5 P.badgeD)", () => {
  assert.deepEqual([20, 32, 40, 46, 50, 54, 80].map(badgeSize), [10, 12, 14, 16, 16, 16, 16]);
});
