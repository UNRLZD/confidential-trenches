// SPDX-License-Identifier: Apache-2.0
// VT-T02's browser leg (card vault-testnet-t02): the kit's own prover (packages/kit/src/prover/client.ts startProver,
// the worker SIGN_HOST serves as /prover-worker.js, the six pinned setup files at /assets/zk/<sha256>.<ext>) proves one
// withdrawal in this browser. The page asks its local run server (contracts/vault/scripts/testnet-t02.ts withdraw) for
// the circuit input (at /<token>/input.json, the run's token read from this page's fragment), loads the withdraw
// circuit, proves, and posts the proof with the times and the browser's name back. The page sets no CSP of its own;
// SIGN_HOST's policy is not applied here. The server checks the proof against withdraw.vkey and carries the
// withdrawal. Nothing here logs the input.
import { startProver } from "../../../../packages/kit/src/prover/client.ts";

const out = document.getElementById("out")!;
const say = (s: string) => {
  out.textContent = s;
};
// the run's token, from the fragment (never sent to a server): the input and the result live under /<token>/ only
const token = location.hash.slice(1);
const post = (body: unknown) => fetch(`/${token}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function run(): Promise<void> {
  document.body.dataset.state = "running";
  say("input");
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("no run token in the address");
  const res = await fetch(`/${token}/input.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`input: HTTP ${res.status}`);
  const input = await res.json();
  const violations: unknown[] = [];
  const t0 = performance.now();
  const prover = startProver({ onViolation: (v) => violations.push(v) });
  say("loading the withdraw circuit");
  await prover.load("withdraw");
  const t1 = performance.now();
  say("proving");
  const r = await prover.prove("withdraw", input);
  const t2 = performance.now();
  prover.terminate();
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } };
  await post({
    proof: r.proof,
    publicSignals: r.publicSignals,
    proveMs: r.proveMs,
    loadMs: Math.round(t1 - t0),
    pageProveMs: Math.round(t2 - t1),
    totalMs: Math.round(t2 - t0),
    userAgent: nav.userAgent,
    brands: nav.userAgentData?.brands ?? null,
    platform: nav.userAgentData?.platform ?? null,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    violations,
  });
  say(`done: load ${Math.round(t1 - t0)} ms, prove ${r.proveMs} ms (worker), ${Math.round(t2 - t1)} ms (page)`);
  document.body.dataset.state = "done";
}

run().catch((e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  say(`error: ${m}`);
  document.body.dataset.state = "error";
  void post({ error: m });
});
