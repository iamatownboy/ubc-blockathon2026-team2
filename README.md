# LanguageToken — Blockathon for Social Good 2026

> **Learn local. Earn local. Belong local.**

Newcomers practise three-minute, real-world English missions and earn
non-transferable credits, which they swap for gift cards from businesses in
their own neighbourhood — a Tim Hortons card for 100 credits, delivered into
their app and sealed to their device. The coach never decides who gets paid,
the ledger holds nothing that identifies anyone, and the credits cannot become
cash by design rather than by policy.

Built to `LanguageToken Blockathon Plan.pdf` (in the parent folder).

| Demo target | Chain | Provider |
|---|---|---|
| Mission → 100 credits → Tim Hortons card | Local Hardhat, chainId 31337 (or the in-memory mirror) | Mock, shaped like the real API |

## Run it

```bash
node server/server.js
```

That is the whole install: no framework, no dependencies. It starts the mock
gift card provider on **:8788** (a separate listener, so the client really
crosses a network boundary) and the service on **:8787**:

| Client | URL | Notable |
|---|---|---|
| Learner app | http://localhost:8787/learner/ | 430px. No account, no e-mail, no wallet software, no gas. Generates its own ECDH keypair (`extractable: false`) in IndexedDB. EN / 한국어 / 中文. |
| Verifier console | http://localhost:8787/verifier/ | The review queue. Approving awards the mission's configured amount — there is **no field to type an amount into**. Token: `verifier-demo` |
| Admin console | http://localhost:8787/admin/ | Missions, catalog, pause, live ledger events, service log — and the provider failure switches. Token: `admin-demo` |
| Public stats | http://localhost:8787/api/stats | Readable by anyone, no login. Aggregate only. |

Requires Node ≥ 20 (`. ~/.nvm/nvm.sh` on this machine).

Optional: `export ANTHROPIC_API_KEY=…` turns the coach from the offline stub
into live Claude feedback (the SDK is picked up from `node_modules/` or
`web/node_modules/` if present — `npm install` at the root fetches it).
Without a key, or on any API failure, the offline coach keeps the demo moving.

### Chain mode

The backend runs on the JS mirror of the contract by default (`ledger.js`),
so a dead RPC endpoint can never stop the pitch. To run against the real
contract:

```bash
cd contracts && npm install                                   # once
cd contracts && CHOKIDAR_USEPOLLING=1 npx hardhat node       # terminal 1
cd contracts && npx hardhat run scripts/deploy.js --network localhost   # terminal 2 → shared/deployment.json
LEDGER=chain node server/server.js                            # terminal 3
```

`./reset-demo.sh` restarts the chain, redeploys and restarts the service.
State is in memory; restarting the service clears every learner, balance and
wallet.

## Tests

```bash
npm test                          # 27 ledger + 24 end-to-end, under 10 s, no toolchain
cd contracts && npx hardhat test  # 22 Solidity tests (needs the network once, for npm install)
```

**Ledger, 27 tests.** Unauthorised award; the ABI has no amount to pass;
duplicate completion; version bump; lifetime cap as a ceiling rather than a
round count; short balance; empty stock; inactive item; double-swap of one
balance; settle-once; the redeemer key refused at settle; cancel restoring
credits and stock exactly; expiry, sweeping, and the clock extending; pause
blocking earning while still allowing refunds; and conservation — awarded
equals outstanding plus in-swap plus swapped plus expired.

**End to end, 24 tests.** The coach filter stripping `pass` and `credits`; a
tampered submission awarding nothing; grading and the review queue; the
verifier awarding the configured amount and ignoring an amount in the request;
every catalog product closed loop and an open-loop one refused; a swap
delivering a card the learner's key opens and a stranger's key does not; the
card being real at the provider's balance endpoint; a provider error refunding;
a ghosted order recovered rather than re-ordered; pause; and no card number,
pin, or name anywhere in the logs or events.

## Where things live

```
contracts/contracts/LanguageCredits.sol   missions, catalog, swaps — non-transferable, no transfer/approve/permit
contracts/test/LanguageCredits.test.js    the Solidity suite (asserts the ABI stays that way)
contracts/scripts/deploy.js               deploy + roles + missions + catalog → shared/deployment.json
server/
  server.js        API + hosts the three clients
  ledger.js        the contract's rules mirrored in JS; memory | chain
  swap.js          burn → order → seal → settle, and the refund path
  bhn-client.js    provider client: certificate-style auth, idempotency, timeout recovery
  bhn-mock.js      provider stand-in, with the failure modes (error / timeout / ghost)
  sealing.js       ECDH + HKDF + AES-GCM to the learner's key
  assessment.js    three missions, fixed grading, the filtered coach
  catalog.js       closed-loop products; open-loop cannot be listed
  store.js         off-chain state, with a PII refusal check
  ids.js           bytes32 helpers, random handles
public/learner · public/admin · public/verifier
test/ledger.test.js · test/e2e.test.js
(the earlier Next.js prototype in web/ is superseded and not committed)
```

## The loop, and where the coach is not allowed to stand

1. Open the app. A device keypair is generated in the browser and never leaves it.
2. Practise three phrasings (library, pharmacy, or school office).
3. The coach rewrites them naturally and explains why — in the learner's language.
   Its output passes an allowlist of four fields; the offline coach deliberately
   returns `pass: true` and `credits: 999999` so a test can prove the filter strips them.
4. Fixed multiple-choice and required-phrase checks decide pass or fail.
5. A pass awards the mission's configured 100 credits. A near miss goes to the verifier console.
6. Open the shop: Tim Hortons, Save-On-Foods, TransLink, a local café — each with a credit price and live stock.
7. Tap swap. Credits burn, stock decrements, the swap opens as *Requested*.
8. The service orders the product using the swap's own hash as the idempotency key.
9. The card comes back, is sealed to the learner's public key, and the swap settles with a commitment.
10. The card appears in the wallet, masked. Reveal opens it on that device only; every reveal is counted.

## The contract

```solidity
function awardCredits(bytes32 learnerHash, bytes32 missionId, bytes32 proofHash)   // no amount parameter
function configureMission(bytes32 missionId, uint128 reward, uint32 version, bool active)
function configureCatalogItem(bytes32 itemId, bytes32 productCode, uint128 cost, uint64 inventory, bool active)
function requestSwap(bytes32 learnerHash, bytes32 itemId, bytes32 requestHash)
function settleSwap(uint256 swapId, bytes32 voucherCommitment)
function cancelSwap(uint256 swapId, bytes32 reason)        // allowed while paused
function sweepExpired(bytes32 learnerHash)                  // permissionless
function pause() / unpause()
```

| Role | Held by | Can do |
|---|---|---|
| `ADMIN_ROLE` | programme multisig (one key in the demo) | configure missions and catalog, pause, grant roles, cancel a swap |
| `VERIFIER_ROLE` | verification service | award the configured amount for a passed mission — nothing else |
| `REDEEMER_ROLE` | swap service, open | burn credits and open a swap |
| `FULFILLER_ROLE` | swap service, settle | settle once the provider confirms, or cancel and refund |

| Constant | Value | Bounds |
|---|---|---|
| `MAX_MISSION_REWARD` | 2,000 credits · CAD 100 | what one bad award can cost |
| `LIFETIME_CAP` | 15,000 credits · CAD 750 | a farmed handle |
| `CREDIT_TTL` | 365 days from last award | standing liability and resale incentive |

100 credits = CAD 5.00, fixed by the catalog. There is no market, no price, and nothing to speculate on.

## Demo it, don't describe it

In the admin console, arm **ghost** and run a swap in the learner app. The
provider issues the card and drops the response; the client times out, asks
the provider about that request id, finds the order, and delivers the one card
that exists. The admin log shows one order, one settlement, one unit of stock.
Arm **error** or **timeout** instead and watch the refund land.

## Why it can't become cash

- Send to another learner — **no transfer function exists**
- List on an exchange — **nothing to list**
- Swap for an open-loop Visa card — **the catalog refuses to list one** (`assertClosedLoop`, tested)
- Cash out through the programme — **no fiat rail is built**
- Reveal a card and sell the code — *made awkward and traceable, not impossible*: never e-mailed, sealed to the device, every reveal counted

## Limits, stated before a judge finds them

- The provider is a mock. No real card is issued and no real card number is handled anywhere in this build.
- One verifier key. The mission registry is what makes that survivable, not acceptable.
- The demo operator holds every role and submits every transaction.
- Expiry is per account, not per lot.
- State is in memory. Restarting the server clears every learner, balance and wallet.
- No partnership with the City of Vancouver, any library, settlement organisation, brand or provider is claimed.
- The chain cannot verify that learning happened. It makes the verifiers and criteria traceable.
