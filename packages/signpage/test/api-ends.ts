// Card signpage-error-after-timeout: one request of a kind through the page's api (src/api.ts startApi) with the kind's
// real handler, and what the page posts for its id. A trade kind's answer may come past the kit client's window
// (10 s), which the client drops: the app then ends the trade only on a progress stage (apps/terminal/src/screens/trade/
// model.ts progress), so each test reads the progress stages posted after the answer.
import assert from "node:assert/strict";
import type { SignpageKind } from "../../kit/src/signpage/messages.ts";
import { APP_ORIGIN, signedOutState, startApi, type ApiHost, type IncomingMessage } from "../src/api.ts";

type Handler = NonNullable<ApiHost["kinds"]>[SignpageKind];

/** Posts one request of `kind` (its params as the kit sends them) and returns the page's posts for its id, once its
 *  answer is posted and the queue is idle: `answer` the answer, `stages` the progress stages posted after it. */
export async function throughApi(kind: SignpageKind, handler: Handler, params: Record<string, unknown>, waitMs = 5_000): Promise<{ answer: unknown; stages: string[]; mine: unknown[] }> {
  const posted: unknown[] = [];
  let listener: ((e: IncomingMessage) => void) | null = null;
  const parent = { postMessage: (msg: unknown) => void posted.push(msg) };
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => signedOutState(), kinds: { [kind]: handler } });
  const id = crypto.randomUUID();
  listener!({ origin: APP_ORIGIN, source: parent, data: { v: 1, id, type: kind, ...params } });
  const end = Date.now() + waitMs;
  const answered = () => posted.some((m) => (m as { id?: string }).id === id && Object.hasOwn(m as object, "ok"));
  while (!answered()) {
    if (Date.now() > end) assert.fail(`no answer for ${kind}: ${JSON.stringify(posted)}`);
    await new Promise((ok) => setTimeout(ok, 1));
  }
  await api.idle();
  await new Promise((ok) => setTimeout(ok, 20));
  await api.idle();
  const mine = posted.filter((m) => (m as { id?: string }).id === id);
  const at = mine.findIndex((m) => Object.hasOwn(m as object, "ok"));
  const stages = mine.slice(at + 1).flatMap((m) => ((m as { type?: string }).type === "progress" && typeof (m as { stage?: unknown }).stage === "string" ? [(m as { stage: string }).stage] : []));
  return { answer: mine[at], stages, mine };
}
