// The launchpad and chain table (card app-launchpad-chain-badges, src/screens/market/pads.ts): every id the helper's
// lists served on 3 Nov maps to its pad's own name and a logo file in the app; null, an unknown id and a pad with no
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
/** The factory table's pads (apps/helper/src/data/evm/lists.ts FACTORIES, card market-data-evm-lists at 8d6e279). */
const EVM = ["zora", "clanker", "doppler", "flaunch", "virtuals", "pons", "bags"];
const NAMES: Record<string, string> = {
  "pump.fun": "pump.fun", stonkfun: "StonkFun", "raydium-launchlab": "LaunchLab", Raydium: "Raydium", "met-dbc": "Meteora", "letsbonk.fun": "bonk.fun",
  metadao: "MetaDAO", "jup-studio": "Jupiter Studio", "bags.fun": "Bags", grainpad: "grainpad", zora: "Zora", clanker: "Clanker", doppler: "Doppler",
  flaunch: "Flaunch", virtuals: "Virtuals", pons: "Pons", bags: "Bags",
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

test("every id served on 3 Nov, Solana and EVM, maps to its pad's own name and a logo file in the app, with its source cited", () => {
  for (const id of [...SOLANA, ...EVM]) {
    const p = padOf(id);
    assert.ok(p, `${id} has no row`);
    assert.equal(p.name, NAMES[id], id);
    assert.equal(logoFault(p.logo), null, `${id}: ${logoFault(p.logo)}`);
    assert.match(p.src, /^https:\/\//, `${id}: source not cited`);
  }
  assert.deepEqual(Object.keys(PADS).sort(), [...SOLANA, ...EVM].sort(), "a row with no test, or a test id with no row");
});

test("null, undefined, an unknown id, an Object prototype key and a pad with no cited logo draw no launchpad badge", () => {
  for (const id of [null, undefined, "", "unknown-pad", "PUMP.FUN", "__proto__", "toString", "constructor", ...NO_LOGO]) assert.equal(padOf(id), null, String(id));
  assert.deepEqual(NO_LOGO, ["spawn"]);
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

// once card market-data-evm-lists is on this tree, every pad its factory table can tag must have a row (or be NO_LOGO)
const EVM_SRC = path.resolve(HERE, "../../helper/src/data/evm/lists.ts");
test("the EVM factory table's pads all have rows", { skip: !existsSync(EVM_SRC) && "apps/helper/src/data/evm/lists.ts is not on this tree yet (card market-data-evm-lists)" }, () => {
  const pads = new Set([...readFileSync(EVM_SRC, "utf8").matchAll(/\{ pad: "([^"]+)"/g)].map((m) => m[1]!));
  assert.ok(pads.size > 0);
  assert.deepEqual([...pads].filter((p) => padOf(p) === null && !NO_LOGO.includes(p)), []);
});

test("badge size: 36% of the avatar, 10 to 16 px (design-lock-r5 P.badgeD)", () => {
  assert.deepEqual([20, 32, 40, 46, 50, 54, 80].map(badgeSize), [10, 12, 14, 16, 16, 16, 16]);
});
