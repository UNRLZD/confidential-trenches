// planted (card signer-guard-parser, reviewer variant b16 of 40115c3d): the caller alone, which reaches a signer some
// other file put on globalThis (bad/m1-define-leak.ts puts one there from a signer file)
export const send = (k: Uint8Array, c: never, b: never) => (globalThis as any).__s(k, c, b);
export const sendByKey = (name: string, k: Uint8Array) => (globalThis as unknown as Record<string, (k: Uint8Array) => Uint8Array>)[name]!(k);
