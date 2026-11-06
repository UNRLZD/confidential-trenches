// planted (card signer-guard-parser, review of 1a367f1e, L1b): a pick at module load, then class members that sign on
// every `new` or call: a field initializer, a parameter property's default, a decorator's argument and a static block
// (the last two run once at load: a false refusal, which fails safe)
import { signEvmSell } from "../../../../src/rules/pool.ts";
import { evmNextNote } from "../../../../../wallet/src/pool/evm-restore.ts";
declare const seed: Uint8Array, scope: bigint, first: never, k: Uint8Array, c: never, b: never;
declare const tag: (x: unknown) => (t: unknown, ctx: unknown) => void;
evmNextNote(seed, scope, [], first, 0n);
export class Sender { sig = signEvmSell(k, c, b); }
export class Param { constructor(public sig = signEvmSell(k, c, b)) {} }
@tag(signEvmSell(k, c, b))
export class Decorated {}
export class Static { static { signEvmSell(k, c, b); } }
