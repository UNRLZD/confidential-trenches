// Records what Verify's live read sends and gets, for the tests to answer from: liveVerify (src/screens/verify/live.ts)
// on the release's pair, every request and its answer kept by the RPC's URL and the request's params; only what the RPCs
// answered is stored. Test data only, never shipped. Run by hand:
//   node apps/terminal/test/verify-mount/record.ts            testnet: answers.json (test/verify-mount.test.ts, run.mjs)
//   node apps/terminal/test/verify-mount/record.ts mainnet    mainnet: answers-mainnet.json (the in-shell harness's
//                                                             mainnet RPC answers, scripts/live-checks/app-in-shell.mjs)
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
const network = process.argv[2] === "mainnet" ? "mainnet" : "testnet";
const release = VERIFY_RELEASES[network];
const view = await liveVerify(release, recording);
const out = { vault: release.pins!.vault, rpcs: release.rpcs, recorded_at: new Date().toISOString(), view, answers };
writeFileSync(network === "mainnet" ? new URL("./answers-mainnet.json", import.meta.url) : new URL("./answers.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${answers.length} answers; view ${view.state}${view.state === "loading" ? "" : ` code ${view.code.status} funds ${view.funds.status} at ${view.height}`}`);
