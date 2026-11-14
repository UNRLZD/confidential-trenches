// The fork runs' requests to anvil (packages/signpage/scripts/pool-fork-evm*.mjs), with each block at or before the
// fork's block read from the fork's own URL (fork-rpc.mjs) in place of anvil.
// anvil 1.7.1 answers eth_getBlockByNumber for such a block (ClientFork::block_by_number and block_by_number_full,
// crates/anvil/src/eth/backend/fork.rs) by taking its fork cache's read lock twice in one expression, the block's hash
// and then the block. The lock is parking_lot's, which queues a reader behind a waiting writer: a cache write between the
// two (any fork read that caches, eth_getLogs's or a block fetch's) waits for the first read, the second read waits for
// the write, and every worker that touches the cache after stops with them, so the fork answers nothing again. Sampled
// 14 Nov 01:10Z on a Base fork buy: nine tokio workers on that lock, one in wait_for_readers, the run's probe refused for
// 300 s. Fixed in anvil v1.9.0 (foundry-rs/foundry #17704, "avoid nested fork storage read locks"). Such a block is
// mainnet history anvil only forwards to its fork URL (fetch_full_block), so reading it there gives the same answer and
// no request takes the double lock. Every other request goes to anvil as sent.
const isNumber = (b) => typeof b === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(b);

/** The fetch of a fork run's anvil requests: `realFetch` the process's own fetch, `anvil` anvil's URL. The fork's URL and
 *  block are read once from anvil (anvil_nodeInfo's forkConfig); a run with no fork there sends everything to anvil. */
export function anvilFetch(realFetch, anvil) {
  let fork;
  const forkOf = () =>
    (fork ??= realFetch(anvil, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_nodeInfo", params: [] }) })
      .then((r) => r.json())
      .then((j) => {
        const c = j?.result?.forkConfig;
        const at = c?.forkBlockNumber;
        if (typeof c?.forkUrl !== "string" || !/^https?:\/\//.test(c.forkUrl) || !(Number.isSafeInteger(at) || isNumber(at))) return null;
        return { url: c.forkUrl, at: BigInt(at) };
      })
      .catch((e) => {
        // anvil not up yet: read again at the next request
        fork = undefined;
        throw e;
      }));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return async (init) => {
    let body;
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "");
    } catch {
      return realFetch(anvil, init);
    }
    const calls = [body].flat();
    const block = (c) => c !== null && typeof c === "object" && c.method === "eth_getBlockByNumber" && Array.isArray(c.params) && isNumber(c.params[0]);
    if (!calls.some(block)) return realFetch(anvil, init);
    const f = await forkOf();
    if (f === null) return realFetch(anvil, init);
    const past = (c) => block(c) && BigInt(c.params[0]) <= f.at;
    if (!calls.some(past)) return realFetch(anvil, init);
    const post = async (url, b) => (await realFetch(url, { ...init, body: JSON.stringify(b) })).json();
    if (!Array.isArray(body)) return json(await post(f.url, body));
    const there = calls.filter(past);
    const here = calls.filter((c) => !past(c));
    const [a, b] = await Promise.all([post(f.url, there), here.length > 0 ? post(anvil, here) : []]);
    const byId = new Map([...[a].flat(), ...[b].flat()].map((x) => [x?.id, x]));
    return json(calls.map((c) => byId.get(c?.id) ?? { jsonrpc: "2.0", id: c?.id ?? null, error: { code: -32603, message: "no answer" } }));
  };
}
