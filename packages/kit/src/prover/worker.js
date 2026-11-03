// The prover worker's own code (vault.md 2.14, row V2.4). build.mjs writes prover-worker.js as snarkjs 0.7.5's browser
// build, byte for byte, then this file with the setup files' pins put in for PINS and prover-thread.js's for THREAD. It
// loads no other script (no importScripts, which Integrity-Policy blocked-destinations=(script) on SIGN_HOST would
// refuse) and uses no eval.
// Threads (card signpage-prover-threads): snarkjs proves on min(hardwareConcurrency - 1, 4) threads, one core left to
// the page; with fewer than 2, or no Worker here, or THREAD unset, it proves single thread. snarkjs starts each thread
// with `new Worker(<blob: or data: URL of its thread code>)`, which SIGN_HOST's CSP (worker-src 'self') and Trusted Types
// refuse; the boundary is that CSP and Trusted Types, and what follows is a compatibility shim inside it. This worker
// stands in its own Worker for snarkjs's: whatever URL snarkjs asks for, it starts only the same-origin file
// THREAD.path through this worker's own Trusted Types policy prover-worker, which turns that one URL and nothing else
// into a TrustedScriptURL. That the file is byte for byte snarkjs's thread code rests on the deploy gate's byte compare
// (packages/signpage/scripts/deploy.mjs) and on the live check's pin read after each deploy
// (scripts/live-checks/signpage-prover-threads.mjs): a fetch here would not control what the browser then starts.
// snarkjs reads the thread count from hardwareConcurrency, so this worker sets its own navigator's to the count.
// A thread that fails to start, or gives no first reply within THREAD_START_MS, ends this worker: the error is thrown
// again outside any promise, so the page's Worker fires `error` and the page drops the worker (client.ts), never a
// proof that waits for ever.
// The page moves each setup file here by transfer (client.ts); this worker checks every one's size and sha256 against
// the pins before snarkjs sees it and refuses anything else, so a changed byte never reaches a proof.
//   {id, cmd: "load", circuit, wasm: ArrayBuffer, zkey: ArrayBuffer}  -> {id, ok: true, value: {circuit}}
//   {id, cmd: "prove", circuit, input}                                 -> {id, ok: true, value: {proof, publicSignals, proveMs, threads}}
//   any refusal                                                        -> {id, ok: false, error}
//   a CSP or Trusted Types violation in this worker                   -> {type: "violation", violation}
(() => {
  "use strict"; // inside the function: in prover-worker.js this code follows snarkjs.min.js, so a file-level one is no directive
  const PINS = /*@PINS@*/ null;
  const THREAD = /*@THREAD@*/ null;
  const CIRCUITS = ["withdraw", "commitment"];
  const loaded = Object.create(null);

  const nav = self.navigator;
  const NativeWorker = typeof self.Worker === "function" ? self.Worker : null;
  const THREADS = Math.max(1, Math.min(((nav && Number(nav.hardwareConcurrency)) | 0) - 1, 4));
  const threaded = THREADS > 1 && NativeWorker !== null && THREAD !== null;
  const THREAD_START_MS = 30000;
  let started = 0; // threads this worker has started
  // thrown outside any promise, so it reaches this worker's global scope and the page's Worker fires `error`
  const die = (why) =>
    setTimeout(() => {
      throw new Error(`prover thread: ${why}`);
    }, 0);
  if (threaded) {
    const url = new URL(THREAD.path, self.location.origin).href;
    const tt = self.trustedTypes;
    const threadURL = tt
      ? tt
          .createPolicy("prover-worker", {
            createScriptURL(input) {
              if (input !== url) throw new TypeError(`prover-worker refuses ${input}`);
              return input;
            },
          })
          .createScriptURL(url)
      : url;
    Object.defineProperty(nav, "hardwareConcurrency", { value: THREADS, configurable: true });
    self.Worker = function ProverThread() {
      const w = new NativeWorker(threadURL, { name: "prover-thread" });
      const n = ++started;
      let answered = false;
      const limit = setTimeout(() => answered || die(`thread ${n} gave no first reply in ${THREAD_START_MS / 1000} s`), THREAD_START_MS);
      w.addEventListener("message", () => ((answered = true), clearTimeout(limit)), { once: true });
      w.addEventListener("error", (e) => {
        clearTimeout(limit);
        die(`thread ${n} failed: ${String((e && e.message) || "it did not start")}`);
      });
      return w;
    };
  }

  self.addEventListener("securitypolicyviolation", (e) => {
    self.postMessage({
      type: "violation",
      violation: { directive: String(e.effectiveDirective || e.violatedDirective || ""), blocked: String(e.blockedURI || ""), sample: String(e.sample || "") },
    });
  });

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

  async function checked(name, buf) {
    const pin = PINS && Object.prototype.hasOwnProperty.call(PINS, name) ? PINS[name] : null;
    if (!pin) throw new Error(`${name}: not a pinned setup file`);
    if (!(buf instanceof ArrayBuffer)) throw new Error(`${name}: not moved as an ArrayBuffer`);
    if (buf.byteLength !== pin.bytes) throw new Error(`${name}: ${buf.byteLength} B, pinned ${pin.bytes} B`);
    const sha256 = hex(await crypto.subtle.digest("SHA-256", buf));
    if (sha256 !== pin.sha256) throw new Error(`${name}: sha256 ${sha256}, pinned ${pin.sha256}`);
    return new Uint8Array(buf);
  }

  self.addEventListener("message", async (ev) => {
    const m = ev.data || {};
    try {
      if (!CIRCUITS.includes(m.circuit)) throw new Error("unknown circuit");
      let value;
      if (m.cmd === "load") {
        delete loaded[m.circuit];
        const wasm = await checked(`${m.circuit}.wasm`, m.wasm);
        const zkey = await checked(`${m.circuit}.zkey`, m.zkey);
        loaded[m.circuit] = { wasm, zkey };
        value = { circuit: m.circuit };
      } else if (m.cmd === "prove") {
        const c = loaded[m.circuit];
        if (!c) throw new Error(`${m.circuit}: setup files not loaded`);
        if (typeof snarkjs !== "object" || !snarkjs || !snarkjs.groth16) throw new Error("snarkjs is missing");
        const t0 = performance.now();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(m.input, c.wasm, c.zkey, undefined, undefined, { singleThread: !threaded });
        // the threads snarkjs has started in this worker (it keeps them across proofs); 1 when it proves single thread
        value = { proof, publicSignals, proveMs: Math.round(performance.now() - t0), threads: threaded ? started : 1 };
      } else {
        throw new Error("unknown command");
      }
      self.postMessage({ id: m.id, ok: true, value });
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 500) });
    }
  });
})();
