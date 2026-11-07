// planted (card pool-deposits, slice 3 review fold): the selector held in a const, compared once and then free to be
// joined into calldata: a literal outside a === or !== needs a pick
const SELECTOR = "0xe2bbb158";
export const isDeposit = (data: string): boolean => data.slice(0, 10) === SELECTOR;
