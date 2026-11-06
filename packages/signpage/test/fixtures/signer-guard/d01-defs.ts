// Card signer-guard-parser (reviewer variant d01 of 1a8a42f0): a planted signer file whose signer has no builder or
// signer name, which the name rule passed as no signer (bad/d01-user.ts calls it)
export const fastPath = (secretKey: Uint8Array) => secretKey.slice(0, 1);
