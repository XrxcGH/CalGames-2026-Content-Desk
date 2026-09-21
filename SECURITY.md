# Security

This is not boilerplate. This software holds credentials that can publish
video as an organisation, and it connects to a network that runs a live FRC
field. Both of those deserve a real answer to "where do I report a problem".

## Reporting

Report privately, not in a public issue:

- **GitHub**: open a [security advisory](https://github.com/XrxcGH/cg2026-content-desk/security/advisories/new)
  on this repository.
- Or contact WRRF directly through <https://wrrf.org>.

Please include what you found, how to reproduce it, and what an attacker gets.
You will get an acknowledgement; this is a volunteer project, so please allow a
few days, and more during competition season.

If a report concerns the field bridge, say so in the first line. That is the
one class of issue that can affect a live event rather than a laptop.

## What matters most here

In rough order of how much damage a flaw would do:

1. **Anything that lets this software affect the field.** The Cheesy Arena
   bridge is receive-only, GET-only, and restricted to a hard endpoint
   allowlist enforced by a failing test; nothing of ours runs on the FMS
   machine. The threat model and the FTA sign-off sheet are in
   [docs/10-field-bridge.md](docs/10-field-bridge.md). A way to make the desk
   send anything to `/match_play/*`, `/panels/scoring/*`, `/panels/referee/*`
   or `/setup/*` is the highest-severity bug this project can have.
2. **Credential disclosure.** `config.json` holds a YouTube refresh token, The
   Blue Alliance Trusted API secret, a start.gg token, and (optionally) a
   Spotify refresh token; `data/spotify-token.json` holds a rotated one. All
   are gitignored. `redacted()` in `apps/core/src/config.ts` exists so the
   config can reach a browser surface without the secrets; a path that leaks
   one of those values is a real vulnerability.
3. **Pre-ceremony award winners.** The Judge Advisor stages each award's
   winner hours before it is announced, and `data/awards-staged.json` is the
   one file on disk holding a secret the architecture exists to keep. The
   winner is deliberately held out of the event bus until the reveal press,
   because every open surface reads the bus fan-out. Anything that puts a
   winner into `/api/state`, a websocket frame, a preview render, a log line,
   an event log, or the desk console before that press is a real
   vulnerability, and so is any path that reads `/api/awards` with a winner
   attached without a Judge Advisor session. See `apps/core/src/awards.ts`.
4. **Control-surface access.** There are **three** codes, not one, resolved in
   `apps/core/src/server.ts` and enforced by the allowlist in
   `apps/core/src/access.ts`, which runs in both directions: anything not
   explicitly opened is closed.
   - The **desk PIN** (`REMOTE_PIN`) covers the operator consoles and every
     mutating endpoint.
   - The **awards code** (`awards.pin`, or `JA_PIN`) is the Judge Advisor's,
     and the desk PIN alone cannot reach a winner: not to read one, not to
     type one, not to put one on screen.
   - The **settings code** (`setup.pin`, or `SETUP_PIN`) is the content
     lead's, and covers `/s/setup`.

   `/s/awards` and `/s/setup` are in `OPEN_SURFACES` on purpose, because
   neither the JA nor the content lead holds the desk PIN. Only the page
   shell is open; every read and write behind it requires that tier's own
   session cookie. A way to reach a gated endpoint without its code, to cross
   from one tier's session into another's, or to read an unrevealed trivia
   answer, belongs here rather than in a public issue.
5. **Audience data.** Crowd trivia collects display names typed by people in
   the stands, held in memory only. Anything that persists or exposes more
   than that is worth reporting.

## What is out of scope

- All three codes are short, shared, and printed for volunteers. That is a
  deliberate trade for a system run by people who arrive on the day; "a
  four-digit code can be brute-forced given unlimited attempts" is answered by
  the rate damper in `server.ts`, which keeps a separate lockout counter per
  door and per address, so a correct desk PIN does not buy fresh guesses at
  the awards code. "A volunteer told someone the PIN" is not a software bug.
- The desk trusts the venue LAN it is on. It is not designed to be exposed to
  the internet, and [docs/13](docs/13-deployment.md) says so.
- Denial of service against your own desk from your own network.

## Supported versions

This tracks one event at a time. Fixes land on `main`; there are no
long-lived release branches. If you are running a fork at your own event, pull
`main` before the event and freeze, which is what
[docs/09](docs/09-roadmap-and-risks.md) tells our own crew to do.
