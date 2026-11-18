// card signpage-other-apps-connect: the terminal's flow on APP_HOST is unchanged by the outside apps' approvals.
//   node --test test/main-terminal-no-connect.test.ts      (from packages/signpage)
// src/main.ts booted top-level at SIGN_HOST's root (test/main-dom.ts: the shell framing APP_HOST): the frame's requests
// are answered, the approvals store (src/connections.ts, IndexedDB "ct-connections") is never opened, no gate is asked,
// and no Connected apps list is drawn. The /connect side is test/connections.test.ts's and test/connected-apps.test.ts's.
import { answer, doc, send, sendRaw, settle } from "./main-dom.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { CONNECTIONS_DB } from "../src/connections.ts";

type Node = { tagName?: string; id?: string; children?: Node[] };
const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];

test("APP_HOST's shell: its state answered, no approvals store opened, no Connected apps list", async () => {
  await import("../src/main.ts");
  doc.body.children.find((c) => c.tagName === "iframe")!.dispatchEvent(new Event("load"));
  sendRaw({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION });
  const id = send({ type: "state" });
  const a = await answer(id);
  assert.equal(a?.ok, true, "the terminal's state is answered as before");
  // a host kind of the shell's own (nav) too: no gate asked
  const nav = send({ type: "nav", path: "/portfolio" });
  assert.equal((await answer(nav))?.ok, true);
  await settle();
  const names = (await indexedDB.databases()).map((d) => d.name);
  assert.ok(!names.includes(CONNECTIONS_DB), `no ${CONNECTIONS_DB} on APP_HOST's path: ${names.join(", ")}`);
  assert.ok(!all(doc.body as unknown as Node).some((n) => n.id === "connected" || n.id === "outside"), "no Connected apps list, no outside sheet");
});
