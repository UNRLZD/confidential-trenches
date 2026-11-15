// Runs ../src/restore/walk-worker.ts in a node:worker_threads Worker as a browser runs it in a module Worker: the
// global scope's addEventListener("message") and postMessage, over this thread's port (structured clone both ways).
import { parentPort, workerData } from "node:worker_threads";

globalThis.addEventListener = (type, listener) => {
  if (type === "message") parentPort.on("message", (data) => listener({ data }));
};
globalThis.postMessage = (m) => parentPort.postMessage(m);
await import("../src/restore/walk-worker.ts");
// workerData { noWasm: true }: no WebAssembly once the code is loaded (node's TypeScript loader uses it), as a page
// whose policy refuses to compile it, so the walk hashes on BigInt (card firefox-restore-holds-on-every-runner)
if (workerData?.noWasm) delete globalThis.WebAssembly;
