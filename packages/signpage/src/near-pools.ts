// The candidate Rhea pools a NEAR buy's quote reads (card near-private-trading): the kit's rheaQuote takes pool ids "from
// any list" and reads each one itself on two providers at one block, so this list is only a hint, and it never makes
// the device sign against a pool state it did not read on both providers.
// - Where: Rhea's own exchange, get_number_of_pools then get_pools pages of NEAR_POOLS_PAGE, read on BOTH providers of
//   the page's paced pair, each once a session per network and kept (a provider whose read failed is read again on the
//   next quote, the other's list used meanwhile); nothing names the user, W or the token, so the read says nothing of
//   what is bought. 9,015 pools on mainnet at 12 Nov 07:15Z, about 95 KB a page of 500. Pages of 2000 (card
//   near-quote-under-the-pace): 5 reads a provider, not 19; a page of 2000 from index 0 answered on both providers,
//   1,225,371 bytes each as JSON-RPC sends it (the result a list of byte numbers), 2000 rows (12 Nov 22:27Z), a
//   quarter of the helper's RPC_ANSWER_MAX (4 MiB).
// - Which: SIMPLE_POOL rows of exactly two tokens, at most RHEA_QUOTE_POOLS_MAX in all: the token's pools with USDC
//   and with wrapped NEAR, deepest first (by the other token's reserve), then the deepest wrapped NEAR / USDC pools for
//   the route through wrapped NEAR. Each provider's list is ranked on its own and the two are taken in turn (its first,
//   the other's first, ...), so one provider that hides the deep pools, or lists shallow pools as deep to crowd them
//   out, still leaves the other's deepest in. What one lying provider can still do: list real pools that are worse (the
//   quote reads them on both providers and keeps the best route), or ids that are no pool (the quote is refused).
// - Every answer is hostile: a count or row out of shape ends the read (it is read again on the next quote), and the
//   pages are bounded (NEAR_POOLS_MAX).
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA, RHEA_QUOTE_POOLS_MAX } from "../../kit/src/near/rhea.ts";

/** One get_pools page. */
export const NEAR_POOLS_PAGE = 2000;
/** The most pools read: past it the count is refused (mainnet held 9,015). */
export const NEAR_POOLS_MAX = 50_000;
/** Pages in flight at once (the provider's pace still spaces them). */
export const NEAR_POOLS_AT_ONCE = 5;
/** How many wrapped NEAR / USDC pools join the token's own ones. */
export const NEAR_POOLS_BRIDGE = 4;

type Row = { id: number; a: string; b: string; ra: bigint; rb: bigint };
const U128 = /^(0|[1-9]\d{0,38})$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** A view call's answer as JSON (call_function at final), refused unless the result is bytes. */
export async function nearView(rpc: NearRpc, contract: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const a = await rpc.query({ request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) }, signal);
  const r = isObj(a) && isObj(a.result) ? a.result.result : undefined;
  if (!Array.isArray(r) || !r.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error(`${rpc.name}: ${method}: not a view answer`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(r as number[])));
}

/** Rhea's simple two-token pools, read page by page. */
export async function readRheaPools(network: NearNetwork, rpc: NearRpc, signal?: AbortSignal): Promise<Row[]> {
  const exchange = NEAR_RHEA[network].exchange;
  const n = await nearView(rpc, exchange, "get_number_of_pools", {}, signal);
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > NEAR_POOLS_MAX) throw new Error("get_number_of_pools: out of range");
  const pages = Array.from({ length: Math.ceil((n as number) / NEAR_POOLS_PAGE) }, (_, k) => k * NEAR_POOLS_PAGE);
  // NEAR_POOLS_AT_ONCE pages in flight; the rows kept in page order whatever order the answers come in
  const got: Row[][] = [];
  let next = 0;
  const one = async (): Promise<void> => {
    while (next < pages.length) {
      const k = next++;
      const from = pages[k]!;
      const page = await nearView(rpc, exchange, "get_pools", { from_index: from, limit: NEAR_POOLS_PAGE }, signal);
      if (!Array.isArray(page) || page.length > NEAR_POOLS_PAGE) throw new Error("get_pools: not a page");
      const rows: Row[] = [];
      page.forEach((p, i) => {
        if (!isObj(p) || p.pool_kind !== "SIMPLE_POOL") return;
        const t = p.token_account_ids;
        const m = p.amounts;
        if (!Array.isArray(t) || t.length !== 2 || !Array.isArray(m) || m.length !== 2) return;
        if (typeof t[0] !== "string" || typeof t[1] !== "string" || typeof m[0] !== "string" || typeof m[1] !== "string" || !U128.test(m[0]) || !U128.test(m[1])) return;
        rows.push({ id: from + i, a: t[0], b: t[1], ra: BigInt(m[0]), rb: BigInt(m[1]) });
      });
      got[k] = rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(NEAR_POOLS_AT_ONCE, pages.length) }, one));
  const rows = got.flat();
  return rows;
}

/** At most RHEA_QUOTE_POOLS_MAX ids for a buy or sell of `token` against the network's USDC (see the header). */
export function rheaCandidates(network: NearNetwork, rows: readonly Row[], token: string): number[] {
  return rheaCandidatesOf(network, [rows], token);
}

/** The ids of several lists (one per provider), each ranked on its own and taken in turn, distinct, within the cap. */
export function rheaCandidatesOf(network: NearNetwork, lists: readonly (readonly Row[])[], token: string): number[] {
  const each = lists.map((rows) => ranked(network, rows, token));
  const bridge = inTurn(each.map((e) => e.bridge)).slice(0, NEAR_POOLS_BRIDGE);
  const own = inTurn(each.map((e) => e.own))
    .filter((id) => !bridge.includes(id))
    .slice(0, RHEA_QUOTE_POOLS_MAX - bridge.length);
  return [...own, ...bridge];
}

/** The lists' ids taken in turn (each list's first, then each one's second, ...), each id once. */
function inTurn(lists: readonly (readonly number[])[]): number[] {
  const out: number[] = [];
  for (let k = 0; lists.some((l) => k < l.length); k++) for (const l of lists) if (k < l.length && !out.includes(l[k]!)) out.push(l[k]!);
  return out;
}

/** One list's ranking: the token's own pools (at most the cap) and the bridge pools (at most NEAR_POOLS_BRIDGE). */
function ranked(network: NearNetwork, rows: readonly Row[], token: string): { own: number[]; bridge: number[] } {
  const usdc = NEAR_NETWORKS[network].usdc;
  const wrap = NEAR_RHEA[network].wrap;
  // a pool of exactly {x, y}: the reserve of `of` in it (one token, one unit, so pools compare), else null
  const reserve = (r: Row, x: string, y: string, of: string): bigint | null =>
    (r.a === x && r.b === y) || (r.a === y && r.b === x) ? (r.a === of ? r.ra : r.rb) : null;
  const deepest = (pairs: readonly [string, string][], of: string, most: number): number[] =>
    rows
      .map((r) => [r.id, pairs.map(([x, y]) => reserve(r, x, y, of)).find((v) => v !== null) ?? null] as const)
      .filter((e): e is readonly [number, bigint] => e[1] !== null && e[1] > 0n)
      .sort((p, q) => (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : p[0] - q[0]))
      .slice(0, most)
      .map((e) => e[0]);
  // the route through wrapped NEAR: its deepest pools with USDC, by their USDC
  const bridge = token === wrap ? [] : deepest([[wrap, usdc]], usdc, NEAR_POOLS_BRIDGE);
  // the token's own pools with USDC or wrapped NEAR, by the token's reserve in each
  const own = deepest(token === wrap ? [[token, usdc]] : [[token, usdc], [token, wrap]], token, RHEA_QUOTE_POOLS_MAX);
  return { own, bridge };
}

/** The session's candidates per network: the pools read once on each of the two providers (a provider's read again
 *  only after its read failed); the candidates from every list read, refused only when neither was. */
export function rheaPoolsKept(network: NearNetwork, rpcs: () => readonly [NearRpc, NearRpc]): (token: string, signal?: AbortSignal) => Promise<number[]> {
  const kept: (Promise<Row[]> | null)[] = [null, null];
  return async (token, signal) => {
    const pair = rpcs();
    const read = await Promise.allSettled(
      [0, 1].map((i) =>
        (kept[i] ??= readRheaPools(network, pair[i]!, signal).catch((e: unknown) => {
          kept[i] = null;
          throw e;
        })),
      ),
    );
    const lists = read.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (lists.length === 0) throw (read[0] as PromiseRejectedResult).reason;
    return rheaCandidatesOf(network, lists, token);
  };
}
