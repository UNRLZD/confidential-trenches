// planted (card signer-guard-parser, reviewer variant b05c-destructure-json-plain of 1a8a42f0)
import * as kit from "../../../../../../packages/kit/src/index.ts";
import names from "./names.json" with { type: "json" };
// @ts-expect-error a string key on the namespace
const { [names.s]: s } = kit;
export const send = (k: Uint8Array, b: never) => s(k, "base", b);
