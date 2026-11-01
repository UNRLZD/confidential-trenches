// SPDX-License-Identifier: Apache-2.0
//! The vault's events against the kit's frozen shapes (vault.md 7.1; card vault-events-promises).
//!
//! The expected bytes come from the kit's own file, `packages/kit/src/vault/shapes.ts`, read here from the repo on
//! every run, never from a copy: its VAULT_EVENT_STANDARD, VAULT_EVENT_VERSION, VAULT_EVENT_DATA ("array") and
//! VAULT_EVENTS (each event's data fields, in order), with its rule that field elements and amounts are decimal
//! strings and indexes JSON numbers. Each event the vault emits must equal, byte for byte, the line built from them.
//! An event that drifts from the kit would break the app's sync without an error, so a drift fails here.

use blindfill_vault::events::{Event, TreeName, STANDARD, VERSION};
use blindfill_vault::{field, Bytes32};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn shapes_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/kit/src/vault/shapes.ts")
}

/// The kit's frozen event shapes, read from shapes.ts.
struct Kit {
    standard: String,
    version: String,
    data: String,
    /// (event, its data fields in order), in the kit's order
    events: Vec<(String, Vec<String>)>,
}

/// The string of `export const <name> = "<value>";`, the only line that declares it.
fn const_str(src: &str, name: &str) -> String {
    let head = format!("export const {name} = \"");
    let lines: Vec<&str> = src.lines().filter(|l| l.starts_with(&head)).collect();
    assert_eq!(lines.len(), 1, "shapes.ts declares {name} once as a string");
    let rest = &lines[0][head.len()..];
    let end = rest.find("\";").unwrap_or_else(|| panic!("{name}: no closing quote"));
    rest[..end].to_string()
}

fn read_kit() -> Kit {
    let src = std::fs::read_to_string(shapes_path()).expect("read packages/kit/src/vault/shapes.ts");
    let start = src.find("export const VAULT_EVENTS = {\n").expect("shapes.ts declares VAULT_EVENTS");
    let body = &src[start..];
    let end = body.find("\n} as const;").expect("VAULT_EVENTS ends with } as const;");
    let mut events = Vec::new();
    for line in body[..end].lines().skip(1) {
        // `  name: ["a", "b"],`
        let line = line.trim();
        let (name, list) = line.split_once(": [").unwrap_or_else(|| panic!("VAULT_EVENTS line: {line}"));
        let list = list.strip_suffix("],").unwrap_or_else(|| panic!("VAULT_EVENTS line: {line}"));
        let fields = list
            .split(", ")
            .map(|f| {
                f.strip_prefix('"')
                    .and_then(|f| f.strip_suffix('"'))
                    .unwrap_or_else(|| panic!("field: {f}"))
                    .to_string()
            })
            .collect();
        events.push((name.to_string(), fields));
    }
    Kit {
        standard: const_str(&src, "VAULT_EVENT_STANDARD"),
        version: const_str(&src, "VAULT_EVENT_VERSION"),
        data: const_str(&src, "VAULT_EVENT_DATA"),
        events,
    }
}

const P_MINUS_1: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495616";

/// A value for each data field name, as JSON. The kit's rule: field elements and amounts are decimal strings, indexes
/// JSON numbers, account ids strings. Every field the kit names must be here, so a new field fails until it is typed.
fn samples() -> BTreeMap<&'static str, String> {
    let s = |v: &str| format!("\"{v}\"");
    BTreeMap::from([
        ("tree", s("state")),
        ("index", "4294967295".to_string()),
        ("leaf", s("12345678901234567890123456789012345678901234567890")),
        ("root", s(P_MINUS_1)),
        ("depositor", s("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de")),
        ("commitment", s("7")),
        ("label", s("8086271268364488307551911707115823685859436809391798291511922449751894623475")),
        ("value", s("340282366920938463463374607431768211455")),
        ("precommitment", s("1")),
        ("payer", s("relayer.confidential.unrlzd.near")),
        ("amount", s("9040000000000000000000")),
        ("processor", s("vault.confidential.unrlzd.near")),
        ("spent_nullifier", s("2696045386038969515385069783440640732471742599039067451316404212202914210601")),
        ("new_commitment", s("0")),
        ("relayer", s("relayer.confidential.unrlzd.near")),
        ("recipient", s("bob.near")),
        ("fee", s("30000")),
        ("refund_precommitment", s("16662280991785675369497844937667382859880671281709203477245988256153950627371")),
        ("ragequitter", s("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de")),
        ("nullifier_hash", s("5072219746749309470750818130492706027783139455468960929403255949759297921774")),
        ("delivered", s("970000")),
        ("returned", s("0")),
    ])
}

/// The kit's line for one event: NEP-297 with `data` an array of one object, its fields in the kit's order.
fn kit_line(kit: &Kit, event: &str, fields: &[String], samples: &BTreeMap<&str, String>) -> String {
    assert_eq!(kit.data, "array");
    let obj: Vec<String> = fields
        .iter()
        .map(|f| {
            format!(
                "\"{f}\":{}",
                samples.get(f.as_str()).unwrap_or_else(|| panic!("no sample type for the kit's field {event}.{f}"))
            )
        })
        .collect();
    format!(
        "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"{}\",\"event\":\"{event}\",\"data\":[{{{}}}]}}",
        kit.standard,
        kit.version,
        obj.join(",")
    )
}

fn fe(json: &str) -> Bytes32 {
    let d = json.trim_matches('"');
    field::to_be(&field::from_decimal(d).unwrap_or_else(|| panic!("not a field element: {d}")))
}

fn amount(json: &str) -> u128 {
    json.trim_matches('"').parse().unwrap()
}

fn acct(json: &str) -> AccountId {
    json.trim_matches('"').parse().unwrap()
}

/// The vault's own name for each of its events. The match is exhaustive, so a variant added to the vault fails to
/// compile here until it is named, and then fails below unless the kit names it too.
fn vault_name(e: &Event) -> &'static str {
    match e {
        Event::LeafInserted { .. } => "leaf_inserted",
        Event::Deposited { .. } => "deposited",
        Event::StoragePrepaid { .. } => "storage_prepaid",
        Event::Withdrawn { .. } => "withdrawn",
        Event::WithdrawalRelayed { .. } => "withdrawal_relayed",
        Event::Ragequit { .. } => "ragequit",
        Event::Payout { .. } => "payout",
        Event::RefundInserted { .. } => "refund_inserted",
    }
}

/// Emits every vault event once, with the sample values, and returns (name, the logged line) for each.
fn emit_all(v: &BTreeMap<&str, String>) -> Vec<(&'static str, String)> {
    testing_env!(VMContextBuilder::new().current_account_id("vault.confidential.unrlzd.near".parse().unwrap()).build());
    let g = |k: &str| v[k].as_str();
    let (leaf, root, commitment, label, precommitment) =
        (fe(g("leaf")), fe(g("root")), fe(g("commitment")), fe(g("label")), fe(g("precommitment")));
    let (spent, new_c, refund_pre, nh) =
        (fe(g("spent_nullifier")), fe(g("new_commitment")), fe(g("refund_precommitment")), fe(g("nullifier_hash")));
    let (depositor, payer, processor, relayer, recipient, ragequitter) = (
        acct(g("depositor")),
        acct(g("payer")),
        acct(g("processor")),
        acct(g("relayer")),
        acct(g("recipient")),
        acct(g("ragequitter")),
    );
    assert_eq!(g("tree"), "\"state\"");
    let index: u64 = g("index").parse().unwrap();
    let all = [
        Event::LeafInserted { tree: TreeName::State, index, leaf: &leaf, root: &root },
        Event::Deposited {
            depositor: &depositor,
            commitment: &commitment,
            label: &label,
            value: amount(g("value")),
            precommitment: &precommitment,
        },
        Event::StoragePrepaid { precommitment: &precommitment, payer: &payer, amount: amount(g("amount")) },
        Event::Withdrawn {
            processor: &processor,
            value: amount(g("value")),
            spent_nullifier: &spent,
            new_commitment: &new_c,
        },
        Event::WithdrawalRelayed {
            relayer: &relayer,
            recipient: &recipient,
            amount: amount(g("amount")),
            fee: amount(g("fee")),
            refund_precommitment: &refund_pre,
        },
        Event::Ragequit {
            ragequitter: &ragequitter,
            commitment: &commitment,
            label: &label,
            value: amount(g("value")),
        },
        Event::Payout { nullifier_hash: &nh, delivered: amount(g("delivered")), returned: amount(g("returned")) },
        Event::RefundInserted {
            nullifier_hash: &nh,
            commitment: &commitment,
            label: &label,
            value: amount(g("value")),
        },
    ];
    for e in &all {
        e.emit();
    }
    let logs = get_logs();
    assert_eq!(logs.len(), all.len(), "one log line per event");
    all.iter().map(vault_name).zip(logs).collect()
}

#[test]
fn the_kit_file_is_read_and_holds_the_frozen_header() {
    let kit = read_kit();
    assert_eq!(kit.standard, STANDARD);
    assert_eq!(kit.version, VERSION);
    assert_eq!(kit.data, "array");
    assert_eq!(kit.events.len(), 8, "{:?}", kit.events);
}

#[test]
fn every_event_equals_the_kit_byte_for_byte() {
    let kit = read_kit();
    let v = samples();
    let emitted = emit_all(&v);
    // the same events, in the kit's order
    let kit_names: Vec<&str> = kit.events.iter().map(|(n, _)| n.as_str()).collect();
    let vault_names: Vec<&str> = emitted.iter().map(|(n, _)| *n).collect();
    assert_eq!(vault_names, kit_names, "the vault's events are the kit's");
    for ((name, line), (kit_name, fields)) in emitted.iter().zip(&kit.events) {
        assert_eq!(name, kit_name);
        assert_eq!(line, &kit_line(&kit, kit_name, fields, &v), "event {name}");
    }
}

#[test]
fn the_label_tree_is_named_label() {
    testing_env!(VMContextBuilder::new().build());
    let (leaf, root) = (fe("\"5\""), fe("\"6\""));
    Event::LeafInserted { tree: TreeName::Label, index: 0, leaf: &leaf, root: &root }.emit();
    assert_eq!(
        get_logs(),
        [format!(
            r#"EVENT_JSON:{{"standard":"{STANDARD}","version":"{VERSION}","event":"leaf_inserted","data":[{{"tree":"label","index":0,"leaf":"5","root":"6"}}]}}"#
        )]
    );
}

#[test]
fn every_line_is_nep297_json() {
    let emitted = emit_all(&samples());
    for (name, line) in emitted {
        let json = line.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).expect("valid JSON");
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 4, "{name}: standard, version, event, data");
        assert_eq!(v["event"], name);
        assert!(v["data"].as_array().is_some_and(|a| a.len() == 1), "{name}: data is an array of one object");
    }
}

/// The vault makes promises only in promise.rs, and only with the low-level env calls (vault.md 2.5): no `Promise`
/// type, no `#[ext_contract]`, no `env::promise_` call anywhere else in its source.
#[test]
fn promises_are_made_only_in_promise_rs() {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut seen = 0;
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        seen += 1;
        // code only: comments may name what is banned
        let text: String = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let file = path.file_name().unwrap().to_str().unwrap();
        for bad in ["ext_contract", "Promise::new", "PromiseOrValue", "near_sdk::Promise;", "Promise,", "Promise}"] {
            assert!(!text.contains(bad), "{file} uses {bad}");
        }
        if file != "promise.rs" {
            assert!(!text.contains("promise_"), "{file} makes or reads a promise outside promise.rs");
        }
    }
    assert!(seen >= 5, "read the vault's sources");
}
