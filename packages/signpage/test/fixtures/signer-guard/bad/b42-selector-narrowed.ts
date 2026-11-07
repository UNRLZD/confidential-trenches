// planted (card pool-deposits, the fold's delta review L1): the literal only compared, but to a value (a reference) that
// the compare narrows to the selector, which is then joined into calldata; only a call's result is compared, never a name
export const build = (sel: string, args: string): string | null => (sel === "0xe2bbb158" ? sel + args : null);
