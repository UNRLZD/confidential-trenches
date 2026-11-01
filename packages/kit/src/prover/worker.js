// The prover worker's own code (vault.md 2.14, row V2.4). build.mjs writes prover-worker.js as snarkjs 0.7.5's browser
// build, byte for byte, then this file with the setup files' pins put in for PINS. So the worker is one file: it loads
// no other script (no importScripts, which Integrity-Policy blocked-destinations=(script) on SIGN_HOST would refuse),
// makes no worker of its own (fullProve's singleThread, ffjavascript src/threadman.js:90-98) and uses no eval.
// The page moves each setup file here by transfer (client.ts); this worker checks every one's size and sha256 against
// the pins before snarkjs sees it and refuses anything else, so a changed byte never reaches a proof.
//   {id, cmd: "load", circuit, wasm: ArrayBuffer, zkey: ArrayBuffer}  -> {id, ok: true, value: {circuit}}
//   {id, cmd: "prove", circuit, input}                                 -> {id, ok: true, value: {proof, publicSignals, proveMs}}
//   any refusal                                                        -> {id, ok: false, error}
//   a CSP or Trusted Types violation in this worker                   -> {type: "violation", violation}
(() => {
  "use strict"; // inside the function: in prover-worker.js this code follows snarkjs.min.js, so a file-level one is no directive
  const PINS = /*@PINS@*/ null;
  const CIRCUITS = ["withdraw", "commitment"];
  const loaded = Object.create(null);

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
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(m.input, c.wasm, c.zkey, undefined, undefined, { singleThread: true });
        value = { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
      } else {
        throw new Error("unknown command");
      }
      self.postMessage({ id: m.id, ok: true, value });
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 500) });
    }
  });
})();
