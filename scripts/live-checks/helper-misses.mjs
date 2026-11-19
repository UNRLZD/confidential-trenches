// The one place a browser check on a local build reads the live helper (card
// queue-browser-checks-tell-a-helper-miss-from-a-page-fault). Merge queue group 44547353452 (19 Nov 14:46Z) refused
// app-trade-box-mount on main's own build, "drew nothing; the page read no token answer", while the helper's vendor
// answered 503 on its timeout: a moment when the helper missed was read as the page's fault, and every pull request
// behind it waited a round.
//
// liveHelper(ctx, harness) routes a context as every such check did: HELPER_HOST's requests go to the live helper
// (route.continue), every other one to the harness; and it watches each helper request the page made. A miss is an
// answer the page asked the helper for that:
//   - came back 5xx or 429 (the helper or its vendor did not answer: a logo the helper is busy on is a 503 too);
//   - failed in the network (`requestfailed`), but for net::ERR_ABORTED (or a closed page's) under MISS_MS, the page's
//     own abort of a read it no longer needs (an abort past MISS_MS is a read the helper kept waiting);
//   - was CORS-blocked (a fetch or XHR answer with no access-control-allow-origin, so the page could not read it);
//   - took MISS_MS or more, or had not come MISS_MS after it was asked when the context closed or the check judged.
// verdictOf(verdict) turns a FAIL into INCONCLUSIVE when a miss happened in the run, and only then: a check judges BAD
// only what the page drew from the answers it got; with a miss the page may have drawn exactly what it had, so the run
// tells nothing and runs again (scripts/ci/test-shards.mjs runs these checks through scripts/ci/live-rerun.mjs's rerun
// rule). A PASS stays a PASS (the page drew right through the miss) and a run with no miss keeps its FAIL.
// The misses print as provider-answer.mjs names a no-answer (`<host> HTTP <status>: <why>`, `<host>: no answer (<why>)`),
// so live-rerun's noAnswerHosts names the helper as the host that did not answer.
// Runs: once, no check: the shared module the checks that read the live helper on a local build import

export const HELPER_HOST = "https://ct-api.unrealized.trade";
/** An answer that took this long, or had not come this long after it was asked, is a miss: the helper's reads answer in
 *  about a second (app-in-shell.mjs TAPE_MS), and the checks wait 8 to 25 s for a page to draw. */
export const MISS_MS = 10_000;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3 });

const host = new URL(HELPER_HOST).host;
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
};

/**
 * A watch on one host's requests, fed events: asked(req, t), answered(req, { status, acao, type }, t), failed(req,
 * error, t), closed(t). misses(t) lists each miss once, in the order asked, as provider-answer.mjs names a no-answer.
 * `req` is any object (Playwright's Request): one key per request.
 */
export function helperWatch({ origin = HELPER_HOST, missMs = MISS_MS } = {}) {
  const seen = new Map();
  let shut = null;
  const of = (req) => seen.get(req);
  const w = {
    origin,
    asked(req, url, t) {
      if (shut !== null || !String(url).startsWith(`${origin}/`)) return;
      seen.set(req, { path: pathOf(url), at: t, end: null, why: null });
    },
    answered(req, { status, acao = null, type = "" }, t) {
      const r = of(req);
      if (!r || r.end !== null || shut !== null) return;
      r.end = t;
      if (status >= 500 || status === 429) r.why = `${host} HTTP ${status}: ${r.path}`;
      else if ((type === "fetch" || type === "xhr") && !acao) r.why = `${host} HTTP ${status}: CORS-blocked, no access-control-allow-origin on ${r.path}`;
      else if (t - r.at >= missMs) r.why = `${host}: no answer (${r.path} answered after ${((t - r.at) / 1000).toFixed(1)} s)`;
    },
    failed(req, error, t) {
      const r = of(req);
      if (!r || r.end !== null || shut !== null) return;
      r.end = t;
      const late = t - r.at >= missMs;
      if (/ERR_ABORTED|closed/i.test(String(error)) && !late) return;
      r.why = `${host}: no answer (${r.path} failed after ${((t - r.at) / 1000).toFixed(1)} s: ${String(error).slice(0, 80)})`;
    },
    /** How many of the host's requests it saw. */
    seen: () => seen.size,
    closed(t) {
      if (shut === null) shut = t;
    },
    misses(t = Date.now()) {
      const at = shut ?? t;
      const out = [];
      for (const r of seen.values()) {
        const why = r.why ?? (r.end === null && at - r.at >= missMs ? `${host}: no answer (${r.path} not answered ${((at - r.at) / 1000).toFixed(1)} s after it was asked)` : null);
        if (why && !out.includes(why)) out.push(why);
      }
      return out;
    },
  };
  return w;
}

/** Every watch made in this process: a check run is one process, so its verdict reads them all. */
const WATCHES = [];

/** Watches `ctx`'s requests to `origin` (Playwright's context events, every frame of every page). */
export function watchContext(ctx, opts = {}) {
  const w = helperWatch(opts);
  WATCHES.push(w);
  ctx.on("request", (r) => w.asked(r, r.url(), Date.now()));
  ctx.on("response", (res) => {
    const r = res.request();
    const h = res.headers();
    w.answered(r, { status: res.status(), acao: h["access-control-allow-origin"] ?? null, type: r.resourceType() }, Date.now());
  });
  ctx.on("requestfailed", (r) => w.failed(r, r.failure()?.errorText ?? "failed", Date.now()));
  // a context's close aborts what is still in flight: the watch ends first, so the abort is never read as a miss
  const close = ctx.close.bind(ctx);
  ctx.close = (...a) => (w.closed(Date.now()), close(...a));
  ctx.on("close", () => w.closed(Date.now()));
  return w;
}

/** Routes `ctx` as the checks on a local build do (the helper live, everything else the harness's) and watches the
 *  helper's answers. Resolves the watch. */
export async function liveHelper(ctx, harness, opts = {}) {
  const origin = opts.origin ?? HELPER_HOST;
  const w = watchContext(ctx, opts);
  await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === origin ? r.continue() : harness(r)));
  return w;
}

/** The misses of every watch in this process (or of `watches`), each once. */
export function helperMisses(watches = WATCHES, t = Date.now()) {
  return [...new Set(watches.flatMap((w) => w.misses(t)))];
}

/** A check's verdict (PASS | FAIL | INCONCLUSIVE) with the run's misses: { verdict, lines }, a FAIL with a miss made
 *  INCONCLUSIVE, its lines the misses (each `-- <miss>`) and one INCONCLUSIVE line that says why. */
export function verdictOf(verdict, misses = helperMisses()) {
  if (verdict !== "FAIL" || misses.length === 0) return { verdict, lines: [] };
  return {
    verdict: "INCONCLUSIVE",
    lines: [...misses.map((m) => `-- ${m}`), `INCONCLUSIVE the helper missed ${misses.length} answer${misses.length === 1 ? "" : "s"} the page asked for, so the BAD lines above may be the helper's, not the page's: run again`],
  };
}

/** The exit for a check that judged `ok` (PASS or FAIL), with the run's misses printed through `say`. */
export function exitOf(ok, say = console.log, misses = helperMisses()) {
  const v = verdictOf(ok ? "PASS" : "FAIL", misses);
  for (const l of v.lines) say(l);
  return EXIT[v.verdict];
}
