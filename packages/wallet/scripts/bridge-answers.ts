// How a check's stdio bridge (./transfer-rpcs-check.ts, ./rpc-hex-case-check.ts, ./evm-pool-sync-check.ts,
// ./pool-reads-throttle-check.ts) hands its answers to the wallet's read (card spares-replay-order). Live ("wait": true)
// each answer is taken as it comes, as the device takes a provider's. In a replay ("wait": false) the answers come from
// a recording at once, so their order was the runner's: how the pipe cut them into chunks and when each one was read
// decided which seat's answer the read saw first, and the wallet's spare walk (evmPair: a provider the other seat
// holds or has a call open to is not free) went another way on a loaded runner and asked a page the recording never held
// (main's runs 42449928067, 42450557518 and 42450652755: "no recorded answer to eth_getLogs" on
// base-mainnet.public.blastapi.io, on a good run that passed on the Mac). So a replay takes them one at a time: once every
// call asked has its answer and the read has run on from the last one, the lowest call's first, the next only after the
// read has run on from it. The order is then the read's own, the same on every runner and at any speed.

export type BridgeAnswer = { id: number };

/** The bridge's answer taker: `settle(m)` hands one answer to its waiting call; `open()` counts the calls asked and not
 * yet handed an answer. Live, each is handed at once; in a replay, held and handed as above. */
export function bridgeAnswers<M extends BridgeAnswer>(wait: boolean, settle: (m: M) => void, open: () => number): (m: M) => void {
  if (wait) return settle;
  const held = new Map<number, M>();
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        // the read runs on from the answer last handed (every promise it settled, to the calls they ask) first
        await new Promise((r) => setImmediate(r));
        if (held.size === 0 || held.size < open()) return;
        const id = Math.min(...held.keys());
        const m = held.get(id)!;
        held.delete(id);
        settle(m);
      }
    } finally {
      pumping = false;
    }
  };
  return (m) => {
    held.set(m.id, m);
    void pump();
  };
}
