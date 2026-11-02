// The prover worker's own code (vault.md 2.14, row V2.4). build.mjs writes prover-worker.js as snarkjs 0.7.5's browser
// build, byte for byte, then this file with the setup files' pins put in for PINS and prover-thread.js's for THREAD. It
// loads no other script (no importScripts, which Integrity-Policy blocked-destinations=(script) on SIGN_HOST would
// refuse) and uses no eval.
// Threads (card signpage-prover-threads): snarkjs proves on min(hardwareConcurrency - 1, 4) threads, one core left to
// the page; with fewer than 2, or no Worker here, or THREAD unset, it proves single thread. snarkjs starts each thread
// with `new Worker(<blob: or data: URL of its thread code>)`, which SIGN_HOST's CSP (worker-src 'self') and Trusted Types
// refuse. So this worker stands in its own Worker for snarkjs's: whatever URL snarkjs asks for, it starts only the
// same-origin file THREAD.path, byte for byte snarkjs's thread code (build.mjs), through this worker's own Trusted
// Types policy prover-worker, which turns that one URL and nothing else into a TrustedScriptURL. At the first load it
// fetches that file and checks its size and sha256 against THREAD, and refuses the load when they differ, so no thread
// starts from a file that is not the pinned one. snarkjs reads the thread count from hardwareConcurrency, so this
// worker sets its own navigator's to the count.
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
  let threadURL = null; // THREAD.path as this worker's prover-worker policy made it, once the served file matched THREAD
  let threadCheck = null;
  if (threaded) {
    Object.defineProperty(nav, "hardwareConcurrency", { value: THREADS, configurable: true });
    self.Worker = function ProverThread() {
      if (threadURL === null) throw new Error("prover thread: the thread file is not checked");
      return new NativeWorker(threadURL, { name: "prover-thread" });
    };
  }

  async function checkThread() {
    const url = new URL(THREAD.path, self.location.origin).href;
    const r = await self.fetch(url, { credentials: "omit", cache: "no-cache" });
    if (!r.ok) throw new Error(`${THREAD.path}: HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength !== THREAD.bytes) throw new Error(`${THREAD.path}: ${buf.byteLength} B, pinned ${THREAD.bytes} B`);
    const sha256 = hex(await crypto.subtle.digest("SHA-256", buf));
    if (sha256 !== THREAD.sha256) throw new Error(`${THREAD.path}: sha256 ${sha256}, pinned ${THREAD.sha256}`);
    const tt = self.trustedTypes;
    if (!tt) return void (threadURL = url);
    const policy = tt.createPolicy("prover-worker", {
      createScriptURL(input) {
        if (input !== url) throw new TypeError(`prover-worker refuses ${input}`);
        return input;
      },
    });
    threadURL = policy.createScriptURL(url);
  }
  // the first load checks the thread file once; a failed check is tried again at the next load
  const threadReady = () => {
    if (!threaded || threadURL !== null) return Promise.resolve();
    threadCheck ??= checkThread().finally(() => (threadCheck = null));
    return threadCheck;
  };

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
        await threadReady();
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
        value = { proof, publicSignals, proveMs: Math.round(performance.now() - t0), threads: threaded ? THREADS : 1 };
      } else {
        throw new Error("unknown command");
      }
      self.postMessage({ id: m.id, ok: true, value });
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 500) });
    }
  });
})();
