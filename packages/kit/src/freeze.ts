// Every pin the kit exports is frozen at every level (card kit-oneclick-pins-frozen, review info 4): a plain object or
// array the kit's entry exports can be read, never written, so nothing running beside the kit (on SIGN_HOST or in an
// app) can change a vault constant, a fetch option or a code list another part of the kit or the app checks against.
// test/exports-frozen.test.ts walks every export of src/index.ts and fails on one left writable.

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
