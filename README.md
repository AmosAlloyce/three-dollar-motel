# Three Dollar Motel

A shared browser lounge for the Three Dollar Motel (TDM) coin, deployed at
https://three-dollar-motel.duckdns.org. HTTPS and multiplayer testing are complete.
The live token is at
https://pump.fun/coin/oQxvSg52N4E1yP5eDC2kKHKiu6EosXLkjHzAzxupump.

Guests choose a nickname and colour, walk around the lounge and pool, sit, chat
and send reactions. One Node server shares actual guest activity using HTTP and
Server-Sent Events (SSE). It has no third-party runtime dependencies or paid APIs.

The interface uses a neon motel redesign with a daily poolside question and an invite-link button.
Answering a question prepares a chat draft; guests submit it themselves. The
question rotates through 14 prompts by UTC day using the browser clock. These
features add no runtime dependency or server endpoint.

See [TOKEN-DESIGN.md](TOKEN-DESIGN.md) for the project's utility and safety notes.

## Open it locally

Use Node.js **22.13 or newer**. From this folder:

```sh
cp .env.example .env
npm start
```

Open **http://127.0.0.1:3000**. To try two guests, open a second browser or private
window: tabs in the same browser share a guest session. Keep the server running
while you use the hotel. `npm run dev` restarts it when server files change;
`npm test` runs the automated server tests. No `npm install` is needed.

Do not open `index.html` directly or use a static file server: live check-in and
chat need `server.mjs`. The earlier visual concept is saved as `concept.html`.

## Settings and hosting the room

Edit `.env`, then restart the server. Keep `.env` private; the provided Git and
Docker exclusions keep it out of source commits and images.

| Setting | Purpose |
| --- | --- |
| `HOST`, `PORT` | The example listens only on `127.0.0.1:3000`. Without `.env`, the server defaults to `0.0.0.0:3000`. |
| `MAX_PLAYERS` | Room limit, initially `20`. This is a configured cap, not a production capacity claim. |
| `MOTEL_DATA_DIR` | Directory for saved browser passports. `npm start` defaults to `./data`; Compose sets `/app/data` on a named volume. |
| `PUBLIC_ORIGIN` | Blank locally; set the exact HTTPS origin in production, without a trailing slash. It controls allowed browser origins and secure cookies. |
| `ADMIN_KEY` | A long random secret that enables host controls. Blank disables them. |
| `MOTEL_NAME` | Name returned by the configuration API; artwork uses the confirmed Three Dollar Motel brand. |
| `COIN_MINT`, `COIN_TICKER` | Set the verified Solana mint and ticker in the private `.env`; a syntactically valid mint enables its Pump.fun purchase link, but the app does not independently verify that the token exists. |
| `BAN_BY_IP` | Keep `false` behind a reverse proxy. See the limits below. |
| `MOTEL_DOMAIN` | Public hostname used by the Docker deployment, without a scheme or path. |

Generate a host key locally, then paste the result into `ADMIN_KEY` in `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Check in as a guest, open **Host controls**, and enter that key. Select a guest to
mute their chat for five minutes, restore it, kick them, or ban their session for
30 minutes. Ordinary guests can also hide someone else's messages on their own
screen. Do not put the host key in public chat or a URL.

The room, host sessions, rate limits and bans live in memory and reset on server
restart. Chat is not saved. Browser passports use a separate persistent database. Bans are temporary
and, by default, a new browser session can bypass them. Node intentionally ignores
forwarding headers: behind Caddy all guests share the proxy address for IP rate
limits. Enabling IP bans there would block other guests too. Keep one server
instance; multiple instances would create separate rooms.

## Room 003 pilot

Find three clues at reception, the lounge and the pool, then enter the door code.
The clue buttons walk your avatar over and inspect automatically; numbered pins
in the room do the same. Solving the mystery awards one **Founding sleuth** stamp
and **three demo credits**, once per browser passport. A 60-second pool party
costs all three credits and appears for everyone, including guests who join midway.
Another guest cannot start a second party or lose credits while one is active.

These are free play credits with no cash value, cash-out, token conversion or
promised airdrop. They are not $TDM. There is one mystery in this pilot; finishing
it does not create repeatable earnings or a daily reward.

Progress is saved on the server and linked to a private browser cookie lasting
one year. It survives checkout, refreshes and server restarts. Clearing site data,
using a different browser, or expiry of that cookie loses access to the passport;
there is no account or recovery service. The database stores hashed identifiers,
clues, stamps and credits, plus the last party host's display name and end time.
The demo does not prevent one person starting over with another browser.

The app uses [Node's built-in SQLite module](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html),
with no additional package or database service. Node 22 labels that module experimental.
Writes commit before rewards are reported. The store limits itself to 100,000
passports, then refuses new passports without removing existing progress.

## Prepare one Oracle VM

The current deployment uses an Oracle Ubuntu 24.04 ARM VM with about 6 GB RAM.
The steps below reproduce the setup. Keep total resources within the tenancy's
confirmed free allowance.

1. Install Docker Engine and the Compose plugin for the VM's OS, using
   [Docker's installation instructions](https://docs.docker.com/engine/install/).
   The image uses the official Node 22 Debian slim base with no architecture
   override, so the local build selects the VM's supported architecture.
   [Node image documentation](https://github.com/nodejs/docker-node)
2. Copy this project to the VM. Create a fresh private `.env` there. Set a random
   `ADMIN_KEY`, `MOTEL_DOMAIN` to a domain or free subdomain you control, and
   `PUBLIC_ORIGIN` to `https://` followed by that hostname. Keep `COIN_MINT` blank
   during testing. Protect the file with `chmod 600 .env`.
3. Point the hostname's DNS record to the VM's public IP. Allow inbound TCP 80 and
   443 in the Oracle network rules and VM firewall; retain your SSH access. Do not
   open port 3000. Caddy obtains and renews HTTPS certificates when DNS and network
   access are ready. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https)
4. From the project root on the VM:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml config --quiet
   docker compose --env-file .env -f deploy/compose.yaml up -d --build
   ```

Only Caddy exposes public ports. The hotel listens on Docker's private network;
Compose sets its HTTPS origin from `MOTEL_DOMAIN` and forces IP bans off. Caddy's
certificate data and saved passports survive container recreation in named Docker volumes. Do not
delete those volumes during routine updates.
[Docker volume lifecycle](https://docs.docker.com/engine/storage/volumes/)

The proxy preserves the long-lived `/api/events` response. Caddy automatically
flushes `text/event-stream` without buffering; the supplied config leaves stream
lifetime unlimited and response read/write timeouts disabled. The application
sends heartbeats every ten seconds. Avoid adding a cache or proxy with a short
stream timeout. [Caddy streaming and transport settings](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

Before inviting anyone, open the HTTPS URL in two independent browser sessions
and verify movement, chat, reconnection and host removal. Check `/healthz` returns
`ok: true`. Test with the intended number of guests on the actual VM before
announcing capacity. Logs are available with:

```sh
docker compose --env-file .env -f deploy/compose.yaml logs --tail=100
```

After changing code or `.env`, repeat `up -d --build`; guests will need to check in
again if the hotel restarts; their passport remains saved. Back up source, private
settings, Caddy data and the `motel_data` volume. Never use `down -v` for an update.
For a consistent passport backup with a short maintenance interruption, run on the VM:

```sh
mkdir -p backups
chmod 700 backups
docker compose --env-file .env -f deploy/compose.yaml stop motel
docker compose --env-file .env -f deploy/compose.yaml cp motel:/app/data/. backups/passport-data
docker compose --env-file .env -f deploy/compose.yaml start motel
```

Use a fresh backup directory for each snapshot, retain all SQLite files together,
and protect backups like private settings. Restore into `/app/data` only while
the motel is stopped, with files owned by container user `node` (UID 1000).
[Compose copy command](https://docs.docker.com/reference/cli/docker/compose/cp/)

## Coin and public launch

The app does not create a coin, custody funds, connect a wallet, verify holder
balances or grant holder badges. Purchase links remain disabled while `COIN_MINT`
is blank or malformed. An address passing the format check is not verification.

The current deployment has the verified TDM mint configured. For another
deployment, independently verify the mint and corresponding Pump.fun page, set
`COIN_MINT` and `COIN_TICKER`, and restart the app. Confirm the displayed address
and destination before sharing the coin and lounge together. This configuration
assumes Pump.fun; another platform would require changing the purchase URL.

The name Three Dollar Motel, ticker $TDM, token artwork and the DuckDNS URL are
confirmed. Approved artwork is saved at `assets/branding/tdm-token-v1.png`.
The token is now live at
https://pump.fun/coin/oQxvSg52N4E1yP5eDC2kKHKiu6EosXLkjHzAzxupump, and the verified
mint is configured in the deployed motel. Private launch planning notes stay
outside the public repository.

## Optional browser checks

`npm run test:browser` checks the actual interface in two isolated Chromium browser
sessions, including a phone viewport. It covers joining, chat, movement, swimming,
seating, local mute, host moderation, reconnection and inactive coin links. It starts
its own temporary local server and closes it afterwards. Screenshots are saved to
`/tmp/motel-browser/artifacts` by default (`BROWSER_ARTIFACTS` overrides this).

This extra test needs Playwright and its Chromium browser; those are development
tools, not app dependencies. If installed in this project, run:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

To use Playwright installed elsewhere, set `PLAYWRIGHT_MODULE` to its absolute
`index.mjs` path. A separate browser-cache location can be set with
`PLAYWRIGHT_BROWSERS_PATH`.
