// planted (card signer-guard-parser): a file that only imports another file's const holding a signer, and calls it;
// the file that holds it (bad/reassign-export.ts) is caught on its own
import { held } from "./reassign-export.ts";

export const send = (key: Uint8Array, ctx: never, built: never) => held(key, ctx, built);
