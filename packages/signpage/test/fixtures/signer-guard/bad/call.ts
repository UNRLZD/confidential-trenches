// planted (card signer-guard-parser): the rule's signer called through Function.prototype.call
import { signEvmSell } from "../../../../src/rules/pool.ts";

export const send = (key: Uint8Array, ctx: never, built: never) => signEvmSell.call(undefined, key, ctx, built);
