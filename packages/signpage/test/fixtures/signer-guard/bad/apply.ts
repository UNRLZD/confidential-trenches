// planted (card signer-guard-parser): the kit's signer called through Function.prototype.apply
import { evmPoolSignSell } from "../../../../../kit/src/trade/evm/sell.ts";

export const send = (args: Parameters<typeof evmPoolSignSell>) => evmPoolSignSell.apply(null, args);
