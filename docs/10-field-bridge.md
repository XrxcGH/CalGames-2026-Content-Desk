# 10: The field bridge

**Operating rule:** any software is fine as long as it cannot interfere with Cheesy Arena actually
controlling the field. Reading data for overlays is fine. Accidentally stopping a match or
corrupting game-piece scoring is not.

That's a much better bar than "don't mutate anything," because it's the one that actually matters,
and because Cheesy Arena's code splits along exactly that line.

---

## The safety boundary is structural, not a promise

`websocket.HandleNotifiers()` **never calls `Read()`**. It selects over notifier channels, writes
outbound frames, and pings every 10s to detect a dead client. That's the entire loop.

So any handler whose body is `ws.HandleNotifiers(...)` is **incapable of processing anything we
send.** Not "won't," *can't*. We could fire arbitrary frames at it all weekend and nothing would
be read. That is a far stronger guarantee than a code review of our own client.

**Five of our six sockets are like that. One is not**, and an earlier version of this document
said all six were. `/displays/field_monitor/websocket` runs `HandleNotifiers` in a goroutine and
then enters its own read loop, which accepts `updateTeamNotes` and writes an FTA note onto a team
record via `Database.UpdateTeam`. It is gated on `?fta=true` **and** `userIsAdmin`, and
`userIsAdmin` returns true unconditionally when no admin password is set, which is the normal
state at an offseason. So the query parameter is effectively the whole gate.

We keep the endpoint, because it is the only source of `arenaStatus` and therefore the only way
the desk knows a robot has lost its link. What changes is the honesty of the claim: on that one
socket the guarantee is **ours**, not the arena's. We never set `fta`, and we never send an
application frame on any socket. The client builds every query string itself rather than taking
one from a caller, so `fta` cannot be smuggled in through a path, and there is no send path in the
file at all. Two tests pin both properties, and they fail if either is broken.

Command-capable handlers are the ones with a read loop, and they are exactly the ones that can hurt
the event:

| Endpoint | Commands it accepts | Why it's forbidden |
| --- | --- | --- |
| `/match_play/websocket` | `startMatch`, **`abortMatch`**, `loadMatch`, `substituteTeams`, `toggleBypass`, `commitAndPost`, `discardResults`, `startTimeout`, `signalReset`, ... | **Literally stops a match.** Also discards results |
| `/panels/scoring/{position}/websocket` | **`autoTower`**, **`endgame`**, **`addFoul`**, `commitMatch` | **Literally is game-piece scoring.** Corrupts the official score |
| `/panels/referee/websocket` | fouls, cards | corrupts the official score |
| `/alliance_selection/websocket` + POSTs | picks, finalize, reset | destroys alliance selection |
| `POST /setup/*` | everything | `POST /setup/db/clear/{type}` and `/setup/db/restore` **wipe or replace the event database** |

## The allowlist

Hard-coded in the client. Not a config file, not a convention: a constant, with a unit test that
fails if anything else appears.

**Allowed (WebSocket). All `HandleNotifiers`-only except `field_monitor`, noted below:**

| Endpoint | Gives us |
| --- | --- |
| `/api/arena/websocket` | `matchTiming`, `matchLoad`, `matchTime` |
| `/displays/audience/websocket` | `realtimeScore`, `scorePosted`, `lowerThird`, `audienceDisplayMode`, `allianceSelection`, `playSound`, `matchLoad`, `matchTime` |
| `/displays/queueing/websocket` | queueing + `eventStatus` |
| `/displays/field_monitor/websocket` | `arenaStatus`: station health, robot comms. Powers the "what happened to 846?" replay marker. **Has a read loop** (`updateTeamNotes`, behind `?fta=true`); we never set `fta` and never send a frame |
| `/displays/rankings/websocket` | **not opened.** Allowlisted, but its handler carries only `display.Notifier`, `eventStatus` and `reload`, none of which the desk reads: rankings come from `GET /api/rankings` on the 60s poll. Opening it bought nothing and cost a display registration |
| `/displays/bracket/websocket` | playoff bracket state |

**Allowed (HTTP, `GET` only):**
`/api/matches/{type}` · `/api/rankings` · `/api/alliances` · `/api/teams/{id}/avatar` ·
`/api/bracket/svg` · `/api/sponsor_slides`

**Forbidden: everything else**, and specifically every path in the table above.

### Verifying a new endpoint before adding it

One command. If it prints nothing, the handler cannot read from us:

```bash
sed -n '/WebsocketHandler/,/^}/p' web/<name>.go | grep -n '\.Read(' || echo SAFE
```

Do this for any endpoint someone wants to add in September. It takes ten seconds and it's the
whole safety argument.

---

## Client rules

1. **Receive-only websockets.** Our WS client never sends an application frame. Protocol-level
   pong is handled by the library; nothing above that layer can write. Belt-and-suspenders on top
   of the structural guarantee.
2. **`GET`-only HTTP, enforced in the wrapper.** The client physically cannot construct another
   method. `POST /setup/db/clear/matches` is one typo away from ending the event; make it
   unreachable rather than merely unwise.
3. **Path allowlist checked at call time**, against the constant above. Reject and log, don't warn.
4. **Reserved `displayId` prefix, coordinated with the scorekeeper.** Registering with an ID a
   genuine audience display uses could reconfigure that display: `RegisterDisplay` overwrites the
   stored configuration for that ID, `Type` included, and the arena's own display client navigates
   itself when the configuration it receives names a different URL. Agree `contentdesk1` through
   `contentdesk4` (or whatever they prefer) in advance, and always pass it explicitly. Connecting
   without one makes Cheesy allocate an ID and redirect.

   Each socket gets its **own** suffixed ID (`contentdesk1-audience`, `-queueing`, `-fieldmon`,
   `-rankings`, `-bracket`). Sharing one ID across the five made the desk overwrite its own
   registration five times over, so the scorekeeper's `/setup/displays` page, the page they open
   when a screen goes missing, showed a single row flickering between five types with a connection
   count of five. Suffixing also shrinks the collision target from one guessable string to five odd
   ones, and Cheesy only ever auto-assigns numeric IDs, so nothing it hands out can land on them.
5. **Connection budget:** one WS per allowed endpoint, one concurrent HTTP request. The schedule
   and rankings poll every 60s, plus one deferred refresh about 1.5s after a posted score so the
   side screens are not a minute behind the room. There is no faster polling mode.
6. **Exponential backoff with jitter, 1s to 60s.** A reconnect storm during a field reset is now
   the most plausible way this project causes a problem. There is no circuit breaker beyond the
   60s cap: the bridge keeps retrying at that ceiling until the kill switch or the operator stops
   it.

## The one remaining way we could actually interfere

Not the API. **The host**.

Cheesy Arena is a *single Go process* that runs the web server, the arena loop talking to driver
stations, PLC I/O, and LED/DMX output. Starve that process of CPU, disk, or NIC and you are
genuinely affecting field control.

So:

- **Never run any of our software on the FMS machine.** Not the bridge, not OBS, not a "small"
  helper script. The bridge is our box.
- **Don't co-locate our recording or encoding** anywhere near it (those are the I/O-hungry ones).
- Our UPS, our power, our switch. If our rack browns out, the field doesn't notice.
- Keep the field-side NIC quiet: no default gateway, no DNS, and disable NetBIOS/LLMNR/mDNS/network
  discovery on that adapter. Windows will otherwise broadcast discovery chatter across the field
  network all weekend. It won't stop a match, but it's free to avoid.
- **Kill switch**, documented and rehearsed: `Disable-NetAdapter -Name "Field" -Confirm:$false`, or
  pull the cable. Everything downstream degrades to manual and keeps running.

## What the relaxed constraint buys us

Registering as a display was the blocker on live data, and it's now in scope. That restores:

- **Live in-match score** on the broadcast, `authoritative`, not a shadow-scorer guess.
- **`score.delta` synthesis**: automatic replay markers for scoring bursts, lead changes, and
  climbs (see [02-architecture.md](02-architecture.md)). This was the single highest-value derived
  signal in the design and it's back.
- **`arenaStatus`**: "robot dropped" markers and a station-health strip on the desk console.
- **`playSound` / `audienceDisplayMode`**: our cue engine can follow the scorekeeper's screen
  changes instead of guessing at them.

It also means the rest of the stack is unconstrained: OBS, vMix, NodeCG, Companion, ffmpeg,
whatever fits. The only line is the allowlist above.

---

## FTA sign-off sheet

*Print it. Get it initialed Friday. Keep a copy at the field.*

> **CalGames 2026 Content Desk: field network connection**
>
> **What:** one host, one Ethernet cable, into a port you designate on the Cheesy Arena network.
> **Purpose:** read match data to drive broadcast graphics and replay.
>
> **Guarantee: structural for five of six endpoints.** Five of the six websockets we open have
> `HandleNotifiers`-only handlers. That function never calls `Read()`, so those endpoints cannot
> process anything we send, by construction.
>
> **The exception, stated plainly:** `/displays/field_monitor/websocket` does have a read loop.
> It accepts one command, `updateTeamNotes`, which writes an FTA note onto a team record. It is
> gated on `?fta=true`, and that gate is weaker than it looks, because Cheesy treats every user
> as an admin when no admin password is set. We use this endpoint because it is the only source
> of robot-link status. **We never set `fta`, and we never send an application frame on any
> socket.** Both are enforced by tests in our code, not by convention. If you would rather we did
> not open it at all, say so: we lose the dropped-robot replay marker and the station-health
> strip, and nothing else.
>
> **We never connect to:** `/match_play/*` (start/abort match), `/panels/scoring/*` (game-piece
> scoring), `/panels/referee/*` (fouls/cards), `/alliance_selection/*`, or any `/setup/*`.
> The HTTP client cannot construct a non-`GET` request.
>
> **Endpoints we do use:** `/api/arena/websocket`, `/displays/{audience,queueing,field_monitor,rankings,bracket}/websocket`,
> and `GET` on `/api/matches`, `/api/rankings`, `/api/alliances`, `/api/teams/*/avatar`, `/api/bracket/svg`,
> `/api/sponsor_slides`.
>
> **Display registration:** we register as display IDs `________-audience`, `-queueing`,
> `-fieldmon`, `-rankings` and `-bracket`, from one agreed prefix (agreed with the scorekeeper) so
> we can't collide with a real audience display or with ourselves. One id per socket, because
> registering overwrites that id's configuration. Listener only.
>
> **Load:** one websocket per endpoint, one HTTP request at a time, 60s polling plus one extra
> refresh ~1.5s after a score posts, exponential backoff capped at 60s on failure.
>
> **Isolation:** nothing of ours runs on the FMS machine. Separate host, separate UPS, separate
> switch. No default gateway or DNS on the field NIC; Windows discovery protocols disabled.
>
> **Full request audit log available at any time.**
>
> **If anything looks wrong:** pull the cable. Nothing on the field depends on us; we fall back to
> manual operation and the event is unaffected.
>
> Contact: ______________ · Display ID: ______ · FTA initials: ______ · Date: ______

---

## Validation against a real Cheesy Arena

Done, on a local `cheesy-arena -dev` build of the 2026 source. `harness.mjs` at the repo root
stands in for the scorekeeper and referees so a genuine match runs with genuine scoring; the bridge
itself never touches those control endpoints.

```bash
node harness.mjs
```

**Result:** the desk tracked a full match, with every phase transition, correct countdown, endgame
lockdown at exactly `matchClock` 110, real scores (15 for the auto climb, 20 for teleop L2, 30 for L3) and
the correct final. Reconnect backoff was separately verified against a dead host: 24 attempts
across six sockets in twelve seconds, no spin, desk healthy throughout.

It also found three bugs that synthetic tests could not have:

1. **Hub alternation was inverted.** Cheesy's `Hub.isShiftActive` returns `!WonAuto` for
   Shift 1/3 and `WonAuto` for Shift 2/4. Winning auto buys the *later* shifts.
2. **The auto winner is decided on AUTO FUEL COUNT ALONE.** Tower climbs don't count. An alliance
   can score 15 auto points from a climb and still lose auto, which our total-score heuristic got
   backwards.
3. **A tied auto is settled by a coin flip**: `if redAutoFuel == blueAutoFuel { redWonAuto =
   rand.Intn(2) == 1 }`. There is nothing to derive. This is what makes taking hub state from the
   field *mandatory* rather than merely tidier: any local inference is wrong half the time whenever
   auto ends level.

The bridge now reads hub state from Cheesy's per-alliance `ActiveRemainingSec` and only falls back
to inference when running desk-only.

### Rehearsing without a field

`harness.mjs` needs a real `cheesy-arena -dev` build. When one isn't at hand, `npm run fake-arena`
serves the real wire protocol instead: the same allowed display websockets, the same `{type, data}`
frames, the same GET-only REST paths, looping a scripted match (robots linking, auto decided on
fuel, alternating hub shifts, endgame climbs, score posting). `npm run validate:offline` drives the
whole bridge against it headless and prints a PASS/FAIL checkpoint table. It's the same hardened
client, the same allowlist, and the same adapter as the real thing; nothing on our side is stubbed.
Good for catching a regression in September without waiting on the next chance at an actual field.

## Verify before October

- [x] Run the whole ingest against a local `cheesy-arena -dev` instance through a real match
- [x] Repeatable offline regression check (`npm run fake-arena` + `npm run validate:offline`) that
      exercises the same client, allowlist, and adapter without needing a live Cheesy Arena build
- [ ] Re-run `harness.mjs` against a local `cheesy-arena -dev` build of the actual
      offseason source being used at the event, on a developer machine and never on
      the field network. It writes: it bypasses stations, starts the match and commits
      a result. It refuses to run against anything but loopback for that reason. In case it
      differs from `main`
- [x] Unit test asserting the endpoint allowlist (`cheesy.test.ts`: refuses control sockets,
      permits only the listener sockets, refuses REST paths outside the read allowlist). It fails
      if anyone adds a `/panels/` or `/match_play/` path.
- [ ] Unit test asserting the HTTP client rejects every method except `GET`.
- [x] Kill Cheesy Arena mid-match; confirm we back off cleanly instead of hammering.
- [ ] Wireshark the field NIC for five minutes; confirm nothing but allowlisted traffic. Bring the
      capture to the FTA conversation (more persuasive than any promise).
- [ ] Agree the reserved `displayId` prefix with the scorekeeper, in writing.
- [ ] **Ask the scorekeeper to set Selection Round 3 Order on `/setup/settings` before alliance
      selection.** Cheesy only creates a fourth alliance slot when that field is non-empty, and the
      shipped default is empty. If nobody sets it, alliances are three teams, selection will not
      finalize with a fourth pick, and everything on the desk that names the whole alliance (the
      selection board, the result card, the awards graphic) quietly falls back to the on-field
      three. Correct, but not what the event decided.
- [ ] **Confirm `CompanionAddress` and `BlackmagicAddresses` are blank on the arena's
      `/setup/settings`.** If `CompanionAddress` is set, and it is easy to inherit from a config
      copied off another event's arena machine, Cheesy opens a TCP connection to Bitfocus Companion
      and sends a button press at match preview, overlay, match start, teleop start, endgame, match
      end, final score, alliance selection and abort. Companion is exactly what an AV crew already
      runs to drive an ATEM, so that is a second automation system cutting the same show as the
      desk's cue engine, with no shared state and no way for either to see the other. If the event
      genuinely wants it, agree which Companion pages it presses and keep the desk off them.
      `BlackmagicAddresses` makes the arena dial TCP 9993 and send `record`/`stop` around each
      match; an ATEM Mini Extreme ISO does not speak that protocol, so this one only bites if there
      is a HyperDeck in the rack.
- [ ] **Confirm "Mute match sounds" is unticked** on the scorekeeper's match play page. Ticked, the
      buzzer and the endgame warning vanish from the PA, the stream and the VOD for that match.
- [ ] Rehearse the kill switch.
