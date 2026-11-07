// planted (card pool-deposits, slice 3 review fold): the selector joined to arguments inside a comparison is still an
// encoding (the literal's parent is the join, not the ===)
export const sameCall = (data: string, args: string): boolean => data === "0xe2bbb158" + args;
