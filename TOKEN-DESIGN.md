# Three Dollar Motel: crypto activity concepts

Updated 13 September 2026. These are proposed mechanics in response to the owner's
request for more creative uses of $TDM. A free Room 003 pilot now implements three
clues, a saved passport stamp and a shared party purchased with demo credits.
No real token utility is implemented, funded or approved as token metadata.
The owner is starting with no audience.
The broader idea space does not authorize spending or token creation.

## Recommended direction: guests make the motel change

The shared place gives token actions a visible social result. A possible loop is:

Visit free -> join an activity -> earn recognition or an approved contribution reward
-> use $TDM for a desirable cosmetic or shared experience -> other guests see it
-> return for another event or make something of their own.

This is a hypothesis about engagement and usefulness. It does not guarantee buyers,
liquidity, higher prices, or project income. Reward recipients may sell; a free
lounge can be popular without producing demand for its token.

## Candidate mechanics

| Idea | Guest experience | Role of crypto | First implementation |
| --- | --- | --- | --- |
| Room 003 Mystery | A cooperative story reveals new clues at each hosted session; guests compare clues and earn completion stamps. | $TDM buys optional dated souvenirs, commissions a guest author, or sponsors the next completed episode. Core puzzles remain free. | One short manually hosted mystery and a persistent completion record. |
| Pool Party Button | A guest activates a time-limited pool/lighting theme and everyone present enjoys it. | Spend $TDM on the shared effect; publicly recognize the sponsor with consent. | A few curated canvas palettes and an effect timer. Apply cooldowns so effects cannot overwhelm the room. |
| Motel Passport | A keycard gains stamps for attending different hosted sessions, helping a newcomer, or making a selected contribution. | Optional wallet-bound collectible; earned reputation remains separate from transferable $TDM. | Persistent server profile and reviewed stamps; wallet verification can follow. No token payouts for merely leaving a tab open. |
| Guest Maker Market | Guests design small approved hats, emotes, or motel posters and sell them to other guests. | Purchases use $TDM, with a disclosed creator/project split. | Start with a handful of moderated assets and explicit creator permission. No arbitrary uploaded code. |
| Renovation Board | Guests choose from finished seasonal themes; a community challenge reveals the winning change. | $TDM can sponsor a completed cosmetic upgrade. Participation reputation can inform voting. | One room with two prebuilt themes; no promised future building funded by an unfinished donation target. One wallet does not prove one person. |
| Room Three Takeover | An approved guest creator or small community hosts a scheduled themed session with a temporary sign, artwork, and activity. | Later, $TDM can book an actual hosting slot or purchase a themed keepsake. | First pilot is free with the owner moderating. Invitations share the actual event, not a trading referral scheme. |
| Motel Bounties | A posted task pays for a useful deliverable: an approved meme, original accessory, reproducible bug report, or hosted activity. | A finite, already funded $TDM reward pool pays reviewed contributions. | Publish budget, criteria and approver before accepting work. No promised rewards until funds actually exist. |

The passport and temporary themes can work without blockchain. Crypto's additional
role would be wallet-held collectibles, verifiable transfers and creator payments;
it does not itself make the underlying activity desirable. NFT ownership would not
mean ownership of motel property or an unconditional right to operate its servers.

## Keep activity and the economy connected

A payout for every message, login, trade, or invited wallet can be farmed. Instead,
start with a small number of human-reviewed contributions. Cap claims, check for
repeat identities where practical, and record awards. Wallet signatures prove key
control, not that the signer is a unique human.

A usable reward budget must have a real source: tokens already held for this purpose,
actual operating receipts, or explicit sponsor funds. If Pump.fun is eventually
chosen and the project actually receives creator fees, a separately approved capped
part could contribute to rewards after costs. Its current fee table describes creator
fees, but receipt depends on trading, pool and configuration. No trading means this
source can be zero. Do not ask guests to trade to manufacture reward funding.
[Pump.fun fee documentation](https://pump.fun/docs/fees)

Token payments to the project are not automatically realized cash revenue. Track
actual balances, expenses and any conversions. A burn destroys spendable tokens;
it does not pay operating costs or guarantee higher prices. There is no proposed
passive yield, cash return for holding, or redistribution promise in these concepts.

## Technical separation

Keep movement, chat, prompt participation and routine theme rendering off-chain.
Verify actual payments before granting purchases; make fulfillment idempotent so
one payment cannot be replayed to obtain multiple rewards. Wallet sign-in, a payment
transaction and a token balance check are different operations.

The pilot persists browser passport progress and demo-credit spending in SQLite.
Actual purchases and token rewards still need their own verified payment records;
the pilot is not a real-token payment system.
Measure VM load and RPC quotas before claiming production capacity. Start with
curated art, no video streams, and no custom financial contract for the first pilot.

Solana supports non-transferable tokens, but extensions and compatibility must be
chosen deliberately. We cannot assume that a launchpad-created $TDM can later gain
arbitrary extensions. A separate credential can hold earned progress while $TDM
remains transferable.
[Solana token extensions](https://solana.com/docs/tokens/extensions)

There is precedent for wearable/emote rewards in virtual spaces: Decentraland's
creator tools describe quest rewards and presence/anti-automation checks. That
supports technical feasibility of the pattern, not market success for our motel.
[Decentraland rewards documentation](https://docs.decentraland.org/creator/rewards/overview)

## Prototype before money

The smallest useful test combines one Room 003 mystery, a passport and a shared
pool-party effect. The story gives people something to do, the passport records
their contribution, and the effect provides a concrete optional purchase.
Use clearly labeled test credits with no cash value, no cash-out and no promised
conversion or airdrop. Give them through hosted activities and observe whether
people choose to spend them, enjoy other guests' effects, and return. This tests
an interaction, not real willingness to pay.

The first prototype is implemented: one self-guided three-clue mystery awards one
stamp and three demo credits per browser passport, enough for a 60-second shared
party. Progress survives restarts, but clearing cookies loses access. There are no
accounts, transferable stamps or repeatable credit rewards. Observe this free pilot
before considering wallet design, pricing, real funding or token-launch compatibility.
The wider maker market, sponsored gatherings and guest-managed rooms are ideas for
later evaluation, not a committed expansion roadmap.

Wallet sign-in can prove address control with a message signature without a network
transaction. Use server verification, domain binding, a nonce and expiry; a wallet
is not a unique human. [Phantom Sign-In with Solana](https://github.com/phantom/sign-in-with-solana)
