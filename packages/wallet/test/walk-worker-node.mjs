// Runs ../src/restore/walk-worker.ts in a node:worker_threads Worker as a browser runs it in a module Worker: the
// global scope's addEventListener("message") and postMessage, over this thread's port (structured clone both ways).
import { parentPort } from "node:worker_threads";

globalThis.addEventListener = (type, listener) => {
  if (type === "message") parentPort.on("message", (data) => listener({ data }));
};
globalThis.postMessage = (m) => parentPort.postMessage(m);
await import("../src/restore/walk-worker.ts");
