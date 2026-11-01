// Compile-time checks of the kit's shapes. The kit's own tsc compiles this file (tsconfig.json "include"); index.ts never
// reaches it, so an app that compiles the kit's source never compiles these. Each check is exported so the kit's
// noUnusedLocals does not refuse it.
import type { Chain, NonceRefs, OrderRecord, ReturnKey, SignpageKind, SignpageParams, SignpageResults } from "../src/index.ts";
import type { OPEN_KINDS, ORDER_RECORD_FIELDS, ORDER_VARIANTS_MAX } from "../src/index.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// the params and results name exactly the fifteen kinds, and every open kind takes a return key
export type ParamsCoverKinds = Assert<Same<keyof SignpageParams, SignpageKind>>;
export type ResultsCoverKinds = Assert<Same<keyof SignpageResults, SignpageKind>>;
export type OpenKindsTakeReturnKey = Assert<SignpageParams[(typeof OPEN_KINDS)[number]] extends { return_key: ReturnKey } ? true : false>;

// the order record's field list and interface name the same fields, variants holds 1 to 3, one nonce form per chain
export type OrderRecordFieldsMatch = Assert<Same<keyof OrderRecord, (typeof ORDER_RECORD_FIELDS)[number]>>;
export type VariantsOneToThree = Assert<Same<OrderRecord["variants"]["length"], 1 | 2 | typeof ORDER_VARIANTS_MAX>>;
export type NonceRefPerChain = Assert<Same<keyof NonceRefs, Chain>>;
