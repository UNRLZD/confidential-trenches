// Card evm-helper-429-waits-its-retry-after: the page's helper (TRADE_HELPER, src/trade.ts) is the origin the kit's
// EVM hold rule names (kit pace.ts EVM_HELPER_ORIGIN), so a 429 the page's helper answers is held for its Retry-After,
// never the 30 s a third party's is. Read from the page's source, so a copy written out again on either side fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EVM_HELPER_ORIGIN } from "../../kit/src/checks/evm/pace.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** TRADE_HELPER's origin as the source writes it: null unless one quoted https origin is its whole value. */
const tradeHelperOf = (src: string): string | null => {
  const m = [...src.matchAll(/^export const TRADE_HELPER = "(https:\/\/[^"/]+)";$/gm)];
  return m.length === 1 ? m[0]![1]! : null;
};
/** The helper's EVM route written out with its origin quoted (`${TRADE_HELPER}/v1/rpc/...` is no copy). */
const rpcCopiesIn = (src: string): number => (src.match(/["'`]https:\/\/ct-api\.unrealized\.trade\/v1\/rpc\//g) ?? []).length;

test("the page's TRADE_HELPER is the kit's EVM_HELPER_ORIGIN, and no page file writes the helper's rpc route out again", () => {
  assert.equal(tradeHelperOf(readFileSync(SRC + "trade.ts", "utf8")), EVM_HELPER_ORIGIN);
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("trade.ts"), files.join(", "));
  assert.deepEqual(files.map((f) => [f, rpcCopiesIn(readFileSync(SRC + f, "utf8"))] as const).filter(([, n]) => n > 0), []);
  // the plants: another origin, a second definition, a value that is not one quoted origin; the route written out again
  assert.notEqual(tradeHelperOf('export const TRADE_HELPER = "https://ct-api2.unrealized.trade";'), EVM_HELPER_ORIGIN);
  assert.equal(tradeHelperOf(`export const TRADE_HELPER = "${EVM_HELPER_ORIGIN}";\nexport const TRADE_HELPER = "${EVM_HELPER_ORIGIN}";`), null);
  assert.equal(tradeHelperOf("export const TRADE_HELPER = HELPER;"), null);
  assert.equal(rpcCopiesIn('const r = "https://ct-api.unrealized.trade/v1/rpc/base";'), 1);
  assert.equal(rpcCopiesIn("const r = `${TRADE_HELPER}/v1/rpc/base`;"), 0);
});
