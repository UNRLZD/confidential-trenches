// planted (card pool-deposits, slice 3 review fold), no refusal: a rule that compares a call's first four bytes to the
// deposit's selector, as rules/pool.ts checkEvmDeposit does; a comparison gives a boolean, never bytes
export const isDeposit = (data: string): boolean => data.slice(0, 10) === "0xe2bbb158";
export const notDeposit = (data: string): boolean => "0xe2bbb158" !== data.slice(0, 10);
