// Every pin the kit exports is frozen at every level (card kit-oneclick-pins-frozen, review info 4): a plain object or
// array the kit's entry exports can be read, never written, so nothing running beside the kit (on SIGN_HOST or in an
// app) can change a vault constant, a fetch option or a code list another part of the kit or the app checks against.
// test/exports-frozen.test.ts walks every export of every module under src/ (the entry and each file imported by path),
// following own keys through plain objects and arrays, and fails on one left writable or on any RegExp not in its list.
// Known limits, outside what freezing can hold (card oneclick-fee-path-own-key): a function, a class among them, is
// neither walked nor frozen, so a class's prototype and statics stay writable (SolanaWalletLinks, VaultTree); only own
// keys are frozen, so a read through the prototype chain still sees what a polluted Object.prototype adds (pin tables
// indexed by a caller's key are read as own keys, as oneClickFeeBps does); and the built-ins a frozen pin is used through,
// such as Array.prototype.includes on ONECLICK_USDC_ASSETS, are the realm's, shared and replaceable by any script on the
// page. Each of these needs a script already running beside the kit; freezing stops only a write to the pin itself.

/** `v` with every object and array in it frozen, itself included, a part already frozen at its top too; returned as
 *  it came. */
export function deepFreeze<T>(v: T): T {
  const seen = new WeakSet<object>();
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    for (const k of Reflect.ownKeys(x)) walk((x as Record<PropertyKey, unknown>)[k]);
    Object.freeze(x);
  };
  walk(v);
  return v;
}
