// node --test scripts/live-checks/verify-row-survives-one-provider.test.mjs: the live check replays recorded answers
// (verify-row-survives-one-provider.answers.json). good: this card's build (`pnpm --filter terminal build`) in the
// harness on a Mac, the release's RPCs real, publicnode refused on the phone and Pocket on the desktop, 12 Nov 23:43Z:
// the Solana row ok on the two others, PASS. bad: the live APP_HOST at 23:45Z (its fixed Solana pair), the same
// refusals: the row Unverified, FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { judge, plantsOf } from "./verify-row-survives-one-provider.mjs";

const A = JSON.parse(readFileSync(new URL("./verify-row-survives-one-provider.answers.json", import.meta.url), "utf8"));
const bad = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => JSON.parse(JSON.stringify(x));

test("the refusals: the phone the Solana list's first host, the desktop its second", () => {
  assert.deepEqual(plantsOf(VERIFY_RELEASES.mainnet.pools.solana.rpcs), { phone: "solana-rpc.publicnode.com", desktop: "solana.api.pocket.network" });
  assert.deepEqual(A.good.plants, plantsOf(VERIFY_RELEASES.mainnet.pools.solana.rpcs));
  assert.deepEqual(A.bad.plants, A.good.plants);
});

test("recorded good answer: the Solana row ok on the two hosts that answered, the refused one walked past: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  // the row names its two hosts in the order they answered
  const on = (w, hosts, refused) => r.lines.some((l) => [hosts, [...hosts].reverse()].some((h) => l === `ok  ${w} /verify solana: row ok, read on ${h.join(" and ")}, with ${refused} refusing`));
  assert.ok(on("phone", ["solana.api.pocket.network", "public.rpc.solanavibestation.com"], "solana-rpc.publicnode.com"), r.lines.join("\n"));
  assert.ok(on("desktop", ["solana-rpc.publicnode.com", "public.rpc.solanavibestation.com"], "solana.api.pocket.network"), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok  desktop \/verify: the page asked solana\.api\.pocket\.network [1-9]\d* time\(s\), answered 400, want the planted 400$/.test(l)));
});

test("recorded bad answer: the live fixed pair, one host refused: the row Unverified: FAIL", () => {
  const b = bad(A.bad);
  assert.ok(b.some((l) => /^BAD desktop \/verify solana: row warn, read on /.test(l)), b.join("\n"));
  assert.ok(b.some((l) => /^BAD phone \/verify solana: row warn, read on /.test(l)), b.join("\n"));
});

test("planted on the good answer: the row naming the refused host, no refusal made, or one host refused on both widths: FAIL", () => {
  const onRefused = clone(A.good);
  for (const r of onRefused.runs) if (r.width === "desktop") r.pools.rows.solana.rpcs = ["solana.api.pocket.network", "public.rpc.solanavibestation.com"];
  assert.ok(bad(onRefused).some((l) => l.startsWith("BAD desktop /verify solana: row ok, read on solana.api.pocket.network")));
  const unasked = clone(A.good);
  for (const r of unasked.runs) r.requests = r.requests.filter((x) => !(x.method === "POST" && x.url.startsWith(`https://${unasked.plants[r.width]}`)));
  assert.ok(bad(unasked).some((l) => /the page asked solana-rpc\.publicnode\.com 0 time\(s\), want the planted 400/.test(l)));
  const same = clone(A.good);
  same.plants = { phone: "solana-rpc.publicnode.com", desktop: "solana-rpc.publicnode.com" };
  assert.ok(bad(same).some((l) => l.startsWith("BAD the run refused")));
});
