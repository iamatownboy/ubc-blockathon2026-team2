# LanguageToken — Blockathon for Social Good 2026

[![tests](https://github.com/iamatownboy/ubc-blockathon2026-team2/actions/workflows/ci.yml/badge.svg)](https://github.com/iamatownboy/ubc-blockathon2026-team2/actions/workflows/ci.yml)

> **Learn local. Earn local. Belong local.**

Newcomers practise three-minute, real-world English missions and earn
non-transferable credits, which they swap for gift cards from businesses in
their own neighbourhood — a Tim Hortons card for 100 credits, delivered into
their app and sealed to their device. The coach never decides who gets paid,
the on-chain ledger holds no direct identifiers, and the credits cannot become
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
| Learner app | http://localhost:8787/learner/ | 430px. No account, no e-mail, no wallet software, no gas. A partner-issued participation code (demo: `WELCOME-01` … `WELCOME-12`, printed at startup) opens the session; the device generates its own ECDH keypair (`extractable: false`) in IndexedDB to receive cards. EN / 한국어 / 中文. |
| Verifier console | http://localhost:8787/verifier/ | The review queue. Approving awards the mission's configured amount — there is **no field to type an amount into**. Token: `verifier-demo` |
| Admin console | http://localhost:8787/admin/ | Missions, catalog, pause, live ledger events, service log — and the provider failure switches. Token: `admin-demo` |
| Demo stage | http://localhost:8787/demo/ | For a judging laptop: the learner phone at full size with the live ledger, catalog stock and the conservation check beside it. Reads only the two token-free endpoints, so the projected screen carries no admin secret. |
| Public stats | http://localhost:8787/api/stats | Readable by anyone, no login. Aggregate only. |

Requires Node ≥ 20 (`. ~/.nvm/nvm.sh` on this machine).

Optional: `COACH=live ANTHROPIC_API_KEY=…` makes live coaching available
(the learner must still explicitly consent before their practice text leaves
the service). The SDK is picked up from `node_modules/` or
`web/node_modules/` if present — `npm install` at the root fetches it.
Without a key, or on any API failure, the offline coach keeps the demo moving.

### Who is allowed to earn

The lifetime cap has to bound a *person*, not a browser. Newcomers often have
no stable phone, e-mail or ID, so the programme uses the boundary the partners
already have: a library, settlement agency or school hands out a printed
participation code.

The server stores no code — only an HMAC of it — and derives the learner
handle from that same HMAC. Three consequences follow, and all three are
tested:

* an unissued code cannot open a session at all;
* clearing the browser and retyping the code restores the same learner —
  same balance, same completed missions, same lifetime cap, so "forget this
  device" is no longer a way to farm a second gift card;
* the service still holds no name, no e-mail and no phone number. The link
  between a code and a human lives on paper, at the partner desk.

`ENROLLMENT_CODES` supplies the real list (comma separated). Demo codes exist
only when `NODE_ENV` is not `production`; production with no code list refuses
to start. `ENROLLMENT=open` disables the check and is an explicit, logged
opt-out that reduces the cap to per-device — it is not a mode to demo in.

A code is the only thing between a stranger and a gift card, so two things
guard it. `npm run codes 200` prints codes with real entropy — 8 characters
from a 32-letter alphabet with `O/0/I/1` removed, 40 bits, grouped so a
volunteer can read one aloud. And wrong codes are counted: eight per address
per ten minutes, then `429` with a `retry-after`, so guessing is not a loop.
A correct code clears the count, so a learner who mistypes twice is not
punished. Neither the address nor the attempted code is ever stored — the log
records only how many tries have been used.

The limiter is in-process. Behind several instances it needs a shared counter,
and it trusts `X-Forwarded-For` only when `TRUST_PROXY=1` says a proxy sets it
— otherwise anyone could reset their own counter with a header.

### Who can use it

The learner app is the whole product for someone who may be new to the
language, the city, and the phone in their hand. So:

* the document declares the language it is actually in, and changes it when
  the learner does — without that, a screen reader announces 한국어 and 中文 in
  an English voice;
* status and errors are announced, not only coloured (`aria-live`, assertive
  for errors);
* changing screen moves focus, so the new screen is read out rather than
  silently replacing the old one; re-rendering the same screen does not steal
  focus from the control you are using;
* text scales with the reader's own browser setting (`1rem`, never a fixed
  pixel size), animation respects `prefers-reduced-motion`, and the bottom
  navigation meets a 48px tap target;
* the emoji are marked decorative, and the current tab is marked `aria-current`.

Test 12c3 pins all of it. Right-to-left is wired (`dir` follows the language)
but no RTL language is translated yet — that is a strings file, not a rewrite.

### Chain mode

With no `LEDGER` set, the service runs on the contract when
`shared/deployment.json` exists and falls back to the JS mirror (`ledger.js`)
only when the chain is genuinely absent or unreachable — so the final demo is
on chain by default and a dead RPC endpoint still cannot stop the pitch.
**Which one is running is shown as a badge on every screen** (`On-chain` /
`Demo mirror`), so a mirror run is never presented as an on-chain one.
`LEDGER=chain` makes a chain failure a hard failure; `LEDGER=memory` forces
the mirror. To run against the real contract:

```bash
cd contracts && npm install                                   # once
cd contracts && CHOKIDAR_USEPOLLING=1 npx hardhat node       # terminal 1
cd contracts && npx hardhat run scripts/deploy.js --network localhost   # terminal 2 → shared/deployment.json
LEDGER=chain node server/server.js                            # terminal 3
```

`./reset-demo.sh` restarts the chain, redeploys and restarts the service.
The default memory-ledger demo is intentionally ephemeral. In chain mode,
pseudonymous device public keys and sealed swap records are written atomically
to `.data/state.json`; startup reconciliation looks up a pending provider
request instead of ordering a second card.

For anything beyond a local demo, set strong secrets rather than using the
published demo values:

```bash
NODE_ENV=production \
IDENTITY_SECRET='at-least-32-random-bytes' \
ADMIN_TOKEN='a-long-random-token' \
VERIFIER_TOKEN='a-different-long-random-token' \
LEDGER=chain node server/server.js
```

Production mode refuses to start with the demo identity secret or demo role
tokens. Real provider use also requires provider onboarding, programme/catalog
approval and the provider's actual authentication setup; it is not only a URL
change.

## Tests

```bash
npm test                          # 28 ledger + 41 end-to-end + 1 parity, under 10 s, no toolchain
npm run test:parity               # the parity suite alone (needs a running chain)
cd contracts && npx hardhat test  # 23 Solidity tests (needs the network once, for npm install)
cd contracts && SOLC_JS=1 npx hardhat test   # same 23, offline: uses the solcjs in node_modules
```

`SOLC_JS=1` is the escape hatch for a laptop that cannot download a compiler
or write into the checkout; it compiles with the bundled solcjs and puts build
output in `/tmp`. All 23 pass either way.

**Ledger, 28 tests.** Unauthorised award; the ABI has no amount to pass;
duplicate completion; version bump; lifetime cap as a ceiling rather than a
round count; short balance; empty stock; inactive item; double-swap of one
balance; settle-once; the redeemer key refused at settle; cancel restoring
credits and stock exactly; expiry, sweeping, and the clock extending; pause
blocking earning while still allowing refunds; and conservation — awarded
equals outstanding plus in-swap plus swapped plus expired.

**Parity, 1 test — the one that keeps the two implementations honest.** The
contract and the JavaScript mirror are two implementations of the same rules,
and two implementations drift. `test/parity.test.js` drives one identical
script — award, duplicate, swap, settle, short balance, cancel, spend the
refund, wrong key — through both and compares the whole transcript step by
step: balance, lifetime total, stock, swap status, the five conservation
totals and the revert name. It skips (loudly, with the reason) when no chain
is running, so `npm test` still works on a bare laptop.

It earned itself immediately. `ChainLedger` wraps each role key in an ethers
`NonceManager`, which counts optimistically — so an *expected* revert (a
learner repeating a mission, a swap short of credits) burned a local nonce and
every later call from that key failed with "Nonce too high". One duplicate
submission would have stopped the verifier key awarding anything for the rest
of an on-chain demo. Fixed, and the parity run now passes against a live
Hardhat chain.

**End to end, 41 tests.** A session refused without a partner-issued code and
a wiped browser landing back on the same handle, balance and lifetime cap; the
code never appearing in the store; the coach filter stripping `pass` and `credits`; a
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
  store.js         minimal off-chain state, review TTL, atomic sealed-swap persistence
  enrollment.js    partner-issued participation codes → one stable handle per person
  ratelimit.js     a sliding window per address, so codes cannot be guessed in a loop
  ids.js           bytes32 helpers, random handles
public/learner · public/admin · public/verifier · public/demo (the stage)
test/ledger.test.js · test/e2e.test.js · test/parity.test.js
scripts/make-codes.js                     high-entropy participation codes for a real desk
make-submission.sh                        git archive → a clean source-only bundle
.github/workflows/ci.yml                  every push runs both suites on Node 20 and 22
(the earlier Next.js prototype in web/ is superseded and not committed)
```

## The loop, and where the coach is not allowed to stand

1. Open the app and enter the participation code from the partner desk. A device keypair is generated in the browser and never leaves it; the code — not the browser — is what fixes the learner's handle, balance and lifetime cap.
2. Practise three phrasings (library, pharmacy, or school office).
3. The coach rewrites them naturally and explains why — in the learner's language.
   Its output passes an allowlist of four fields; the offline coach deliberately
   returns `pass: true` and `credits: 999999` so a test can prove the filter strips them.
4. Fixed multiple-choice and required-phrase checks decide pass or fail. A canonical proof-v2 hash commits to both answers and learner-written attempts without putting either on chain.
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
| `REFUND_GRACE_PERIOD` | 30 days | an exact late refund remains usable instead of returning into an expired account |

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
- In memory-ledger mode, balances are intentionally ephemeral. Chain mode persists only device public keys and sealed swap state; session tokens and learner-written review text are not written to disk.
- Passed and failed submissions retain structured audit results, not learner-written text. A near miss keeps its text for verifier review for at most 24 hours and deletes it immediately after a decision. Pattern checks reduce obvious PII, but free-text detection is not a guarantee.
- The person-level cap is only as good as the partner's code hygiene: someone handed two codes is two learners to this service. Distribution controls (one code per person at the desk, codes voided when reissued) are a programme responsibility this build cannot enforce, and a funded pilot should add per-code issuance records on the partner side.
- Cards are sealed to the device key that last used the code. Retyping the code on a new device restores the balance but not cards sealed to the old key — stated in the wallet screen, not hidden.
- The rate limiter lives in one process's memory. It is the right shape and the wrong scale for more than one instance.
- The `admin-demo` / `verifier-demo` tokens are published here and in the consoles, which flag themselves in red while either is in use. They are fine on a laptop and nowhere else; production refuses to start with them.
- The working checkout carries roughly a gigabyte of dependencies and build output. None of it is tracked — `./make-submission.sh` exports the tracked source and lockfiles only (about 1.8 MB, 55 files) so a reviewer installs dependencies themselves.
- No partnership with the City of Vancouver, any library, settlement organisation, brand or provider is claimed.
- The chain cannot verify that learning happened. It makes the verifiers and criteria traceable.
