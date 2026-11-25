// Card tests-make-no-late-reads: no package test reaches the network. scripts/test-bound-watch.cjs loads this into every
// package's `node --test` (the run's process and each file's, and a process a test starts, which inherits the preload).
// A connection to a host off this machine is refused before it leaves, before any DNS (a name the caller's own lookup
// pins is judged by the address it hands back): its socket errors as a host that answers nothing does, the host is named on stderr, and the file's process exits 1, so its file fails though every
// test in it passed. A test reads planted answers or a server of its own on this machine (loopback, a unix socket). A
// read of a real provider flakes on its answers and its rate limits, and on a reviewer's machine reaches mainnet RPCs
// and our helper: before this, kit's evm-quote-attacks read four Base providers from the head watch and the scan its
// pinned quote left running after the test's fetch came back, four signpage files read Base Sepolia, Solana devnet and
// the helper, and the helper's env-names test read Base (read 2026-11-25 with every connection of the suites logged; scripts/ci/test-no-network.test.mjs plants
// both sides).
const net = require("node:net");

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i;

/** The options a Socket#connect call names: net.connect and tls.connect pass them as node's normalized [options, cb]. */
function optionsOf(args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (a !== null && typeof a === "object") return a;
  if (typeof a === "string" && !/^\d+$/.test(a)) return { path: a };
  return { port: a, host: typeof args[1] === "string" ? args[1] : undefined };
}

const named = new Set();
/** Fails this process's file, `where` named on stderr once, and returns the error the refused connection ends with. */
function refused(where) {
  process.exitCode = 1;
  if (!named.has(where)) {
    named.add(where);
    process.stderr.write(`\ntest-no-network: ${process.argv[1] ?? "?"} asked ${where}, refused\n`);
  }
  return new Error(`test-no-network: a connection to ${where} is refused: a test reads planted answers or a server on this machine`);
}
const PINNED = Symbol("test-no-network: a lookup read here");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = optionsOf(args);
  const host = String(o.host ?? "localhost").replace(/^\[(.*)\]$/, "$1");
  // a unix socket as node's own connect reads one: a path that is set (an https request's agent passes `path: null`)
  if (o.path || LOOPBACK.test(host)) return connect.apply(this, args);
  // a lookup of the caller's own decides the address (the helper's logo fetch pins a name to the address it checked,
  // src/data/logo.ts, and its test pins one to its own stub on 127.0.0.1): the address it hands back is judged, before
  // any connection; no other name is looked up here
  if (typeof o.lookup === "function") {
    if (o.lookup[PINNED] !== true) {
      const own = o.lookup;
      o.lookup = Object.assign(
        function (name, opts, cb) {
          const done = typeof opts === "function" ? opts : cb;
          return own.call(this, name, typeof opts === "function" ? {} : opts, (err, addr, family) => {
            const off = err ? undefined : (Array.isArray(addr) ? addr.map((a) => a.address) : [addr]).find((a) => !LOOPBACK.test(String(a)));
            if (off === undefined) return done(err, addr, family);
            done(refused(`${name} (${off}):${o.port ?? "?"}`));
          });
        },
        { [PINNED]: true },
      );
    }
    return connect.apply(this, args);
  }
  const e = refused(`${host}:${o.port ?? "?"}`);
  process.nextTick(() => this.destroy(e));
  return this;
};
