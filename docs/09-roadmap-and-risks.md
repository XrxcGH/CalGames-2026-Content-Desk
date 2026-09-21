# 09: Roadmap, open decisions, risks

CalGames 2026 is **October 16-18, 2026**. Load-in and practice matches Friday afternoon.

Working backwards from that, with the constraint that this is a volunteer project competing with
build season, school, and jobs.

## Phases

Ordered so that **every phase is independently shippable**. If the project stops after any one of
them, CalGames still gets something better than last year.

### P0: Works with zero integrations *(target: end of August)*

The floor. Everything here runs off manual operator input and a camera. No FMS, no Cheesy Arena,
no network approval needed.

- Done: Theme tokens + the seven-transition motion system (see [tokens.css](../packages/theme/tokens.css))
- Done: `core`: event bus, dual-clocked NDJSON event log, snapshot reducer, WS fan-out, log replay
- Done: Program overlay: alliance overview + score bar + hub indicator + threshold-labeled RP
  badges + lower third + final score + analysis-desk strap + arcade bumper, all in one
  Browser Source, switching on `state.screen`
- Done: Desk console: keyboard-first, drives the whole show including shadow scoring at `estimated`
  confidence and back-dated replay markers
- Done: Team media library: drag-drop upload, alpha/perimeter validation, trim, multi-width output,
  two-tier fallback in the overview (cutout, else the gold-number plinth; the tier-2 TBA avatar
  is designed but not wired, see [07-team-media.md](07-team-media.md))
- Done: Telestrator: `/s/draw` pad + `/s/tele` render surface, shared renderer, six tools
  (pen, arrow, ellipse, spotlight, path, team tag), five inks, frozen-frame backdrop,
  6s auto-fade, ANALYSIS chip. Strokes relay off-bus at pointer rate; one durable
  `telestrator.stroke` event per finished stroke goes to the log
- Done: Rolling record: supervised ffmpeg per source, wall-clock-aligned segments, restart-with-backoff,
  and an encoder chooser that picks by **running a real encode** rather than trusting
  `-encoders` (NVENC, then QSV, then AMF, then libx264)
- Done: Clip extraction: segment index, accurate seek, multi-range cuts, optional slow-motion.
  Timing-aware `matchCut()` frames a match video as pre-roll over the announcer's countdown, then the
  match, then a jump to the score reveal, skipping referee deliberation
- Done: Replay console (`/s/replay`): match-clock timeline, automatic markers, cut/preview,
  and a frame grab that pushes the frozen frame to the telestrator
- Done: Durable publish queue, then YouTube resumable upload, then TBA `match_videos/add` / `media/add`,
  with official FIRST-channel naming. Credentials live in a gitignored `config.json`

**P0 is complete.** Everything above runs today; only the credentials are outstanding.

**Ship criterion: met.** A producer, a switcher op, and an analyst can run a full match with
replay and telestration using nothing but keyboards.

### P1: Live data *(target: end of September)*

- Done: **Cheesy Arena adapter**: wire shapes transcribed from the 2026 source, not guessed
- Done: **The bridge**, hardened per [10-field-bridge.md](10-field-bridge.md): socket and REST
  allowlists as constants with tests, GET-only client, exponential backoff, request audit log,
  kill switch. Launch flag (`--cheesy`), never a config setting
- Done: `score.delta` synthesis driving automatic replay markers (bursts, lead changes, climbs), plus
  "robot dropped" markers off `arenaStatus`
- Done: Hub state indicator + shift clock, taken from the field, not inferred (see below)
- Done: Cue engine with per-cue autopilot toggles, and a hand-rolled obs-websocket v5 client
- Done: **Validated against a real `cheesy-arena -dev` build** driving a genuine scored match.
  `harness.mjs` makes it repeatable

**Ship criterion: met.** The score bar is correct without anyone typing, and replay markers land
on their own.

The validation was worth more than the code it checked: it found the hub alternation inverted, the
auto winner decided on fuel count rather than points, and a tied auto settled by a **coin flip**.
That's why hub state now comes from the field rather than any local inference. Details in
[10-field-bridge.md](10-field-bridge.md).

### P2: Depth *(target: first week of October)*

- Done: Arcade: head-to-head sets, Mario Kart GP points model with the MK8D table and
  best-finish tie-break, `/s/arcade` overlay and `/s/arcadedesk` console. Entrants can
  register by FRC team, so the card reads `846 The Funky Monkeys` rather than a gamertag
- Done: Cheesy REST polling (60s): rankings and schedule, feeding the side screens
- Done: Side screens (`/s/side`): on-deck and rankings, rotating on a timer, room-scale type
  set locally (the only surface that is *only* ever seen in the room)
- Done: Post-match social cards (`/s/cards`): 1080×1080 canvas-rendered result graphics, auto-built
  on `match.score_posted`. Download a PNG or save it to the desk. Same shape language and WRRF
  palette as the broadcast: winner cap, RP badges with icons and thresholds, team lists
- Done: Crowd trivia (`/s/trivia` overlay · `/s/quiz` phones · `/s/triviadesk` host): the audience
  plays from their seats over the venue Wi-Fi, with FRC and 2026 REBUILT questions (the RP-threshold
  ones double as scorebug education), speed scoring, team-tagged leaderboard. Answers never
  leave the server before reveal, and scoring is entirely server-side. A per-event question
  bank drops in at `data/trivia.json`, and the host console can add, edit, reorder, and delete
  questions live during the event, writing straight back to that file
- Open: Statbotics pre-match prediction + alliance selection value board.
  **Still blocked** (re-checked 2026-07-30): every `/v3` path returns 500, so the schema
  cannot be verified against a live response. The rule stands: wire shapes get transcribed
  from reality, never guessed. Re-check before the September freeze
- Done: start.gg adapter, bracket metadata only (`apps/core/src/ingest/startgg/`): round labels,
  entrants, seeds, and the FRC-team crossover parse, polled once a minute into
  `ArcadeStore.setBracket()`. The console's **Load** button pre-fills the next set. The live
  score stays operator-authoritative because start.gg lags reality by up to a full round. That's
  structurally enforced: the adapter can only call `setBracket()`, and `BracketSet` has no
  score field

Capture is a hardware task, not a software one: HDMI splitter first so players never play
through a capture card, then Elgato/Cam Link into an OBS scene. See
[05-arcade.md](05-arcade.md).

### P2.5: The gap list *(from [12-community-research.md](12-community-research.md))*

A sourced sweep of what the FRC community actually complains about at events, mapped against this
desk. The high-leverage items are built:

- Done: **Pace model** ([pace.ts](../apps/core/src/pace.ts)): median actual cycle time feeding drift-adjusted
  start estimates on the side screens, the phone page, and the talent view, answering "why does the
  printed schedule say 4:02 when it's 4:20"
- Done: **Status cards**: one desk button puts *Field delay / Score review / Arena fault / Match
  replay* with an estimated return time on the program, side screens, and phones. Silence is the
  complaint, not the delay
- Done: **Talent view** (`/s/talent`): announcer tablet with the same numbers as the overlay, RP
  progress in words, and pronunciation notes that persist on the device
- Done: **"When do we play?"** (`/s/next`): per-team schedule on any phone, reached by a vendored-QR
  corner card on the side screens: no third-party QR service, works on venue LAN
- Done: **Clean second program** (`/s/program?mode=clean`): match screen only, no thirds or status
  cards, for a scouting/pit feed; shed first when the uplink degrades ([11](11-distribution.md))
- Done: **Dual-bus audio** ([06](06-hardware-and-network.md)): the event Spotify playlist plays
  in-house only, never to stream; MC/GA mics ride both buses. Copyright-safe VODs by construction
- Done: **Wide-shot lock**: autopilot cues can't cut the program away from the field mid-match;
  operator and replay cues still can
- Done: **Publish QC hold**: a cut whose length is implausible for what it claims to be is held
  rather than uploaded (the classic "the VOD is 4 seconds long" failure). Bounds are per kind,
  so a 40-minute awards ceremony is not held for being long
- Done: **Alliance selection board** (program screen `selection`): captains in seed order, the ranked
  pool graying out as teams are taken, and Cheesy Arena's own pick clock. The wire shape came from
  `generateAllianceSelectionMessage` in the 2026 source, and it arrives on the audience display
  socket we already subscribe to. The selection websocket itself stays forbidden: the scorekeeper
  runs selection, we only draw it
- Done: **Explainer loop** (program screen `explain`): six cards, twelve seconds each, in the gaps.
  What fuel is, why only one hub scores, why a losing alliance is celebrating. The newcomer
  complaint is not that the game is complex, it is that nobody ever says what the numbers mean
- Done: **Head referee review** (`/s/var`): frame-step the recording with no cut, no send to air, no
  publish, and no route to the field. Frames are grabbed with `send: false`, so nothing this page
  does can reach the broadcast. Only useful if CalGames adopts review; harmless if it does not
- Done: **Day-VOD chapters** ([chapters.ts](../apps/core/src/chapters.ts)): the event log already
  knows when every match started, so `GET /api/chapters` turns it into text that pastes into a
  YouTube description. YouTube's rules (0:00 first, three minimum, ten seconds apart) are
  enforced rather than discovered on a live VOD, because breaking one silently shows no chapters
- Done: **Award, ceremony and selection videos**: the operator marks both ends from the desk and the
  queue cuts them from the program recording. Teams ask for these and nobody records them
- Done: **Pick the winner**: a trivia round on the match that is up. The answer is unleakable by
  construction, since at the moment the question opens the match has not been played and no
  answer exists on the server either. It resolves from the posted score

- Done: **Alliance size is data, not a constant**: every surface that lists teams sizes itself off
  the array it is given. The overview grid takes its row count from the alliance, the score
  bar tightens its leading for a fourth line, the deck blocks on the venue TVs follow suit, and
  the social card recomputes its vertical rhythm. Team numerals scale against their own column
  with container queries, so a 5-digit rookie number in a four-up playoff alliance stops short
  of its neighbor instead of colliding with it. Cheesy Arena only ever fields three robots, so
  the fourth member of a playoff alliance is a backup: the seeds ride along on `match.loaded`
  as `redAlliance` / `blueAlliance` for the join against the selection rosters

Still open, and each for a reason. **Statbotics prediction** stays blocked upstream (`/v3` was
returning 500s again on 2026-07-30). **frc-colors accents** were considered and dropped: the WRRF
palette is mandated and alliance colors are reserved as semantic-only ([03](03-brand.md)), so
per-team colors on broadcast graphics would break the rule the rest of the system follows.
A full **colorblind pass** is a Friday task with the graphics on the actual projector, not a
code change, since every color-carrying element already has a non-color cue.

### P3: Nice to have, cut without regret

- OCR fallback for FMS live score
- Slow-mo frame interpolation
- Automatic TBA match-video upload
- Multi-camera synchronized replay (quad-split)

### The week of

Freeze code the **Monday before**, then build the launcher exe from the frozen tree and hand out
copies: getting the desk onto the AV machines is a double-click, not a git clone
([13-deployment.md](13-deployment.md)). Friday is for cable-labeling, the photo session, a full
end-to-end rehearsal during practice matches, and **30 minutes looking at every graphic from the
back row of the gym**. Nothing new ships Friday.

---

## Decisions (resolved)

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Field management system | **Cheesy Arena.** The `cheesy` adapter is the primary and only ingest path; the FMS adapter is not being built |
| 2 | Field bridge | **Approved.** Any software is fine as long as it can't interfere with Cheesy Arena controlling the field |
| 2b | Registering as a display | **In scope.** Unlocks live score, `score.delta`, and `arenaStatus` |

Rule 2 resolves to a hard endpoint allowlist. For five of the six sockets the guarantee is
structural rather than procedural: `HandleNotifiers` never calls `Read()`, so those endpoints
*cannot* process anything we send. The sixth, `/displays/field_monitor/websocket`, does have a
read loop behind a `?fta=true` gate; we keep it because it is the only source of robot-link
status, and we never set `fta` or send a frame, which tests enforce. The forbidden list is short and specific: `/match_play/*` (abort match),
`/panels/scoring/*` (game-piece scoring), `/panels/referee/*`, `/setup/*`. Full spec and the FTA
sign-off sheet: [10-field-bridge.md](10-field-bridge.md).

The one genuine interference vector left is **the host, not the API**. Cheesy Arena is a single Go
process that also runs the arena loop and PLC I/O, so nothing of ours ever runs on the FMS machine.

## Open decisions

| # | Decision | Why it matters | Default if nobody decides |
| --- | --- | --- | --- |
| 3 | Server language/stack | Affects who can contribute | TypeScript + Node: surfaces are already browser pages, and one language across the whole project matters more than raw performance at this scale |
| 4 | OBS or vMix | vMix has native replay/ISO; OBS is free and scriptable | OBS + separate rolling record. Revisit if an ATEM Mini Extreme ISO is in budget |
| 5 | Budget for the ATEM Mini Extreme ISO | It collapses the whole replay ingest problem into hardware | Ask WRRF early; ~$1200 and it outlives the event |
| 6 | Who owns the robot photo session | The alliance overview is worthless without it | Assign a named photographer by September; block 2 hours Friday |
| 7 | Are Smash/Mario Kart approved by the planning committee | Venue, hardware, and stream-audio implications | Raise it at the next planning meeting. It's their call, not ours |

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Venue power outage** | **High** (it happened in 2025 and killed the Sunday stream) | High | UPS on every production box; rolling record never stops; backup stream key pre-created and the fallback URL posted before the event |
| **Our software interferes with field control**, a stray connection to `/match_play` or `/panels/scoring`, or resource starvation on the FMS host | Low | **Severe** (the one way this project can damage the event and our standing with WRRF) | Endpoint allowlist as a constant with a failing unit test; `GET`-only HTTP client; nothing of ours ever runs on the FMS machine; exponential backoff with jitter; rehearsed kill switch. See [10-field-bridge.md](10-field-bridge.md) |
| `displayId` collision reconfigures a real audience display | Low | Medium | Reserved ID prefix agreed with the scorekeeper in writing, always passed explicitly, and one suffixed ID per socket so the five registrations cannot overwrite each other |
| Venue internet is poor or absent | Medium | Low to Medium | Cache team lists, avatars, and Statbotics data locally on Friday. Nothing on the critical path needs internet except the stream itself |
| Too few robot photos | **High** | Low | Tier-3 fallback (gold team number on a purple plinth) must look deliberate. Ship the screen with zero photos and improve it live |
| Volunteer crew smaller than planned | High | Medium | Minimum viable crew is 3. Every surface must be operable after 20 minutes of training |
| Telestrator Wi-Fi latency | Medium | Low | Dedicated 5GHz production AP, clear of the field AP. Wired fallback: a laptop with a trackpad works, badly but adequately |
| YouTube Content ID on game audio | Medium | **High** (can kill the whole VOD) | Game audio routed to venue only, never to the stream feed. Non-negotiable |
| **NVENC unavailable on the recording box**, since ffmpeg's required NVENC API outruns the installed NVIDIA driver | **High**, already hit it on the dev laptop (needs driver 610.00+, had 596.49) | Medium | Test a real encode, not a capability list. Update the driver or pin a matching ffmpeg build. `libx264 veryfast` works at 2.88× realtime for one 1080p60 stream, but that only covers 1-2 cameras |
| YouTube per-channel daily upload cap (separate from API quota) | Medium | Medium | Use WRRF's established, verified channel, not a new one. Stage uploads across the weekend; queue defaults to `deferred` |
| Uploads contend with the live stream for venue uplink | Medium | Medium | Upload mode defaults to `deferred`; measure the uplink Friday before switching ([11](11-distribution.md)) |
| Graphics unreadable in the room | Medium | Medium | The legibility spec in [08-motion.md](08-motion.md), where the overlay's venue-critical elements (score, clock, alliance) are its largest, plus the Friday back-row walkthrough |
| Scope creep in September | **High** | High | P3 is explicitly labeled "cut without regret." Freeze Monday |

## The honest assessment

The riskiest thing here isn't technical. It's that this is a lot of surface area for a volunteer
crew, and offseason events are staffed by people who are also doing five other things.

The design is deliberately ordered so the **most visually valuable pieces have the fewest
dependencies**. The alliance overview, the telestrator, and replay are P0 and need no field
integration at all. If P1 never lands and the whole weekend runs on manual input, CalGames still
gets a broadcast that looks dramatically better than a static camera and a scoreboard. That's
the actual goal.

Build P0 completely before starting P1.
