// planted (card signer-guard-parser, carried from precommit-taken-recover's inline cases): the kit's builder and the
// rule's signer called by their own names, with evmNextNote only in a comment
// const { next } = evmNextNote(seed, scope, events, first, finalBlock) would go here
import { evmPoolBuildSell } from "../../../../../kit/src/trade/evm/sell.ts";
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { fixtureBuildSell } from "../defs.ts";

export const build = (q: never, f: never) => evmPoolBuildSell(q, f);
export const send = (key: Uint8Array, ctx: never, built: never) => signEvmSell(key, ctx, built);
export const built = fixtureBuildSell({ chain: "base" });
