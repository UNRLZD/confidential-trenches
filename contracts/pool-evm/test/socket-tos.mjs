// A socket's type of service, set best effort in the fork runs' Node processes (fork-rpc.mjs, and the signing page's
// fork scripts packages/signpage/scripts/pool-fork-evm*.mjs), as Node itself sets it when a socket connects.
// Node 24.22's fetch (its bundled undici, writeH1) calls socket.setTypeOfService(0) before a new socket's first request,
// and net.Socket's setTypeOfService throws when the system refuses it: macOS answers EINVAL on a socket its peer has
// already reset. The throw leaves undici from inside its write, so the request's promise never settles and its
// AbortSignal never ends it: a fork read held anvil, and so every request to the fork, until the run was killed
// (14 Nov 00:1x-00:4xZ, nine Base fork runs; curl answered the same read in 0.36 s). Node's own connect path (net.js
// afterConnect) already treats a refused type of service as no fault of the connection. With this, the request goes on
// to its write, which fails as any reset connection does (ECONNRESET), and its caller's own retry or refusal runs.
import net from "node:net";

const set = net.Socket.prototype.setTypeOfService;
/** How many times the system refused a socket's type of service in this process. */
export const refusedTos = { count: 0 };
if (typeof set === "function" && set.bestEffort !== true) {
  const bestEffort = function setTypeOfService(tos) {
    try {
      return set.call(this, tos);
    } catch (e) {
      if (e?.syscall !== "setTypeOfService") throw e;
      refusedTos.count++;
      return this;
    }
  };
  bestEffort.bestEffort = true;
  net.Socket.prototype.setTypeOfService = bestEffort;
}
