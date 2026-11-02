// The Verify panel on fixtures (run.mjs): the app's own Verify drawing verifyView of the recorded reads (reads.json,
// the testnet skeleton vault at one block on fastnear and drpc), each bad state that recording with one answer
// planted, as test/verify.test.ts plants it. ?f=<fixture> picks the state and the rows opened. Test only.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { VerifyPins, VerifyReads } from "../../src/screens/verify/read.ts";
import { verifyView } from "../../src/screens/verify/model.ts";
import { Verify } from "../../src/screens/verify/Verify.tsx";
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

type Fx = { reads?: Plant[] | null; pins?: Partial<VerifyPins>; open?: ("code" | "funds")[] };
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
};

const fx = FIXTURES[new URLSearchParams(location.search).get("f") ?? "read"]!;
let reads: VerifyReads | null = null;
if (fx.reads !== null) {
  reads = JSON.parse(JSON.stringify(REC)) as VerifyReads;
  for (const p of fx.reads ?? []) p(reads);
}
const view = verifyView(reads, { ...PINS, ...fx.pins });

applyFit();
fontsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <div className="shell">
        <main className="screen" data-route="verify" />
      </div>
      <Verify view={view} opened={fx.open} onClose={() => void 0} />
    </StrictMode>,
  ),
);
