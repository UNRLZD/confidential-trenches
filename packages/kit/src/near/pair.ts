// The rule for a pair of NEAR RPCs, for an app that reads NEAR on two providers (card app-verify-pair-rule). Re-exported,
// not copied, from the wallet's one home for it (it imports nothing, so this adds no wallet code beyond these names): the
// pair is exactly one of the network's FastNEAR URLs and its dRPC URL, each provider named by the exact URL it reads.
// Two hosts of one operator are one read, so a pair of them is refused, as every money path refuses it.
export { nearPairNetwork, nearPairRule, type NearNetwork } from "../../../wallet/src/near/networks.ts";
