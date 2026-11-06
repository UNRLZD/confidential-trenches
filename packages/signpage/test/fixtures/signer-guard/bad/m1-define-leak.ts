// planted (card signer-guard-parser, review of 40115c3d, M1): a signer file (the test gives it `define`, as the four
// real ones have) calls its own signer with no pick, which it may, and hands it out on globalThis, which it may not
export const leakSign = (secretKey: Uint8Array) => secretKey.slice(0, 1);
export const own = (k: Uint8Array) => leakSign(k);
(globalThis as unknown as { __s: unknown }).__s = leakSign;
