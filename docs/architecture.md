# Architecture

Blindfill is the engine: a vault on NEAR that nobody holds a key to, wallets whose keys exist only on your device, orders signed ahead of time, and an open kit that any app can call. Confidential Trenches is the flagship and experimental version of the UNRLZD terminal, built on that engine. Our terminal reaches Blindfill through the kit's one public entry and nowhere else, and CI fails the build the moment a file reaches past it.

Technical words are explained where they first show up. Where a part is built to do something, that's the design; the one piece you can run against live NEAR today is the read-only check at the end of [Security](security.md).

## The system on one page

<picture><source media="(prefers-color-scheme: dark)" srcset="../assets/architecture-dark.svg"><img alt="Apps call the kit's one public entry. Your device holds the 12 words, keys, notes, the prover and the signed orders. Helpers carry messages and hold no money keys. The vault on NEAR has no key and pays only what a proof names. NEAR Intents moves money between the vault, fresh wallets and any address." src="../assets/architecture-light.svg" width="100%"></picture>

Solid green lines are money. Dashed blue lines are signed messages: requests that a key has already approved, which anyone can carry and nobody can change. Read it top to bottom.

## The parts

### Your device

Everything that can move your money starts here. Your 12 words (a standard backup phrase) rebuild every key and every note on the device, so there's nothing else to back up.

A note is a sealed record that says "this much is mine". Only your 12 words can rebuild its secret, and the vault stores just its fingerprint. A proof is a short piece of math that says "I own one of the notes on the vault's public list and haven't spent it", without saying which one. Your device makes proofs in a background thread of the browser, checks every quote before it signs, and signs every trade. We hold none of that on any server of ours.

### The signing page

`sign.confidential.unrealized.trade` sits on its own address. Keys are made there and stay there. Because the browser treats the two addresses as separate places, the terminal can't read the page's storage. Our terminal embeds the page out of sight and sends it requests such as "buy this" or "withdraw there". Anything that needs your full attention opens as a page of its own on this address: the passkey prompt, the screen that shows your 12 words, key export, the address for an outside withdrawal.

This is the one page that handles your keys, and the one we'd most like you to test. A release is built to come out byte for byte the same when built twice, with every file hashed and an outside check that compares what's served with the release. The exit tool below needs none of it.

### The terminal

`confidential.unrealized.trade` shows the screens, the prices and the charts. It holds no key, no 12 words and no note secret. When you tap Buy, it hands a request to the signing page and waits.

### The kit

`@blindfill/kit` is the public entry. It offers deposit, prove, ready the wallets, trade, set orders, withdraw and verify. A wallet, a bot or an AI agent calls the same entry the terminal does, with no shortcuts. The device's checks live inside it: before anything is signed, a quote is compared with your own request and with pool reads from two RPC providers, which are public servers that answer questions about a chain. A server's word on a quote is never enough, so we don't sign on it. The reach check runs in CI today with 36 deep-import tests, so an app that goes around the entry fails the build.

### The helper

`api.confidential.unrealized.trade` does five small jobs, and we've kept every key to anyone's money out of all five.

- The prices and quotes proxy keeps our vendor API keys, forwards requests and caches public data.
- The withdrawal relayer pays the NEAR fee and storage for a withdrawal. The proof fixes the recipient, the fee recipient and the fee, so the relayer can't redirect the money or take more.
- The deposit relayer prepays the vault's storage and submits your signed deposit. That deposit is a delegate action: a message your one-time account signs and someone else submits and pays for.
- The order sender stores your signed exits byte for byte and sends one when its price is hit.
- The USDC watch follows USDC's pause and blocklist events and its code hash, and holds moves while either is in doubt.

The helper's accounts hold gas and storage money and nothing else. Still, break into every one and the vault stays shut. What a broken-in helper can do is delay or refuse a quote, a withdrawal or an order. That costs you time, and it's why the exit tool exists.

### The vault

A NEAR contract under `confidential.unrlzd.near`. It has no access key, no owner, no upgrade path, no pause and no setter. It holds everyone's USDC in one pool, a public list of note fingerprints, a list of spent marks, and a `totals()` method that reports what it owes.

Its code is a port of Privacy Pools v1, whose code is audited and open source. We removed two admin parts: the Entrypoint contract with its roles, and the outside list keeper who approves deposits. The vault approves every deposit itself. We wouldn't put money in a vault that only promises not to change, so ours has no way to. Our port gets its own review, since the audit belongs to Privacy Pools and doesn't cover what we changed. The vault pays only the accounts a proof names, and if a payment bounces it writes the money back as a new note that only your device can open.

### NEAR Intents

`intents.near` and its quoting service 1Click move every dollar: in from any chain NEAR Intents reaches, out to fresh wallets, back to the vault after a sell, and out to any address.

We keep the vault's resting balance outside `intents.near`, on purpose. The DAO behind `intents.near` holds roles that can lock an account, force-move a balance or force a withdrawal, and it can replace the contract's code. So the vault keeps its USDC as its own balance on the USDC token contract, and money sits inside `intents.near` for one hop at a time while it travels.

### Fresh wallets

Brand-new wallets on any chain NEAR Intents reaches. Each is used once: one arming funds one wallet, which makes one trade. All keys come from your 12 words on standard-shape paths and never leave the device, and any wallet that imports a private key opens them.

NEAR Intents' shared payers fund a fresh wallet, so the money doesn't arrive from the vault, from you, or from a wallet that's been used before. One thing is visible from outside. A buy from a set of wallets shows up as several fresh wallets buying the same token in the same second. Watchers can group them as one position and read its size. They can't tell whose it is.

### Orders signed in advance

Right after a buy fills, your device signs the exits for that wallet, a stop and a take-profit. Each sells from the wallet and pays back to the same wallet, with its minimum out fixed in the signature: the amount sold, times the trigger price, less your own slippage. So an exit fills at your price or better, or it doesn't fill.

Our order sender holds the signed bytes and sends one when its price is hit. The stop and the take-profit share one nonce, a number a chain lets a wallet use once, so whichever lands makes the other invalid.

- On Solana the nonce is a durable nonce account. It stands in for the recent block hash, which means the signed exit doesn't go stale after about a minute.
- On EVM chains such as Base and Robinhood, it's the wallet's next nonce.
- On NEAR the exit is a delegate action with an expiry block height of its own, so it isn't cut off at the usual 14 hours.

Someone inside the helper can send an exit early, and it still fills at your price or better, into your own wallet, because price and destination sit inside the signature. Until it fills, an exit exists on no chain.

### The exit tool

`packages/exit` brings money home with your 12 words and public RPCs, with no server of ours. It asks two public NEAR RPCs and requires that they agree byte for byte. It rebuilds your notes from public data, makes the proof and submits the withdrawal, with no helper in the path. The demo is meant to show it: every server we run switched off, and the 12 words still withdraw.

## The life of one private buy

<picture><source media="(prefers-color-scheme: dark)" srcset="img/private-buy-dark.svg"><img alt="The life of one private buy as a timeline: deposit about 40 seconds, get ready in the background, a fresh wallet in up to 39 seconds ahead of time, the tap with a phone buy on Solana at p50 1.2 seconds and p95 3.3 seconds, the exits signed right after, and back to the vault." src="img/private-buy-light.svg" width="100%"></picture>

1. Deposit. Send USDC from any wallet on any chain NEAR Intents reaches. 1Click delivers it to a one-time NEAR account whose key your device holds. That account signs one deposit call, the deposit relayer prepays the vault's storage and submits it, and the vault adds your note's fingerprint to its list. NEAR Intents' part of this takes about 40 s. The commitment proof that goes with the note takes 0.6 s on an iPhone.
2. Get ready. In the background your device picks notes, proves them, and has the withdrawal relayer carry each proof. The vault pays a one-use account in standard sizes. One withdraw proof takes 8.3 s on an iPhone. We make it while you browse, never at the tap.
3. A fresh wallet. NEAR Intents carries that account's money to a new wallet on the chain you trade on. This move takes up to 39 s, so we do it ahead of time and you don't wait on it.
4. The tap. Your device asks the proxy for a quote, checks it against your request and two RPC providers, signs the trade and sends it on several paths at once. A phone buy on Solana took 1.2 s at p50 and 3.3 s at p95 from tap to filled, over five live buys.
5. The exits. The stop and the take-profit are signed as soon as the buy fills, and they wait with the order sender.
6. Back. After a sell, the money returns over NEAR Intents and lands in the vault as a new note. Withdraw to any address on any chain whenever you like.

The proof is why step 2 happens early. It takes 8.3 s on an iPhone, and a trade can't wait that long, so the wait moved out of the tap.

Checking one proof on NEAR costs 33.6 Tgas, about 0.003 NEAR. A whole withdrawal, with its update to the vault's note list, costs at most 92.6 Tgas, under 0.01 NEAR.
