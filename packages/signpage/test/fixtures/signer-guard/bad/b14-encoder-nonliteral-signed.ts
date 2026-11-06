// planted (card signer-guard-parser, reviewer variant b14 of 40115c3d, with a signature): an ethers-style encoder given
// the function's name by a const, signed by the helper's own transaction signer
import { signEvmTx } from "../../../../../../apps/helper/src/pool/evm.ts";
type Iface = { encodeFunctionData(name: string, args: readonly unknown[]): Uint8Array };
const fn = "deposit";
export const send = (iface: Iface, tx: Parameters<typeof signEvmTx>[0], wKey: Uint8Array, p: bigint, a: bigint) => signEvmTx({ ...tx, data: iface.encodeFunctionData(fn, [p, a]) }, wKey);
