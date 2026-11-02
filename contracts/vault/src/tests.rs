// SPDX-License-Identifier: Apache-2.0
//! Unit tests of the skeleton, in near-sdk's mocked blockchain.

use super::*;
use near_sdk::borsh;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn at(account: &str) {
    testing_env!(VMContextBuilder::new().current_account_id(account.parse().unwrap()).build());
}

fn dec_of(n: &field::U256) -> String {
    field::to_decimal(n)
}

// VT-U02's scope vectors, all 8, made by the kit's own TypeScript (packages/kit/test/vectors/vault-v1.json on card
// kit-freeze-vault at 4627f82): an implementation apart from this one. They include the mainnet names
// vault.confidential.unrlzd.near and vault-test.confidential.unrlzd.near.
const KIT_SCOPE_VECTORS: [(&str, &str, &str); 8] = [
    ("vault.test.near", "token.test.near", "5072219746749309470750818130492706027783139455468960929403255949759297921774"),
    ("vault.blindfill.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "16662280991785675369497844937667382859880671281709203477245988256153950627371"),
    ("blindfill-vault.testnet", "usdc.fakes.testnet", "14090770524410888430224531465369551299190548835170249055311171831321123385000"),
    ("ab", "cd", "20140971955816724150720695925831920467796116491617058689276657274348330201270"),
    ("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.test.near", "0xabababababababababababababababababababab", "9034959744937537139939941921384637516008514430191250421905699374517591735340"),
    ("vault.confidential.unrlzd.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "2696045386038969515385069783440640732471742599039067451316404212202914210601"),
    ("vault-test.confidential.unrlzd.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "8086271268364488307551911707115823685859436809391798291511922449751894623475"),
    ("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv.near", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "7224455128834488627368050912648686451945915340954810834723647495687916324593"),
];

#[test]
fn scope_matches_every_kit_vector() {
    at("vault.testnet");
    for (vault, token, want) in KIT_SCOPE_VECTORS {
        assert_eq!(dec_of(&scope_for(vault, token)), want, "{vault} {token}");
    }
}

#[test]
fn scope_is_this_account_and_token() {
    at("vault.skeleton.testnet");
    assert_eq!(scope(), scope_for("vault.skeleton.testnet", TOKEN));
    at("vault2.skeleton.testnet");
    assert_ne!(scope(), scope_for("vault.skeleton.testnet", TOKEN));
}

#[test]
fn decimals_are_canonical_field_elements() {
    let p = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    let p_minus_1 = "21888242871839275222246405745257275088548364400416034343698204186575808495616";
    assert_eq!(dec_of(&field::P), p);
    assert_eq!(field::from_decimal(p), None, "p itself is not a field element");
    assert_eq!(dec_of(&field::from_decimal(p_minus_1).unwrap()), p_minus_1);
    assert_eq!(dec_of(&field::from_decimal("0").unwrap()), "0");
    for bad in ["", "00", "01", "-1", "+1", "1 ", "0x1", "1e3"] {
        assert_eq!(field::from_decimal(bad), None, "{bad:?}");
    }
    // 2^256 overflows the limbs
    let two_256 = "115792089237316195423570985008687907853269984665640564039457584007913129639936";
    assert_eq!(field::from_decimal(two_256), None);
    // the largest 256-bit number reduces below p, by five subtractions
    let r = field::reduce([u64::MAX; 4]);
    assert_eq!(dec_of(&r), "6350874878119819312338956282401532410528162663560392320966563075034087161850");
    assert_eq!(field::to_be(&field::from_be(&[7u8; 32])), [7u8; 32]);
}

#[test]
fn config_names_the_token_scope_and_constants() {
    at("vault.skeleton.testnet");
    let c = Vault::default().config();
    assert_eq!(c.asset.as_str(), TOKEN);
    #[cfg(feature = "testnet")]
    assert_eq!(c.asset.as_str(), "bf-usdc-20261101t022248.testnet"); // gitleaks:allow (a public account id)
    #[cfg(not(feature = "testnet"))]
    assert_eq!(c.asset.as_str(), "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    assert_eq!(c.version, format!("blindfill-vault {} {}", env!("CARGO_PKG_VERSION"), NETWORK));
    assert_eq!(c.scope, dec_of(&scope_for("vault.skeleton.testnet", TOKEN)));
    assert_eq!(
        (c.max_tree_depth, c.min_deposit.0, c.max_relay_fee_bps, c.page_max, c.intents.as_str()),
        (32, 1_000_000, 5_000, 1_000, "intents.near")
    );
    assert_eq!((c.gas_ft_transfer_tgas, c.gas_storage_deposit_tgas, c.gas_on_payout_tgas), (15, 10, 30));
    assert_eq!((c.deposit_storage_bytes, c.refund_reserve_bytes), (756, 389));
}

#[test]
fn a_fresh_vault_reads_empty() {
    at("vault.skeleton.testnet");
    let v = Vault::default();
    for t in [v.state_tree(), v.label_tree()] {
        assert_eq!((t.size, t.depth, t.root.as_str()), (0, 0, "0"));
    }
    assert!(v.leaves(0, 1_000).is_empty());
    assert!(v.labels(0, 1_000).is_empty());
    assert!(v.deposits(0, 1_000).is_empty());
    assert!(v.spends(0, 1_000).is_empty());
    assert_eq!(v.totals(), Totals::default());
    assert!(!v.is_known_state_root("0".into()));
    assert!(!v.is_known_label_root("1".into()));
}

#[test]
#[should_panic(expected = "InvalidRoot")]
fn a_root_at_p_is_refused() {
    at("vault.skeleton.testnet");
    Vault::default()
        .is_known_state_root("21888242871839275222246405745257275088548364400416034343698204186575808495617".into());
}

#[test]
#[should_panic(expected = "InvalidRoot")]
fn a_root_with_a_leading_zero_is_refused() {
    at("vault.skeleton.testnet");
    Vault::default().is_known_label_root("07".into());
}

fn deposit(i: u64) -> Deposit {
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&i.to_be_bytes());
    Deposit { precommitment: b, label: b, value: 1_000_000 + i as u128, leaf_index: i, depositor: "u.testnet".parse().unwrap() }
}

#[test]
fn pages_are_capped_and_never_skip_a_row() {
    at("vault.skeleton.testnet");
    let mut v = Vault::default();
    for i in 0..1_005u64 {
        v.deposits.push(&deposit(i));
        let mut leaf = [0u8; 32];
        leaf[24..].copy_from_slice(&(i + 1).to_be_bytes());
        v.state_tree.leaf_at.insert(&i, &leaf);
    }
    v.state_tree.size = 1_005;
    let all = v.deposits(0, u64::MAX);
    assert_eq!(all.len(), 1_000, "capped at PAGE_MAX");
    assert_eq!((all[0].index, all[999].index, all[999].value.0), (0, 999, 1_000_999));
    let rest = v.deposits(1_000, 1_000);
    assert_eq!(rest.iter().map(|d| d.index).collect::<Vec<_>>(), vec![1_000, 1_001, 1_002, 1_003, 1_004]);
    assert_eq!(rest[4].precommitment, "1004");
    assert!(v.deposits(1_005, 10).is_empty());
    assert!(v.deposits(u64::MAX, u64::MAX).is_empty());
    assert!(v.deposits(3, 0).is_empty());
    assert_eq!(v.leaves(1_003, 5), vec!["1004".to_string(), "1005".to_string()]);
    assert_eq!(v.leaves(0, 2), vec!["1".to_string(), "2".to_string()]);
}

#[test]
fn a_known_root_reads_true_and_the_tree_root_is_the_side_node_at_depth() {
    at("vault.skeleton.testnet");
    let mut v = Vault::default();
    let mut r = [0u8; 32];
    r[31] = 9;
    v.state_tree.roots.insert(&r);
    v.state_tree.side_nodes.insert(&0, &r);
    assert!(v.is_known_state_root("9".into()));
    assert!(!v.is_known_label_root("9".into()), "the two root sets are apart");
    assert_eq!(v.state_tree().root, "9");
}

#[test]
fn the_state_record_is_a_fixed_size() {
    at("vault.skeleton.testnet");
    let mut v = Vault::default();
    let before = borsh::to_vec(&v).unwrap().len();
    v.deposits.push(&deposit(0));
    v.spends.push(&spend(0));
    v.nonce = u64::MAX;
    v.totals.deposited = U128(u128::MAX);
    assert_eq!(borsh::to_vec(&v).unwrap().len(), before);
}

fn spend(i: u64) -> Spend {
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&i.to_be_bytes());
    Spend {
        nullifier_hash: b,
        withdrawn: 5,
        new_leaf_index: i,
        refund_precommitment: b,
        refund_value: 0,
        refund_label: [0; 32],
        refund_leaf_index: 0,
        status: Status::InFlight,
        payer: "relay.testnet".parse().unwrap(),
        reserve: 7,
        recipient: "r.testnet".parse().unwrap(),
        fee: 1,
        context: b,
    }
}

// deposits and spends are append-only Vectors: a push writes the row and its count together, so a row can never be
// written without its count (or a count without its row), and each row sits at the key 2.3 counts: the collection's
// one-byte prefix, then the index as 8 little-endian bytes (near-sdk 5.29.1 collections/vector.rs l.98-99).
#[test]
fn deposits_and_spends_append_with_their_count_at_two_point_three_keys() {
    at("vault.skeleton.testnet");
    let mut v = Vault::default();
    v.deposits.push(&deposit(0));
    v.deposits.push(&deposit(1));
    v.spends.push(&spend(0));
    assert_eq!(v.deposits(0, 10).iter().map(|d| d.index).collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(v.spends(0, 10).len(), 1);
    assert_eq!(v.spends(0, 10)[0].status, Status::InFlight);
    let key = |prefix: Key, i: u64| {
        let mut k = borsh::to_vec(&prefix).unwrap();
        assert_eq!(k.len(), 1, "a one-byte prefix");
        k.extend_from_slice(&i.to_le_bytes());
        k
    };
    assert_eq!(env::storage_read(&key(Key::Deposits, 1)).unwrap(), borsh::to_vec(&deposit(1)).unwrap());
    assert_eq!(env::storage_read(&key(Key::Spends, 0)).unwrap(), borsh::to_vec(&spend(0)).unwrap());
    assert!(env::storage_read(&key(Key::Deposits, 2)).is_none());
}

#[test]
fn the_notice_credits_privacy_pools() {
    let notice = include_str!("../NOTICE");
    for want in ["Privacy Pools", "0XBOW LTD", "Apache License, Version 2.0", "v1.3.0"] {
        assert!(notice.contains(want), "NOTICE names {want}");
    }
}
