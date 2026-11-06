// Card signer-guard-parser (reviewer variant p3a of c00a169d): a module of ours that re-exports both pinned packages
// whole (bad/p3b-reexport-user.ts reads it); a re-export alone signs nothing
export * from "../../../../wallet/node_modules/@scure/bip32/index.js";
export * from "@noble/curves/secp256k1.js";
