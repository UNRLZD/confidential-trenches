// planted (card signer-guard-parser, reviewer variant b31 of 40115c3d): a pool deposit as W's own send, its calldata
// built at run time, signed by the helper's exported transaction signer imported onto the device
import { signEvmTx } from "../../../../../../apps/helper/src/pool/evm.ts";
const t = "uint256";
export const SIG = ["deposit(", t, ",", t, ")"].join("");
export const send = (wKey: Uint8Array, tx: Parameters<typeof signEvmTx>[0], data: Uint8Array) => signEvmTx({ ...tx, data }, wKey);
