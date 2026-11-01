// node test/passkey.e2e.mjs (from packages/wallet): the card's browser proof. Headless Chromium with a CDP virtual
// authenticator with PRF (app.md 5.0, A:1312) on the browser harness, SIGN_HOST's real name mapped to the signing page's
// own build under its own _headers (CSP with Trusted Types, Integrity-Policy): create, reload, sign out, sign in
// (scripts/live-checks/wallet-passkey-prf.mjs's steps, and its verdict), then the account the page shows is the kit's
// own derivation (kit-freeze-keys: entropyFromPrf, the 12 words, seed64, T_0) of that passkey's PRF output, and the kit
// still gives A.8's vectors. A no-PRF authenticator opens the no-PRF path. Run it through scripts/heavy.sh (Playwright).
// The PRF output stays in this process's memory; nothing secret is printed. exit 0 all as expected, 1 otherwise.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as d from "../src/derive/index.ts";
import { judge, probe } from "../../../scripts/live-checks/wallet-passkey-prf.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? "ok " : "BAD"} ${name}: ${detail}`);
};

const { record, prf } = await probe({ harness: true });
const v = judge(record);
for (const l of v.lines) console.log(`    ${l}`);
check("the live check's steps on the harness", v.pass, v.pass ? "PASS" : "FAIL");

const A = record.prf.steps?.signin?.account;
let kit = null;
if (prf) kit = d.profileKey(d.wordsToSeed64(d.entropyToWords(d.entropyFromPrf(Uint8Array.from(Buffer.from(prf, "hex"))))), 0).id;
check("the page's account is the kit's T_0 of the passkey's PRF output", !!kit && kit === A && kit === record.prf.expected,
  `kit ${kit ? "derived" : "none"}, ${kit === A ? "equal to the page" : "differs from the page"}, ${kit === record.prf.expected ? "equal to the check's own" : "differs from the check's own"}`);

const a8 = JSON.parse(readFileSync(join(PKG, "test/vectors/a8.json"), "utf8"));
const seed0 = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const t = a8.ids.filter((x) => x.kind === "profile");
check("the kit still gives A.8's profile keys", t.length > 0 && t.every((x) => d.profileKey(seed0, x.k).id === x.id), `${t.length} vectors`);

const ok = results.every(Boolean);
console.log(ok ? "passkey e2e: all as expected" : "passkey e2e: FAILED");
process.exit(ok ? 0 : 1);
