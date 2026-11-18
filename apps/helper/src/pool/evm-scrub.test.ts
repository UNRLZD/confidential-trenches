// Card helper-scrubber-takes-the-kits-rule: the helper cleans a provider's words with the kit's one rule
// (secretScrubber, the kit's seatWords), so a keyed URL never reaches a helper log line or answer in any written form.
// The kit's 20 hostile forms (packages/kit/test/evm-read-two.test.ts, card device-evm-read-residuals) run here against
// the helper's scrubber, as do the forms past them this card found: a raw "+" in a query key the URL parser reads as
// a space.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as kit from "@blindfill/kit";
import * as evm from "./evm.ts";

const KEYED = "https://us3r:PaSs%2FW0rdSeCrEt@lb.drpc.live/robinhood/AkEySeCrEt0123456789?apikey=QuErYsEcReT0123456789";
const SEG_S = "AkEySeCrEt0123456789";
const QUERY_S = "QuErYsEcReT0123456789";
/** The kit's table, row for row (its test asserts the same 20). */
const HOSTILE: readonly (readonly [string, string])[] = [
  ["the seat's URL as is", `upstream ${KEYED} said no`],
  ["in upper case", `upstream ${KEYED.toUpperCase()} said no`],
  ["with a port", `upstream https://lb.drpc.live:443/robinhood/${SEG_S} said no`],
  ["a listed host with no scheme", `lb.drpc.live/robinhood/${SEG_S}`],
  ["an unlisted host's userinfo", `upstream https://user:${SEG_S}@other.example/x/${SEG_S}?k=${QUERY_S}`],
  ["a query alone", `bad request ?apikey=${QUERY_S}`],
  ["a path alone", `no route /robinhood/${SEG_S}`],
  ["JSON-escaped slashes", `{"url":"https:\\/\\/lb.drpc.live\\/robinhood\\/${SEG_S}"}`],
  ["percent-encoded", `redirect to ${encodeURIComponent(`https://lb.drpc.live/robinhood/${SEG_S}?apikey=${QUERY_S}`)}`],
  ["wss on an unlisted host", `try wss://ws.other.example/robinhood/${SEG_S}`],
  ["an unlisted host with no scheme", `mirror.other.example/robinhood/${SEG_S}`],
  ["a trailing-dot host", `lb.drpc.live./robinhood/${SEG_S}`],
  ["a backslash path", `lb.drpc.live\\robinhood\\${SEG_S}`],
  ["userinfo holding a slash", `upstream https://us3r:PaSs/W0rdSeCrEt@lb.drpc.live/x refused`],
  ["the password percent-encoded", `auth PaSs%2fW0rdSeCrEt refused`],
  ["a key cut short by the provider", `key AkEySeCrEt01… rejected`],
  ["a key alone in another case", `${SEG_S.toLowerCase()} is not a valid key`],
  ["a key in a JSON body", `{"error":"invalid key ${QUERY_S}"}`],
  ["a long Unicode run before the URL", `İ${"İ".repeat(5000)} ${KEYED}`],
  ["a backtick-quoted URL", "`" + `https://lb.drpc.live/x?apikey=${QUERY_S}` + "`"],
];
// any piece of a secret, in any case; the password's start "PaSs" in its own mixed case (in any case it is a common word)
const LEAK = (s: string) => /AkEySeCr|QuErYsEc|W0rdSeCr|%2fW0rd/i.test(s) || /PaSs/.test(s);

// the forms past the kit's 20 this card found, each with the keyed URL it is about: four the helper's own rule leaked at
// main (a password with a slash, JSON-escaped; a key as a bare query name; a key in the fragment; a path key of 8 to 15
// characters), and one both rules leaked (a query key holding a raw "+", which the URL parser reads as a space, so the
// key as written was no part either listed)
const PLUS_K = "PlUsKeY0+9876543210fedcba";
const PLUS_URL = `https://b.example/rpc?apikey=${PLUS_K}`;
const PAST: readonly (readonly [string, string, string, RegExp])[] = [
  ["a password holding a slash, JSON-escaped", KEYED, `{"auth":"PaSs\\/W0rdSeCrEt"}`, /W0rdSeCr/i],
  ["a key as a bare query name", "https://q.example/rpc?BaReNaMeKeY0123", "bad request BaReNaMeKeY0123 refused", /BaReNaMe/i],
  ["a key in the fragment", "https://f.example/rpc#FrAgKeY0123456", "no such route FrAgKeY0123456", /FrAgKeY0/i],
  ["a path key of 10 characters", "https://s.example/v2/Sh0rtK3y9z", "invalid key Sh0rtK3y9z", /Sh0rtK3y/i],
  ["a raw '+' query key alone", PLUS_URL, `invalid api key ${PLUS_K} for this plan`, /PlUsKeY0|98765/i],
  ["a raw '+' query key's rest past its first 8", PLUS_URL, `key ${PLUS_K.slice(0, 15)} rejected`, /PlUsKeY0|98765/i],
  ["a raw '+' query key percent-encoded", PLUS_URL, `bad ${encodeURIComponent(PLUS_K)} here`, /PlUsKeY0|98765/i],
];

const leaks = (scrub: (t: string) => string, rows: readonly (readonly [string, string])[], leak: (s: string) => boolean) =>
  rows.filter(([, words]) => leak(scrub(words))).map(([name, words]) => `${name}: ${scrub(words).slice(0, 120)}`);
const pastLeaks = (scrubber: (urls: readonly string[]) => (t: string) => string) =>
  PAST.filter(([, url, words, leak]) => leak.test(scrubber([url])(words))).map(([name, url, words]) => `${name}: ${scrubber([url])(words)}`);

test("the kit's 20 hostile forms: none leaves a piece of a keyed seat's secret in the helper's scrubbed words", () => {
  assert.equal(HOSTILE.length, 20);
  assert.deepEqual(leaks(evm.evmScrubber([KEYED]), HOSTILE, LEAK), []);
  // a log line's 160 and a refusal's 1,200 read the same: none past the cut either
  assert.deepEqual(leaks((t) => evm.evmScrubber([KEYED])(t).slice(0, 160), HOSTILE, LEAK), []);
});

test("the forms past the 20: none leaves a piece of its keyed URL's secret, in the helper's scrubber and the kit's", () => {
  assert.deepEqual(pastLeaks(evm.evmScrubber), []);
  assert.equal(typeof kit.secretScrubber, "function", "the kit's public entry exports its rule");
  assert.deepEqual(pastLeaks(kit.secretScrubber), []);
});

test("the helper's scrubber is the kit's one function, from its public entry: one rule, never a second", () => {
  assert.equal(evm.evmScrubber, kit.secretScrubber);
});

test("cleaned words keep what the helper decides on: the provider's code, 'execution reverted', a rate or limit word, the seat's host", () => {
  const scrub = evm.evmScrubber([KEYED]);
  assert.equal(scrub(`HTTP 429: rate limit exceeded at ${KEYED}`), "HTTP 429: rate limit exceeded at lb.drpc.live");
  assert.equal(scrub(`RPC error 3: execution reverted (${KEYED})`), "RPC error 3: execution reverted (lb.drpc.live");
  assert.equal(scrub("RPC error -32005: limit exceeded"), "RPC error -32005: limit exceeded");
});
