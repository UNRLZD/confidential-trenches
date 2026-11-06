// planted (card signer-guard-parser, reviewer variant b07-return-user of 1a8a42f0)
import { getSigner } from "./b06a-guarded-holder.ts";
export const send = (k: Uint8Array, c: never, b: never) => getSigner()(k, c, b);
