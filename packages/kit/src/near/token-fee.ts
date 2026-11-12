// A NEAR token's own transfer fee, read from the token's view and applied only where the token's code takes it. Some
// launchpad tokens keep part of a transfer: the venue's minimum-out check runs before the fee is taken, so the device
// must count the fee itself (a buy delivers less than the venue paid out; a sell gives the venue less than was sent).
//
// The table is the one the UNRLZD trading terminal reads (its packages/trade/src/token-tax.ts, read for the venue facts):
// each launchpad (the token's parent account), the view its tokens answer, and the code hashes that view was measured
// on. The rule is that terminal's too:
// - a token under no listed launchpad carries no fee;
// - a listed token's fee is read at the quote's block, and applies only on the venues its scope names ("all": every
//   transfer), never on a venue the token lists as exempt;
// - a view the code has no method for is 0% on code pinned as having none, and an unread or unknown answer, or a rate
//   read from code that is not pinned, is quoted at 0% and marked `unknown`, so the screen says the fee is not known.
// The fee never blocks a trade; it is shown, and the device's numbers count it.

/** The longest fee view answer read (the terminal's MAX_TAX_VIEW_BYTES). */
export const NEAR_TOKEN_FEE_VIEW_MAX_BYTES = 16_384;

type Pad = "nearly" | "nearpaid" | "nucleus" | "nearrr" | "hoot" | "rheameme";

/** nearly.trade's templates with get_tax, then those with no fee code at all. */
const NEARLY_TAXED = ["1uGuBEpx3dFRDrr2wNzm5Vcb5sF3jWY3AKQ3Gopd6we", "YXJL2KYynDA52JPBpAP5qDZhJqCTfB6dR5Ee4jdEgDK", "Cct6RbLZAEs5WmKkPFr4qqTAWKKzPhE4aTJHVwNLeGBS", "8GXVnFTxx1d6tYnoqNiQ5YzzQpj1uyxG7u28LeCGmsER"];
const NEARLY_UNTAXED = ["5qScjXG9uRG82Yrh36XZNZgVUYiqPtuC9ep5DvV42eGQ", "B6EjqsNJXfQXYX1KkUaypN8z7KpYcBrf9JNwTVtWUUBY", "54GH1DmZgArERRH2ed8zJBXT7UxdeumaZe8Du8dtYJrt"];
const NEARRR_TAXED = ["AV2tF8CMPhgMLF13oiuuHvn5ArhR8dUx6HcspxqFUB69", "9euqG2zMa65iLEsk934AByTB9YqCtbJNsPjRzmJQtMnU", "8RRPK2YmcMonzHVhXGQWk4mHdJs1KMVonYxrcEUNosF9"];
/** Nearrr's first template: no fee code (it caps holdings, which a venue's transfer then refuses on chain). */
const NEARRR_UNTAXED = "GtS8LEn8Q6x4iyPwAPwJp1kbzCyJnq97Rm5E8bFuj4qS";
/** JustHoot's token codes, which Rhea's meme launchpad runs too. */
const HOOT = ["9afh213xddvqMpmz3sZXDwtvJ19hkTsQwFhpNEmrq8QN", "G5e8FihMhiHoQduWMxSApGdZTtTCUrWV3daAtqt6DSB1", "kS1z69vkEemTNtvSokhdwRZGiMZrGEiUsxM1h6T898N", "2uPhSwUzMbV9MHHitiWUKTdPeRGYXHJungpoH5kDbL2d"];

const FACTORIES: Readonly<Record<string, Pad>> = Object.freeze({
  "nearlytrade.near": "nearly",
  "nearpaid.near": "nearpaid",
  "nucleusbroker.near": "nucleus",
  "nearrr-fun.near": "nearrr",
  "launchpad.justhoot.near": "hoot",
  "v2-launchpad.justhoot.near": "hoot",
  "rhea.meme-launchpad.near": "rheameme",
  "v2.meme-launchpad.near": "rheameme",
});
const VIEW: Readonly<Record<Pad, string>> = Object.freeze({ nearly: "get_tax", nearpaid: "tax_info", nucleus: "get_tax", nearrr: "tax_state", hoot: "get_config", rheameme: "get_config" });
const PINNED: Readonly<Record<Pad, readonly string[]>> = Object.freeze({
  nearly: [...NEARLY_TAXED, ...NEARLY_UNTAXED],
  nearpaid: ["ALZF4JurwxqkfB8aktDiSkFxggh4Ec5EpdaU9CfVKTNg"],
  nucleus: ["AcUSSxMmqbBmACUrThokZaYWHi3MaNXRStqbcC7mtaZz"],
  nearrr: [...NEARRR_TAXED, NEARRR_UNTAXED],
  hoot: HOOT,
  rheameme: HOOT,
});
/** Pinned code with no fee view: a view that fails there is the expected 0%. */
const NO_VIEW: readonly string[] = [...NEARLY_UNTAXED, NEARRR_UNTAXED];
/** Nearrr: Standard mode cuts 0.5% a transfer; Tax mode adds a 1% platform share to the rates it reads. */
const NEARRR_STANDARD_BPS = 50;
const NEARRR_PLATFORM_BPS = 100;

/** A token's fee as the device counts it. */
export type NearTokenFee = {
  /** what a buyer receives less, in bps of what the venue pays out */
  buyBps: number;
  /** what the venue receives less on a sell (or, senderPays, what the seller pays on top), in bps */
  sellBps: number;
  /** the seller pays the fee on top of the amount sent (the venue receives all of it) */
  senderPays: boolean;
  /** the venues it applies on: "all" or their account ids */
  scope: "all" | readonly string[];
  exempt: readonly string[];
  /** the fee could not be read with certainty, so it is counted as 0% */
  unknown: boolean;
};

export const NEAR_TOKEN_NO_FEE: NearTokenFee = Object.freeze({ buyBps: 0, sellBps: 0, senderPays: false, scope: Object.freeze([]), exempt: Object.freeze([]), unknown: false });

/**
 * The code hashes of plain NEP-141 tokens, with no fee of their own on a transfer: a token under no listed launchpad
 * counts 0% only when its code (or the global contract it runs) is one of these, read on both providers at the
 * quote's block; any other is counted 0% and marked unknown, never a silent 0%. Started from the tokens of the
 * recorded mainnet swaps and quotes (test/fixtures/near-rhea-swaps.json, near-rhea-quotes.json), each hash read by
 * view_account on mainnet on 11 Nov: wrap.near, token.rhealab.near, zec.omft.near.
 */
export const NEAR_PLAIN_TOKEN_CODES: readonly string[] = Object.freeze([
  "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1", // wrap.near
  "3XbB1xkQTNFhtizVSCNW5xM9MyuF3AYhFKc8HAPc3pdx", // token.rhealab.near
  "2akS4vNtbGMSoAPYf4FXbgyZypb4HYJDMcbVq95KYz6g", // zec.omft.near
]);

/** The fee of a token under no listed launchpad, from its code hash at the quote's block (null: not read). */
export function nearPlainTokenFee(codeHash: string | null): NearTokenFee {
  return codeHash !== null && NEAR_PLAIN_TOKEN_CODES.includes(codeHash) ? NEAR_TOKEN_NO_FEE : Object.freeze({ ...NEAR_TOKEN_NO_FEE, unknown: true });
}

/** The view a token's fee is read from, or null for a token under no listed launchpad (its code hash decides). */
export function nearTokenFeeView(token: string): { pad: Pad; method: string } | null {
  for (const [f, pad] of Object.entries(FACTORIES)) if (token.endsWith(`.${f}`)) return { pad, method: VIEW[pad] };
  return null;
}

const bps = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 10_000 ? v : undefined);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * The fee from the token's code hash and its fee view's answer at one block: `view` is the parsed JSON, or
 * { failed: true } when the contract has no such method or the view failed on chain.
 */
export function nearTokenFee(pad: Pad, codeHash: string | null, view: { value: unknown } | { failed: true }): NearTokenFee {
  const pinned = codeHash !== null && PINNED[pad].includes(codeHash);
  const unknown = (): NearTokenFee => ({ ...NEAR_TOKEN_NO_FEE, unknown: true });
  if ("failed" in view) return codeHash !== null && NO_VIEW.includes(codeHash) ? NEAR_TOKEN_NO_FEE : unknown();
  const fee = (buy: number, sell: number, senderPays: boolean, scope: "all" | readonly string[], exempt: readonly string[]): NearTokenFee =>
    !pinned ? unknown() : buy === 0 && sell === 0 ? NEAR_TOKEN_NO_FEE : { buyBps: buy, sellBps: sell, senderPays, scope, exempt, unknown: false };
  const v = view.value;
  switch (pad) {
    case "nearly": {
      const o = obj(v);
      if (o && "tax" in o && o.tax === null) return fee(0, 0, false, [], []);
      const t = obj(o?.tax);
      const b = bps(t?.buy_bps);
      const s = bps(t?.sell_bps);
      const ex = t?.exempt ?? [];
      if (b === undefined || s === undefined || !strings(t?.pairs) || !strings(ex)) return unknown();
      return fee(b, s, false, [...t.pairs], [...ex]);
    }
    case "nearpaid": {
      const o = obj(v);
      const b = bps(o?.buy_bps);
      const s = bps(o?.sell_bps);
      if (b === undefined || s === undefined) return unknown();
      return fee(b, s, false, "all", []);
    }
    case "nucleus": {
      const b = Array.isArray(v) ? bps(v[0]) : undefined;
      const pair = Array.isArray(v) ? v[1] : undefined;
      if (b === undefined || typeof pair !== "string") return unknown();
      return fee(b, b, true, [pair], []);
    }
    case "nearrr": {
      const o = obj(v);
      const b = bps(o?.buy_tax_bps);
      const s = bps(o?.sell_tax_bps);
      if (!o || b === undefined || s === undefined) return unknown();
      if (o.mode === "Standard") return fee(NEARRR_STANDARD_BPS, NEARRR_STANDARD_BPS, false, "all", []);
      if (o.mode !== "Tax" || b + NEARRR_PLATFORM_BPS >= 10_000 || s + NEARRR_PLATFORM_BPS >= 10_000) return unknown();
      return fee(b + NEARRR_PLATFORM_BPS, s + NEARRR_PLATFORM_BPS, false, "all", []);
    }
    case "hoot":
    case "rheameme": {
      const o = obj(v);
      const pips = o?.transfer_fee_pips;
      // pips (1e-6) rounded up to whole bps: the fee counted is never under the fee taken
      const b = typeof pips === "number" && Number.isSafeInteger(pips) && pips >= 0 ? bps(Math.ceil(pips / 100)) : undefined;
      const dcl = o?.dcl_exchange_id;
      if (b === undefined || typeof dcl !== "string" || dcl === "") return unknown();
      return fee(b, b, false, [dcl], []);
    }
  }
}

/** Whether `fee` applies to a transfer to or from `venue`. */
export function nearTokenFeeApplies(fee: NearTokenFee, venue: string): boolean {
  return (fee.buyBps > 0 || fee.sellBps > 0) && (fee.scope === "all" || fee.scope.includes(venue)) && !fee.exempt.includes(venue);
}

/** What the venue receives of `sent` on a sell into it (a receiver-pays fee comes off; floor). */
export function nearFeeVenueReceives(fee: NearTokenFee, venue: string, sent: bigint): bigint {
  if (!nearTokenFeeApplies(fee, venue) || fee.senderPays || fee.sellBps === 0) return sent;
  return (sent * BigInt(10_000 - fee.sellBps)) / 10_000n;
}

/**
 * The most a wallet holding `balance` can sell into `venue`: all of it, or, when the token's fee is the sender's to pay
 * on top there (nucleus), floor(balance × 10⁴ / (10⁴ + bps)), so the amount and its fee fit what is held (the UNRLZD
 * trading terminal's senderTaxSellAmount); a full-balance send would fail.
 */
export function nearSellAmount(fee: NearTokenFee, venue: string, balance: bigint): bigint {
  if (typeof balance !== "bigint" || balance < 0n) throw new Error("balance: not an amount");
  if (!fee.senderPays || fee.sellBps === 0 || !nearTokenFeeApplies(fee, venue)) return balance;
  return (balance * 10_000n) / BigInt(10_000 + fee.sellBps);
}

/** What the buyer receives of `paid` out of the venue (floor). */
export function nearFeeBuyerReceives(fee: NearTokenFee, venue: string, paid: bigint): bigint {
  if (!nearTokenFeeApplies(fee, venue) || fee.buyBps === 0) return paid;
  return (paid * BigInt(10_000 - fee.buyBps)) / 10_000n;
}
