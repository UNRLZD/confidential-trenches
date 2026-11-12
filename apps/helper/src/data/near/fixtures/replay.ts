// The recorded NEAR RPC answers (rhea-reads-2026-11-11.json) as a fetch, for the near tests.
import { readFileSync } from "node:fs";
import type { Fetch } from "../views.ts";

type Rec = { body: { method: string; params: Record<string, unknown> }; view?: unknown; answer?: { result: unknown }; block_height?: number };
const FX = JSON.parse(readFileSync(new URL("./rhea-reads-2026-11-11.json", import.meta.url), "utf8")) as { pages: number[]; rpc: Rec[] };
const keyOf = (b: { method: string; params: Record<string, unknown> }) => JSON.stringify([b.method, b.params]);
const ANSWERS = new Map(FX.rpc.map((r) => [keyOf(r.body), r]));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

/** The recorded answers by request; a get_pools page the recorder did not keep is [], any other request a 500. */
export function fixtureFetch(calls: string[] = []): Fetch {
  return async (url, init) => {
    calls.push(url);
    const b = JSON.parse(String(init.body)) as { method: string; params: Record<string, unknown> };
    const r = ANSWERS.get(keyOf(b));
    const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
    if (r === undefined) {
      if (b.params.method_name === "get_pools") return json({ jsonrpc: "2.0", id: 1, result: { result: bytes([]) } });
      return json({ error: "not recorded" }, 500);
    }
    if (r.view !== undefined) return json({ jsonrpc: "2.0", id: 1, result: { result: bytes(r.view), block_height: r.block_height } });
    return json({ jsonrpc: "2.0", id: 1, ...r.answer });
  };
}

