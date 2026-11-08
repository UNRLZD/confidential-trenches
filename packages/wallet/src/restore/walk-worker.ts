// A walk Worker's entry (card wallet-restore-wallets): one WalkAsk in, one WalkAnswer out (./walk.ts). Run as a module
// Worker, whose global scope has addEventListener and postMessage.
import { answerWalk } from "./walk.ts";

const scope = globalThis as unknown as { addEventListener(t: "message", f: (e: { data: unknown }) => void): void; postMessage(m: unknown): void };
scope.addEventListener("message", (e) => scope.postMessage(answerWalk(e.data)));
