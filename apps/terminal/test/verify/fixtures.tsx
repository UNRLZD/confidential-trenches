// The Verify panel on fixtures (run.mjs): the app's own Verify drawing verifyView of the recorded reads (reads.json,
// the testnet skeleton vault at one block on fastnear and drpc), each bad state that recording with one answer
// planted, as test/verify.test.ts plants it; the pool rows (card verify-pools) draw poolRow of pool-reads.json, each bad
// pool state that recording with one answer planted, as test/verify-pools.test.ts plants it. ?f=<fixture> picks the
// state and the rows opened. Test only.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { VerifyPins, VerifyReads } from "../../src/screens/verify/read.ts";
import { verifyView } from "../../src/screens/verify/model.ts";
import { Verify } from "../../src/screens/verify/Verify.tsx";
import { POOL_CHAINS, poolRow, type PoolChain, type PoolPin, type PoolReads, type PoolsView } from "../../src/screens/verify/pools.ts";
import { VERIFY_RELEASES } from "../../src/screens/verify/release.ts";
import POOL_REC from "./pool-reads.json";
import { applyFit } from "../../src/shell/fit.ts";
import { fontsReady } from "../../src/shell/fonts.ts";
import "../../src/shell/shell.css";
import REC from "./reads.json";

const PINS: VerifyPins = {
  vault: "vault.bf-vs-20261101t012200.testnet",
  asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  release: "GGfTdwuLbonERu3vKnpLF828eyWZ4DxS24kpLp67PmSn",
  assetRelease: "EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z",
  assetSymbol: "USDC",
  assetDecimals: 6,
};
const KEY = { public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } };
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
type Plant = (r: any) => void;
const call = (id: string, v: unknown, on = [0, 1]): Plant => (r) => on.forEach((i) => (r.rpcs[i].answers[id].result.result = bytes(v)));

type PoolPlant = (r: Record<PoolChain, any>) => void;
const word = (w: string) => `0x${w.padStart(64, "0")}`;
const evm = (c: PoolChain, id: string, f: (a: any) => void, on = [0, 1]): PoolPlant => (r) => on.forEach((i) => f(r[c].rpcs[i].answers[id]));
const authority: PoolPlant = (r) =>
  [0, 1].forEach((i) => {
    const v = r.solana.rpcs[i].answers.accounts.result.value[1];
    const b = Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0));
    b[12] = 1;
    b.fill(7, 13, 45);
    v.data[0] = btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
  });
type Fx = { reads?: Plant[] | null; pins?: Partial<VerifyPins>; open?: ("code" | "funds" | PoolChain)[]; pools?: PoolPlant[] | null };
export const FIXTURES: Record<string, Fx> = {
  loading: { reads: null },
  read: {},
  "code-open": { open: ["code"] },
  "funds-open": { open: ["funds"] },
  unverified: { reads: [(r) => (r.rpcs[1].answers.totals = { error: "fetch failed" })], open: ["funds"] },
  disagree: { reads: [(r) => (r.rpcs[1].answers.keys.result.keys = [KEY])], open: ["code"] },
  short: { reads: [call("totals", { deposited: "10000000", spent: "4000000", returned: "1000000" }), call("balance", "6999999")], open: ["funds"] },
  release: { pins: { release: "11111111111111111111111111111111" }, open: ["code"] },
  key: { reads: [(r) => r.rpcs.forEach((x: any) => (x.answers.keys.result.keys = [KEY]))], open: ["code"] },
  unregistered: { reads: [call("registration", null)], open: ["funds"] },
  "pools-loading": { pools: null },
  "pools-open": { open: ["solana", "base", "robinhood"] },
  "pool-authority": { pools: [authority], open: ["solana"] },
  "pool-owner": { pools: [evm("base", "owner", (a) => { delete a.error; a.result = word("1111111111111111111111111111111111111111"); })], open: ["base"] },
  "pool-proxy": { pools: [evm("robinhood", "implementation", (a) => (a.result = word("22".repeat(20))))], open: ["robinhood"] },
  "pool-code": { pools: [evm("base", "code", (a) => (a.result = `${a.result.slice(0, -2)}01`))], open: ["base"] },
  "pool-disagree": { pools: [evm("robinhood", "owner", (a) => { delete a.error; a.result = word("33".repeat(20)); }, [1])], open: ["robinhood"] },
};

const fx = FIXTURES[new URLSearchParams(location.search).get("f") ?? "read"]!;
let reads: VerifyReads | null = null;
if (fx.reads !== null) {
  reads = JSON.parse(JSON.stringify(REC)) as VerifyReads;
  for (const p of fx.reads ?? []) p(reads);
}
const view = verifyView(reads, { ...PINS, ...fx.pins });
async function poolsView(): Promise<PoolsView> {
  if (fx.pools === null) return { state: "loading" };
  const rec = JSON.parse(JSON.stringify(POOL_REC)) as Record<PoolChain, PoolReads>;
  for (const p of fx.pools ?? []) p(rec);
  return { state: "read", rows: await Promise.all(POOL_CHAINS.map((c) => poolRow(rec[c], VERIFY_RELEASES.mainnet.pools[c] as PoolPin))) };
}

applyFit();
Promise.all([poolsView(), fontsReady()]).then(([pools]) =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <div className="shell">
        <main className="screen" data-route="verify" />
      </div>
      <Verify view={view} pools={pools} opened={fx.open} onClose={() => void 0} />
    </StrictMode>,
  ),
);
