// node packages/signpage/scripts/agent.e2e.mjs: card example-agent-full-cycle, the agent example (examples/agent) against
// this tree's SIGN_HOST build, served by wrangler pages dev as outside-app.e2e.mjs serves it, in the installed Chrome.
// The agent signs in with the published all-zero test seed (packages/wallet/test/vectors/a8.json) typed on SIGN_HOST's
// words screen, from a temp folder of its own, and runs its five steps in order as kit requests in popup mode: fund
// (deposit.assets, deposit.quote), deposit (deposit.confirm), buy (pool.buy on NEAR), sell (pool.sell, all of it),
// withdraw (withdraw.open to an address, max, then the page's own Confirm). No chain and no 1Click are reached: every
// request but SIGN_HOST's and the agent's page is aborted, so each step's answer is a refusal and the next step is run
// anyway, to show each request reaches the page, each Confirm is read and tapped, and each answer comes back. A second
// session with --max 1 shows a buy Confirm above --max is not tapped. Exit 0 when all hold, 1 otherwise.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, WRANGLER } from "./deploy.mjs";
import { entropyToWords } from "../../wallet/src/derive/index.ts";
import { APP, home, session, SIGN, steps } from "../../../examples/agent/agent.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8789;
const LOCAL = `http://127.0.0.1:${PORT}`;
const TOKEN = "touched.tkn.near";
// a NEAR implicit account, 64 characters
const TO = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

let ok = true;
const check = (cond, what) => {
  ok &&= !!cond;
  console.log(`${cond ? "ok " : "BAD"} ${what}`);
};
const lines = [];
const say = (l) => (lines.push(l), console.log(`    agent: ${l}`));
const hooks = {
  context: (ctx) =>
    ctx.route("**/*", async (r) => {
      const u = new URL(r.request().url());
      if (u.origin === SIGN) return r.fulfill({ response: await r.fetch({ url: `${LOCAL}${u.pathname}${u.search}`, maxRedirects: 0 }) });
      if (u.origin === APP) return r.fallback();
      return r.abort();
    }),
};
const answer = async (p) => {
  try {
    await p;
    return "landed";
  } catch (e) {
    return String(e.message);
  }
};

const site = build(PKG);
const wranglerHome = mkdtempSync(join(tmpdir(), "agent-e2e-wrangler-"));
const wrangler = spawn("npx", ["-y", WRANGLER, "pages", "dev", site, "--port", String(PORT), "--ip", "127.0.0.1", "--log-level", "error"], { cwd: wranglerHome, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let wranglerOut = "";
wrangler.stdout.on("data", (d) => (wranglerOut += d));
wrangler.stderr.on("data", (d) => (wranglerOut += d));
const agentHome = mkdtempSync(join(tmpdir(), "agent-e2e-home-"));
let s = null;
try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try {
      up = (await fetch(`${LOCAL}/`)).status === 200;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  check(up, `wrangler pages dev (${WRANGLER}) serves the build at ${LOCAL}`);
  if (!up) throw new Error(wranglerOut.slice(-2000));
  const h = home(agentHome);
  const seed = entropyToWords(new Uint8Array(16));
  writeFileSync(h.words, seed + "\n", { mode: 0o600 });
  const notes = [];
  const o = { token: TOKEN, amount: "5", max: 6, to: TO, slippageBps: 300, say, note: (step, f) => notes.push([step, f]) };

  s = await session({ h, max: 6, say, hooks });
  check(lines.includes(`connect sheet: Connect ${APP}`) && lines.includes("signed in"), "the agent read its own origin on the connect sheet, tapped Allow and signed in with the test seed");
  const f = await answer(steps.fund(s, o));
  check(/^deposit\.(assets|quote): /.test(f), `fund: the deposit kinds answer the outside app: ${f}`);
  const d = await answer(steps.deposit(s, { ...o, address: "planted-deposit.near" }, 20_000));
  check(/^deposit(\.confirm)?: /.test(d), `deposit: deposit.confirm answers: ${d}`);
  for (const side of ["buy", "sell"]) {
    lines.length = 0;
    const t = await answer(steps.trade(s, side, o));
    const c = lines.find((l) => l.startsWith(`confirm pool.${side}: `));
    check(c?.startsWith(`confirm pool.${side}: ${side === "buy" ? "Buy" : "Sell"} ${APP}; `) && c.includes(`Token ${TOKEN}`) && c.includes(side === "buy" ? "Amount 5" : "Share 100%"), `${side}: the agent read its Confirm and tapped it: ${c ?? "no Confirm"}`);
    check(new RegExp(`^pool\\.${side}: `).test(t), `${side}: its answer reached the agent: ${t}`);
  }
  lines.length = 0;
  const w = await answer(steps.withdraw(s, o));
  const wc = lines.find((l) => l.startsWith("confirm withdraw.open: "));
  check(wc?.startsWith(`confirm withdraw.open: ${APP}; To ${TO}, Amount `), `withdraw: the agent read the page's own Confirm, the origin first and the address whole: ${wc ?? `none (${w})`}`);
  check(w === "not confirmed: the page did not offer its Confirm", `withdraw: with no chain the page never offers Confirm, so nothing is sent: ${w}`);
  check(!lines.some((l) => l.includes(seed)) && !(existsSync(h.record) && readFileSync(h.record, "utf8").includes(seed)), "the words are in no line the agent printed or recorded");
  await s.close();

  // --max 1: the buy's Confirm shows 5, so the agent taps Cancel
  lines.length = 0;
  s = await session({ h, max: 1, say, hooks });
  const over = await answer(steps.trade(s, "buy", { ...o, max: 1 }));
  check(/^not confirmed: Amount 5( USDC)? is above --max 1$/.test(over), `a Confirm above --max is not tapped: ${over}`);
} catch (e) {
  ok = false;
  console.log(`BAD ${String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
} finally {
  await s?.close();
  wrangler.kill("SIGTERM");
  rmSync(site, { recursive: true, force: true });
  rmSync(wranglerHome, { recursive: true, force: true });
  rmSync(agentHome, { recursive: true, force: true });
  console.log(`agent.e2e: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}
