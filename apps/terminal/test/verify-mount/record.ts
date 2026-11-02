// Records what Verify's live read sends and gets on testnet, for test/verify-mount.test.ts and run.mjs to answer from:
// liveVerify (src/screens/verify/live.ts) on the release's testnet pair, every request and its answer kept by the RPC's
// URL and the request's params. Test data only, never shipped. Run by hand; writes test/verify-mount/answers.json.
//   node apps/terminal/test/verify-mount/record.ts
import { writeFileSync } from "node:fs";
import { liveVerify } from "../../src/screens/verify/live.ts";
import { VERIFY_RELEASES } from "../../src/screens/verify/release.ts";

const answers: { url: string; params: unknown; answer: unknown }[] = [];
const recording: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const answer = await res.json();
  answers.push({ url: String(input), params: JSON.parse(String(init?.body)).params, answer });
  return new Response(JSON.stringify(answer), { status: res.status, headers: { "content-type": "application/json" } });
};
const release = VERIFY_RELEASES.testnet;
const view = await liveVerify(release, recording);
const out = { vault: release.pins!.vault, rpcs: release.rpcs, recorded_at: new Date().toISOString(), view, answers };
writeFileSync(new URL("./answers.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${answers.length} answers; view ${view.state}${view.state === "loading" ? "" : ` code ${view.code.status} funds ${view.funds.status} at ${view.height}`}`);
