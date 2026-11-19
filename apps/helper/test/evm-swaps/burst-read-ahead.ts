// The read ahead's burst replay (card robinhood-tapes-read-ahead-bounded): a local Robinhood swaps reader on this
// machine, its upstream the spread coins' fake chain (spread.ts: the recorded Robinhood head and block times, every
// answer LATE_MS late), served over HTTP on 127.0.0.1, and a burst of callers in a child process polling the trade
// lists of the 12 listed coins and of coins no list carries. It prints the reader's event-loop delay (perf_hooks
// monitorEventLoopDelay: p50, p99, max) with the lists' read ahead off, on as 6b1926fc9 had it (no loop gate), and on
// behind limits/loop-busy.ts. Nothing leaves this machine: no deployed helper and no live provider is called.
//
//   node apps/helper/test/evm-swaps/burst-read-ahead.ts [--s 60] [--callers 24] [--others 28]
//
// Not a test: a measurement, run by hand on a quiet machine. One mode after another, each in its own reader process.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loopBusy } from "../../src/limits/loop-busy.ts";
import { HEADER_TIMED, SWAP_RPCS } from "../../src/data/evm/swaps.ts";
import { open } from "./robinhood.ts";
import { LISTED, rig, spreadTokens } from "./spread.ts";

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : d;
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
  return v;
};
const SECONDS = arg("s", 60);
const CALLERS = arg("callers", 24);
const OTHERS = arg("others", 28);
/** Each caller's pause between two reads, as a page polls a filling tape. */
const POLL_MS = 250;
/** The lists' answer loads again this often (server.ts evmSwapsFromEnv calls ahead on each). */
const LIST_MS = 60_000;
const MODES = ["off", "ungated", "gated"] as const;
type Mode = (typeof MODES)[number];
const SELF = fileURLToPath(import.meta.url);

const get = (port: number, path: string): Promise<{ status: number; body: string }> =>
  new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", fail);
    r.setTimeout(30_000, () => r.destroy(new Error(`GET ${path} past 30 s`)));
    r.end();
  });

/** The reader: one mode, on a free port it prints, its loop delay printed when its parent says stop. */
async function reader(mode: Mode): Promise<void> {
  const tokens = spreadTokens(12 + OTHERS);
  const r = rig({ tokens });
  const s = open(r.chain, { get t() { return Date.now(); } }, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never, tickMs: undefined, ...(mode === "gated" ? { busy: loopBusy } : {}) });
  // sampled every 1 ms: each figure is the gap between two samples, so a free loop reads about 1 ms
  const h = monitorEventLoopDelay({ resolution: 1 });
  const server = createServer((req, res) => {
    const token = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
    s.trades(token, 50).then(
      (a) => res.writeHead(a.status, { "content-type": "application/json" }).end(a.body),
      () => res.writeHead(500).end(),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    h.enable();
    if (mode !== "off") {
      void s.ahead(LISTED.map((x) => x.token));
      setInterval(() => void s.ahead(LISTED.map((x) => x.token)), LIST_MS).unref();
    }
    process.stdout.write(`port ${(server.address() as AddressInfo).port}\n`);
  });
  process.stdin.on("data", async () => {
    h.disable();
    const whole = (await Promise.all(LISTED.map(({ token }) => s.trades(token, 50)))).filter((a) => a.status === 200 && JSON.parse(a.body).filling !== true).length;
    const ms = (ns: number) => Math.round(ns / 1e5) / 10;
    process.stdout.write(`${JSON.stringify({ mode, p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), posts: r.n.posts, listedWhole: whole })}\n`);
    s.stop();
    process.exit(0);
  });
}

/** The callers: CALLERS loops for SECONDS, each reading one coin's list after another (listed and not), then a count. */
async function callers(port: number): Promise<void> {
  const tokens = spreadTokens(12 + OTHERS);
  const end = Date.now() + SECONDS * 1_000;
  const n = { ok: 0, filling: 0, other: 0 };
  await Promise.all(
    Array.from({ length: CALLERS }, async (_, c) => {
      for (let k = c; Date.now() < end; k += CALLERS) {
        const a = await get(port, `/trades?token=${tokens[k % tokens.length]!.token}`).catch(() => ({ status: 0, body: "" }));
        if (a.status !== 200) n.other++;
        else if (JSON.parse(a.body).filling === true) n.filling++;
        else n.ok++;
        await new Promise((go) => setTimeout(go, POLL_MS));
      }
    }),
  );
  process.stdout.write(`${JSON.stringify(n)}\n`);
}

/** One mode: its reader started, the callers run against it, its numbers read. */
async function runMode(mode: Mode): Promise<string> {
  const rd = spawn(process.execPath, [SELF, "--as-reader", mode, ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "inherit"] });
  const lines: string[] = [];
  let buf = "";
  const waiters: ((l: string) => void)[] = [];
  rd.stdout.setEncoding("utf8").on("data", (c: string) => {
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(l);
      else lines.push(l);
    }
  });
  const next = () => new Promise<string>((ok) => (lines.length > 0 ? ok(lines.shift()!) : waiters.push(ok)));
  const port = Number((await next()).replace(/^port /, ""));
  const cl = spawn(process.execPath, [SELF, "--as-callers", String(port), ...process.argv.slice(2)], { stdio: ["ignore", "pipe", "inherit"] });
  let calls = "";
  cl.stdout.setEncoding("utf8").on("data", (c: string) => (calls += c));
  await new Promise((go) => cl.on("exit", go));
  rd.stdin.write("stop\n");
  const out = JSON.parse(await next());
  return JSON.stringify({ ...out, calls: JSON.parse(calls) });
}

const i = process.argv.indexOf("--as-reader");
const j = process.argv.indexOf("--as-callers");
if (i >= 0) await reader(process.argv[i + 1] as Mode);
else if (j >= 0) await callers(Number(process.argv[j + 1]));
else {
  console.log(`burst-read-ahead: ${CALLERS} callers for ${SECONDS} s, 12 listed coins and ${OTHERS} others, every upstream answer from the local fake chain`);
  for (const m of MODES) console.log(await runMode(m));
}
