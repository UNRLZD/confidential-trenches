/// <reference types="node" />
// Card solana-uncapped-fits, fold 2: the trade's build is a cap search judged on the device's own assembly (Jupiter's
// requote with lower max accounts, developers.jup.ag/docs/swap/requote-with-lower-max-accounts): 40 first, up on
// "No routes found" (40, 48, 60: the reach of 3 builds), down when the assembly is over 1,232 bytes (40 to 32, any other cap by 4, never
// to a cap known to have no route), at most SOLANA_JUPITER_MAX_BUILDS builds. The builds here are one recorded build
// (test/fixtures/solana-builds.json `good`) answered at every cap; `fit` stands in for the device's assembly and says,
// per cap, whether it is over 1,232 bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SOLANA_JUPITER_CAP_UP,
  SOLANA_JUPITER_MAX_BUILDS,
  SolanaBuildError,
  fetchSolanaJupiterBuildThatFits,
  solanaNextCap,
  type SolanaBuildRequest,
} from "../src/trade/solana/build.ts";
import type { SolanaFetch } from "../src/trade/solana/send.ts";

const G = JSON.parse(readFileSync(new URL("./fixtures/solana-builds.json", import.meta.url), "utf8")).good as { mint: string; wallet: string; shapes: { body: string }[] };
const ORIGIN = "https://ct-api.unrealized.trade";
const R: SolanaBuildRequest = { side: "buy", wallet: G.wallet, token: G.mint, amount: 10_000_000n, slippageBps: 1000 };
const capOf = (url: string) => Number(new URL(url).searchParams.get("maxAccounts"));

// Jupiter, by cap: "none" (No routes found), "big" (a route the device assembles over 1,232 bytes) or "fit".
function world(by: Record<number, "none" | "big" | "fit" | "503">) {
  const asked: number[] = [];
  const f: SolanaFetch = async (url) => {
    const cap = capOf(url);
    asked.push(cap);
    const w = by[cap] ?? "none";
    if (w === "none") return new Response('{"error":"No routes found"}', { status: 400 });
    if (w === "503") return new Response('{"error":{"code":"upstream"}}', { status: 503 });
    return new Response(G.shapes[0]!.body, { status: 200 });
  };
  const fit = (_b: unknown, cap: number) => {
    if (by[cap] === "big") throw new SolanaBuildError("too_large", `${1200 + cap} bytes > 1232`);
    return `tx at ${cap}`;
  };
  return { f, fit, asked };
}
const run = (by: Record<number, "none" | "big" | "fit" | "503">) => {
  const w = world(by);
  return { w, p: fetchSolanaJupiterBuildThatFits(ORIGIN, R, w.fit, { fetch: w.f }) };
};

test("the steps: up 40, 48, 60 on no route; down 40 to 32 and by 4 on too large; never onto a cap known bad", () => {
  // fold 3: the steps and the bound agree, every step up is one the 3 builds from 40 reach (60 is the third)
  assert.deepEqual(SOLANA_JUPITER_CAP_UP, { 40: 48, 48: 60 });
  assert.equal(SOLANA_JUPITER_MAX_BUILDS, 3);
  assert.equal(solanaNextCap(40, "no_route", 40, 65), 48);
  assert.equal(solanaNextCap(48, "no_route", 48, 65), 60);
  assert.equal(solanaNextCap(60, "no_route", 60, 65), null);
  assert.equal(solanaNextCap(64, "no_route", 64, 65), null);
  // no route below a cap known too large still goes half way between them
  assert.equal(solanaNextCap(32, "no_route", 32, 40), 36);
  assert.equal(solanaNextCap(40, "too_large", 0, 40), 32);
  assert.equal(solanaNextCap(48, "too_large", 40, 48), 44);
  assert.equal(solanaNextCap(60, "too_large", 48, 60), 56);
  // 52's too_large with 48 known to have no route: 52 - 4 is 48, so half way, 50
  assert.equal(solanaNextCap(52, "too_large", 48, 52), 50);
  // a no route above a known too_large never steps up past it
  assert.equal(solanaNextCap(40, "no_route", 40, 48), 44);
  assert.equal(solanaNextCap(44, "no_route", 44, 45), null);
});

test("a route at 40 that fits: one build", async () => {
  const { w, p } = run({ 40: "fit" });
  const got = await p;
  assert.deepEqual(w.asked, [40]);
  assert.equal(got.fitted, "tx at 40");
  assert.deepEqual(got.steps, [{ maxAccounts: 40, outcome: "fits" }]);
});

test("no route at 40, a fitting one at 48: two builds (most of the measured no-route tokens)", async () => {
  const { w, p } = run({ 48: "fit" });
  assert.equal((await p).maxAccounts, 48);
  assert.deepEqual(w.asked, [40, 48]);
});

test("no route at 40 or 48, one at 60: three builds (B8gv9RJk…pump, measured)", async () => {
  const { w, p } = run({ 60: "fit", 64: "fit" });
  assert.equal((await p).maxAccounts, 60);
  assert.deepEqual(w.asked, [40, 48, 60]);
});

test("40 too large, then 32 no route: the next ask is between them (36), never 48, which is above a cap known too large", async () => {
  const { w, p } = run({ 40: "big", 32: "none", 36: "fit", 48: "fit" });
  assert.equal((await p).maxAccounts, 36);
  assert.deepEqual(w.asked, [40, 32, 36]);
});

test("startAt: the search asks that cap first (the live check's probe asks the steps past 40 with it) and steps on from there when it does not fit", async () => {
  const one = world({ 48: "fit" });
  const got = await fetchSolanaJupiterBuildThatFits(ORIGIN, R, one.fit, { fetch: one.f, startAt: 48 });
  assert.equal(got.maxAccounts, 48);
  assert.deepEqual(one.asked, [48]);
  const on = world({ 48: "big", 44: "fit" });
  assert.equal((await fetchSolanaJupiterBuildThatFits(ORIGIN, R, on.fit, { fetch: on.f, startAt: 48 })).maxAccounts, 44);
  assert.deepEqual(on.asked, [48, 44]);
  const top = world({});
  await assert.rejects(fetchSolanaJupiterBuildThatFits(ORIGIN, R, top.fit, { fetch: top.f, startAt: 60 }), (e: unknown) => e instanceof SolanaBuildError && e.code === "no_route");
  assert.deepEqual(top.asked, [60]);
  for (const bad of [0, 65, 40.5]) await assert.rejects(fetchSolanaJupiterBuildThatFits(ORIGIN, R, top.fit, { fetch: top.f, startAt: bad }), /startAt must be 1 to 64/);
});

test("40's route over 1,232 bytes: asked again at 32", async () => {
  const { w, p } = run({ 40: "big", 32: "fit" });
  const got = await p;
  assert.equal(got.maxAccounts, 32);
  assert.deepEqual(w.asked, [40, 32]);
  assert.deepEqual(got.steps, [{ maxAccounts: 40, outcome: "too_large", size: 1240 }, { maxAccounts: 32, outcome: "fits" }]);
});

test("no route at 40, 48's route over 1,232 bytes (ExxzYBTt…pump's buy, 1,276 at 48): asked again at 44", async () => {
  const { w, p } = run({ 48: "big", 44: "fit" });
  assert.equal((await p).maxAccounts, 44);
  assert.deepEqual(w.asked, [40, 48, 44]);
});

test("the search is bounded: at most 3 builds, then too_large when one was over 1,232 bytes, else no_route", async () => {
  const big = run({ 40: "big", 32: "big", 28: "big", 24: "fit" });
  await assert.rejects(big.p, (e: unknown) => e instanceof SolanaBuildError && e.code === "too_large" && /40 too_large 1240, 32 too_large 1232, 28 too_large 1228/.test(e.message));
  assert.deepEqual(big.w.asked, [40, 32, 28]);
  const none = run({ 64: "fit" });
  await assert.rejects(none.p, (e: unknown) => e instanceof SolanaBuildError && e.code === "no_route" && e.message === "no_route: no route (40 no_route, 48 no_route, 60 no_route)");
  assert.deepEqual(none.w.asked, [40, 48, 60]);
  const mixed = run({ 48: "big" });
  await assert.rejects(mixed.p, (e: unknown) => e instanceof SolanaBuildError && e.code === "too_large");
  assert.deepEqual(mixed.w.asked, [40, 48, 44]);
  await assert.rejects(fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => 1, { fetch: world({}).f, maxBuilds: 4 }), /maxBuilds must be 1 to 3/);
});

test("nothing the device's assembly refused is returned, and any other refusal or answer ends the search as it is", async () => {
  // the fit's own refusal that is not too_large (a check, a read) is not a reason to ask another cap
  const w = world({ 40: "fit" });
  await assert.rejects(fetchSolanaJupiterBuildThatFits(ORIGIN, R, () => { throw new SolanaBuildError("bad_answer", "an instruction asks X to sign"); }, { fetch: w.f }), (e: unknown) => e instanceof SolanaBuildError && e.code === "bad_answer");
  assert.deepEqual(w.asked, [40]);
  // the helper's 503 is upstream, never retried here
  const u = run({ 40: "none", 48: "503", 60: "fit" });
  await assert.rejects(u.p, (e: unknown) => e instanceof SolanaBuildError && e.code === "upstream");
  assert.deepEqual(u.w.asked, [40, 48]);
});
