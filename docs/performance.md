# Performance

This page lists every run we have recorded, with each sample and a link to each of its transactions.
`scripts/perf-table.mjs` rebuilds it and the README table from `perf/runs/*.json`, so a number here changes only
when a new run record lands. Do not edit it by hand.

p50 and p95 are nearest rank: sort the samples, take the one at rank ceil(p/100 x n). A failed sample counts as
infinitely slow, so it is in n and never improves a percentile.

## solana-phone-2026-10-26

Solana, mainnet, 2026-10-26, signed by: phone browser. Record: `proofs/g1-phone-trade/results/live-2026-10-26T11-29-51-268Z.json`.

Signed in a phone browser with the device's checks. Fee is meta.fee plus the send tips, read on two RPCs.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Buy | tap to filled | 5 | 5 | 1,200 ms / 3,225 ms | 3,225 ms | 0.0000300 SOL median (n=5) |
| Sell | tap to filled | 5 | 5 | 1,354 ms / 1,490 ms | 1,490 ms | 0.0000307 SOL median (n=5) |

Buy, every sample:

1. 3,225 ms: [2btTg7crbv…](https://solscan.io/tx/2btTg7crbv6EL6DJtpNo67Vv9J2vioFHz4uMTuHR2hrWnJMumu7PQb9gYQwToV3ac55LGw418hL28JvChi8oc4Rv)
2. 963 ms: [3hnP9BcaVb…](https://solscan.io/tx/3hnP9BcaVbemuUDkDw3TvrEEc9mHEsvTq6iQLKQvG46RxiySt6S1XxcKX4r5DdFhKC5Hbh4K1AK6mPQ3x1rk4xzV)
3. 1,275 ms: [3iGWDcecxY…](https://solscan.io/tx/3iGWDcecxY14rC6jmpbK5vxoiBVekLtNCx4sxMjCWr3FRdeEkbp3PYLkhXv9RUPv8SdsgEhoS28PAi14iDR4Qrg8)
4. 1,200 ms: [HnV2vwsVER…](https://solscan.io/tx/HnV2vwsVERfQGEWwGiRPzR5AEs2WiZnumj5V5MXJHsWGY7Bg5FGknDotnt9KcczhjDMXAZRhzkXUcoN2rPtW8bf)
5. 1,025 ms: [3AAEyMeKPi…](https://solscan.io/tx/3AAEyMeKPiXngz7D1tRgtvZn5gMTaWqRyJaKgs5MAhCdHb6Cbet7Gn453pFWacJF5c9sZYAE3R4R7PLdrkVTF7WL)

Sell, every sample:

1. 1,490 ms: [4hN9gQ1PQP…](https://solscan.io/tx/4hN9gQ1PQPSDUJrHAXLHDaYd6mK2C6V3a3KtSoMoUb3nC2X1MEiKswTo6XzGfuoQ7Fb1Le7x3JU648dMwcdrLDA8)
2. 1,376 ms: [2NuYJ48bPE…](https://solscan.io/tx/2NuYJ48bPEmDnuKChHdN71NCyJZbBPwaD8sdUnnLc6VcEHtmxjCHiDQKoVdiyehCSy8AV49PLdAFkXxSaVK7iNw)
3. 1,354 ms: [4bjHZTSuTT…](https://solscan.io/tx/4bjHZTSuTTzqCoUzdRm9Y6rbDaQKHFARJxQCd3HkLpLEVZ2ZbG9bJFtDYJdV5jDxJ4ZWDziBGKVeuNhZ16hP84bi)
4. 1,158 ms: [4mA466e9fs…](https://solscan.io/tx/4mA466e9fsXE2bJRWbDkJmY8Hyj84EgeXzehemyqNdEEVsXMLjmv8YXm1ZGTejjkgxLtfCbhcJ7aVurz1465o14G)
5. 936 ms: [554UVzq82c…](https://solscan.io/tx/554UVzq82cixvoqoHsH5gWBQnuVAxq2sCxeHZdDXErnASWy17GHZksJCaTBqUgZVmTXDoSbFeSyUpcvzYkth15pq)

## solana-intents-2026-10-19

Solana, mainnet, 2026-10-19, signed by: test script. Record: `proofs/p1-private-balance/runs/2026-10-19T22-53-44-913Z-live.json`.

One leg of the P1 live run through NEAR Intents (1Click): request to the balance visible. Fee is 1Click's quoted fee in USD.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Money in to NEAR Intents | request to visible | 1 | 1 | 41,835 ms | 41,835 ms | 0.0000 USD median (n=1) |
| Money out to a fresh wallet (NEAR Intents) | request to visible | 2 | 2 | 21,052 ms / 22,606 ms | 22,606 ms | 0.0100 USD median (n=2) |

Money in to NEAR Intents, every sample:

1. 41,835 ms: [3ZDDh9uCso…](https://solscan.io/tx/3ZDDh9uCsob3Ti5VSgscTShnyGdZBh7XVoahGB4x97b4CS8LxAFHBbtbfJw4MnXTGnQwZpBSwkBS812xfcitaL8E), [FJjdHWBub7…](https://nearblocks.io/txns/FJjdHWBub7EbR325NrM1a2BpUptU5LWfbFDZDNwUEeps), [GTYXNPCXFh…](https://nearblocks.io/txns/GTYXNPCXFhbLbx7JhyJqgUbTRhJf2YTsPPLubVTDGoVx)

Money out to a fresh wallet (NEAR Intents), every sample:

1. 21,052 ms: [A4YU9mQELT…](https://nearblocks.io/txns/A4YU9mQELTdHdA2SJjKzmjZqXvtgDCLwqoaGv4MFUBWS), [RcBwpfSQy6…](https://nearblocks.io/txns/RcBwpfSQy6XLirvuUteqUFxo6cK2zufdgLjk8dhReW1), [2c48hnCtQ5…](https://solscan.io/tx/2c48hnCtQ5QVGk5ACYExm4y91pbExezUU3Nx3uTzQ287uHMS9jtdHNgidMu2EW9BAufhw5ius1meyJ9TeyCfWmMA)
2. 22,606 ms: [7LLTRZJsjW…](https://nearblocks.io/txns/7LLTRZJsjWLzfZ41N3vc4b7Mb3KnXutTdXenrMUdWsdE), [9Pt7HK5JQN…](https://nearblocks.io/txns/9Pt7HK5JQN1nRxu3SoDDedtA45xUJYkLrKv4SwozptZS), [4hubwZPvft…](https://solscan.io/tx/4hubwZPvftt6BKzGXNC4WuQCPo8nSHgxCRnAKceJYM4UEhxryt97iDENd61zxzQ5nweuLhjsySRgZdjAjCSDBhte)

## solana-script-2026-10-19

Solana, mainnet, 2026-10-19, signed by: test script. Record: `proofs/p4-speed/solana/results`.

Keys held by the test script, self mode, records live-2026-10-19T23-32-14-314Z.json, live-2026-10-19T23-33-50-203Z.json, live-2026-10-20T00-02-08-517Z.json. Fee is meta.fee plus the send tips, read on two RPCs.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Buy | tap to filled | 21 | 20 | 911 ms / 1,148 ms | failed | 0.0000331 SOL median (n=21) |
| Sell | tap to filled | 20 | 20 | 773 ms / 937 ms | 959 ms | 0.0000351 SOL median (n=20) |

Buy, every sample:

1. 947 ms: [51XuU6yEWn…](https://solscan.io/tx/51XuU6yEWnFjmsfmNUNW4XGYziTQWksHJa6sqkTe4YqQEV45AdQdLYsThyNALhAiMSwkuLJ9QRURKcXJB8rdm6ND)
2. 798 ms: [2TxXJ4AbZ2…](https://solscan.io/tx/2TxXJ4AbZ2Zs52QyYnxWq7XvC822smbRwhCHbGVV5R6fKcdXJXoAd3pFxVU24QMKvKZvxNUQGNXnx48kAVidtwme)
3. 981 ms: [38TfdSZnJL…](https://solscan.io/tx/38TfdSZnJLZRVQBNet9hUudFZTPrET4qSXwBzqyRQ9ij8okhcSq8b3Uz4VN97SvHSVbj2rSzyQ9QsBjW12wWSPdQ)
4. 632 ms: [2sWEEHZJv2…](https://solscan.io/tx/2sWEEHZJv2jzbamCUGYW1gW2hRxo4rXc6NiAjHUysM7ACVYVGGQBQxEXP69UE4yfvR1Q9hWktKx2PFJP5tvMwurB)
5. failed: [5jiZJU23yu…](https://solscan.io/tx/5jiZJU23yu67WeS5Ho36hSJAYXAiuM2JLrihC7YdoMLQXxZbnMZjHSJovxKzFJ2HPhEzHXUV6hoEhyeqXRzxx2Ay)
6. 728 ms: [4hCbP16JCx…](https://solscan.io/tx/4hCbP16JCxNUzfVM5nFuV8UXW6cLCZbLZRR5AASZzwU21uAEPhFjLyfxNwimXm9P6o8gtUwYH5dikBvFXCGbZQCM)
7. 876 ms: [3Nq1SDuQYJ…](https://solscan.io/tx/3Nq1SDuQYJ3pd9JNHnMQicQQZpwBAbWPPESFen6rrwfCDTEtMbeAm8jaDKAyBLWBPbarL5ztJsrvFJuyxGZZoMbT)
8. 926 ms: [4Bys7Ffwac…](https://solscan.io/tx/4Bys7FfwaceSCHzzU8FkBbqokTchCZCLYZU1FwfweAuiLoDkix6T25Sbs766oxh5wZT7BJavTkUwHVnNSacsfVeD)
9. 1,051 ms: [3Bwv6MSnJX…](https://solscan.io/tx/3Bwv6MSnJX5Pr6zgAtiS7v1ctbKGrf2APZe1Ex3qjGLkBRVJ9BuqQBVPNgKu95H7tUakaSdkqM6JQp9zfprmmkuy)
10. 778 ms: [5J91FxKAk6…](https://solscan.io/tx/5J91FxKAk6cWTf5Ntofxy1aRDHa2SXD4ASbu7RkH3X5PK2soX54KuJDmV5ns1nkRA192thNinsnpG5h3TfBRpocD)
11. 1,148 ms: [3UafLrrVjq…](https://solscan.io/tx/3UafLrrVjq1GPoD9PYQD3Aj2WbkB89j5tXNgbRko7yP9ML5j83vyoZPX98jm5N8yHd2vgc8XaFYKXuMjpNobvheY)
12. 955 ms: [hzXdCFxmc2…](https://solscan.io/tx/hzXdCFxmc2UL7s6nor2yPg39fLQis7pUiUVnjvNm5FxNRMBqSYMSTDa9ZcCg1B1URFfUm2p3nmGjBwaXMSxHjRa)
13. 736 ms: [2nWwoZ8L6d…](https://solscan.io/tx/2nWwoZ8L6dpbmXANAkae929xahAMrCRyw7MX6sRFtwQh8SrzpGG4TAXXLwfskwNd6aAtcAUEnHCFPAjkwWApS49R)
14. 911 ms: [2MdPaQ6F8n…](https://solscan.io/tx/2MdPaQ6F8nBk12zKRdW3N6CqBGMHd1yX5BUS1PgitCVxLZTJFdTCu8URq3HmoYy6R5WaYJ1Qe3epHheksi6FeD6s)
15. 854 ms: [5meavLiB7u…](https://solscan.io/tx/5meavLiB7umL5mbXeBASUBCfjeKRJqazHraodNzN5Dp5VorK8ckua9un3homegCzXNK3xw93kHaguJN7vg9ELAHZ)
16. 844 ms: [26F5V6eW6E…](https://solscan.io/tx/26F5V6eW6Ev1oB4MeRmL4uQ1WXDKoBZmwb44j6V8EqfzY5ckuw4cp7iFBHr4KdA2ynfV5mqmo1p7eZcXU3ZsBjBp)
17. 1,011 ms: [2uqDWmfjSX…](https://solscan.io/tx/2uqDWmfjSXGcmBD93yzz82nbwFTTc6yzt14QmUJqFsdbbF4pWVDLqkG3amJXh9Y1nvyym9NJpU1j5UAMHcegbFGH)
18. 967 ms: [4wDaVEJaW9…](https://solscan.io/tx/4wDaVEJaW9DsaGALos4WCH95fa8V5GKJU8hbi8fNiRgbbBdQpekSR9sj7NJvAJRxX3bMnSoqdUYqvBtdQcZh86GF)
19. 693 ms: [2F7A8fRrtW…](https://solscan.io/tx/2F7A8fRrtWKEhWvEgwMbJhbetGMBdYHQhvAhLSLcsgxSRS2s1qFR452H14p985MRFDd2QzxS6iX1bnv6Zjn5K1L7)
20. 906 ms: [46r9NaNB3S…](https://solscan.io/tx/46r9NaNB3SpnKWjja5Z4jGpRxMgj1fXTVhM2qLRypGpXb6sNAHj4zjmS6YjgR7Pi5WvGxatzbaGcXW8ToEvEupYV)
21. 1,069 ms: [q5LGCdA9r2…](https://solscan.io/tx/q5LGCdA9r2W4A6bnp2Ypz6ZzZaWXzoXLji5zESAUXN33xgF3HBp5RAu5f8bDvjSteVrwi1e3NKDe4ASaCyx3Ksm)

Sell, every sample:

1. 728 ms: [jvgD25xyGn…](https://solscan.io/tx/jvgD25xyGnvFQQzYjQHE6pbumvrBk87f6nNG1hooyNF17M3Q6w5GPDFLDtVcVfgNHeQJ8U27kyD8wi1dZ1Zg2u4)
2. 581 ms: [5tCnuK8Rdh…](https://solscan.io/tx/5tCnuK8RdhhXfysPR5cmDXojfeKWF7iAVMyck8mLMf7gZEGghGBi9boB3FrD1cCT7pJ4VoWgMPspVTz5ALDYcVL)
3. 959 ms: [28khwLTxcj…](https://solscan.io/tx/28khwLTxcjYF4daFaK2vK8x8Bz3mPZvppcKsQwT3B9heRBbAbXBMa8Synyfgw7HL9uuVXHcrMh48ktDTowMjenQV)
4. 818 ms: [3ZKx9ta6tg…](https://solscan.io/tx/3ZKx9ta6tgbnLSjPStkK95JCWpY9CjHqi8JEq4qAqUZVJC5vRti7xhTu2iQXxveMWr2NLTeiiVfn1mw6iLtpoWfW)
5. 587 ms: [5EwukhgDb8…](https://solscan.io/tx/5EwukhgDb8yrkzjcTGsaisN7XNn2tWbqfQdqfRuhzEurUJKEZgGxSP31YJ9jwbmeruiQMdsbBJULnkdqYb9d1oUo)
6. 937 ms: [5ZhWLeiHY5…](https://solscan.io/tx/5ZhWLeiHY5DWNYKvLAxomtNya3d3Pv6FakWm1i1aef7Z1EC5rzB1yz1uG5t1BH8eKtawbM43z5Q3R6osuoHBDs5X)
7. 773 ms: [2xASKDYxSL…](https://solscan.io/tx/2xASKDYxSLwELJ1LBeFCdeaSQFt1xpPbFkVdnE7nThTomuwimw2JbmaU9MKhbyZNWbXM7K8hACarjSGzvxcwyXRf)
8. 774 ms: [414g8m1ur7…](https://solscan.io/tx/414g8m1ur7xZf49cQPukuQkCmJLJ3WkN3EwZMVoNJzV9UKW4X2wUV3dQWosHQN3Y8xdy71kYzMdfHUJRkQ4bjYJ5)
9. 663 ms: [3fRMJVmwRk…](https://solscan.io/tx/3fRMJVmwRkfrw9Zku3v6RdCeu3vRPuyiZ6rhukSQfHyadKACcgg6bnr33s8gmNQ7w2TcGaBTJ3MsGEvy6BLijccu)
10. 560 ms: [2DCpmDXcqT…](https://solscan.io/tx/2DCpmDXcqTPhCuXL4qTsVFDSzon9eR2nkF3CX9ADmCWCf72hbSnAjW3MdEeiwtPB6bZt5dMzjVNxqpnvXxsMi6HD)
11. 735 ms: [A1GaWsx6zw…](https://solscan.io/tx/A1GaWsx6zwBcrT44zUM6hDoXFsUXvaKxm6NqnYQcv8bHUNvLS8sFRCaJenJQ1C4CJoGKsjGcX9aX67zdzxXDaED)
12. 827 ms: [39TnCyQAYa…](https://solscan.io/tx/39TnCyQAYajinWiXvXj2HG2qggYA2SpPUtfhuRkYchveHXRujELZq5C4Bp5snX6SQKELpFUEVwwNYUrH9zmrTZL)
13. 624 ms: [4UMcyxdJjj…](https://solscan.io/tx/4UMcyxdJjjqd2T8M1eLQm7qBLuXPJkZYeeAuqNMdNsJTS8QhCiYQv8WveoL439ZtpPpaQt2MVRrZ3zWn5JWajxB6)
14. 911 ms: [ctUZvqZUJ8…](https://solscan.io/tx/ctUZvqZUJ8X6TKFiMnvNf46ejPJJbSPZ9LyuNG1bkmMWmvuyA7aP9VhSKgRqKyoAMgeJYXeawUE7zAE1qbr3uEn)
15. 684 ms: [Wka5oc5vXi…](https://solscan.io/tx/Wka5oc5vXiEmuKHaDCJaYKPzhJK4nq1SiRPRnM5XfsYsJURTAV81qhPMaimYTCbvXBppwxkCpVDFECXrrRyUhbv)
16. 889 ms: [2qWoWi8gh1…](https://solscan.io/tx/2qWoWi8gh1Ufr9D5vcKAFYr1XRLYsgCbxUGUDEjuBxA15CWe6LY2xYxo5iaMjpSUFUk6dbdkHVaJUV4qHC5H8Mq5)
17. 736 ms: [4xGumVovrS…](https://solscan.io/tx/4xGumVovrSScubfC9brpvP7uN32Sr7QpYKU2pNYQcTbiTKtzX5fDRzfdJszjRXUsJ9AnncvcecfENHmdummcd5Ab)
18. 861 ms: [kNRiwKxVb6…](https://solscan.io/tx/kNRiwKxVb6mBJ53bt176dBT6wQ6rJBsLB4pnaWVVqVgjwkwA1LuTwrDRrNz9vVCzrYThcuhSJsAKnwyproZY74f)
19. 823 ms: [4ynW3A2ECJ…](https://solscan.io/tx/4ynW3A2ECJ7n8g3ThkrPGU8Tk8ic8aRcGpiMvX9FsHfwauUq3GgjB8yHbtuDs4wHeep7VPRRVVm4mk4uGQQYX7zB)
20. 914 ms: [4i5eBCS5ti…](https://solscan.io/tx/4i5eBCS5tiJDvMvc4upph3UJncJ92oSMENXMoWeDU33RTMeJoskH18J38x3UVPEaWGieN6zcJVYZ5dKw3xBmwJy)

## solana-intents-out-2026-10-26

Solana, mainnet, 2026-10-26, signed by: test script. Record: `proofs/g1-money-loop/runs`.

NEAR to SOL on a fresh Solana wallet through NEAR Intents (1Click), request to arrival read on two RPCs. Fee is 1Click's quoted fee in USD.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Money out to a fresh wallet (NEAR Intents) | request to visible | 2 | 2 | 38,863 ms / 38,911 ms | 38,911 ms | 0.0453 USD median (n=2) |

Money out to a fresh wallet (NEAR Intents), every sample:

1. 38,863 ms: [5Bw6uJ61SR…](https://nearblocks.io/txns/5Bw6uJ61SRBpo1guNiVqvQTR5yyD1Ewf9c6Z1gYRkne9), [HWxwgnibsk…](https://nearblocks.io/txns/HWxwgnibsk3ToyQyKvkaexXomvMwq7hTyNveUkdnpADZ), [yVESkJ7fkg…](https://nearblocks.io/txns/yVESkJ7fkg1vgfUyeDpTyBbZmkZphC68VoguoJ3QB47), [4qpENZRqjZ…](https://solscan.io/tx/4qpENZRqjZyW37QF8zrhD38v2CFFnLPGn4h8DxNna4gMzaxEZA6B92ifjgGnCtkeLT6u8AdYzdRb9g5Eta9M8hZH)
2. 38,911 ms: [Aurjx7AvMR…](https://nearblocks.io/txns/Aurjx7AvMRw5kC85yEynSNf6QF5a7nLVmRtpUob6t3WG), [9zQ8ZqKfeD…](https://nearblocks.io/txns/9zQ8ZqKfeDzzEaG4Zd7gmh8UChwVznwNwgcCSRGpz1YC), [6VLo3Y8KJe…](https://nearblocks.io/txns/6VLo3Y8KJeH2SL83MkScNdivVjC6y2rBprSqKD9eKRR7), [5XCMCotZRP…](https://solscan.io/tx/5XCMCotZRPu6D4CwfGsjHtDJ3N2Cye8Nh9RTiB22wNRtL4jB12rDgU7eZ6TU4vmzLNJ75L85h7wHej6vqxD6FQ5e)

## base-intents-2026-10-19

Base, mainnet, 2026-10-19, signed by: test script. Record: `proofs/p1-private-balance/runs/2026-10-19T22-53-44-913Z-live.json`.

One leg of the P1 live run through NEAR Intents (1Click): request to the balance visible. Fee is 1Click's quoted fee in USD.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Money out to a fresh wallet (NEAR Intents) | request to visible | 1 | 1 | 21,157 ms | 21,157 ms | 0.0335 USD median (n=1) |

Money out to a fresh wallet (NEAR Intents), every sample:

1. 21,157 ms: [HJdGaYSqpu…](https://nearblocks.io/txns/HJdGaYSqpunEVNYj4bjjntbSCt1fUEwVQoH5mwXoM9T4), [EtAWUauyXd…](https://nearblocks.io/txns/EtAWUauyXdUxBpzTjSSR2T6w2tqM7gB7M4SDe2M8dMmH), [0x37a15d42…](https://basescan.org/tx/0x37a15d422ffa8e1af7f3131de782510d61598b2a95a341c38c7a06351142f9ba)

## base-script-2026-10-20

Base, mainnet, 2026-10-20, signed by: test script. Record: `proofs/p4-speed/base/results/2026-10-20T00-51-59-782Z-live.json`.

Keys held by the test script, quote held before the tap. Filled is the first receipt with status 1. Fee is gas used x price + the L1 data fee.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Buy | tap to filled | 20 | 20 | 886 ms / 1,294 ms | 1,350 ms | 0.00000329 ETH median (n=20) |
| Sell | tap to filled | 20 | 20 | 1,189 ms / 1,250 ms | 1,285 ms | 0.00000331 ETH median (n=20) |

Buy, every sample:

1. 925 ms: [0x8fc972d0…](https://basescan.org/tx/0x8fc972d01e09fe754764d8c50dd08ada3b7a11a8793f62d7e13d7931eaa91937)
2. 859 ms: [0x1735fca7…](https://basescan.org/tx/0x1735fca74c2d63650751346cafb40e49048003762af2741388bf501c5b20c737)
3. 884 ms: [0x6a0fe540…](https://basescan.org/tx/0x6a0fe5406630715038ac3ee2a84a2e19002e1836729d8b9f37503a5df5393574)
4. 1,294 ms: [0x3f82948b…](https://basescan.org/tx/0x3f82948be9d5d4fe3ed1572ee255b734771bee77f778d19eb2dea855f75c86a7)
5. 1,279 ms: [0x77514b8c…](https://basescan.org/tx/0x77514b8c1c6b15ef70a8345a6b68d3f60994fc3076edbe51622e733cd6fcba4f)
6. 1,261 ms: [0x73d80814…](https://basescan.org/tx/0x73d80814427b62f932e12fd0201584fd4847b2a3990a8ca9232514ee64e2cf0b)
7. 850 ms: [0x7e385af2…](https://basescan.org/tx/0x7e385af2fbbf2303991414e925c4d9489eef0a2dcc865f77103edb6be260726f)
8. 850 ms: [0x2d3bed38…](https://basescan.org/tx/0x2d3bed38a2dcabfd31300914b89aebfb34eaa8aeeda603f555c0db5ba0e23e5d)
9. 943 ms: [0x87acbcc5…](https://basescan.org/tx/0x87acbcc52a8f566ddc976b9332adb7679aeb61e6a13bbb0a8de79a32fc79ad4c)
10. 886 ms: [0xaed72ff0…](https://basescan.org/tx/0xaed72ff0bfb26d05ae14f624a059a94fee618555c9fbf8b17a1e1c85fd89a3e5)
11. 885 ms: [0x37dd9c49…](https://basescan.org/tx/0x37dd9c49b2d67ebb8e7f3facf556181173e40f1e19a0d2bd03c14a0bbea28945)
12. 893 ms: [0x3058d7e2…](https://basescan.org/tx/0x3058d7e245b261a72da26c64f2441a915dbfb6b86d2ca3a9b8de916203681e1d)
13. 1,350 ms: [0x29b57699…](https://basescan.org/tx/0x29b576993d0746b559d5a1c978c8e545925df2b3df65220a95f8a35f074f6e25)
14. 950 ms: [0xd8a43e2c…](https://basescan.org/tx/0xd8a43e2cca5f201bbee49d35618b9f94e3ebc11df2126295090ebade6e96e298)
15. 857 ms: [0x4a228e64…](https://basescan.org/tx/0x4a228e640c63488dc83144c6cc6340a1146ab382aec0e89c5ef9e945d0a099dd)
16. 944 ms: [0x4bebe365…](https://basescan.org/tx/0x4bebe36515f2ef7ac227350d2f5558eee0d09606bebaea5918c25350db4c2e13)
17. 851 ms: [0x8a8b897b…](https://basescan.org/tx/0x8a8b897bf12991c95b7822627daac4a474e3be55e1a0e32b41c3840721344022)
18. 991 ms: [0x61e479fd…](https://basescan.org/tx/0x61e479fdb2c1f356cd08ac7a9ed19c1bb166e6be0295055b0167a951b8f1ea09)
19. 882 ms: [0x8a74a653…](https://basescan.org/tx/0x8a74a6532a37d3af986375ee75307f5ae8ee851c959569fc43f83eaf927ebc6c)
20. 880 ms: [0x995ad00d…](https://basescan.org/tx/0x995ad00d2e9232ffc5cadadaff603cd8730f596e1625398470acf53fb6f0f091)

Sell, every sample:

1. 1,124 ms: [0x55df7e39…](https://basescan.org/tx/0x55df7e39f60913a83d32269b69ac0ff83796f3b400ac5d059412f3692abc5e4a)
2. 1,242 ms: [0x063cae84…](https://basescan.org/tx/0x063cae84e9f7af491099f3706203de1931aebdfa7bc2e090446737031e1b9966)
3. 1,207 ms: [0x85b82524…](https://basescan.org/tx/0x85b82524b450940f6c738aec1f5c69ddada03ba07ee373523cf8b6a5ddcf921d)
4. 1,224 ms: [0x6be5bac9…](https://basescan.org/tx/0x6be5bac9ef378249f9bfd720b6aa3cc8c0f5cd31360b7cd8a0e8abeb8df93104)
5. 1,285 ms: [0xe26a7fd5…](https://basescan.org/tx/0xe26a7fd5154a20e9f4d48c4bee3166bd471cf99d2e79c3b9255d5e9e910221e6)
6. 1,183 ms: [0x25b85879…](https://basescan.org/tx/0x25b8587922c7deca0c85cb0e8cd92e017ff2e88e89433b9fe7b571b5e0c2d04e)
7. 1,189 ms: [0x7be78b4f…](https://basescan.org/tx/0x7be78b4fff4ac10557acd9cd80efa8e7aeac57327ed2b92b160663b6f690ea53)
8. 1,204 ms: [0x45e30cbb…](https://basescan.org/tx/0x45e30cbb8eb06b12d8c99310be54d9f7d5cd49be9180433db748b3adbe14ab06)
9. 1,151 ms: [0x5c54cc31…](https://basescan.org/tx/0x5c54cc310995bbed60b36cfd0fde4a897fcfad1aa8baf6e7b86b97aafef290d0)
10. 1,170 ms: [0xb12758e1…](https://basescan.org/tx/0xb12758e1d03870fbd2d7b0b218e42f6614cd242aebe3b7d8e94fc93a8cf6658d)
11. 1,142 ms: [0x4d65bc2d…](https://basescan.org/tx/0x4d65bc2d0ae623fcd1e6488130d720b1a5b2beefbab3ae2e27148c11308bee1e)
12. 1,215 ms: [0x1b396a8f…](https://basescan.org/tx/0x1b396a8f6889c857038e26ab691c80a5bd6a5c42680aaff1a5e9468ae076b09a)
13. 1,213 ms: [0x0b08470c…](https://basescan.org/tx/0x0b08470c39953080e9f1c6bd98c5864697f7ef1197df149855de9782313dbea6)
14. 1,250 ms: [0xbae7ad3d…](https://basescan.org/tx/0xbae7ad3d7183af060c3519cbf04645f857f8bacf228df691f94db55e43bc17e7)
15. 1,193 ms: [0x5613a79d…](https://basescan.org/tx/0x5613a79de8ad4973972d9aca6e0fe6da3df3bed7b6554c51e95f2feb079e66e2)
16. 1,231 ms: [0x609f1b42…](https://basescan.org/tx/0x609f1b428ca0cb6224da097ae7b25d8f4a3f255b6418da409de9c376ce9b8092)
17. 1,174 ms: [0x14f4069a…](https://basescan.org/tx/0x14f4069a0e54a0d0b5d05ab72ef3ab0b4c83e43edbd4fbd2e30440841397acf7)
18. 1,187 ms: [0xddc13422…](https://basescan.org/tx/0xddc13422c20b1199339d2699c326115dde4719d0d4cb3fa100e9d770cd0e88fc)
19. 1,129 ms: [0x184517c6…](https://basescan.org/tx/0x184517c69f69e1ec21e246aa1e2cac40debab1a45bf48ca68b08de6837b3b662)
20. 831 ms: [0x7a96401b…](https://basescan.org/tx/0x7a96401b8bde102883106849119a2f7ef2682c351c7ff63ee6f574d0f8312fdb)

## base-hop-2026-10-26

Base, mainnet, 2026-10-26, signed by: test script. Record: `proofs/g1-money-loop/runs`.

SOL on Solana to ETH on a fresh Base wallet through Relay, request to arrival read on two RPCs per chain. Fee is Relay's quoted fee in USD.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Hop between chains (Relay) | request to arrival | 2 | 2 | 4,921 ms / 5,795 ms | 5,795 ms | 0.0378 USD median (n=2) |

Hop between chains (Relay), every sample:

1. 5,795 ms: [q3zqNKebFS…](https://solscan.io/tx/q3zqNKebFSXZMrFeDCUYzG8UK9RdAkULWbbXoshWY2VfYFN2Kb4kZQFi4vrpYzPm6RDX8LRK2PPq9CfP8FqpdYa), [0x732f0e46…](https://basescan.org/tx/0x732f0e461ac76c3596d3d3f170e15f1c29ab525c17c97626eb244c8d483f1dda)
2. 4,921 ms: [3dcGVem1Ve…](https://solscan.io/tx/3dcGVem1VepmpxZ9FjHpNDJbaH8x8gjbw56C3exdLF5Vfm94fzEHvUAEJe9h6yEGod5rxShfhLxipdSX8MUBN3ip), [0x8f82661c…](https://basescan.org/tx/0x8f82661c6d256f985b03bb1c4209554177c6177d50273909bc333fd3e77d730e)

## robinhood-script-2026-10-20

Robinhood, mainnet, 2026-10-20, signed by: test script. Record: `proofs/p4-speed/hood/results/2026-10-20T17-13-35-480Z-live.json`.

Keys held by the test script, quote held before the tap. Filled is the first receipt with status 1. Fee is gas used x price.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Buy | tap to filled | 20 | 20 | 1,872 ms / 3,953 ms | 4,060 ms | 0.00000781 ETH median (n=20) |
| Sell | tap to filled | 20 | 20 | 2,014 ms / 2,516 ms | 2,549 ms | 0.00000662 ETH median (n=20) |

Buy, every sample:

1. 1,774 ms: [0x500108c9…](https://robinhoodchain.blockscout.com/tx/0x500108c909d6cbe145fae5555c991bb9a33152957096860faf961555b23c6293)
2. 2,202 ms: [0x6985cae1…](https://robinhoodchain.blockscout.com/tx/0x6985cae19af0bc87c90e266e4d6e57e495da48537482d818ddf0944670471350)
3. 2,220 ms: [0x9ea4096c…](https://robinhoodchain.blockscout.com/tx/0x9ea4096c7564c3babd376f1576b7f5c677d6b1875c57cffb6b6c8ab368d5a504)
4. 3,953 ms: [0x2f7832f8…](https://robinhoodchain.blockscout.com/tx/0x2f7832f87d53856e325d5e2eaa577c363a0e3fc36c7be3f9e528ac6c69c7c967)
5. 2,196 ms: [0x8c613fc4…](https://robinhoodchain.blockscout.com/tx/0x8c613fc45cd47c96c18374608a37a31add25e93592849fe5380aa272ea49cedc)
6. 2,148 ms: [0x9a69076b…](https://robinhoodchain.blockscout.com/tx/0x9a69076bc83989d9c5cea78bef70970a4d9921431c761bbcec82291c39239298)
7. 2,215 ms: [0xe1df11af…](https://robinhoodchain.blockscout.com/tx/0xe1df11af76cf1a7011453012b77139bb056d7e6aa5165a4ee1ca4182f0088126)
8. 1,749 ms: [0xab776556…](https://robinhoodchain.blockscout.com/tx/0xab77655622d5a5888ad25f270b88e166cd3f2099c37712cff70aa70d4cc91116)
9. 1,975 ms: [0x18f8570b…](https://robinhoodchain.blockscout.com/tx/0x18f8570b675a88728c748949a1f9306ddb6da3288dc93160ed2e88dc7cf40a2f)
10. 1,773 ms: [0x988af135…](https://robinhoodchain.blockscout.com/tx/0x988af135a10e274a8bdf7be229bd34ca9b6d245664d5163ca883f6832d921773)
11. 1,807 ms: [0xacaeec9c…](https://robinhoodchain.blockscout.com/tx/0xacaeec9c2be5d28f9a731bfd6f8804476cb75dab2b25ad6bc6bbbfc4ceb442b8)
12. 1,824 ms: [0x3df02d63…](https://robinhoodchain.blockscout.com/tx/0x3df02d63294b7fd1f624021f77f4862ef609df2e2637c58e06d09c6ae360d62c)
13. 1,768 ms: [0x5f98c80c…](https://robinhoodchain.blockscout.com/tx/0x5f98c80cf31caab9b228dd64d86ba703856994aa5fdd91760e40607bb7dea07b)
14. 2,219 ms: [0x360afd89…](https://robinhoodchain.blockscout.com/tx/0x360afd89ea69a0a644c119672470107560df369c13337c5f3826bb4aac11ba36)
15. 1,748 ms: [0xa5c1759b…](https://robinhoodchain.blockscout.com/tx/0xa5c1759b7658c7ff322c78a002327a615e97e3dfac4cb0440877189d42f23b53)
16. 2,200 ms: [0x74321623…](https://robinhoodchain.blockscout.com/tx/0x743216238a59c5ebde09bb753df32d147c90f5f7be44e68b9d8cbaca9bdf5c99)
17. 1,714 ms: [0x927bf2e1…](https://robinhoodchain.blockscout.com/tx/0x927bf2e10d1ee08911bdbf8a8a6830e4bed61b3612053d78f3bc3780245c901c)
18. 1,707 ms: [0xd1611cfb…](https://robinhoodchain.blockscout.com/tx/0xd1611cfb48ff1cffce76bd8e023516872a2ddce779a9808e00de11cc4319bbc8)
19. 4,060 ms: [0xb7428952…](https://robinhoodchain.blockscout.com/tx/0xb742895276038bc09c95354ad5187fa84970b2f756e51b4b15a64c0e38793144)
20. 1,872 ms: [0x155f78f4…](https://robinhoodchain.blockscout.com/tx/0x155f78f47c3e6b4d964bc388deccc6d0f1e75f26890812d43538a1b0527e9bc4)

Sell, every sample:

1. 1,763 ms: [0xe7a67f54…](https://robinhoodchain.blockscout.com/tx/0xe7a67f54554470501730a1834da0726dad85801736dd42922729d9409d249fa4)
2. 2,516 ms: [0xc20045bb…](https://robinhoodchain.blockscout.com/tx/0xc20045bb8172776849ad9df43555626c5ab64a4a9ad9b83caad76a069f68c580)
3. 1,880 ms: [0x5213d6c8…](https://robinhoodchain.blockscout.com/tx/0x5213d6c8a6646ca86dd4cb5608b0044f7ab662df6ba96dd7f08d5a72d955a85c)
4. 2,490 ms: [0x96f10acb…](https://robinhoodchain.blockscout.com/tx/0x96f10acb9058f9f720cfeaea1024f5fb907e50952fb06c7e1d07990c76d219cf)
5. 2,194 ms: [0x839d8ebe…](https://robinhoodchain.blockscout.com/tx/0x839d8ebe208ec1029edf5d2b62dcac814bd4f354fc0cefe792806c2d2eaf8677)
6. 1,767 ms: [0xccc5be7b…](https://robinhoodchain.blockscout.com/tx/0xccc5be7b595cf483e40cc0fa2f0ddd8d66ad69519a0d72c1b7382a488ee72728)
7. 1,680 ms: [0xe922e33d…](https://robinhoodchain.blockscout.com/tx/0xe922e33d007502ce391f8cc69eeeb68189c0dcb61028bca207ac1acab6e4d531)
8. 2,245 ms: [0xe78aea63…](https://robinhoodchain.blockscout.com/tx/0xe78aea63d1c73183e2dd2b0bc181aaf1e329ee59e0840e0e663cf88a26349603)
9. 2,294 ms: [0xefc6ae9e…](https://robinhoodchain.blockscout.com/tx/0xefc6ae9eaf7e05f2c408b8646b2fa6273218a914c9a1bfb48fd2222dcff7ded3)
10. 1,846 ms: [0x350e9beb…](https://robinhoodchain.blockscout.com/tx/0x350e9bebc9e3405f938a0bbc9afa8b551f8c2af1266d77cea79f586a14911e82)
11. 1,787 ms: [0xb2b8a5ab…](https://robinhoodchain.blockscout.com/tx/0xb2b8a5abb038848e622cab1d3891ff5eb717cdc8e3f2a2f4b8b1277e30ca2b58)
12. 1,774 ms: [0xd7dfd2cc…](https://robinhoodchain.blockscout.com/tx/0xd7dfd2cc49753ba7c3af3f1cc1563520f9bc552f6a795c2b0f760ca5e504d9db)
13. 2,214 ms: [0x5247ed00…](https://robinhoodchain.blockscout.com/tx/0x5247ed00092b1ce78bc9aa4e4e5a5e427ea1d35680524a6cab47f8af3c6f251d)
14. 2,290 ms: [0xa05a6e5f…](https://robinhoodchain.blockscout.com/tx/0xa05a6e5f14f5bf53975d0f5f9fc2ab39351ad1f97fddd868c57db8b3a977ca3d)
15. 1,615 ms: [0x0cea685d…](https://robinhoodchain.blockscout.com/tx/0x0cea685defe92a3d171a81af510f68b143fef5ca27a60c53d0a47f7ddf8c5c3a)
16. 2,549 ms: [0x9f0d45cf…](https://robinhoodchain.blockscout.com/tx/0x9f0d45cf1799fe47f20a9dfceb1833220164ba5b9dd480579531371da67f4d6c)
17. 2,081 ms: [0x6818a486…](https://robinhoodchain.blockscout.com/tx/0x6818a486af13850e92c6ec3a0549af79663fc450982132fafdd06748bac7d832)
18. 2,014 ms: [0x96a4a9a7…](https://robinhoodchain.blockscout.com/tx/0x96a4a9a7518eaacc594c7c9cff9dbd802b90b72695b4e5dcb0eef6c636eac153)
19. 1,863 ms: [0x453841c1…](https://robinhoodchain.blockscout.com/tx/0x453841c1f903bd036cfc2e974ad625acf289c7dde9b7f413962b8f2ac7bf980c)
20. 2,190 ms: [0x6cf55cd5…](https://robinhoodchain.blockscout.com/tx/0x6cf55cd5ca7d18b6fc230d2baddcf668678f50bc9ca80b941cdc04e8ec1cf72b)

## near-intents-2026-10-19

NEAR, mainnet, 2026-10-19, signed by: test script. Record: `proofs/p1-private-balance/runs/2026-10-19T22-53-44-913Z-live.json`.

One leg of the P1 live run through NEAR Intents (1Click): request to the balance visible. Fee is 1Click's quoted fee in USD.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Money in to NEAR Intents | request to visible | 1 | 1 | 31,891 ms | 31,891 ms | 0.3523 USD median (n=1) |
| Money out to a fresh wallet (NEAR Intents) | request to visible | 1 | 1 | 24,337 ms | 24,337 ms | 0.0000 USD median (n=1) |

Money in to NEAR Intents, every sample:

1. 31,891 ms: [HzXdX4nnTa…](https://nearblocks.io/txns/HzXdX4nnTai9J7nN9RTNDFsPi6dQP3Q49TvKF5sZzb1K), [HHUxsLkFtz…](https://nearblocks.io/txns/HHUxsLkFtzfRaMXb63DK7qm285vUXSoEJZq21UZUcufe), [FtQLHq3Y4D…](https://nearblocks.io/txns/FtQLHq3Y4DAby62uxTjHqSSe9Axkhx5wehKoRsgtR6r7)

Money out to a fresh wallet (NEAR Intents), every sample:

1. 24,337 ms: [NKJibXNM9A…](https://nearblocks.io/txns/NKJibXNM9A1QbjGzf1T8w7ttwPhQdt8rrpAiz7UvasW), [HdKgkMzeMg…](https://nearblocks.io/txns/HdKgkMzeMgkAH2PekBu1YHtzkTFvCWek7VrcNpaVZH3B)

## near-script-2026-10-20

NEAR, mainnet, 2026-10-20, signed by: test script. Record: `proofs/p4-speed/near/results/2026-10-20T01-27-04-776Z-live.json`.

Keys held by the test script. Filled is the wallet's balance seen at optimistic, polled every 200 ms. Fee is the NEAR the trade's transactions burnt.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Buy | tap to filled | 20 | 20 | 3,870 ms / 4,295 ms | 4,328 ms | 0.00236 NEAR median (n=20) |
| Sell | tap to filled | 20 | 20 | 3,745 ms / 4,177 ms | 4,385 ms | 0.00185 NEAR median (n=20) |

Buy, every sample:

1. 4,088 ms: [Grg2QcPqzQ…](https://nearblocks.io/txns/Grg2QcPqzQEh3XsVvEC9EP625MJJCjgJ28zTD2WGxcXH), [GRGzwbpNGw…](https://nearblocks.io/txns/GRGzwbpNGwFkBSVDT6apuSAZKv4wYPSBsNX6PbHCG1QC)
2. 4,192 ms: [8e9zjyHMnU…](https://nearblocks.io/txns/8e9zjyHMnUHaUG2cLdBS2PpwgsTtZwJWKgfMUdHjfGrW), [HFebw8FEPr…](https://nearblocks.io/txns/HFebw8FEPrucKsUCrrefUQpVJw7gd5sZk4jjWeoSKzyt)
3. 4,295 ms: [8JxF4UHWfZ…](https://nearblocks.io/txns/8JxF4UHWfZHz77mohH6cGtisvtWmrww8cNUepT15aPuu), [Fzd5n4ZqD9…](https://nearblocks.io/txns/Fzd5n4ZqD9LXBbmuqwr79nwabBj4CsFhtZU6f5vZ7ky9)
4. 3,679 ms: [CYRbTr9XDT…](https://nearblocks.io/txns/CYRbTr9XDToSN9AMVmwpiwCVVCoVXZNZnpYs1p7xkmYv), [jeuSSoFRTD…](https://nearblocks.io/txns/jeuSSoFRTDBxyrUy2rXpo67YquNzwbY22SBiVpMZfAX)
5. 3,668 ms: [C1sraoq4PJ…](https://nearblocks.io/txns/C1sraoq4PJu1qAaRqdZcy7iyPWWTCamzrRoacir6rQtz), [4sQwetyAXM…](https://nearblocks.io/txns/4sQwetyAXMEvcoUJc2mkiz3snQyeoWV1LG2LAZkLxjf4)
6. 3,597 ms: [EjoXXoxF19…](https://nearblocks.io/txns/EjoXXoxF19S4cc8AUj3uEzh6qUTN1cyayHXaH7hvpbZ8), [Anq8ym7WnL…](https://nearblocks.io/txns/Anq8ym7WnL5AjRdvkqJMb7S7FCPexcfgF358tdKWpnBj)
7. 3,998 ms: [CJRnDXfwHZ…](https://nearblocks.io/txns/CJRnDXfwHZCtNiR9sd36YGPJAn8dCHriHKyRR34CWFza), [CLQGruhvwD…](https://nearblocks.io/txns/CLQGruhvwDrizrbmRJ4YTYtE6Z3FDXeQ1Cuwoy7Ne4eg)
8. 3,870 ms: [BizraxzpD7…](https://nearblocks.io/txns/BizraxzpD7fZiQHtestLD5GLmBse1jJFfSaiwA99wL6s), [5u7aWAmpLy…](https://nearblocks.io/txns/5u7aWAmpLyN73tdNHcYjMr5WCWY18H3VcxfZpBGUd6QB)
9. 3,735 ms: [CAgtYYnNgh…](https://nearblocks.io/txns/CAgtYYnNgh9ixxsfo3MmxFgdj5DfRNMx3WiTcpdzhH8), [6jZzwzmvmQ…](https://nearblocks.io/txns/6jZzwzmvmQmA3sWyjYDUiF9hsRp1eeXNchRcQfiYozmL)
10. 3,372 ms: [BhorVtLkqG…](https://nearblocks.io/txns/BhorVtLkqGtiinPPaA7MgxnkimoRznuRj5AfYKCcEVpy), [3shkzxpPA3…](https://nearblocks.io/txns/3shkzxpPA3RYUDoTVSMeRqJDHT9Smu3HU1nPqLUfVDkx)
11. 4,178 ms: [9fXzURRaP3…](https://nearblocks.io/txns/9fXzURRaP3ubYHTgYigudzgLomNzeKYq8APvN4SmyEHp), [37j18DwFYu…](https://nearblocks.io/txns/37j18DwFYuguLtuSB24Q7jERb33AGVDKuj9MQ5coZ1dn)
12. 3,639 ms: [3fH1saJGVm…](https://nearblocks.io/txns/3fH1saJGVmqhHXacuoSA83dPtmadWrBmEfVvru7zW3aL), [BZPmXoa7u1…](https://nearblocks.io/txns/BZPmXoa7u1xGqSfez5fZT7i4ygbhjGoko522HLU4ifo7)
13. 3,938 ms: [MqKmHhD7PQ…](https://nearblocks.io/txns/MqKmHhD7PQEd5Jw8uHePwF7jco8HAyyHrGkcmeLD33P), [7LscnncGVX…](https://nearblocks.io/txns/7LscnncGVXU7jDMNfn7JGb5Nq733XHjYrDQsMYmUDixV)
14. 3,671 ms: [AmMMNMLzbD…](https://nearblocks.io/txns/AmMMNMLzbDLM1MXtqNcuSxWxQ7WksuzNvBSzEJrUT2q7), [DPm5RytDAB…](https://nearblocks.io/txns/DPm5RytDABLcro2xCtTAWig6g1aaZVb4tHZa1oJWLGzd)
15. 3,353 ms: [8cEGFr7Va9…](https://nearblocks.io/txns/8cEGFr7Va9zqk2HtMxVEhLwyqu1FvU5bs5ZWLmj4qSip), [CLThHC5Ex6…](https://nearblocks.io/txns/CLThHC5Ex68mSE5dX1nYfgU5xXjixMUFY9t44e32G8fH)
16. 3,956 ms: [Gfupn2EBUj…](https://nearblocks.io/txns/Gfupn2EBUjsDfyJMgWuzGPdMUpSJryyCs1MEaGuAiwcM), [8oEswn3mAx…](https://nearblocks.io/txns/8oEswn3mAxE7PTFDXdjUdZspSXT4SYeSj53v3CSswYqE)
17. 4,328 ms: [FGogfkdfxE…](https://nearblocks.io/txns/FGogfkdfxEViaLPpQdWGR2AKHiAg8DbwZ7HHoyJuMo3J), [HfDuHxGsNZ…](https://nearblocks.io/txns/HfDuHxGsNZHuVkaVHhLFCH5sBdcuHL2M6xMDMeUukMLt)
18. 4,087 ms: [7biQaQaivR…](https://nearblocks.io/txns/7biQaQaivRVSzHXeCW8vAxz3G7bs3uDjVX19PbqAVD5J), [hYUczxEbXe…](https://nearblocks.io/txns/hYUczxEbXeyZjSK7gPaqPSrJWANuKmixDYSYRAXv7m3)
19. 3,391 ms: [C18xnpTYMK…](https://nearblocks.io/txns/C18xnpTYMKjznEzBCqQSRhJLfR43nXHG3urmRaDoB6Nm), [J3EzF9Rpuk…](https://nearblocks.io/txns/J3EzF9Rpukcq8Fjf5fydUyRgSBiDjQT4fLWMRn7fZT6m)
20. 3,895 ms: [23dWboKBmh…](https://nearblocks.io/txns/23dWboKBmhKmTaeZeR5ZLFpNttd7dNTjf8ZHCtM1oXTT), [4ZvjGn9pM2…](https://nearblocks.io/txns/4ZvjGn9pM2zjVLSQH6DYkHmK6FXUDDwBAxt3YRyz9v7h)

Sell, every sample:

1. 3,675 ms: [BYAPatr2xe…](https://nearblocks.io/txns/BYAPatr2xets6tw2wNBK1JCVzEbrVdyQMRYUMeJGiqPx)
2. 3,372 ms: [BMSbQHdCEB…](https://nearblocks.io/txns/BMSbQHdCEBUNevj5q77mH88CScVevw7ksNkipHdZZTdo)
3. 3,769 ms: [2yfn43843D…](https://nearblocks.io/txns/2yfn43843DCsy2CAzm4GAjMHXv1bd1VPjGGq3j2GdAur)
4. 3,227 ms: [DD3eVo2foQ…](https://nearblocks.io/txns/DD3eVo2foQhzXKZ9bXHoCcRv18QWguCzZDbu27ttAXc1)
5. 3,805 ms: [EThatdDUtP…](https://nearblocks.io/txns/EThatdDUtPB42hbpxvetajSjWSfV1YZb2e3y4W1QieZd)
6. 3,618 ms: [CMctX5ExZG…](https://nearblocks.io/txns/CMctX5ExZGDAKdCyqA7MDdXigqvNRkmER1dNR7iKmnHN)
7. 4,110 ms: [FUWkubxnmM…](https://nearblocks.io/txns/FUWkubxnmMqJJsm279U8P97GxBWdmvohkmj2ti4XiEf7)
8. 3,833 ms: [2x9KqyX8ew…](https://nearblocks.io/txns/2x9KqyX8ew41egz3n8iPeWbsdneSbr39jfSMApjRLFHJ)
9. 3,955 ms: [CBe3u7Pdrp…](https://nearblocks.io/txns/CBe3u7PdrpWR6cYgL7Ebj8naed3LY1J9UF1AVJRwyHG5)
10. 3,420 ms: [G9hoYqa7Zn…](https://nearblocks.io/txns/G9hoYqa7ZnsVhNdKemjx1eA4Gg1t8qJBNRp5qbditQzU)
11. 3,745 ms: [Etj813NCeh…](https://nearblocks.io/txns/Etj813NCeheCaSgVtri9VEzeYo55Xk4vR1vRDfGk9iAk)
12. 3,636 ms: [7xFJBTSA5o…](https://nearblocks.io/txns/7xFJBTSA5oog9xjTTNuA5GZGL1UyMp8hJkVU13DcrMnb)
13. 3,640 ms: [BzHJod96iY…](https://nearblocks.io/txns/BzHJod96iYs7Q9F1u8ZgCbLp6VeamtPr6LH55q4WZMwp)
14. 4,166 ms: [FVCyBRT4UZ…](https://nearblocks.io/txns/FVCyBRT4UZsypVw59rTmq46KQzJShr2Nr6e4bGMpRySA)
15. 3,701 ms: [8PixsfNaW8…](https://nearblocks.io/txns/8PixsfNaW8TrQpNvQxyvFmFbzRBTRkZQqUKUbYJ9pqgY)
16. 3,948 ms: [CdzU6vWqw6…](https://nearblocks.io/txns/CdzU6vWqw66eKeWBBzQGHLybu5mHLWQhQNqHhzmvk6XX)
17. 4,177 ms: [HMUg2g2V6A…](https://nearblocks.io/txns/HMUg2g2V6Akx8J3rNzQkTxGHWCsva2rFfb7h8HwvqFH3)
18. 3,672 ms: [BwkKBwEBeJ…](https://nearblocks.io/txns/BwkKBwEBeJM7veBJrz5F66Vp7crFsoRZkS78gWGTeuM7)
19. 4,385 ms: [DhzQHqi1kq…](https://nearblocks.io/txns/DhzQHqi1kqwBPQg3d8SeHst1y9zgck24duEUX96t6o9b)
20. 3,813 ms: [2rSegsU17z…](https://nearblocks.io/txns/2rSegsU17zaJzbkrejFsyNXua3HGwukB56NTHxU9PJQd)

## vault-gas-testnet-2026-10-26

NEAR, testnet, 2026-10-26, signed by: test script. Record: `proofs/g1-vault-gas/testnet/results/runs/20261026T034502Z-testnet/txs.json`.

The vault's test build: a real withdraw proof checked at tree depths 3, 16 and 32, and five deposits' tree work (no token call). Value is the vault receipt's gas; fee is the NEAR all receipts burnt.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Vault withdraw, the vault's own gas | gas | 3 | 3 | 49.918 Tgas / 82.420 Tgas | 82.420 Tgas | 0.00503 NEAR median (n=3) |
| Vault deposit, tree work only | gas | 5 | 5 | 9.405 Tgas / 11.900 Tgas | 11.900 Tgas | 0.000972 NEAR median (n=5) |

Vault withdraw, the vault's own gas, every sample:

1. 40.584 Tgas: `E3D2t9QABxYJF9KhQbqi23QE7JcdaxRHjH9L4iTqEjdk` (near testnet, no explorer index)
2. 49.918 Tgas: `J3BR5BGV5Q87ovArpxCxPrjEMVoRvaAYisUZoXe7zSM1` (near testnet, no explorer index)
3. 82.420 Tgas: `4RQcq1sbB9GLA6SunWzWkbPigRVhr5qLnq74ndEaxZfj` (near testnet, no explorer index)

Vault deposit, tree work only, every sample:

1. 6.167 Tgas: `EioYwuXPgpEkar6uPohK6bNnQPg54n2Ud5r2kBPkRkou` (near testnet, no explorer index)
2. 9.065 Tgas: `8DB3hVfwxRbLVyoFMgUMBrTuyQVEDidc3AqFRV4uXn8s` (near testnet, no explorer index)
3. 9.405 Tgas: `2xRK7hnH41ydRLVD23DG5XrvdSWomh9oztKFePLzoWb3` (near testnet, no explorer index)
4. 11.900 Tgas: `6uF3mDkczfMeqNeumFWF1q4qFMBYjikiqiSV54DUz5uY` (near testnet, no explorer index)
5. 9.755 Tgas: `4UJNnhT9ktb1pzYknhVsMsoqw2EPfhpzHUrFEifXo8K5` (near testnet, no explorer index)

## proof-phone-2026-10-26

NEAR, device, 2026-10-26, signed by: phone browser. Record: `proofs/g1-phone-prover/results/phone`.

snarkjs 0.7.5 in one worker, single thread, in a phone browser; the first run of each page load is cold. Every proof re-verified on a second machine.

| What | Measures | n | ok | p50 / p95 | max | Fee per sample |
|---|---|---|---|---|---|---|
| Withdraw proof on a phone | proof time | 5 | 5 | 8,348 ms / 8,492 ms | 8,492 ms | - |
| Commitment proof on a phone | proof time | 5 | 5 | 600 ms / 616 ms | 616 ms | - |
