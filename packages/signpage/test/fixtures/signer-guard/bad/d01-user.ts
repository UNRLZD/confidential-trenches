// planted (card signer-guard-parser, reviewer variant d01 of 1a8a42f0): a call of d01-defs.ts's signer, its note never picked
import { fastPath } from "../d01-defs.ts";

export const send = (key: Uint8Array) => fastPath(key);
