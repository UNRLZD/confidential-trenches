// planted (card signer-guard-parser), no refusal: a local value that shares a signer's name is not the signer
const signEvmSell = (n: number) => n + 1;
export const one = signEvmSell(0);
export const label = { evmPoolSignSell: "a label", functionName: "withdraw" };
// names destructured one by one from a namespace that also exports a signer: only the names taken are read
import * as sell from "../../../../../kit/src/trade/evm/sell.ts";
const { EvmPoolSellError } = sell;
export const failed = new EvmPoolSellError("not_built", "planted");
