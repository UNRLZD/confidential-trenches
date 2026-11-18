// The helper tests' one way to wait on a test server's start and to call it (card helper-test-servers-never-hang). On
// 18 Nov a full helper suite run hung 71 min at 0% CPU: a test waited on a server's 'listening' event that had already
// fired (start() listens at import, so the event can pass before the test's before() runs, and it is never said again),
// and its calls had no bound. listening() reads the server's own state first; it and call() each end inside a bound or
// fail naming what they waited on. Tested in servers.test.ts.
//
// The bound is real time on purpose: what ends these waits is a socket (the kernel's accept or a peer's bytes), which no
// virtual clock moves, so a mocked clock would fire it too early or never. It asserts nothing about how long a wait took
// (no-wall-clock-asserts: a hang bound, like the runner's own { timeout }), and it runs on the setTimeout read when this
// file loads, so a test that mocks timers neither holds it nor fires it early. A test of the bound itself passes `timer`.
import { request, type Agent, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Sets `fire` to run after `ms` and returns its cancel. */
export type Timer = (ms: number, fire: () => void) => () => void;
export type Bound = { ms?: number; timer?: Timer };
/** The bound on a start and on a call: far above any honest test server's answer, far below a hang worth noticing. */
export const WAIT_MS = 30_000;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realTimer: Timer = (ms, fire) => {
  const t = realSetTimeout(fire, ms);
  return () => realClearTimeout(t);
};

/** The server's port once it listens: at once when it already does (its 'listening' event may be past), else on that
 *  event. A listen error fails at once, and no listen within the bound fails, each naming `name`. */
export function listening(s: Server, name: string, { ms = WAIT_MS, timer = realTimer }: Bound = {}): Promise<number> {
  const port = () => (s.address() as AddressInfo).port;
  if (s.listening) return Promise.resolve(port());
  return new Promise((ok, fail) => {
    const done = (e?: Error) => {
      cancel();
      s.off("listening", up).off("error", down);
      if (e === undefined) ok(port());
      else fail(e);
    };
    const up = () => done();
    const down = (e: Error) => done(new Error(`${name} did not start: ${e.message}`));
    s.once("listening", up).once("error", down);
    const cancel = timer(ms, () => done(new Error(`${name} was not listening within ${ms} ms`)));
  });
}

export type Call = { method?: string; path: string; headers?: OutgoingHttpHeaders; body?: string | Buffer; agent?: Agent | boolean; host?: string };
/** `body` read as UTF-8, `raw` its bytes. */
export type Answer = { status: number; headers: IncomingHttpHeaders; body: string; raw: Buffer };

/** One HTTP request to the test server on `port`, read to its end. No whole answer within the bound (a stalled handler,
 *  a body that stops) drops the connection and fails as "<method> <path> on <name>: no answer within <ms> ms"; a socket
 *  error fails at once, named the same way. */
export function call(port: number, c: Call, name: string, { ms = WAIT_MS, timer = realTimer }: Bound = {}): Promise<Answer> {
  const method = c.method ?? "GET";
  return new Promise((ok, fail) => {
    let over = false;
    const end = (e: Error) => {
      if (over) return;
      over = true;
      cancel();
      fail(new Error(`${method} ${c.path} on ${name}: ${e.message}`));
    };
    const r = request({ host: c.host ?? "127.0.0.1", port, method, path: c.path, headers: c.headers, agent: c.agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("error", end).on("end", () => {
        if (over) return;
        over = true;
        cancel();
        const raw = Buffer.concat(chunks);
        ok({ status: res.statusCode ?? 0, headers: res.headers, body: raw.toString("utf8"), raw });
      });
    });
    r.on("error", end);
    const cancel = timer(ms, () => (end(new Error(`no answer within ${ms} ms`)), r.destroy()));
    r.end(c.body);
  });
}
