CARD precommit-taken-recover / live: PASS
Money path: yes
Tx: solana-devnet 1T3qf4AZ95Sr8TAimtyvE5sD8EhUtM96Fc8oMqZL8k8pvBpaRFpuHCeoxCE2TY8S4LqXNuYoiseDHDNXNMbPpcg
Tx: solana-devnet 4uPr2PkgJpCbAJJELV8WVvBu6ApjjcceHKfDzUAR5HsuBUtf8YG5MRDToc2HHCVzFpP87o6w2snaE64UBbq59Rje
Tx: solana-devnet 29bT6cU2RPaNpkJwbuF3j2d2K8MimyUKi4HdZBqQe125bjrT1JfmC1mNRW54JabwiHnQ4pbWwYQ3XsvAhcQpn9u7
Tx: solana-devnet 5LkRwCfQcMZmx7GvDVPXVACwcnnzsc7WgJQobxiS7zjEPWjv9gKTn7P1bzVB8GoxvpcaSTBQcr1ShFbfZwZefxeg
Tx: solana-devnet ZTUeY1sMPa8ERKJPywVvzj48ssjcacgqPBLr4bo6x9ui4GwDVeFE8dCorB8Gv1k3tyqRjgqBimyVXGULFypiB6n
Tx: solana-devnet 2jeNKALHsScMucxRd48ScfJQsfRqYTrBiAPJy3Y7yFUgpurCCiiXssgQtpVo8uKpwG3zwS6PS7VZNtY4FhZayN6V
Tx: solana-devnet 3SiC4ZdGyrbQaWrxCuntj7t8AmHVWPjyfk4uoTgqYUjG9WW56azHZ3QnnaYKBup2BbfhN1WQQ7xVYSVRCjG9Np23
Tx: solana-devnet 2h5qykqpRMN22YpiWvey8t8ha5Yyqpv6nsAn3kyb58h43jLR6ynjhG68UJ9nVsVH7UixcNdmeJT2KfZVRm4CJkfn
Tx: solana-devnet 3PRgPjnTebFdJbrj2BvV44B9FjTodhe7cAesaENybZ2rJFNLRaeb9ffv1QyE7EVUfwPw75htUBtLfVEGPY5xkv64
Tx: solana-devnet 4H5FhgVRGQSYtreBfUSLbd38hmehhNrXDYouenZjrPFaRq9kUHuCrYaTp8iYJFnnHMLpxYYAcRn6s7zwJ65VnfWH
Tx: solana-devnet 4AHhi3N9WmVS6rrQHuWS7JyCeHKMpFK7eaJvfL3k9dw7dsdLvgL6RbbbPWWNXDAz9dpM7CKUSYodMXCGDCCUEpvH
Tx: solana-devnet uKRuZrusmyZVLLbNWAjyvYJR79CyYrVwHeWaY1KCnNrFSJ5VthYyjvoS9utCbcm2t1HGjVaBiuhXrDpr5S7G21B
Tx: solana-devnet 3WiaKtZLtiiSnRdw4BhSKUsEkUxM6vS6eNdjP2WCvSms1F2Lnhoad3cdMm6XCSmhVBrpCqx2zDTRpv1woMEBBYwU
Tx: solana-devnet 5dNzDGmSZEJYiX2JQuNnpw5UP7etE5WTCRzBMMkWDHWvmtbtVavXFUPnvigVgKBwuWUZrL8FaV3DaQUFt7TwijPV
Tx: solana-devnet ai6yiBzaRg8F7q3ZGW8C47QM2r2Nhya7WG9r9xacBXpGUz3rpQG4Biv1VzYr6wtJFWLoLqDWNTTkGMEmPUTqCP8
Tx: solana-devnet 4yMUJy8YWcEcDYMjQ9nsD2oz5qmeg94rRG19LrLewcuFJwedhRJvTcBQosLFQ7XfaPjKiSuu57chJmhukn17HL4K
Tx: solana-devnet 8VqCs44YR5daoAcVRCTJXca4LPcp9M3wsXwkhTdiXXAb3qEwUhx6u2RGJRBqP33EMzgzhZV4dAEGwyKH4nFJc8c
Tx: solana-devnet PCEs5dF8Q7w5tqxejavLvJdxSzSkWPKCZAX26FT5iLZCHwq9hqRFB6kP3HnVQKSQySzqNA6tSHn93UfA9RzWMtN
Tx: solana-devnet 31Dm5bofdz9GP81AVoZxnuNarVF7DSN7KErs5pJUF2TDJnjhqnf5LLuUs6FnwBwSuhvmLGKaXhQT6EUNdq4rxEtZ

The front-run run, on Solana devnet, 2026-11-06 01:02-01:41Z, against the pinned devnet pool
2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr (program 5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ), through
packages/signpage/scripts/pool-deposit-taken-devnet.mjs: the signing page's runPoolDeposit with a seed made in the run, a
stranger's key S, and U the seed's deposit address. Every funding came from our devnet wallet D
(3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx), the exact amount the step printed, and every sweep went back to D.

Run 4, the live run (precommit-taken-recover.run.json, the Tx lines above in its order):
1. D funds S, 18,177,800 lamports (1T3qf4AZ).
2. S funds U, 13,586,400 lamports (4uPr2Pkg).
3. U's deposit of the 0.01 SOL rung goes to send. Before it does, S deposits MIN_DEPOSIT (1,000,000 lamports) on U's
   precommitment 0e10290b... (29bT6cU2). U's send 475P2aBD... is then refused by both RPCs at preflight and never lands:
   both RPCs know no such signature.
4. The device reads the mark (value 1,000,000, nonce 27) on both RPCs and stores the deposit note UNSPENT at 1,000,000,
   leaf 36, its commitment Poseidon(1,000,000, label, precommitment). It then signs the rung on the next precommitment
   04feb814... (second arrival 0), which lands (5LkRwCfQ): UNSPENT at 10,000,000, leaf 37, nonce 28. The ask answers filled
   with that one tx.
5. The sweeps: S 2,108,280 lamports (ZTUeY1sM), U 2,108,280 lamports (2jeNKALH).

Runs 1 to 3, before the live run (the Tx lines after run 4's):
- Run 1 (S 5sefhm555WEq3nV2yBEFwM6LuqZ41RJ37MhKzf95bASF, U 4Ja9w2YW1H6Yeh3X4SwmWqvouzenSMvddkeWwvauupqn). D funded S
  twice, 18,177,800 lamports each (3SiC4ZdG, 2h5qykqp), and S funded U (3PRgPjnT). S front-ran with 1,000,000 lamports
  (4H5FhgVR). The process then died on a 429 from the second RPC (onfinality's public route) before the restore, and
  its seed and S's key lived only in that process. Stranded for good: S 20,291,080 lamports, U 13,586,400 lamports, and
  the 1,000,000-lamport note in the pool, whose secrets went with the seed. In all 34,877,480 lamports.
- Run 2 (S G4J4U7kWWeq5Z3mB5XyqYTZ4FTX8UbUrTbQU4Bt882wF, U 2JbS1oQeYNjDM73DBcWm1VAVdQiviKgWNUNnpM3gr12E). D funded S
  (4AHhi3N9), and S funded U (uKRuZrus). On onfinality's public route (1 request a second per IP) the deposit's build
  never got its reads, so nothing was sent and S never deposited. Its five passes ended at 01:34Z, and its process
  swept both keys back: S 4,581,400 lamports (3WiaKtZL), U 13,581,400 lamports (5dNzDGmS). Nothing stranded but fees.
- Run 3 (S GFAK11ezvKLeh2Txd5Pp12Mc2t3vAouEfhYGC3rgjYAK, U G7GcKXcUdmP3Yip7kFDxqi7qoxreHYPyzFVkSY8Txs6D), the first run on
  the page's pair. D funded S (ai6yiBza), and S funded U (4yMUJy8Y). S front-ran with 1,000,000 lamports (8VqCs44Y), and
  U's send 5o3vCz7E... was refused and never landed. The restore then left the note INCOMING: the bug this run found
  (pool-deposit.ts restore, the move inside `h.landed?.(...)`), fixed with its regression test before run 4. Sweeps:
  S 2,108,280 lamports (PCEs5dF8) in the run, and U 13,581,400 lamports (31Dm5bof) from its key file afterwards. Run 3's
  1,000,000-lamport note stays in the pool, restorable from that key file's seed (deposit index 3).

From run 3 on, the run's seed and S's key are written before any funding to a 0600 file in ~/.ct-devnet-runs (0700),
outside the repo, so a run that dies can still be swept.
