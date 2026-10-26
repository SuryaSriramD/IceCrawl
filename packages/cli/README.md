# @icecrawl/cli

`icecrawl verify` checks an [IceCrawl](https://github.com/SuryaSriramD/IceCrawl) receipt: the Ed25519 signature, the SHA-256 of the stored snapshot, and a replay of the pinned converter and injection scanner.

```bash
npx @icecrawl/cli verify <receiptId> --api http://localhost:3002 --key $KEY
npx @icecrawl/cli verify --receipt r.json --snapshot s.html --keys keys.json   # offline
```
