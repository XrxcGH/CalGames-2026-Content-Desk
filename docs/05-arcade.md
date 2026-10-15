# 05. Arcade: Smash Bros. and Mario Kart on the same rig

## Why this is a real feature, not a gimmick

Look at the CalGames 2025 schedule: a **one-hour lunch block on Saturday and Sunday**, a
~30-minute alliance selection window, plus load-in Friday evening and the gaps around awards.
On a single-field event that's roughly **three hours of dead air across the weekend.**

A stream that goes to a static slate for three hours loses its audience and doesn't get it back.
A stream that cuts to a Smash bracket between teams, with the same overlay language, the same
gold-on-purple graphics, and the same commentators, keeps it.

The architectural payoff is that this costs almost nothing: **the arcade overlay is just another
surface bound to another source.** Same event bus, same theme tokens, same lower-third component,
same replay pipeline. If the arcade overlay is expensive to build, the architecture is wrong.

## Capture path

```
Switch ──HDMI──▶ HDMI splitter ──▶ venue monitor (players; zero added latency)
                       │
                       └──────▶ capture card ──USB3──▶ production PC ──▶ OBS scene
```

- **HDMI splitter first, capture second.** Players must never play on a feed that has been through
  a capture card. Even 60ms of added latency is unplayable for Smash, and competitors will notice
  immediately.
- Capture: Elgato HD60 X or Cam Link 4K. Both do 1080p60 uncompressed-ish over USB3.
  Smash Ultimate and MK8 Deluxe both output 1080p60 docked.
- **Two consoles, two captures** if running Smash and Mario Kart in parallel stations. Cheap
  insurance: a station reset takes 4 minutes and dead air during a reset is exactly what we're
  trying to avoid.

## Data sources

### Smash: start.gg GraphQL

**Built**: `apps/core/src/ingest/startgg/`. `https://api.start.gg/gql/alpha`, bearer token,
GraphQL. The adapter polls the configured event's sets once a minute (brackets change on the order
of once a set, and start.gg's 80 req/min limit is a shared resource):

```graphql
query EventSets($slug: String!, $page: Int!, $perPage: Int!) {
  event(slug: $slug) {
    name
    sets(page: $page, perPage: $perPage, sortType: CALL_ORDER) {
      pageInfo { totalPages }
      nodes {
        id state fullRoundText
        slots { entrant { id name initialSeedNum } }
      }
    }
  }
}
```

Configured via `startgg.token` and `startgg.eventSlug` in `config.json` (no launch flag, because
unlike the field bridge there is nothing here that can hurt the event). Mapped sets land in
`ArcadeStore.setBracket()` and fan out as `arcade.bracket_updated`; the arcade console lists the
open sets with a **Load** button that pre-fills round and entrants. Entrant names parse the FRC
crossover: a numeric sponsor prefix (`846 | Ana`) or trailing number (`Cy 254`) becomes the team
number; a real sponsor tag (`C9 | Mango`) stays a gamertag.

**Poll, but never trust.** start.gg reflects what a TO has typed in, which lags the actual match by
anywhere from 30 seconds to a full round. The overlay's score is **operator-authoritative**, with
start.gg supplying names, seeds, and round labels only. The adapter structurally cannot touch the
live set: `setBracket()` is the only store method it calls, and the mapped `BracketSet` type
carries no score field at all. Live set score is `estimated` until the operator confirms it.

### Free-for-alls: Pac-Man, Tetris, 4-up Mario Kart

Sets take **2 to 4 players**. Two players renders the versus card; three or four renders a
free-for-all strip (one cell per player, current leader capped in gold), which is how a
4-player split-screen Kart lobby, a Pac-Man party, or Tetris head-to-head-to-head reads on
stream. Free-for-alls never auto-complete: the operator ends the set, and the leader at that
moment wins. Same operator-authoritative scoring, same `arcade.*` events, same capture chain.

**The set graphics run across the TOP of the frame, never the bottom.** MK8D draws coins, lap
count, and position along the bottom edge of every split-screen quadrant, and Smash keeps damage
percentages in the lower third, because a bottom scoreboard covers exactly the numbers the audience
needs to follow the game. In split-screen the strip's cells line up over the player quadrants
(left/right for two screens, one per quadrant column for four).

### Mario Kart: no API, so model it

MK8 Deluxe has no external data source. Build a small GP model instead:

- Standard 12-player GP points: `15 · 12 · 10 · 9 · 8 · 7 · 6 · 5 · 4 · 3 · 2 · 1`
- Operator enters finishing order after each race (8 keystrokes, ~5 seconds)
- Overlay renders a running cumulative standings table across a 4-race GP

Stretch, explicitly not on the critical path: OCR the results screen from the capture feed. The
MK8D results screen is a fixed layout with high-contrast text (it's tractable), but it's a
Saturday-afternoon-of-October problem, not a September one.

## The crossover that makes it CalGames

This is the part that justifies building it in-house rather than downloading BracketFlow.

Because the team list and rankings are already on the event bus:

| Feature | What it looks like |
| --- | --- |
| **Team vs Team** | Smash entrants registered by team number, so the card reads `846 The Funky Monkeys`, not `xX_smashgod_Xx` |
| **Alliance GP** | During alliance selection, run a Mario Kart GP where the karts *are* the alliance captains. `ArcadePlayer.alliance` tags each racer for that context, but the standings graphic still renders with the arcade's own purple/green scheme, not alliance colors: see the color rule below |
| **Pit Crew Cup** | Bracket seeded by qualification ranking; the underdog storyline writes itself |
| **Between-match filler** | Cut to the arcade automatically three minutes after a score posts when no next match has been loaded (the end of a session, or a field stall; on a real field the next match arrives 20 to 60 s after a post), and never over an award, a slide, a held screen or a running replay: a cue rule, not an operator decision. It never consults the schedule, and it never fires before the day's first posted score, so a Friday load-in morning stays on whatever the producer chose |

The last one is the real win: the cue engine already knows when there's no match. Filling dead air
becomes automatic.

## Overlay design

Identical component vocabulary, different data:

- **Arcade card**: player/team names, seed, set score, round label (`Winners Semifinal`)
- Same lower third, same replay wipe, same `--cg-purple` panel with `--cg-gold` edge
- Player 1 / Player 2 sides use `--cg-purple-hi` and `--cg-green`, **not** alliance red/blue.
  Red and blue mean *FRC alliance* on this broadcast and nowhere else. A Smash overlay using them
  would quietly poison the association we spend all weekend building.

## Two practical constraints, both non-negotiable

**1. Mute the game audio on the stream feed.**

Nintendo soundtracks are aggressively matched by YouTube's Content ID. A three-hour CalGames
livestream that picks up a copyright claim can be muted, blocked, or stripped of its archive,
and the archive is what teams actually watch afterward. Route game audio to the **venue** for the
players and the room, and run the **stream** on commentary plus a licensed music bed. This is a
routing decision on the audio mixer that takes 30 seconds to set up and saves the weekend's VOD.

**2. Retail hardware and legally-owned copies only.**

School venue, community event, streamed publicly under the CalGames and WRRF names. Real consoles,
real cartridges, no emulators, no ROMs, no modded hardware. Melee on original hardware is fine;
Slippi on a laptop is a conversation to have with the planning committee first, not a decision for
the content desk to make alone.

## Staffing

One arcade operator, who is *not* the replay operator and *not* the desk producer. During matches
they run the bracket and reset stations; during breaks they're the one on the keyboard driving the
overlay. This is a great first-year volunteer role: low stakes, high visibility, and it's the
on-ramp that produces next year's replay operator.
