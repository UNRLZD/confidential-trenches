// The one table of where a token was launched and on which chain (card app-launchpad-chain-badges): a row's
// `launchpad` id -> the pad's own name and logo, a row's `chain` -> the chain's mark. Every logo is the brand's own
// public file, fetched 2026-11-03 from the source cited on its line (its site, or its own GitHub org or repo), cut to
// 64 px or less (PNG) or kept as served (SVG) in ./logos. The design folder's files are never used.
// Ids are spelled as the helper serves them: Solana rows carry Jupiter's `launchpad` field as is (apps/helper/src/data/
// solana/lists.ts); Base and Robinhood rows carry the factory table's pad (FACTORIES in apps/helper/src/data/evm/
// lists.ts, card market-data-evm-lists). An id with no row here, or null, draws no launchpad badge: never the raw id.

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
};

/** Pads the factory table names whose own brand files could not be found or cited: they draw no badge until they can. */
export const NO_LOGO: readonly string[] = ["spawn"];

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

/** The badge's diameter for an avatar of `size` px (design-lock-r5 P.badgeD): 36% of it, 10 to 16 px. */
export const badgeSize = (size: number): number => Math.max(10, Math.min(16, Math.round(size * 0.36)));
