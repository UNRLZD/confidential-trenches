// Pillow Auditors, finding V-01, on near-sandbox and the real USDC wasm.
// A stranger who sees a storage_prepay(P) deposits first on P. The victim's deposit is refused.
#![cfg(feature = "sandbox")]

mod harness;

use harness::{Harness, R, TokenKind, YOCTO_PER_BYTE};
use near_sdk::serde_json::json;
use near_workspaces::types::{Gas, NearToken};

const P: &str = "12345678901234567890123456789012345678901234567890";
const ONE_USDC: u128 = 1_000_000;
const TEN_USDC: u128 = 10_000_000;

#[tokio::test]
async fn a_visible_prepay_lets_a_stranger_take_the_precommitment_first() -> R<()> {
    let h = Harness::with_vault_and(TokenKind::Usdc).await?;
    let relayer = h.account("relayer", 10).await?;
    let victim = h.account("victim", 10).await?;
    let stranger = h.account("stranger", 10).await?;
    h.mint(victim.id(), TEN_USDC).await?;
    h.mint(stranger.id(), ONE_USDC).await?;

    let paid = NearToken::from_yoctonear(904 * YOCTO_PER_BYTE);
    let o = h.call_outcome(&relayer, &h.vault, "storage_prepay", json!({"precommitment": P}), paid, Gas::from_tgas(30)).await?;
    o.expect_all_ok("relayer prepay")?;

    let send = |depositor: String, amount: u128| {
        json!({"receiver_id": h.vault, "amount": amount.to_string(),
               "msg": json!({"precommitment": P, "depositor": depositor}).to_string()})
    };
    let one = NearToken::from_yoctonear(1);
    let gas = Gas::from_tgas(180);

    let o = h.call_outcome(&stranger, &h.token, "ft_transfer_call", send(stranger.id().to_string(), ONE_USDC), one, gas).await?;
    println!("stranger deposit failures: {:?}", o.failures().iter().map(|r| r.line()).collect::<Vec<_>>());
    assert_eq!(h.token_balance(stranger.id()).await?, 0, "the stranger's USDC went in");
    assert_eq!(h.token_balance(&h.vault).await?, ONE_USDC);

    let o = h.call_outcome(&victim, &h.token, "ft_transfer_call", send(victim.id().to_string(), TEN_USDC), one, gas).await?;
    let lines: Vec<_> = o.failures().iter().map(|r| r.line()).collect();
    println!("victim deposit failures: {lines:?}");
    assert!(lines.iter().any(|l| l.contains("PrecommitmentAlreadyUsed")), "refused on the used precommitment");
    assert_eq!(h.token_balance(victim.id()).await?, TEN_USDC, "the victim's USDC came back whole");
    assert_eq!(h.token_balance(&h.vault).await?, ONE_USDC, "the vault holds only the stranger's USDC");
    Ok(())
}
