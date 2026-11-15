// The one route.fetch for a Playwright route handler (card outside-app-route-never-crashes). route.fetch is the one
// route call that does its own network read from Node, so it rejects on a connection error; fulfill, continue and abort
// race the page's close and never do (Playwright 1.63, Route._raceWithTargetClose). A handler that let it reject ended
// the whole run as an unhandled rejection: merge queue run 43673463187 (job 132688370700), outside-app.e2e.mjs:137,
// "socket hang up" from wrangler pages dev on /prover-worker.js, after every check had passed. Every route.fetch in the
// e2e scripts and the live checks goes through fetchOrAbort; scripts/live-checks/route-fetch.test.mjs plants each end
// and refuses a bare route.fetch anywhere else.
// Runs: once, a module the e2e runs and the checks share (their route handlers), no check of its own

/** A connection that closed under the read: the server dropped a kept-alive socket, as Chrome itself retries once. */
export const CLOSED = /socket hang up|ECONNRESET|EPIPE|ECONNABORTED/;

/**
 * route.fetch(options), tried once more when the first read lost its connection (CLOSED), as a browser retries a
 * request on a reused connection the server closed. Any other failure, or a second one, aborts the route ("failed"):
 * the page sees a failed request, and the run's verdict stays the page's own. Returns the response, or null once the
 * route is aborted (the handler then returns).
 * @param {import("playwright").Route} route
 * @param {Parameters<import("playwright").Route["fetch"]>[0]} [options]
 */
export async function fetchOrAbort(route, options) {
  for (let tries = 1; ; tries++) {
    try {
      return await route.fetch(options);
    } catch (e) {
      if (tries === 1 && CLOSED.test(String(e?.message))) continue;
      await route.abort("failed");
      return null;
    }
  }
}
