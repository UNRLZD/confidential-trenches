// node --test apps/helper/src/data/solana/page-meta-logo.test.ts (card token-page-data-complete-and-fast): a token page
// whose Jupiter row has no logo asks for its metadata's image (../logo.ts fromMeta, the mint's own uri), and its row's
// icon is set once the URL is known. Its own file: the logo registry is one per process, and token.test.ts fills it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSolanaToken } from "./token.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const NOW = Date.parse("2026-11-02T13:53:00Z");
const URI = "https://ipfs.io/ipfs/bafkreibcglldkfdekdkxgumlveoe6qv3pbiceypkwtli33clbzul7leo4m"; // the mint's own, on chain

/** The mint read answers the recorded mint account and no Metaplex account; every other read none. */
const rpc = {
  async handle(_c: string, _ct: string | undefined, body: string) {
    const r = JSON.parse(body) as { method: string; params: [string[], { encoding?: string }] };
    if (r.method !== "getMultipleAccounts") return { status: 503, body: '{"error":{"code":"upstream"}}' };
    const keys = r.params[0];
    const value = keys.map((k, i) => (i === 0 && k === PUMP && r.params[1].encoding !== "base64" ? FX.tokens[PUMP].accounts.result.value[0] : null));
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value } }) };
  },
};
const proxyOf = (icon: string | null) => ({
  async handle() {
    return { status: 200, headers: { "X-Fetched-At": FX.tokens[PUMP].fetched_at }, body: JSON.stringify(FX.tokens[PUMP].search.map((r: Record<string, unknown>) => ({ ...r, icon }))) };
  },
});

test("a page whose Jupiter row has no logo asks for its metadata's image once and draws it when known; a row with a logo asks nothing", async () => {
  const asked: [string, string, unknown][] = [];
  let open!: (v: boolean) => void;
  const metaLogos = { fromMeta: (c: string, m: string, uri: unknown) => (asked.push([c, m, uri]), new Promise<boolean>((ok) => (open = ok))) };
  const t = createSolanaToken(proxyOf(null) as never, rpc as never, { now: () => NOW, metaLogos });
  const p = JSON.parse((await t.page(PUMP)).body);
  assert.equal(p.row.icon, false);
  assert.deepEqual(asked, [["solana", PUMP, URI]]);
  open(true);
  await new Promise((ok) => setImmediate(ok));
  assert.equal(JSON.parse((await t.page(PUMP)).body).row.icon, true);
  // a Jupiter logo is the row's: no metadata read
  const withIcon = createSolanaToken(proxyOf(FX.tokens[PUMP].search[0].icon) as never, rpc as never, { now: () => NOW, metaLogos: { fromMeta: async () => (asked.push(["x", "x", "x"]), true) } });
  assert.equal(JSON.parse((await withIcon.page(PUMP)).body).row.icon, true);
  assert.equal(asked.length, 1);
});
