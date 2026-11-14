// The one table of where a token was launched and on which chain (card app-launchpad-chain-badges): a row's
// `launchpad` id -> the pad's own name and logo, a row's `chain` -> the chain's mark. Every logo is the brand's own
// public file, fetched 2026-11-03 from the source cited on its line (its site, or its own GitHub org or repo), cut to
// 64 px or less (PNG) or kept as served (SVG) in ./logos. The design folder's files are never used.
// Ids are spelled as the helper serves them: Solana rows carry Jupiter's `launchpad` field as is (apps/helper/src/data/
// solana/lists.ts); Base and Robinhood rows carry the factory table's pad (FACTORIES in apps/helper/src/data/evm/
// lists.ts, card market-data-evm-lists); NEAR rows carry the UNRLZD engine's pad id as the helper reads it (apps/helper/
// src/data/near/engine.ts), its NEAR pads' logos fetched 2026-11-14 from the source on their line, the same files the
// UNRLZD terminal's launchpad registry cites (apps/terminal/public/launchpads/manifest.json there). An id with no row
// here, or null, draws no launchpad badge: never the raw id.

export type Pad = { name: string; logo: string; src: string };
export type ChainMark = { name: string; logo: string; src: string; /** Padding inside the round badge, 0-0.5 of its size. */ inset: number };

const at = (f: string) => new URL(`./logos/${f}`, import.meta.url).href;

const PUMP: Pad = { name: "pump.fun", logo: at("pumpfun.png"), src: "https://avatars.githubusercontent.com/u/148890315 (github.com/pump-fun, the org whose site is pump.fun; pump.fun itself answers 403 to a script)" };
const RAYDIUM = "https://raydium.io/favicon.ico";
const BAGS = "https://bags.fm/icon.png";

export const PADS: Readonly<Record<string, Pad>> = {
  // Solana (Jupiter's ids)
  "pump.fun": PUMP,
  stonkfun: { name: "StonkFun", logo: at("stonkfun.png"), src: "https://www.stonkfun.xyz/stonkfun-logo.png" },
  "raydium-launchlab": { name: "LaunchLab", logo: at("raydium.png"), src: RAYDIUM },
  Raydium: { name: "Raydium", logo: at("raydium.png"), src: RAYDIUM },
  "met-dbc": { name: "Meteora", logo: at("meteora.png"), src: "https://www.meteora.ag/apple/apple-icon-180x180.png" },
  "letsbonk.fun": { name: "bonk.fun", logo: at("bonkfun.png"), src: "https://bonk.fun/logos/bonk_fun.png" },
  metadao: { name: "MetaDAO", logo: at("metadao.svg"), src: "https://github.com/metaDAOproject/programs/blob/419cdea3743646784388b2225ca72e8a09c490ab/docs/.gitbook/assets/MetaDAO-logo.svg" },
  "jup-studio": { name: "Jupiter Studio", logo: at("jupstudio.png"), src: "https://studio.jup.ag/favicon.ico" },
  "bags.fun": { name: "Bags", logo: at("bags.png"), src: BAGS },
  grainpad: { name: "grainpad", logo: at("grainpad.svg"), src: "https://grainpad.fun/favicon.svg" },
  // Base and Robinhood (the factory table's ids)
  zora: { name: "Zora", logo: at("zora.png"), src: "https://zora.co/assets/favicon/apple-touch-icon.png" },
  clanker: { name: "Clanker", logo: at("clanker.png"), src: "https://www.clanker.world/logo_circle.png" },
  doppler: { name: "Doppler", logo: at("doppler.png"), src: "https://www.doppler.lol/favicon.ico" },
  flaunch: { name: "Flaunch", logo: at("flaunch.svg"), src: "https://flaunch.gg/favicon.svg" },
  virtuals: { name: "Virtuals", logo: at("virtuals.png"), src: "https://app.virtuals.io/apple-touch-icon.png" },
  pons: { name: "Pons", logo: at("pons.png"), src: "https://ponsfamily.com/favicon.png" },
  bags: { name: "Bags", logo: at("bags.png"), src: BAGS },
  torch: { name: "Torch", logo: at("torch.png"), src: "https://torchpad.fun/brand/TorchMark-400.png (the site's apple-touch-icon)" },
  // NEAR (the engine's ids)
  hoot: { name: "Hoot", logo: at("hoot.png"), src: "https://justhoot.fun/logo.png (128 px, cut to 64)" },
  nearlytrade: { name: "Nearly.trade", logo: at("nearlytrade.svg"), src: "https://nearly.trade/favicon.svg" },
  qlyphs: { name: "Qlyphs", logo: at("qlyphs.svg"), src: "https://qlyphs.com/icon.svg" },
  memecooking: { name: "meme.cooking", logo: at("memecooking.png"), src: "https://meme.cooking/assets/apple-touch-icon.png (180 px, cut to 64)" },
  nearpaid: { name: "NearPaid", logo: at("nearpaid.png"), src: "https://nearpaid.com/apple-touch-icon.png (180 px, cut to 64)" },
};

/** Pads the lists name whose own brand files could not be found or cited: they draw no badge until they can. GayPad
 *  (factory gaypad.j1-racing.near) and token0 (token0.near) have no site of their own: gaypad.xyz is a parked lander
 *  and gaypad.fun answers "Offline" (read 14 Nov 06:3xZ), token0 has none (the UNRLZD registry's research). */
export const NO_LOGO: readonly string[] = ["spawn", "gaypad", "token0"];

const ROBINHOOD: ChainMark = { name: "Robinhood", logo: at("robinhood.png"), src: "https://robinhood.com/us/en/rh_favicon_120.png", inset: 0 };

export const CHAINS: Readonly<Record<string, ChainMark>> = {
  solana: { name: "Solana", logo: at("solana.svg"), src: "https://github.com/solana-foundation/solana-com/blob/4a3bcdb476ce73f4e2a2f92c4856d7c1fc728727/apps/web/public/src/img/branding/solanaLogoMark.svg", inset: 0.2 },
  base: { name: "Base", logo: at("base.svg"), src: "https://github.com/base/brand-kit/blob/eba9e730be34f8c9ae7f9a21f32cc6aafebe2ad1/logo/TheSquare/Digital/Base_square_blue.svg", inset: 0.2 },
  robinhood: ROBINHOOD,
  near: { name: "NEAR", logo: at("near.png"), src: "https://near.org/apple-touch-icon.png", inset: 0 },
};

const own = (t: object, k: string) => Object.prototype.hasOwnProperty.call(t, k);

/** The pad a row's `launchpad` names, or null: null, an unknown id or a pad with no logo draws no badge. */
export function padOf(id: string | null | undefined): Pad | null {
  return typeof id === "string" && own(PADS, id) ? PADS[id]! : null;
}

/** The mark of a row's chain, or null for a chain this table does not know. */
export function chainOf(chain: string | null | undefined): ChainMark | null {
  return typeof chain === "string" && own(CHAINS, chain) ? CHAINS[chain]! : null;
}

/** OKLCH, as the main app's padColors.ts writes a ring colour. */
export type RingColor = { l: number; c: number; h: number };

/**
 * The ring colour of each pad, by the main app's method (UNRLZD components/viz/padColors.ts): the brand colour sampled
 * from the pad's own logo in ./logos (the chroma-weighted main hue of its opaque pixels), kept saturated and clean, then
 * moved by the smallest hue, lightness or chroma step until it clears the gain green, the loss red, the live blue, the
 * neutral ring and every pad above it (test/pad-rings.test.ts holds each rule). The comment is the sample it moved from.
 * A pad whose logo has no brand colour (white or grey on black) takes the one neutral ring, NEUTRAL_RING.
 */
export const PAD_RING: Readonly<Record<string, RingColor | "neutral">> = {
  "pump.fun": { l: 0.76, c: 0.12, h: 154 }, // 0.76 0.14 154
  "met-dbc": { l: 0.73, c: 0.18, h: 50 }, // 0.73 0.18 50
  "letsbonk.fun": { l: 0.63, c: 0.18, h: 39 }, // 0.67 0.20 39
  metadao: { l: 0.61, c: 0.24, h: 25 }, // 0.67 0.22 25
  Raydium: { l: 0.59, c: 0.2, h: 261 }, // 0.62 0.20 261
  "raydium-launchlab": { l: 0.56, c: 0.24, h: 278 }, // 0.62 0.20 261 (Raydium's logo)
  stonkfun: { l: 0.69, c: 0.1, h: 225 }, // 0.69 0.10 225
  "jup-studio": { l: 0.73, c: 0.1, h: 53 }, // 0.73 0.09 53
  grainpad: { l: 0.56, c: 0.18, h: 20 }, // 0.70 0.20 43
  zora: { l: 0.72, c: 0.14, h: 268 }, // 0.57 0.16 268
  clanker: { l: 0.6, c: 0.17, h: 298 }, // 0.60 0.17 298
  flaunch: { l: 0.7, c: 0.22, h: 349 }, // 0.70 0.24 349
  virtuals: { l: 0.63, c: 0.1, h: 192 }, // 0.63 0.09 192
  torch: { l: 0.78, c: 0.22, h: 148 }, // 0.80 0.16 148
  // NEAR: each from the UNRLZD terminal's value for the same logo (components/viz/padColors.ts), moved by the least
  // step that clears every rule here
  hoot: { l: 0.66, c: 0.14, h: 67 }, // 0.71 0.17 50
  qlyphs: { l: 0.66, c: 0.21, h: 9 }, // 0.63 0.25 30
  nearlytrade: { l: 0.57, c: 0.11, h: 159 }, // 0.59 0.10 169
  memecooking: { l: 0.58, c: 0.18, h: 139 }, // 0.56 0.17 140
  nearpaid: { l: 0.88, c: 0.1, h: 211 }, // 0.88 0.10 211
  "bags.fun": "neutral", // white on black
  bags: "neutral", // white on black
  doppler: "neutral", // white on black
  pons: "neutral", // grey chrome, chroma 0.07
};

/** The one ring of a pad with no brand colour (the app's --text-2). */
export const NEUTRAL_RING = "#a3a3a3";

/** The CSS colour of a row's launchpad ring, or null when the row names no pad this table knows (the ring keeps its
 *  stage colour, as the main app's does). */
export function padRing(id: string | null | undefined): string | null {
  if (typeof id !== "string" || !own(PAD_RING, id)) return null;
  const r = PAD_RING[id]!;
  return r === "neutral" ? NEUTRAL_RING : `oklch(${r.l} ${r.c} ${r.h})`;
}

/** The badge's diameter for an avatar of `size` px (design-lock-r5 P.badgeD): 36% of it, 10 to 16 px. */
export const badgeSize = (size: number): number => Math.max(10, Math.min(16, Math.round(size * 0.36)));
