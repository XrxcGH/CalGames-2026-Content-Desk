# 02: Architecture

## The shape

```
 SOURCES                    CORE                          SURFACES
 ─────────────────────      ─────────────────────────     ──────────────────────────
 Cheesy Arena WS      ─┐                                ┌─ Program overlay  (OBS browser src)
 FMS Audience Display ─┤    ┌──────────────┐            ├─ Telestrator draw pad (tablet)
   · Companion HTTP    ├───▶│   Ingest     │            ├─ Replay console      (operator)
   · OBS scene events  │    │   Adapters   │            ├─ Venue side screens
 FRC Events API       ─┤    └──────┬───────┘            ├─ Arcade overlay      (Smash / MK)
 The Blue Alliance    ─┤           ▼                    ├─ Announcer / analyst tablet
 Statbotics           ─┤    ┌──────────────┐            ├─ Post-match card renderer
 start.gg             ─┤    │  Normalizer  │            └─ Rundown / stage manager view
 Desk console (manual)─┘    └──────┬───────┘                        ▲
                                   ▼                                │
                            ┌──────────────┐   ┌────────────────┐   │
                            │  Event Log   │──▶│  Fan-out hub   │───┘
                            │  + Snapshot  │   │  (WS + REST)   │
                            └──────┬───────┘   └────────┬───────┘
                                   │                    ▼
                                   │           ┌────────────────┐
                                   └──────────▶│  Cue Engine    │──▶ OBS-WS scene cuts
                                               │  (show automation) │   · replay markers
                                               └────────────────┘
```

Three rules that keep this honest:

1. **Sources never talk to surfaces.** Everything goes through the normalizer. Swapping Cheesy
   Arena for FMS changes one adapter and nothing else.
2. **The event log is append-only and dual-clocked.** Every event carries both wall-clock and
   `matchClock` (signed seconds relative to match start). Replay, analysis, and post-match cards
   all key off `matchClock`; nothing else works.
3. **Manual always wins.** Every automated cue has a manual override, and the desk console can
   inject any event. A volunteer with a keyboard must be able to run the whole show if every
   integration dies.

---

## Core data contract

One envelope. Everything is a `DeskEvent`.

```ts
type DeskEvent = {
  id: string;              // ULID, sortable and unique
  ts: number;              // wall clock, epoch ms, from the desk's clock
  matchClock: number|null; // signed seconds vs. match start. -20 = auto start, 0 = teleop... see below
  source: 'cheesy'|'frcapi'|'tba'|'statbotics'|'startgg'|'manual'|'cue'|'clock'|'demo'|'replay';
  // 'clock' is the 10Hz ticker's time-driven phase boundaries; 'demo' is the
  // simulated match driver, tagged honestly so it can never pass for field data.
  confidence: 'authoritative'|'derived'|'estimated';
  type: string;            // see vocabulary
  payload: unknown;
};
```

There is no `'fms'` source: that adapter is reference-only (see below) and the type in
`types.ts` never grew one. `'replay'` covers events the replay and telestrator services emit
themselves (`replay.clip_ready`, `telestrator.frame`), and the cue engine treats it as
operator-driven when applying the wide-shot lock.

`confidence` matters more than it looks. FMS-via-Companion gives `authoritative` state but no
numbers. A scene-change inferred from OBS is `derived`. An operator's guess is `estimated`.
Graphics can then decide: show a live score only if `authoritative`, otherwise show the clock and
shut up.

### Match clock convention

REBUILT is 20s auto + 2:20 teleop. We use a single continuous axis so replay scrubbing is sane:

| `matchClock` | Phase |
| --- | --- |
| `-20 ... 0` | AUTO |
| `0 ... 10` | Transition Shift |
| `10 ... 110` | Shifts 1-4 (25s each) |
| `110 ... 140` | End Game |
| `> 140` | post-match |

Derived from `matchTiming` (Cheesy) or hard-coded + `Match Start` trigger (FMS).

### Event vocabulary

Deliberately a superset of Cheesy Arena's notifiers so the Cheesy adapter is near-pass-through.

**Match lifecycle**: `match.loaded` · `match.prestart` · `match.preview` · `match.armed` ·
`match.start` · `match.auto_end` · `match.teleop_start` · `match.shift_change` · `match.endgame` ·
`match.end` · `match.aborted` · `match.score_posted`

**Live state**: `score.realtime` · `score.delta` · `hub.state` · `arena.status` ·
`card.issued` · `foul.called`

**Event flow**: `alliance_selection.update` · `award.presented` · `break.started` ·
`queue.updated` · `rankings.updated`

**Production**: `graphic.show` · `graphic.hide` · `lower_third.show` · `lower_third.hide` ·
`replay.marker` · `replay.clip_ready` · `replay.play` · `telestrator.stroke` · `telestrator.undo` ·
`telestrator.clear` · `telestrator.frame` · `telestrator.hide` · `screen.change` · `scene.change` ·
`sound.play`

`screen.change` is the overlay switching its own pages (`overview`, `match`, `score`, `selection`,
`explain`...); `scene.change` is the switcher cutting cameras. Different layers, deliberately
different events, so an operator taking a program screen never touches what the switcher is doing.

**Arcade**: `arcade.set_start` · `arcade.score` · `arcade.set_end` · `arcade.bracket_updated`

**Schedule, status, and config**: `pace.updated` (drift-adjusted start estimate) ·
`status.show` · `status.hide` (the audience-facing delay/review/fault card) ·
`game.thresholds` (bonus RP thresholds pushed from `config.json` at boot)

**Crowd trivia**: `trivia.updated`, one event type whose payload is the whole trivia snapshot

### `score.delta`: the one we synthesize

Neither Cheesy Arena nor FMS emits "team X just scored." We derive it by diffing consecutive
`realtimeScore` snapshots:

```ts
{ type: 'score.delta',
  matchClock: 47.3,
  payload: { alliance: 'red', field: 'fuel', amount: 6 } }
```

Only positive deltas are emitted: a downward score correction is not a highlight, and marking one
would drop a bogus replay marker. `field` is `'fuel' | 'tower' | 'fouls'`; the reducer attributes
the amount to auto or teleop itself, by the match clock at the moment the event landed.

This is what powers scoring-rate charts, auto replay markers ("6 fuel in 1.2s, that's a burst,
mark it"), and the post-match timeline card. It is the highest-value thing in the whole system
and it costs ~40 lines.

### The live snapshot: `DeskState`

A `DeskEvent` is the wire; `DeskState` is what every surface actually renders from.
`reduce(state, event)` in `state.ts` is the only place one becomes the other, and it is a pure
function, which is what lets a recorded NDJSON log replay to byte-identical state. A few fields on
that snapshot are easy to miss from the event vocabulary alone:

- **`thresholds`**. The bonus RP numbers (`energizedFuel`, `superchargedFuel`, `traversalTower`)
  are not the constants in `REBUILT`; they live on the snapshot, arrive once from `config.json` as
  a `game.thresholds` event at boot, and both the reducer's own scoring and every badge on every
  surface read them from there. Change `config.game` and restart, and the whole system repaints
  against the new numbers.
- **`screenHold`**. Match lifecycle events drive `screen` on their own, which is what lets the show
  run unattended. The moment an operator sends `screen.change` with a real screen name, `screenHold`
  flips true and automatic changes stop moving the screen until something sends `screen.change`
  with `{ screen: 'auto' }`, which clears the hold and leaves whatever is on air alone. Without
  this, taking the arcade bumper in a gap between matches got yanked back to the overview the
  moment the next `match.loaded` landed.
- **`selection`**. Mirrors Cheesy Arena's own alliance-selection state (captains in seed order, the
  ranked pool with picks marked, the field's own pick clock) off the `allianceSelection` notifier
  already carried on the audience display socket. The desk only draws it; the field's selection
  websocket stays on the forbidden list.
- **Playoff seeds**. `MatchInfo.redAlliance` / `blueAlliance` carry the 1-8 seed number in a
  playoff match, absent in qualification. Cheesy Arena only ever fields three robots per alliance
  on the field, so a four-team playoff alliance's fourth member is a backup; the seed is the join
  key back to the selection rosters wherever a surface needs the full roster. Every surface sizes
  itself off the length of `red`/`blue` rather than assuming three, so a fuller roster (or a
  four-up arcade free-for-all) renders correctly wherever one is supplied.

---

## Ingest adapters

### `cheesy`: **the primary and only ingest adapter**

CalGames 2026 runs Cheesy Arena with an approved field bridge. The operating rule is *any software
is fine as long as it can't interfere with Cheesy Arena controlling the field*, which resolves to a
hard endpoint allowlist. Read [10-field-bridge.md](10-field-bridge.md) before writing a line of
this adapter. Short version: connect only to handlers whose body is `ws.HandleNotifiers(...)`,
because that function never calls `Read()` and therefore **cannot process anything we send**. The
one exception we allow is `/displays/field_monitor/websocket`, which does have a read loop: it is
the only source of robot-link status, and the rule there is that we never set `fta` and never send
a frame. Never touch `/match_play/*` (abort match), `/panels/scoring/*` (game-piece scoring),
`/panels/referee/*`, or `/setup/*`.

**WebSocket subscriptions** (register with a scorekeeper-agreed `displayId`):

| Endpoint | Notifiers |
| --- | --- |
| `/api/arena/websocket` | `matchTiming`, `matchLoad`, `matchTime` |
| `/displays/audience/websocket` | `realtimeScore`, `scorePosted`, `lowerThird`, `audienceDisplayMode`, `allianceSelection`, `playSound` |
| `/displays/field_monitor/websocket` | `arenaStatus`: station health, robot comms |
| `/displays/queueing/websocket` | queueing, `eventStatus` |
| `/displays/rankings/websocket`, `/displays/bracket/websocket` | rankings, bracket |

**REST**, `GET` only: the qualification schedule (`/api/matches/qualification`) and
`/api/rankings` poll every 60s, deliberate and slow, since the field network is not ours to load
up and both change on the order of once a match. A score post triggers one extra debounced poll
1.5s later, so the side screens are not still showing the previous match's standings for up to a
full minute while the room already has the new ones. `/api/alliances`, `/api/teams/{id}/avatar`,
and `/api/bracket/svg` are on the client's endpoint allowlist but nothing polls them yet.

Confidence: `authoritative` throughout. Every derived signal in this document (`score.delta`,
automatic replay markers, hub state, the cue engine following the scorekeeper's screen) is
available.

Effort: low. It's close to a straight rename of fields.

### `fms`: **not being built.** Kept as reference only

CalGames 2026 runs Cheesy Arena, so this adapter is out of scope. The notes below stay because the
Companion-shim technique is the right answer if a future CalGames switches to official FMS, and
because it took real digging to find.

Three legs, best-effort combined:

1. **Companion shim (primary).** Stand up an HTTP endpoint that speaks Companion's press API and
   point Audience Display's automation URL at it. Yields the 10 documented state transitions with
   real timing: `match.prestart`, `match.preview`, `match.start`, `match.endgame`, `match.end`,
   `match.score_posted`, `alliance_selection.update`, `award.presented`. `authoritative`.
   *If A/V already uses Companion for switching, don't fight it: run Companion and consume its
   own HTTP/TCP API, or chain our shim after it.*
2. **OBS scene watch (fallback).** Subscribe to obs-websocket `CurrentProgramSceneChanged`; map
   `FMS_PREVIEW`/`FMS_SCORE`/`FMS_RESULT`/`FMS_ALLIANCE`/`FMS_AWARDS`. `derived`.
3. **FRC Events API poll (numbers).** Post-match scores, rankings. Internet-dependent and
   delayed, good enough for rankings graphics but useless for live score.

Live score under FMS: we do **not** get one. Options, in order of preference:
- Accept it. Show clock + hub state + pre-match analytics live; show final score on `Post Result`.
  This is what most community broadcasts do and it's fine.
- A "shadow scorer" volunteer on the desk console tapping fuel counts (`estimated` confidence,
  visually distinguished, e.g. score shown in outline rather than solid).
- Stretch: OCR the Audience Display score bar from a capture card. Cheap to prototype, brittle
  under stress. Not on the critical path.

### `frcapi` / `tba`

Schedule, team list, nicknames, avatars, historical results. Runs off the production LAN's
internet, not the field network. Cache aggressively to a local JSON store on load-in day so a
venue internet failure can't blank the graphics.

Also: **TBA Trusted API** for pushing CalGames results out live. Cheesy Arena does this natively;
under FMS, off-season sync handles it. Either way we consume, not duplicate.

### `statbotics`

Pulled once on Friday, cached. Team EPA, component EPAs (auto/teleop/endgame), and RP EPAs feed the pre-match
prediction bar, "biggest EPA delta on the field", alliance-selection value board. No key required.

**Caveat to state on air:** EPA is season-long and CalGames is an offseason event with swapped
drivers, B-teams (2025 had five `999x` B-team entries), and rebuilt robots. Label predictions as
season-form, not a forecast. A graphic that's confidently wrong costs more credibility than no
graphic.

### `manual`

The desk console. Injects any event, overrides any field, and is the source of truth for anything
the automation can't see (a robot that lost comms, a great save, "that's a foul"). Keyboard-first
with a Stream Deck binding.

---

## Services

| Service | Job | Notes |
| --- | --- | --- |
| `bridge` | sits on the field-adjacent NIC, reads Cheesy/FMS, republishes to production LAN | only component allowed to touch the field side; read-only |
| `core` | normalizer, event log, snapshot store, WS fan-out, REST | single process; NDJSON log to disk, replayable |
| `replay` | rolling record, clip extraction, clip library | separate process/box, a crash here must not take program down |
| `cue` | show automation: `on(state) -> actions` | drives OBS-WS scene changes today, honoring a wide-shot lock that keeps autopilot from cutting away from the field mid-match; ATEM and Companion integrations are not built |
| `surfaces` | static web bundles, one per surface | served by `core`; every one is just a WS subscriber. Every operator console shares a navigation strip (writes `screen.change` directly) so an operator can jump between consoles and take a program screen without going back to `/` |

Deliberately small. Five processes, one of which is optional, all on a LAN, no cloud dependency
during show.

### Why the event log matters

Because it makes the whole thing **replayable in development**. Record Friday's practice matches
to NDJSON, then `npm run replay -- data/events/friday.ndjson 4` (the speed is positional, after
the file; there is no `--speed` flag) and you can build and test every graphic
on Sunday night in October, or in March, on a laptop, with no field. Volunteer-run systems live
or die on whether people can practice without hardware.

---

## Surfaces

All surfaces are browser pages that consume the same WS stream and the same
[theme tokens](../packages/theme/tokens.css). Every one takes `?key=alpha|luma` (see
[03-brand.md](03-brand.md)).

| Surface | Route | Runs on |
| --- | --- | --- |
| Program overlay | `/s/program` | OBS Browser Source, 1920×1080 |
| Telestrator draw pad | `/s/draw` | iPad + Pencil, on the production Wi-Fi |
| Telestrator render | `/s/tele` | OBS Browser Source, layered over replay |
| Replay console | `/s/replay` | operator laptop |
| Desk console | `/s/desk` | operator laptop, keyboard-first |
| Team media | `/s/media` | operator laptop, robot cutout uploads |
| Arcade overlay | `/s/arcade` | OBS Browser Source |
| Arcade console | `/s/arcadedesk` | operator laptop, side tournament |
| Side screen | `/s/side` | venue TVs, queueing, rankings, next match |
| Post-match cards | `/s/cards` | operator laptop, 1080×1080 result PNGs |
| Trivia overlay | `/s/trivia` | OBS Browser Source, crowd trivia question/answer/leaderboard |
| Trivia play | `/s/quiz` | audience phones, join and answer |
| Trivia host | `/s/triviadesk` | operator laptop, opens/reveals questions and edits the bank |
| Talent view | `/s/talent` | announcer tablet, RP progress in words, pronunciation notes |
| When do we play? | `/s/next` | any phone, per-team schedule with drift-adjusted estimates |
| Head referee review | `/s/var` | operator laptop, frame-step review only: no cut, no publish |
| Pit monitor kiosk | `/s/watch` | venue pit TVs, a full-screen wrapper around any open screen |
| Phone remote | `/s/remote` | operator's phone, runs the show over the venue Wi-Fi |

Access is gated by [`access.ts`](../apps/core/src/access.ts): the overlays, the venue TVs, the
two audience phone pages, and the pit monitor kiosk (`program`, `side`, `tele`, `arcade`,
`trivia`, `quiz`, `next`, `watch`) are open by allowlist; every operator console and every write
requires the shared PIN. See [the README](../README.md#who-can-drive-it).

---

## Non-goals

Worth writing down so scope doesn't creep in September:

- **Not a field management system.** We never control the field, never score officially, never
  touch team VLANs. Cheesy Arena / FMS owns the match; we observe it.
- **Not a replacement for the audience display.** The in-venue audience screen stays FMS/Cheesy.
  We own the *stream* and any secondary screens.
- **Not a cloud service.** Everything runs on the production LAN. Internet is a nice-to-have.
- **Not multi-event.** Build for one field, one venue, one weekend. Generalize later if it works.
