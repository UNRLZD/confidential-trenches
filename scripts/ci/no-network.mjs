// Card readme-fresh-run: a preload that refuses every network connection except to this machine.
//   NODE_OPTIONS="--import=/path/to/scripts/ci/no-network.mjs" pnpm -r run test
// Every node process the tests start inherits NODE_OPTIONS, so a default test that reaches a vendor host (a real fetch
// of a quote, an RPC read, a price feed) fails on the line that connects, with the host in the message. A judge's
// machine may have no route out, no API key and no rate budget: the default tests must pass there.
//
// Allowed: a unix socket, `localhost`, 127.0.0.0/8, ::1 and ::ffff:127.x. Refused: every other host, by name before
// any DNS lookup. The hook is net.Socket.prototype.connect, which fetch (undici), http, https, tls and net all end in.
import net from "node:net";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;

/** Whether a connection to this host (a name or an address) stays on this machine. */
export function isLocal(host) {
  return LOOPBACK.test(String(host ?? "localhost"));
}

const refuse = (host) => new Error(`no-network: a connection to ${host} was refused (default tests reach this machine only)`);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net's forms: ([options], cb), (path, cb), (port, host, cb)
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    if (typeof first.path !== "string" && !isLocal(first.host ?? first.hostname)) throw refuse(first.host ?? first.hostname);
  } else if (typeof first === "number" || /^\d+$/.test(String(first))) {
    if (typeof args[1] === "string" && !isLocal(args[1])) throw refuse(args[1]);
  } // a string that is not a port is a unix socket path
  return Reflect.apply(connect, this, args);
};
