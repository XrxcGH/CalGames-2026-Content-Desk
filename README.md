# CalGames 2026 Content Desk

An in-house analysis / broadcast content desk for **CalGames 2026** at Woodside High School,
**October 16-18, 2026**, presented by the Western Region Robotics Forum (WRRF).

The goal is a broadcast layer for CalGames that behaves like a real sports desk. Instant replay,
an analyst who can draw on the field, RSN-style pre-match alliance overviews with real robot
photos, live data-driven graphics, and something worth watching in the gaps. That last part is
side-tournament Smash Bros. and Mario Kart on the same overlay system, plus crowd trivia the
whole gym plays from their phones. All CalGames-branded, all runnable by volunteers.

**Running your own event?** Fork it. The code is Apache 2.0 and the whole thing is built so the
parts you would need to change are the parts that are easy to change: the palette is one token
file, the event is one config file, and a different field system is one adapter behind a seam that
already exists. It is deliberately *not* white-labelled, so a fresh clone is CalGames-branded
until you re-theme it; that was a design choice in favour of the graphics actually looking like
something. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and read
[TRADEMARKS.md](TRADEMARKS.md) first: the code is yours to change, the CalGames and WRRF names
are not.

## Run it in two minutes

You do not need a terminal, and you do not need to install anything. You need one file,
`CalGamesContentDesk.exe`, which the content desk lead builds and hands out
(how: [docs/13-deployment.md](docs/13-deployment.md)).

1. Copy the exe onto the machine. Anywhere is fine.
2. Double-click it. A window opens and prints four numbered steps as it works.
3. Wait for the yellow **READY**. The first run takes about a minute; after that, seconds.
4. The window prints an address like `http://10.0.100.23:8720/` and opens it in a browser.
   That page lists every screen, and the window shows the PIN (a four-digit door code) that
   the control screens ask for.

Just trying it out at a kitchen table, with no field to connect to? The launcher notices there
is no field and asks; press **D** and every screen plays a pretend match. After the first run
the desk lives in `Downloads\CalGames2026-ContentDesk`, and two files there run it by
double-click: **START-PRACTICE.cmd** for the pretend match, **START-DESK.cmd** for the real
thing.

Leave the launcher window open; closing it stops the desk. Pit monitors, updating, and what to
do when something goes wrong are all in [docs/13-deployment.md](docs/13-deployment.md).

The rest of this README is for people building or changing the desk.

## Design principle

> **One event bus, many surfaces.**

Every data source (Cheesy Arena, Off-Season FMS, FRC Events API, The Blue Alliance, Statbotics, a
Switch running Mario Kart, the desk operator's keyboard) is normalized into a single timestamped
event stream. Every output (broadcast overlay, telestrator, replay console, alliance overview,
venue side screens, arcade scoreboard, post-match cards) is a *subscriber* to that stream.

That's the whole architecture. Everything else is adapters and CSS.

## Repo map

| Path | What |
| --- | --- |
| [docs/01-research.md](docs/01-research.md) | How FMS, Cheesy Arena, RSN, FRC AV, and the public APIs actually work |
| [docs/02-architecture.md](docs/02-architecture.md) | System architecture, data contracts, ingest adapters |
| [docs/03-brand.md](docs/03-brand.md) | CalGames design system: WRRF palette, type, broadcast rules |
| [docs/04-replay-and-telestrator.md](docs/04-replay-and-telestrator.md) | Match replay pipeline + analyst drawing overlay |
| [docs/05-arcade.md](docs/05-arcade.md) | Smash Bros. / Mario Kart integration |
| [docs/06-hardware-and-network.md](docs/06-hardware-and-network.md) | AV rack, cameras, network segmentation, show flow |
| [docs/07-team-media.md](docs/07-team-media.md) | Robot photo library + pre-match alliance overview |
| [docs/08-motion.md](docs/08-motion.md) | Motion system + gym legibility math |
| [docs/09-roadmap-and-risks.md](docs/09-roadmap-and-risks.md) | Build phases, open decisions, risk register |
| [docs/10-field-bridge.md](docs/10-field-bridge.md) | Cheesy Arena field bridge: endpoint allowlist + FTA sign-off sheet |
| [docs/11-distribution.md](docs/11-distribution.md) | Recording, YouTube live + upload, TBA video/webcast publishing |
| [docs/12-community-research.md](docs/12-community-research.md) | What the FRC community complains about, mapped against this desk: the sourced gap list |
| [docs/13-deployment.md](docs/13-deployment.md) | The volunteer launcher: one exe that unpacks the desk, installs a private Node, finds the field, and starts everything |
| [docs/14-gap-research.md](docs/14-gap-research.md) | What it takes to run the whole event program, and to become a standard other events can adopt: the ranked, sourced roadmap |
| [packages/theme/tokens.css](packages/theme/tokens.css) | Design tokens + motion system, shared by every surface |
| [prototypes/overlay.html](prototypes/overlay.html) | Runnable proof-of-concept |

## See it without installing it

[previews/](previews/) holds a render of every screen, one PNG per page, plus
[previews/index.html](previews/index.html) as a contact sheet. They are real
renders of the real surfaces driven through the real event bus, not mockups,
so they cannot quietly drift from the code.

```powershell
npm run previews
```

Re-run that after changing anything visual. It boots a desk on a spare port,
walks it through each state, screenshots every page, and rewrites the folder.

## Look

Palette is mandated, so the character comes from **typography and geometry**: expanded **Archivo**
for display, **Chivo** for scores, **Saira Condensed** for team names, and a "field-built" form
language of chamfered plates, perforated-aluminum texture, and blueprint tick rules. Details in
[docs/03-brand.md](docs/03-brand.md).

Official **WRRF** palette, with **official FIRST** alliance colors reserved as semantic-only:

| | |
| --- | --- |
| Purple `#560F6B` | primary surface and chrome |
| Gold `#F0AF00` | primary accent |
| Green `#006549` | secondary accent |
| Black `#000000` / White `#FFFFFF` | text, and black is the luma-key background |
| Red `#ED1C24` / Blue `#0066B3` | **alliance only**, never decorative |

## Run it from the source

This is the developer path. Volunteers should use the launcher above instead.

<a id="where-commands-go"></a>
**Where these commands go.** Press the Windows key, type `powershell`, press Enter. A window
opens with a prompt line ending in `>`. Type `cd ` followed by the folder this repo is in (for
example `cd C:\Users\you\cg2026-content-desk`) and press Enter. Then paste each command below
into that window and press Enter. Every command block in this README goes into that same
window, except the one firewall rule that says otherwise.

Needs Node 22.6+ (the JavaScript runtime; uses native TypeScript type stripping, no build step)
and **ffmpeg** (a command-line video tool) for recording and replay
(`winget install Gyan.FFmpeg` and take the full build, which carries the `segment` muxer and
`minterpolate`). Everything except recording runs without ffmpeg.

```powershell
npm install
```

It prints a summary of what it added and returns to the `>` prompt. A warning or two is normal.

```powershell
npm start -- --demo
```

The window prints a banner and stays running; leave it open. Then open
<http://localhost:8720>. `--demo` runs a simulated match loop so graphics can be
built without a field. Drop it to run on desk input alone.

| Surface | URL | Runs on |
| --- | --- | --- |
| Program overlay | `/s/program` | OBS Browser Source, 1920×1080 |
| Desk console | `/s/desk` | Operator laptop, keyboard-first |
| Team media | `/s/media` | Drag-drop robot cutouts |
| Telestrator pad | `/s/draw` | iPad + Pencil, on the production Wi-Fi |
| Telestrator render | `/s/tele` | OBS Browser Source, layered over the replay |
| Replay console | `/s/replay` | Match-clock timeline, markers, cut and send |
| Arcade overlay | `/s/arcade` | OBS Browser Source: Smash sets, 4-up Kart/Pac-Man/Tetris free-for-alls, GP standings |
| Arcade console | `/s/arcadedesk` | Run the side tournament |
| Side screen | `/s/side` | Venue TVs: on-deck and rankings, room-scale type |
| Post-match cards | `/s/cards` | 1080×1080 result graphics, auto-built on score |
| Trivia overlay | `/s/trivia` | Crowd trivia: question, countdown, answer bars, leaderboard |
| Trivia play | `/s/quiz` | The audience phone page: join, answer fast, climb the board |
| Trivia host | `/s/triviadesk` | Run the crowd game: open, reveal, next |
| Talent view | `/s/talent` | Announcer tablet: teams, ranks, RP progress in words, pronunciation notes |
| When do we play? | `/s/next` | Per-team schedule on any phone, drift-adjusted start estimates |
| Head referee review | `/s/var` | Frame-step the recording. Read-only: no cut, no air, no publish |
| Pit monitor kiosk | `/s/watch` | Venue pit TVs: a full-screen browser wrapping any of the open screens (`?screen=side`, `?screen=program`, ...) |
| Phone remote | `/s/remote` | Run the show from a phone: screens, match lifecycle, marks, cue arming |
| House audio player | `/s/house` | Opens on the music machine: plays walk-ups and stingers, drives the playlist. Never in OBS, and it refuses to run there |

The index page at `/` lists every surface with a one-line description. Start there.

OBS, mentioned throughout, is the streaming program the broadcast runs in; a "Browser Source"
is OBS rendering one of these pages as a video layer.

Recording and replay need ffmpeg. Real cameras are listed under `recording.sources` in
`config.json` ([docs/11](docs/11-distribution.md)); add `--record --test-sources` to exercise
the whole pipeline without any:

```powershell
npm start -- --demo --record --test-sources
```

Program takes `?key=alpha|luma`. It contains the alliance overview, live match, final score,
analysis-desk strap, and arcade bumper in one page. Screens switch on state, so the switcher
operator never changes sources. One scale serves the stream and the venue projector; only the
side screens (`/s/side`) carry their own larger room-only type. `?mode=clean` pins the match
screen with no lower thirds or status cards, which gives you a second, quieter program for a
scouting or pit feed.

When the field stops, one desk button raises a **status card** (*Field delay*, *Score review*,
*Arena fault*, *Match replay*, with an estimated return time) on the program, the side screens,
and phones at once. Once two matches have run, the desk measures the real cycle time and shows
**drift-adjusted start estimates** everywhere a schedule appears. The side screens carry a QR
code to `/s/next` so anyone can follow their own team from their seat.

Two more screens cover the parts of the weekend that usually have no graphics at all. The
**alliance selection board** mirrors the field: captains in seed order, the pool graying out as
teams are taken, and Cheesy Arena's own pick clock. The **explainer loop** runs in the gaps and
answers what nobody ever says out loud, like what fuel is and why a losing alliance is
celebrating. Both are in the screen dropdown on the desk.

Replay a recorded event log instead of running live:

```powershell
npm run replay -- data/events/2026-10-17-09-14-02.ndjson 4
```

```powershell
npm test
```

## Connecting to the field

The Cheesy Arena bridge is a **launch flag, never a config setting**: it needs FTA sign-off, so
switching it on should be an explicit act at the point of use rather than something inherited from
a file copied between machines.

```powershell
npm start -- --cheesy --cheesy-host 10.0.100.5:8080 --display-id contentdesk1
```

Agree the display ID with the scorekeeper in advance so it can't collide with a real audience
screen. `GET /api/cheesy/audit?format=text` prints every request the bridge has made, which is what
[docs/10-field-bridge.md](docs/10-field-bridge.md) promises the FTA.

Show automation and OBS are separate flags. Cues start **disarmed** (nobody should discover
automation by having it happen to them mid-match) and are armed individually from `/api/cues`.
The OBS password comes from the environment, never a CLI argument, because `argv` is visible in
`ps` and in shell history.

```powershell
$env:OBS_PASSWORD = "..."; npm start -- --cheesy --obs --obs-host 127.0.0.1:4455
```

To rehearse without a field, build [Cheesy Arena](https://github.com/Team254/cheesy-arena), run it
with `-dev`, and drive a real scored match through it:

```powershell
node harness.mjs
```

No Cheesy Arena build either? The **fake arena** speaks the real wire protocol (the same
display websockets, `{type, data}` frames, and GET-only REST paths) and loops a scripted match:
robots linking one by one (the desk arms before the countdown), auto decided on fuel, alternating
hub shifts, endgame climbs, bonus RPs, score posting. The desk connects with the same hardened
client and allowlists it uses at the venue; nothing is stubbed.

```powershell
npm run validate:offline
```

runs the whole thing headless and prints a PASS/FAIL checkpoint table. To watch it drive the
surfaces instead, run the fake arena and a bridged core side by side:

```powershell
npm run fake-arena -- --port 8091 --speed 2
```

```powershell
npm start -- --cheesy --cheesy-host 127.0.0.1:8091 --display-id simdesk
```

## Who can drive it

Control is gated. Viewing is not.

The desk runs on the venue network, and at an event that network has a few hundred phones on
it. The trivia QR code puts the desk's address on a projector in front of the whole gym, so
"nobody will find it" was never a real answer.

| | Surfaces | Needs the PIN |
| --- | --- | --- |
| **Open** | `/s/program` `/s/side` `/s/tele` `/s/arcade` `/s/trivia` `/s/quiz` `/s/next` `/s/watch` | no |
| **Gated** | `/s/desk` `/s/replay` `/s/draw` `/s/media` `/s/arcadedesk` `/s/triviadesk` `/s/talent` `/s/var` `/s/cards` `/s/remote` | yes |

An OBS Browser Source cannot type a PIN and a spectator should not have to, so the overlays,
the venue TVs, the two audience phone pages, and the pit monitor kiosk (`/s/watch`, which only
wraps screens that are already open) stay open, along with exactly the reads they need. Joining
and answering trivia stay open too: that is the game. Everything else that *changes* something
requires the PIN, over HTTP and over the websocket alike.

The rule is an allowlist in both directions, so an endpoint added later is private until
somebody opens it deliberately. That is the safe direction for a mistake to fall.

**The gate is on by default.** Out of the box the PIN is `0864`. That default is printed in
this repo, so treat it as public and set your own before the event:

```powershell
$env:REMOTE_PIN = "4726"; npm start -- --demo
```

(The launcher takes `/pin:4726` instead, and has no way to turn the gate off at all. See
[docs/13-deployment.md](docs/13-deployment.md).)

Sign in once at `/signin` and the session lasts the day. The PIN is only ever read from a POST
body, never a query string, because a query string ends up in the server log and the browser
history of a machine several volunteers share.

For a laptop on a kitchen table in March, the escape hatch is setting the PIN to an explicit
empty string, which turns the gate off:

```powershell
$env:REMOTE_PIN = ""; npm start -- --demo
```

Never do that on a venue network. Startup says which mode it is in, and warns loudly when the
gate is off.

## Phone remote

`/s/remote` runs the show from a phone: screen changes, match lifecycle, replay marks,
telestrator kill, and per-cue arming. Big thumb targets, haptic confirmation, and it
re-authenticates itself after a reconnect so it can't quietly stop working mid-show.

It sits behind the same PIN as every other control surface, `0864` until you change it. See
"Who can drive it" above for setting the event's own.

The desk prints its reachable addresses at startup, and the launcher's READY message shows the
same one. On the phone, open `http://<desk-ip>:8720/s/remote`.

Two things have to be true for the phone to reach it:

1. **Windows Firewall must allow inbound TCP 8720** (the port is the number after the colon in
   the desk's address). This one command needs an administrator window, once per machine: press
   the Windows key, type `powershell`, right-click **Windows PowerShell**, choose **Run as
   administrator**, paste the line, press Enter. It prints a short table describing the new rule.

```powershell
New-NetFirewallRule -DisplayName "CalGames Content Desk 8720" -Direction Inbound -Protocol TCP -LocalPort 8720 -Action Allow -Profile Private
```

2. **Both devices must be on a network that permits client-to-client traffic.** Guest and
   captive-portal Wi-Fi (university visitor networks, hotel Wi-Fi) almost always enable client
   isolation, which blocks this no matter what the firewall says. Use the event's own production
   AP, which [docs/06](docs/06-hardware-and-network.md) already calls for on 5GHz clear of the
   field AP, or a phone hotspot to test.

Note the `-Profile Private` above: don't open the port on a public profile you don't control.

## Publishing

Copy [config.example.json](config.example.json) to `config.json` (gitignored because it holds
credentials) and fill it in. `npm run auth:youtube` walks through getting a YouTube refresh token.
Everything at the event queues itself: matches when the score posts, practice included
(`publish.autoQueuePractice` turns just the automatic practice path off; TBA gets no link
because it has no practice keys), arcade sets when they end, and everything else as a two-tap
segment from the desk. Nothing uploads until `publish.enabled` is true, and the default
`deferred` mode queues during the event and uploads afterwards so nothing competes with the
live stream for the venue uplink.

Titles follow the official FIRST channel convention: `Qualification 42 - CalGames`,
`Practice 3 - CalGames`, `Match 5 (R2) - CalGames`, `Arcade Winners Semifinal (Smash) - CalGames`.
Details in [docs/11-distribution.md](docs/11-distribution.md).

## Try the standalone prototype

Open [prototypes/overlay.html](prototypes/overlay.html) in a browser. Standalone, fake match
driver, no server or build step.

**Query params**

| | |
| --- | --- |
| `?key=alpha` (default) | transparent, for an OBS Browser Source |
| `?key=luma` | black background, for a Blackmagic downstream luma keyer |
| `?demo=0` | freeze the fake match driver |
| `?ui=0` | hide the control bar |

**Keys**: `P` pen · `A` arrow · `E` ellipse · `S` spotlight · `Z` undo · `C` clear ·
`H` toggle telestrator · `U` toggle the control bar

It demonstrates the Gold Sweep transition, the alliance overview with its tier-3 photo fallback,
the live score bar with the 2026 hub-state indicator and threshold-labeled RP badges, Number Roll
counters, endgame lockdown, and the telestrator.

## Status

**P0 and P1 are built and validated; P2 is nearly complete.** The bridge has been run against a
real `cheesy-arena -dev` build of the 2026 source through a genuine scored match. The arcade,
Cheesy REST polling, side screens, post-match cards, and the start.gg bracket adapter are in.
So is the first round of the community gap list ([docs/12](docs/12-community-research.md)):
schedule-drift estimates, status cards, the talent view, the per-team phone schedule, the clean
second program, dual-bus audio, the wide-shot lock, and the publish QC hold.
Outstanding: YouTube and TBA credentials, and the Statbotics prediction board, blocked upstream
while `api.statbotics.io/v3` returns 500s (see
[docs/09-roadmap-and-risks.md](docs/09-roadmap-and-risks.md)).

Two decisions shaped everything:

- **CalGames 2026 runs Cheesy Arena.** The `cheesy` adapter is the only ingest path.
- **The field bridge is approved**, on the condition that nothing can interfere with Cheesy Arena
  controlling the field.

That condition resolves to a hard endpoint allowlist, and the guarantee behind it is **structural
rather than procedural**: Cheesy Arena's `HandleNotifiers` never calls `Read()`, so the display
endpoints we subscribe to *cannot* process anything we send. What's forbidden is short and
specific: `/match_play/*` (abort match), `/panels/scoring/*` (game-piece scoring),
`/panels/referee/*`, and every `/setup/*`. The remaining interference vector is the *host*, not
the API, so nothing of ours runs on the FMS machine. Spec and a printable FTA sign-off sheet:
[docs/10-field-bridge.md](docs/10-field-bridge.md).

Running the bridge against the real thing was worth more than the code it checked: it found the
hub alternation inverted, the auto winner decided on fuel count rather than points, and a tied auto
settled by a **coin flip**. Hub state now comes from the field rather than any local inference.
