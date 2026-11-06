// planted (card signer-guard-parser): a local function named evmNextNote guards nothing; the rule's signer is called
import { signEvmSell } from "../../../../src/rules/pool.ts";

function evmNextNote(): void {}
export const send = (key: Uint8Array, ctx: never, built: never) => {
  evmNextNote();
  return signEvmSell(key, ctx, built);
};
