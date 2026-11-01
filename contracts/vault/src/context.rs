// SPDX-License-Identifier: Apache-2.0
//! `scope`, `label` and `context`: the bytes each one hashes, then keccak256 read big-endian, mod p (vault.md 2.2,
//! 2.5.1 row 8 and 2.5.2 row 3; frozen in 7.1). The kit builds the same bytes (`packages/kit/src/vault/shapes.ts`:
//! `vaultScopePreimage`, `vaultLabelPreimage`, `vaultContextPreimage`, `vaultFieldOf`), and the relayer recomputes
//! `context` with the kit. Both sides are held to VT-U02's 50 vectors, `packages/kit/test/vectors/vault-v1.json`.
//!
//! Ported from Privacy Pools v1.3.0 `packages/contracts/src/contracts/State.sol:89` (SCOPE),
//! `PrivacyPool.sol:93` (`label = keccak256(abi.encodePacked(SCOPE, ++nonce))`) and `PrivacyPool.sol:48` (context),
//! Copyright 2025 0XBOW LTD, Apache-2.0. Deviation (vault.md 2.7, Dev 5): NEAR has string account ids and no chain id,
//! so `scope` and `context` hash Borsh bytes in place of ABI encoding; keccak256 mod p stays, so the circuit is
//! unchanged.

use crate::constants::SCOPE_TAG;
use crate::field::{self, U256};
use crate::Bytes32;
use near_sdk::{borsh, env, near, AccountId};

/// keccak256 of `bytes`, its 32 bytes read big-endian, then mod p.
pub fn field_of(bytes: &[u8]) -> U256 {
    field::reduce(field::from_be(&env::keccak256_array(bytes)))
}

/// `borsh(("blindfill-vault-v1", vault, token))`: three Borsh strings, each a 4-byte little-endian length, then its bytes.
pub fn scope_preimage(vault: &str, token: &str) -> Vec<u8> {
    let mut b = Vec::with_capacity(12 + SCOPE_TAG.len() + vault.len() + token.len());
    for s in [SCOPE_TAG, vault, token] {
        b.extend_from_slice(&(s.len() as u32).to_le_bytes());
        b.extend_from_slice(s.as_bytes());
    }
    b
}

/// `scope = keccak256(borsh((SCOPE_TAG, vault, token))) mod p` (vault.md 2.2; PP `State.sol:89` in NEAR form).
pub fn scope_for(vault: &str, token: &str) -> U256 {
    field_of(&scope_preimage(vault, token))
}

/// `scope_be32 ‖ nonce_be32`: the same 64 bytes as PP's `abi.encodePacked(SCOPE, nonce)` (vault.md 2.5.1 row 8).
pub fn label_preimage(scope: &U256, nonce: u64) -> [u8; 64] {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&field::to_be(scope));
    b[56..].copy_from_slice(&nonce.to_be_bytes());
    b
}

/// `label = keccak256(scope_be32 ‖ nonce_be32) mod p`.
pub fn label_of(scope: &U256, nonce: u64) -> U256 {
    field_of(&label_preimage(scope, nonce))
}

/// The withdrawal as `context` hashes it (vault.md 2.5.2 row 3, 7.1). Borsh writes a struct's fields in declaration
/// order with no padding, so this order is the frozen one and never changes: an account id is a 4-byte little-endian
/// length, then its bytes; u128 16 bytes and u64 8 bytes, little-endian; `refund_precommitment` 32 raw big-endian
/// bytes and `salt` 16 raw bytes (fixed arrays, no length). 100 bytes plus the three ids. The kit's
/// `VAULT_CONTEXT_FIELDS` names the same order.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextFields {
    /// this vault's own account id (PP's `processooor`)
    pub processor: AccountId,
    pub recipient: AccountId,
    pub register_deposit: u128,
    pub fee_recipient: AccountId,
    pub relay_fee: u128,
    /// a field element in 1..p-1, as 32 big-endian bytes; the caller refuses 0 and p or more when it parses the request
    pub refund_precommitment: Bytes32,
    pub deadline_ms: u64,
    pub salt: [u8; 16],
}

/// `borsh(fields) ‖ scope_be32`.
pub fn context_preimage(fields: &ContextFields, scope: &U256) -> Vec<u8> {
    let mut b = borsh::to_vec(fields).expect("Borsh of fixed fields and account ids cannot fail");
    b.extend_from_slice(&field::to_be(scope));
    b
}

/// `context = keccak256(borsh(fields) ‖ scope_be32) mod p` (vault.md 2.5.2 row 3; PP `PrivacyPool.sol:48`).
pub fn context_of(fields: &ContextFields, scope: &U256) -> U256 {
    field_of(&context_preimage(fields, scope))
}

/// The request's `salt`: exactly 32 lowercase hex characters, as the kit reads it. Anything else is None, so one salt
/// has one spelling.
pub fn salt_from_hex(s: &str) -> Option<[u8; 16]> {
    let b = s.as_bytes();
    if b.len() != 32 {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 16];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (nibble(b[2 * i])? << 4) | nibble(b[2 * i + 1])?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// VT-U02's one vector file, made by the kit's shapes.ts and recomputed by packages/kit/test/vault-shapes.test.mjs.
    const VECTORS: &str = include_str!("../../../packages/kit/test/vectors/vault-v1.json");

    fn vectors() -> Value {
        testing_env!(VMContextBuilder::new().build());
        let v: Value = serde_json::from_str(VECTORS).expect("vault-v1.json is JSON");
        assert_eq!(v["version"], "blindfill-vault-v1");
        v
    }

    fn rows<'a>(v: &'a Value, kind: &str) -> &'a Vec<Value> {
        v[kind].as_array().unwrap_or_else(|| panic!("{kind}: an array"))
    }

    fn st<'a>(v: &'a Value, k: &str) -> &'a str {
        v[k].as_str().unwrap_or_else(|| panic!("{k}: a string in {v}"))
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn fe(s: &str) -> U256 {
        field::from_decimal(s).unwrap_or_else(|| panic!("{s}: a canonical field element"))
    }

    fn id(s: &str) -> AccountId {
        s.parse().unwrap_or_else(|_| panic!("{s}: a NEAR account id"))
    }

    #[test]
    fn vt_u02_has_50_vectors_8_scope_10_label_32_context() {
        let v = vectors();
        assert_eq!([rows(&v, "scope").len(), rows(&v, "label").len(), rows(&v, "context").len()], [8, 10, 32]);
    }

    #[test]
    fn every_scope_vector_matches_byte_for_byte() {
        let v = vectors();
        for t in rows(&v, "scope") {
            let (vault, asset) = (st(t, "vault"), st(t, "asset"));
            let pre = scope_preimage(vault, asset);
            assert_eq!(hex(&pre), st(t, "preimage_hex"), "{vault}");
            assert_eq!(hex(&env::keccak256_array(&pre)), st(t, "keccak_hex"), "{vault}");
            assert_eq!(field::to_decimal(&scope_for(vault, asset)), st(t, "scope"), "{vault}");
        }
    }

    #[test]
    fn every_label_vector_matches_byte_for_byte() {
        let v = vectors();
        for t in rows(&v, "label") {
            let scope = fe(st(t, "scope"));
            let nonce: u64 = st(t, "nonce").parse().expect("nonce: a u64");
            let pre = label_preimage(&scope, nonce);
            assert_eq!(hex(&pre), st(t, "preimage_hex"), "nonce {nonce}");
            assert_eq!(hex(&env::keccak256_array(pre)), st(t, "keccak_hex"), "nonce {nonce}");
            assert_eq!(field::to_decimal(&label_of(&scope, nonce)), st(t, "label"), "nonce {nonce}");
        }
    }

    fn context_fields(i: &Value) -> ContextFields {
        ContextFields {
            processor: id(st(i, "processor")),
            recipient: id(st(i, "recipient")),
            register_deposit: st(i, "register_deposit").parse().expect("register_deposit: a u128"),
            fee_recipient: id(st(i, "fee_recipient")),
            relay_fee: st(i, "relay_fee").parse().expect("relay_fee: a u128"),
            refund_precommitment: field::to_be(&fe(st(i, "refund_precommitment"))),
            deadline_ms: st(i, "deadline_ms").parse().expect("deadline_ms: a u64"),
            salt: salt_from_hex(st(i, "salt")).expect("salt: 32 lowercase hex"),
        }
    }

    #[test]
    fn every_context_vector_matches_byte_for_byte() {
        let v = vectors();
        for t in rows(&v, "context") {
            let name = st(t, "name");
            let c = context_fields(&t["input"]);
            let scope = fe(st(t, "scope"));
            let pre = context_preimage(&c, &scope);
            assert_eq!(hex(&pre), st(t, "preimage_hex"), "{name}");
            let ids = c.processor.len() + c.recipient.len() + c.fee_recipient.len();
            assert_eq!(pre.len(), 100 + ids + 32, "{name}: 100 bytes plus the ids, then scope");
            assert_eq!(hex(&env::keccak256_array(&pre)), st(t, "keccak_hex"), "{name}");
            assert_eq!(field::to_decimal(&context_of(&c, &scope)), st(t, "context"), "{name}");
        }
    }

    #[test]
    fn the_two_vectors_that_differ_only_in_salt_give_two_contexts() {
        let v = vectors();
        let ctx = rows(&v, "context");
        let (a, b) = (context_fields(&ctx[2]["input"]), context_fields(&ctx[3]["input"]));
        assert_ne!(a.salt, b.salt);
        assert_eq!(ContextFields { salt: b.salt, ..a.clone() }, b, "only the salt differs");
        let scope = fe(st(&ctx[2], "scope"));
        assert_eq!(scope, fe(st(&ctx[3], "scope")));
        assert_ne!(context_of(&a, &scope), context_of(&b, &scope));
    }

    #[test]
    fn a_salt_has_one_spelling() {
        assert_eq!(salt_from_hex("00000000000000000000000000000000"), Some([0; 16]));
        assert_eq!(salt_from_hex("ffffffffffffffffffffffffffffffff"), Some([0xff; 16]));
        assert_eq!(salt_from_hex("0123456789abcdef0123456789abcdef").map(|s| s[..8].to_vec()), Some(vec![1, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]));
        for bad in [
            "",
            "0000000000000000000000000000000",   // 31
            "000000000000000000000000000000000", // 33
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",  // uppercase: a second spelling
            "0x000000000000000000000000000000",  // a prefix
            "g0000000000000000000000000000000",
            " 0000000000000000000000000000000",
        ] {
            assert_eq!(salt_from_hex(bad), None, "{bad:?}");
        }
    }
}
