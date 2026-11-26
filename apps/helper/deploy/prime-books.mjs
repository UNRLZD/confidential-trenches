// The old helper's read before its stop (card helper-tape-handover-reads-a-handed-book). redeploy.sh pipes this file to
// each old helper's own node once the new one is ready and before the old one stops: it reads the trades of the first
// COINS_MAX coins of each chain's lists, as an app on the lists would, so the warm file the old helper writes at its stop
// hands their books over. The handover live check (scripts/live-checks/helper-tape-handover.mjs) reads the same coins of
// the same lists on the new helper. With no user on the lists, the old helper had read none of the lists' coins, and the
// check failed on how long ago the last deploy was, a handover that works included (helpers 245 and 247: 0 of 8 coins
// read as handed, runs 45748513710 and 45797107803; helper 246, deployed an hour after 245: 2 of 3).
// Reads only, with no key, bounded (READ_MS a read, ALL_MS in all); prints counts, never a coin; exits 0 whatever it read.
//   node prime-books.mjs [<helper base>]   (default the helper's own port, as compose.yaml's healthcheck reads it)
const BASE = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
// as the check reads them (helper-tape-handover.mjs CHAINS, COINS_MAX, LIMIT); its test runs this file against the check
const CHAINS = ["base", "robinhood"];
const COINS_MAX = 8;
const LIMIT = 50;
const READ_MS = 15_000;
const ALL_MS = 90_000;
const end = Date.now() + ALL_MS;

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(Math.max(1, Math.min(READ_MS, end - Date.now()))) });
  return { status: r.status, body: await r.text() };
};
const said = [];
for (const chain of CHAINS) {
  let coins = [];
  try {
    const lists = JSON.parse((await get(`/v1/market/lists?chain=${chain}`)).body)?.lists ?? {};
    coins = [...new Set(Object.values(lists).flat().map((r) => r?.token).filter((t) => /^0x[0-9a-f]{40}$/.test(String(t))))].slice(0, COINS_MAX);
  } catch {
    // no lists read: none of this chain's coins
  }
  let read = 0;
  for (const coin of coins) {
    if (Date.now() >= end) break;
    try {
      if ((await get(`/v1/market/trades?chain=${chain}&token=${coin}&limit=${LIMIT}`)).status === 200) read++;
    } catch {
      // not read: counted out
    }
  }
  said.push(`${chain} ${read} of ${coins.length}`);
}
console.log(`read the lists' first coins' trades: ${said.join(", ")}`);
