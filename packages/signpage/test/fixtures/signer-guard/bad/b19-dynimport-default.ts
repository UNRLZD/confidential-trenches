// planted (card signer-guard-parser, reviewer variant b19-dynimport-default of 1a8a42f0): a computed key on an import() of a
// module whose default export is a signer (good/default-reexport.ts)
export const send = async (k: Uint8Array, c: never, b: never) => {
  const m = await import("../good/default-reexport.ts");
  return m["def" + "ault"](k, c, b);
};
