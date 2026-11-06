// planted (card signer-guard-parser), no refusal: a local value that shares a signer's name is not the signer
const signEvmSell = (n: number) => n + 1;
export const one = signEvmSell(0);
export const label = { evmPoolSignSell: "a label", functionName: "withdraw" };
