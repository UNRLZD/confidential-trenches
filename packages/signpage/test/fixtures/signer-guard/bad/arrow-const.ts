// planted (card signer-guard-parser): a call of a signer defined as a typed-arrow const (fixtures/signer-guard/defs.ts)
import { fixtureSignSell } from "../defs.ts";

export const send = (key: Uint8Array) => fixtureSignSell(key, { chain: "base" });
