// One rule for reading the vault's paged lists (`deposits` for the deposit relayer, `spends` for the withdrawal relayer)
// on two NEAR providers of two operators: a page counts only when both answer it at the block asked, with the same block
// hash and the same bytes, and every row sits at its own index. Anything else throws, so the caller decides nothing on
// it (markets paper H3.4 check 5: "a page counts only when the two answers agree at a block whose hash is the same on
// both").

/** A JSON-RPC call to one NEAR provider (bind/send.ts nearRpc makes one). */
export type Rpc = (method: string, params: unknown) => Promise<unknown>;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One provider's answer to `method(from, limit)` at block `h`: its bytes and the hash of the block it names, which must be `h`. */
async function pageOf(r: Rpc, account: string, method: string, h: bigint, from: number, limit: number): Promise<{ bytes: Buffer; hash: string }> {
  const a = await r("query", {
    request_type: "call_function",
    block_id: Number(h),
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify({ from, limit })).toString("base64"),
  });
  if (!isObj(a) || !Array.isArray(a.result)) throw new Error(`${method}: no result bytes`);
  if (a.block_height !== Number(h)) throw new Error(`${method}: not answered at the block asked`);
  if (typeof a.block_hash !== "string" || !B58.test(a.block_hash)) throw new Error(`${method}: no block hash`);
  if (!a.result.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error(`${method}: result not bytes`);
  return { bytes: Buffer.from(a.result as number[]), hash: a.block_hash };
}

/**
 * The rows `from..from+limit` of `account`'s paged list `method` at block `h`, read on both providers. Throws unless
 * both answer at `h` with one block hash and the same bytes, the bytes are a JSON list of at most `limit` objects, and
 * row i holds `index` = from + i. A short page is the list's end.
 */
export async function pagesAt(rpcs: readonly [Rpc, Rpc], account: string, method: string, h: bigint, from: number, limit: number): Promise<Record<string, unknown>[]> {
  const [a, b] = await Promise.all(rpcs.map((r) => pageOf(r, account, method, h, from, limit)));
  if (a!.hash !== b!.hash) throw new Error(`${method}: the two providers name different blocks`);
  if (!a!.bytes.equals(b!.bytes)) throw new Error(`${method}: the two providers disagree on a page`);
  const page = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(a!.bytes)) as unknown;
  if (!Array.isArray(page) || page.length > limit) throw new Error(`${method}: not a page`);
  page.forEach((x, i) => {
    if (!isObj(x) || x.index !== from + i) throw new Error(`${method}: a row not at its index`);
  });
  return page as Record<string, unknown>[];
}
