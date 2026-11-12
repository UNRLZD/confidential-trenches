CARD pool-sol-mainnet-run / live: PASS
Money path: yes
Tx: solana 4kNHqZat17nVu9Rg6NZZhBTL6BUJ4VbDsrGb9k5fXQs7rkfsrADKFuYnE618xFXp5H8udgd2wq8aJysmpQs8scLF
Tx: solana 5Qn5LtHiu7xb7irPaPTSpcwPoreem1toPSYT3XvVBPDfH42CU3hMWmKP3AMXg3ag3qdoQb3Rnxrfo6dXVGXtvB8Q
Tx: solana 32CSJ1GSPrJScgPxyF41zuszLjosxgiDbeFWFRM5p7G6DzbxHjeFWihPjqhQqCLobXhkn3aqBD6WxmenAXLu7Kwn
Tx: solana Kdke7g2dHGa3q1FKHtFKnArybGBJRD4KU3A112iMMZatVk1jDdFgC9BBX9TkzmkbzJU34AkQUJtD744SWVHXsEP
Tx: solana 3sPawpfvAdoYLHa9i5MRKZVv6xEGLCmRXjJTKxEMHpNYqPMSX22QZ6eyLbdyJDNA7T6TTpWWaKamEA1LiAMaDoQr
Tx: solana 3aUiLLSmj1oHFot7bPLp1VewwqHZ1eNsJnTyZvLnDFKyubfqmwK6iCq7AsSXmt497Vjx8o6AxwEbRzxeEjQr52bd
Tx: solana 6izGizBmwFmVf5HxwGtpziWLnCxWNm8kP1xLVC7LspNwHJHAhQZeWdjMQ9peq7nFVYBiZsD9CuJa7Uj78jiTL8Z
Tx: solana 4HSwogMa6ru6c61XhXgb1zxisrFaiPWTuWmhRDsxAaW8PwsWDJNHK9ydPq7GjGW28KC2vKiyKarAqKmfxyZANZd3
Tx: solana 5o9u2hP8d2Ctp2qugXoZnoqGW6u5M8pvd6RDDdvizAqhUVC9k1syg5Hs8btNasdvtpKVdKoP79PrU9JTzNAhTYyF
Tx: solana o9wLjGp3LGqYSc4cuyZPERy6pDuiPETGxuEvCvj6RpSWD3R6j6BpJNgyNDsWkwa92R2Rx2qLAgRVyTGr4izee3g

Real money through the deployed pool on Solana mainnet (program EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF, pool
account 7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8), from the live app, by its owner's own taps, between 11 Nov 13:42Z
and 12 Nov 15:56Z. The ten lines above are everything the pool account has ever done, in time order, read on 12 Nov at
16:21Z from the pool account's own list on a public RPC. Each line below gives the change in the pool account's
lamports that the read shows.

| # | When (UTC) | Pool account | What it is |
|---|---|---|---|
| 1 | 11 Nov 13:42:12 | +50,000,000 | the deposit, 0.05 SOL |
| 2 | 12 Nov 05:36:56 | -50,000,000 | a buy on the venue from a one-time wallet the pool funds |
| 3 | 12 Nov 05:38:32 | +39,425,404 | the sale: that wallet sells and pays back into the pool |
| 4 | 12 Nov 05:38:47 | +5,487,104 | what the sale left on that wallet comes back into the pool |
| 5 | 12 Nov 05:39:36 | -20,000,000 | a buy from a second one-time wallet |
| 6 | 12 Nov 05:40:00 | +9,966,767 | the second wallet's sale pays back into the pool |
| 7 | 12 Nov 05:40:11 | +5,547,107 | what that sale left comes back into the pool |
| 8 | 12 Nov 12:19:52 | -10,000,000 | a buy of $0.01 of a PumpSwap coin from a third one-time wallet |
| 9 | 12 Nov 12:28:32 | +3,502,518 | the sale of that coin pays back into the pool |
| 10 | 12 Nov 15:56:01 | -3,305,000 | the withdraw: 2,005,000 lamports arrive at the address typed |

Line 10 in full, from the same read: of the 3,305,000 lamports the pool paid out, 2,005,000 reached the address typed,
1,082,040 stayed as rent in the two record accounts the withdraw made (716,280 and 365,760), the sending wallet kept
207,960 and the network took 10,000. This withdraw cost 1,300,000 lamports, and the form showed the most it could
cost before the tap.

What this run does not show: a buy that spends more than one piece of the balance, and a trade on NEAR, Base or
Robinhood with real money. After line 9 the third one-time wallet still held 3,521,615 lamports: what that sale left
had not come back into the pool when this was written, as lines 4 and 7 did for the first two.

No script checks this card after a deploy. Its proof is the ten lines above, which CI reads back as succeeded on two
public RPCs of two operators whenever this file changes.
