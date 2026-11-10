// The harness's sockets (card market-data-push). A harness run answers every http request itself and aborts the rest
// (app-in-shell.mjs harnessRoute, or each run's own route), but Playwright's context.route never sees a WebSocket: a
// page's socket went to the real host, so once the token page opened the helper's push socket every harness run that
// mounts it met the deployed helper (CI, PR #554: "WebSocket connection to 'wss://ct-api.unrealized.trade/v1/market/push'
// failed: ... 404" on BAR-10's loads). Every context of a harness browser routes every WebSocket here instead:
//   - the helper's push socket (PUSH_SOCKET) is mocked: open, sending only what the run sends on it (pushSockets(ctx));
//   - any other socket is a host the harness did not route: it is closed (1008) and the run fails (onUnrouted, by
//     default an uncaught error, so no run's own exit code can hide it);
//   - an http request no route of the run's answered (a fixture run serves only 127.0.0.1 and routes nothing) goes on
//     only to the run's local server or a name the harness maps there, else it is refused and fails the run the same way.
// A route of the run's that answers, aborts or lets a request go on is the run's own decision and is not judged here.
// Every terminal harness run starts its browser with launchHarnessBrowser; apps/terminal/test/harness/sockets.test.mjs
// refuses one that does not.
import { launchBrowser } from "./browsers.mjs";

/** The helper's push socket, any token (apps/helper/src/data/push.ts PUSH_PATH). */
export const PUSH_SOCKET = /^wss:\/\/ct-api\.unrealized\.trade\/v1\/market\/push\?/;

const pushes = new WeakMap();

/** The push sockets the pages of `ctx` opened, oldest first: each is mocked and sends what the run sends. */
export const pushSockets = (ctx) => pushes.get(ctx) ?? [];

const failRun = (url) => {
  const e = new Error(`harness: a page opened ${url}, a connection the harness does not route`);
  console.error(`FAIL ${e.message}`);
  setImmediate(() => {
    throw e;
  });
};

/** Hosts a harness page may reach with no route of the run's: the run's own local server, and the names a harness maps
 *  to it (`hosts`, apps/terminal/test/harness/harness.mjs MAPPED: "*.ct.test" is any name under ct.test). */
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const mapped = (hosts, name) => LOCAL.has(name) || hosts.some((h) => (h.startsWith("*.") ? name.endsWith(h.slice(1)) : name === h));

/**
 * Routes every connection of `ctx` the run does not: every WebSocket (context.route never sees one), the push socket
 * mocked and any other closed; and, under every route the run adds after it (a later route is asked first), each http
 * request no route of the run's answered, which goes on only to the run's own local server or a name the harness maps
 * there (`hosts`). Anything else is a host the harness did not route: refused, and `onUnrouted(url)` (an http one only
 * refused, as not found, under `refuseHttp`).
 */
export async function harnessSockets(ctx, { onUnrouted = failRun, hosts = [], refuseHttp = false } = {}) {
  pushes.set(ctx, []);
  await ctx.route(
    () => true,
    (r) => {
      const u = new URL(r.request().url());
      if (mapped(hosts, u.hostname)) return r.continue();
      // `refuseHttp`: a harness whose own rule refuses every other name (harness.mjs's resolver: "every other name fails
      // as not found") keeps it, the same refusal before any lookup; the run's own checks judge what its page asked
      if (refuseHttp) return r.abort("namenotresolved");
      onUnrouted(u.href);
      return r.abort("blockedbyclient");
    },
  );
  await ctx.routeWebSocket(
    () => true,
    (ws) => {
      if (PUSH_SOCKET.test(ws.url())) return void pushes.get(ctx).push(ws);
      ws.close({ code: 1008, reason: "not routed by the harness" });
      onUnrouted(ws.url());
    },
  );
}

/** launchBrowser, with harnessSockets on every context it opens (browser.newContext, and browser.newPage's own). */
export async function launchHarnessBrowser(engine = "chromium", options = {}, sockets = {}) {
  const browser = await launchBrowser(engine, options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (o = {}) => {
    const ctx = await newContext(o);
    await harnessSockets(ctx, sockets);
    return ctx;
  };
  browser.newPage = async (o = {}) => {
    const ctx = await browser.newContext(o);
    const page = await ctx.newPage();
    page.on("close", () => void ctx.close().catch(() => {}));
    return page;
  };
  return browser;
}
