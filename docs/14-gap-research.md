# Program and standard roadmap

This is the synthesis of the August 2026 research sweep: what the content desk has to add to run an FRC event's whole *program* rather than just its broadcast, and what it has to add before another event can adopt and modify it. Everything below has been deduplicated across the six research areas, checked against the repo as it stands today, and ranked; the reasons an item was ruled out are recorded in [Not doing](#not-doing) so they do not get re-litigated in September. Sequencing assumes the event runs 16 to 18 October 2026 and code freezes Monday 12 October.

## How to read this

The sweep produced roughly ninety candidate items across seven areas. About a third were the same idea seen from different angles: "Companion module" and "physical button control" and "switcher abstraction" are one workstream with three faces; NDI appears twice with opposite verdicts; tally appears twice; captions appear four times; loudness appears three times. They are merged here and counted once.

Ranking is value to an event times evidence of demand, divided by effort, with two overrides. First, anything that puts a factually wrong statement on a 20-foot screen outranks anything that adds a feature, because the desk's program feed is replacing the audience display and a wrong ranking-point claim is worse than a missing graphic. Second, anything that gates other work is pulled forward regardless of its own value, which is why a LICENSE file sits at the top of a roadmap that is otherwise about broadcast software.

Two things are true of the repo today that shape the whole document:

- There is no `LICENSE`, no `NOTICE`, no `CONTRIBUTING.md`, no `SECURITY.md` and no `TRADEMARKS.md`, and `package.json` carries `"private": true`. Nobody can legally adopt or modify this, so every publishable-standard item is currently blocked behind a five-minute change.
- 62 files contain `CalGames`, `WRRF` or `Woodside` across 354 occurrences, and 42 raw six-digit hex colours live outside `packages/theme/tokens.css`. A palette swap today produces a fork that looks broken rather than rebranded.

Verdict shorthand used throughout: **program** means it serves running the event; **standard** means it serves adoption; **both** means it does real work on each axis rather than being claimed for both by association.

---

## Blockers: do these first, they gate the rest

### B1. The legal package: licence, notice, trademarks, governance

**What.** A three-way split at the repo root: a permissive licence for code (Apache-2.0 or BSD-3, both defensible), CC BY 4.0 for `docs/`, and an explicit all-rights-reserved carve-out for brand assets, plus `NOTICE`, `TRADEMARKS.md` stating what an adopter may call their fork, `CONTRIBUTING.md`, `SECURITY.md` and a one-page `GOVERNANCE.md`. Drop `"private": true`.

**Why.** Without it the second goal does not exist: nobody may adopt or modify the project at all. The comparative evidence is unusually clear. [Cheesy Arena's licence](https://raw.githubusercontent.com/Team254/cheesy-arena/main/LICENSE) permits off-season use and modification but states that "the modifications may not be redistributed without permission from Team 254", which is exactly why no community formed around the reference FRC field system despite it being the best one. [AdvantageScope's BSD-3](https://raw.githubusercontent.com/Mechanical-Advantage/AdvantageScope/main/LICENSE) names "Littleton Robotics, FRC 6328 (\"Mechanical Advantage\"), AdvantageScope" in its endorsement clause, which protects a project name without a trademark filing. `SECURITY.md` is not boilerplate here: `config.json` holds a YouTube refresh token, a TBA Trusted API secret, a start.gg token and the event PIN, and the software speaks to a field network under an FTA sign-off, so "where do I report a vulnerability" has a real answer nobody has written.

**Where.** Repo root. `package.json`.

**Effort.** Small. **Serves.** Standard, and it gates every other standard item.

**Caveat.** This needs a WRRF board conversation, not an engineering decision, because it decides what happens to the CalGames wordmark and the WRRF marks. Start that conversation this week; it is the long pole, not the files. Do not adopt a CLA: it will scare off student contributors for no benefit at this scale.

### B2. Add `schemaVersion` and `seq` to the DeskEvent envelope

**What.** Two fields on the envelope in `apps/core/src/types.ts`, written by `EventBus.emit`, before any more NDJSON exists in the wild.

**Why.** The envelope today is `id, ts, matchClock, source, confidence, type, payload` with no version, so a v2 has no migration story and a published schema has nothing to key off. `seq` is what lets a reconnecting client ask for events after N, which the existing 5,000-event ring in `bus.ts` can already serve. This is a one-line change with a large downstream payoff and it gets radically more expensive after CalGames 2026 logs exist as reference fixtures.

**Where.** `apps/core/src/types.ts`, `apps/core/src/bus.ts`.

**Effort.** Small. **Serves.** Both.

### B3. ~~Verify the ENERGIZED bonus RP threshold~~ — CHECKED, the desk is right

**Resolved 2026-08-11, before this document was committed.** The sweep flagged this
as urgent on the strength of [PitRadar's changelog](https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920),
which records "corrected from 100 to 240 points". Checked against the manual:
[frcmanual.com section 6, Game Details](https://www.frcmanual.com/2026/game-details)
gives **ENERGIZED 100 fuel, SUPERCHARGED 360 fuel, TRAVERSAL 50 tower** for
Regional and District events, which is exactly what `config.example.json`,
`apps/core/src/types.ts` and `surfaces/_shared/desk-client.js` already carry.
No change needed. Whatever PitRadar corrected, it was not this.

**One real thing survives the false alarm.** The manual adds that "BONUS RP
thresholds for District Championships and FIRST Championship will be announced
in Team Updates", so these numbers are explicitly per-event-tier and mutable
mid-season. That is the reason [09-roadmap-and-risks.md](09-roadmap-and-risks.md)
made them config rather than constants, and it is worth keeping that way: an
off-season is free to move them, and CalGames should confirm which set it is
scoring against on Friday rather than assuming.

**Effort.** Done. **Serves.** Program.

### B4. One decision: is CalGames on Nexus?

**What.** A single ops decision, made once, before any of the four Nexus-dependent features are scheduled.

**Why.** Four separate research items (queue lifecycle and per-station lineups, pit map wayfinding, inspection alerts, announcement mirroring) are all gated on the same fact, and [Nexus's own API docs](https://frc.nexus/api/v1/docs) state plainly that "Live event status is only available for events that are using Nexus to manage queuing". Their [event-manager guide](https://guides.frc.nexus/roles/event-manager) says to register an offseason at least a week ahead. If WRRF is not registering and staffing a Lead Queuer, all four items drop off the roadmap and roughly two weeks of work goes elsewhere.

**Effort.** Zero code. **Serves.** Program.

### B5. ~~One decision: how many people are actually running this?~~ — ANSWERED

**Answered 2026-08-11: three.** A desk manager (all software, plus the camera cut), an on-air
talent (mics and cameras first, then analysis and interviews), and a field tech (field bridge,
OBS, scorekeeping, and fixing whatever broke). Written up as a design constraint in
[06-hardware-and-network.md](06-hardware-and-network.md#crew-three-people-and-one-of-them-is-on-camera).

The crew-profile feature below is therefore NOT being built: profiles exist to describe a crew
that varies, and this one does not. What survives is the discipline it was meant to impose, and
it is now the first question asked of every item in this document: *who operates it, given that
the desk manager is also cutting cameras and the talent is on camera?* Several items were reshaped
by that question and a few died of it.

The original write-up follows, because the reasoning still applies to an event adopting this repo
with a different crew.



**What.** Name the crew, then ship named crew profiles in config (one person, three, six) that disable, auto-pilot or merge surfaces rather than presenting a dark console for every role nobody filled.

**Why.** The desk is already twenty surfaces and this roadmap proposes more, while an offseason media room is typically two to four volunteers recruited weeks beforehand, some of them students who have never seen the software. [IRI's media room recruits by open call](https://www.chiefdelphi.com/t/509538/63) and enumerates a handful of roles; [CalGames recruits volunteers through a single Google Form](http://www.calgames.org/) with no role-capacity model behind it. This is the refusal reason nobody in the sweep listed: an adopting event does not evaluate the feature list, it evaluates whether the two people it can find can run it. It also disciplines the rest of this roadmap, because every item below has to survive the question "who operates it".

**Where.** `config.json`, launcher prompt, per-surface "off because profile X" state.

**Effort.** Medium as software, small as a decision. **Serves.** Both.

**Caveat.** Profiles that silently disable surfaces get blamed for "the feature is broken". Every disabled surface must say why it is off and which profile turns it on, and the profile must be changeable mid-event when a volunteer finally shows up.

---

## Axis 1: running the whole event program

### 1a. Correctness on air

These are the items where the desk currently says something false, or will. They are all small. They outrank everything else in this document.

#### 1. Surrogate and disqualification flags

**What.** Thread Cheesy Arena's per-station surrogate flags (`Red1IsSurrogate` through `Blue3IsSurrogate` on the `Match` model) and head-referee DQ state through the match event, then suppress or re-word the RP threshold icons, the analysis strap, `/s/talent`'s RP progress, `/s/next` and pick-the-winner for that team-match, and mark the station on the alliance overview.

**Why.** §10.5.2 of the [2026 Game Manual](https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf) defines a surrogate as a team randomly assigned an extra qualification match, always their third, flagged on the schedule; §10.5.3 states a surrogate receives 0 ranking points, as does a disqualified team. The string `surrogate` does not appear anywhere in this repository (verified: zero matches). Without the flag the broadcast tells a surrogate team's parents that a ranking point is on the line when it structurally is not. This happens at nearly every event whose team count is not divisible by six, and the upstream system is already handing us the flag.

**Where.** `apps/core/src/ingest/cheesy/protocol.ts`, `adapter.ts`, `state.ts`, then the RP-rendering paths in `surfaces/_shared/rp.js`.

**Effort.** Small. **Serves.** Both.

**Caveat.** An offseason running its own schedule generator may not set the flags at all, so the desk must distinguish "not a surrogate" from "source did not say" and degrade to neutral wording rather than asserting RP consequences.

#### 2. Card ledger and the mandated CARD indicator

**What.** A per-team card standing in `state.ts` with the manual's clearing rules, rendered as the indicator the manual requires on the alliance overview, the in-match scorebug, `/s/side`, `/s/talent` and `/s/next`.

**Why.** §6.6 of the [2026 Game Manual](https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf) makes this a mandated audience-display element: once a team receives a yellow or red card, a yellow rectangle shows next to the team number on the audience display during subsequent matches including replays, a second yellow auto-converts to red, and cards clear at the conclusion of Practice, Qualification and division Playoff matches. The desk already ingests the data: `adapter.ts:463` emits `card.issued` from Cheesy Arena's `RedCards`/`BlueCards` map. The only consumer in the entire repo is `markers.ts`, which files a replay marker. Nothing renders it and nothing persists it across matches. A head referee or FTA can legitimately refuse an overlay that drops a rules-mandated indicator, and the sanctioned-event compliance mode in §2c cannot claim compliance without it.

**Where.** `apps/core/src/state.ts` (new ledger), the alliance overview and scorebug in `surfaces/program/program.js`, `surfaces/side`, `surfaces/talent`, `surfaces/next`.

**Effort.** Small. **Serves.** Both.

**Caveat.** Card state is head-referee-authored and revisable during deliberation. Render it with the same "posted, not provisional" latch the score reveal uses, and give the desk an override.

#### 3. Result amendment: corrections have to chase every artifact

**What.** A `result.amended` event, an artifact lineage index recording every derivative produced from a match (social card, cut clip, TBA `match_videos` push, wrap-show entry, storyline factlet, locker row), and an operator flow that re-renders or retracts each one and puts a correction strap on air.

**Why.** [Cheesy Arena's match review handler](https://raw.githubusercontent.com/Team254/cheesy-arena/main/web/match_review.go) edits already-committed scores and calls `commitMatchScore(match, &matchResult, true)`, persisting a revised score for a completed match. By the time that happens the desk has already published. Score corrections are routine rather than exotic: an [offseason organiser publicly corrected points after the fact](https://www.chiefdelphi.com/t/362460/26), and [FIRST has published mid-season scoring adjustments](https://www.chiefdelphi.com/t/497230/1). The sweep proposed a TBA reconciler that verifies what the field system claimed it published landed; nobody covered the inverse and more damaging case, where the desk published something correct at the time and the truth changed underneath it. This is also the lineage index the takedown ledger needs anyway, so build it once.

**Where.** `apps/core/src/publish/queue.ts` (`QueueItem` already carries `sourceId`, `ranges`, `matchKey` and `videoId`; the missing piece is the reverse index), plus a new `result.amended` DeskEventType.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Always re-render, never auto-delete. A mis-click in match review must not be able to unpublish a YouTube video; any retraction requires a human confirm and a dry-run listing.

#### 4. Playoff lineups, backup teams, and the backup pool

**What.** A head-referee/desk surface that captures the lineup an alliance submits (which three of four play, in which driver station), records backup-coupon use, and holds the backup pool; emitting a `lineup` event that the overlay, post-match cards, auto-cut naming and the TBA push consume instead of the alliance roster.

**Why.** §10.6.3 and §10.6.4 of the [manual](https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf): a playoff alliance can be four teams; lineups naming three players and their driver stations are due in writing to the head referee two minutes before the match (T613); backup coupons are paper, name the replaced team, are initialled by the captain, are one per alliance, cannot be withdrawn and cannot be used for replays; and the backup pool is assembled right after alliance selection by the lead queuer polling remaining teams in rank order until up to eight accept. Without this the overlay names the wrong three teams during the most-watched matches of the weekend, and shows three teams for a four-team alliance whose fourth member is standing on the awards stage as a winner.

**Where.** New gated surface; `UpcomingMatch` in `types.ts`; `publish/naming.ts`.

**Effort.** Medium. **Serves.** Program.

**Caveat.** This sits next to a head-referee decision under time pressure. If it is slower than paper it will be abandoned mid-playoffs. One-handed, under twenty seconds, and never blocking the match if skipped.

#### 5. Alliance selection as a rules engine, not a board

**What.** A selection state machine driving the existing board: strikethrough on declined team numbers, the explicit exemption for teams highlighted orange because they would still become a captain, pick-clock reset and restart on a decline, T605 violations and the revisit queue in violation order, and the two-minute break between rounds; ending by running the backup-pool poll.

**Why.** §10.6.1 of the [manual](https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf) specifies all of it as audience-display semantics. Grepping this repo for `declin` returns nothing. Alliance selection is fifteen unbroken minutes of live television where the graphic is the only record anyone in the room can see, and the mistakes are unrecoverable on air. `docs/12` flagged that alliance selection had no broadcast support and the board was built; what was never captured is the set of rules governing what the board must show and when the clock restarts.

**Where.** `apps/core/src/state.ts` plus the `selection` screen in `surfaces/program`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** An offseason may deliberately run a simplified selection with no backup pool and a shorter clock. Make it configurable down to "just a board" or adopters will fight it.

#### 6. Practice day and the filler line

**What.** A queuer-facing surface that assigns six teams to stations live, emitting the same `lineup` event the playoff work needs; and downstream surfaces that tolerate "practice, unscheduled".

**Why.** §10.4.1 of the [manual](https://firstfrc.blob.core.windows.net/frc2026/Manual/2026GameManual.pdf) defines a filler line used to fill open practice slots, or *all* slots at events with an open practice schedule, first come first served. Offseasons very commonly run fully open practice, which means the six teams on the field are chosen at the field moments before the match. Every surface here assumes a scheduled match with six known teams. Practice day is the first several hours the program feed is live, and the first impression an adopting event gets of the software, and it is the one block of the weekend where the desk's core assumption is structurally false. Note also that the filler line has an eligibility gate: [teams must generally pass inspection before non-scheduled practice](https://www.chiefdelphi.com/t/461035/1).

**Where.** New surface plus the shared `lineup` event from item 4; graceful "unknown teams" render in `program.js` and `surfaces/side`.

**Effort.** Medium, and most of it is shared with item 4. **Serves.** Program.

#### 7. Ranking tiebreak order as a typed constant

**What.** Pin `["RP", "Match", "Auto Fuel", "Tower"]` as a constant with a rankings comparator and a golden fixture, and have `/s/talent` say it in words.

**Why.** `RankingRow` in `types.ts` carries `rankingPoints`, `record` and `played` and nothing about how ties break, so the announcer tablet cannot explain why a team is ranked where it is. Verified in [Cheesy Arena's TBA publisher](https://github.com/Team254/cheesy-arena/blob/main/partner/tba.go): `breakdowns := []string{"RP","Match","Auto Fuel","Tower"}` at line 409. Note for the record that the sweep's framing of this as a score-breakdown contract risk was wrong: the desk reads Cheesy's websocket `ScoreSummary`, not TBA's `score_breakdown`, and `protocol.ts` already transcribes the Go field names correctly. The tiebreak order is the part that is genuinely missing.

**Where.** `apps/core/src/ingest/cheesy/protocol.ts`, `surfaces/talent`, one fixture in `cheesy.test.ts`.

**Effort.** Small. **Serves.** Program.

### 1b. Nothing goes missing

#### 8. Coverage reconciliation ledger

**What.** One table keyed by *scheduled match number* with a column per stage: recorded segment, auto-cut, QC state, uploaded video id, TBA link, public URL resolves. Red for any gap, gaps first, an unaccounted-for count, and an end-of-day export.

**Why.** This is the highest-leverage item in the whole roadmap for goal 1. `publish/queue.ts` is a list of items that *entered* the queue, so it is structurally incapable of seeing the match that never entered. The failure it catches is verified and recurring: [whole blocks of matches went missing at multiple 2024 events](https://www.chiefdelphi.com/t/missing-event-videos/458269) ("At Kettering 2 (FIM) Q55 - Q80 are missing"; "Q1-7 and Final2 from FNC UNC Pembroke"; Mt. Olive with "less than 50% of official quals videos posted, and no elims"), and every one was discovered by teams afterwards rather than by operators during the event. The Cheesy REST poll already brings the schedule in for the side screens, so the join key exists. This converts a silent loss into a loud one while the crew is still in the room.

**Where.** New `apps/core/src/ledger.ts` joining the schedule poll against queue items and TBA link results; panel on `/s/desk`; `GET /api/ledger`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Gate red on "match ended more than N minutes ago" where N comes from `pace.ts`'s median cycle, or it screams all morning.

#### 9. Recording liveness and real QC

**What.** On `match.start` with no recorder output active: start the fallback recorder, raise a red alarm, log it. Extend `qcHold` to take an ffprobe *stream* summary rather than duration alone, and derive tolerance from the logged match clock instead of the flat `QC_BOUNDS` constant.

**Why.** Correcting the sweep on one point: `publish/queue.ts` already re-runs `qcHold` on the probed duration of the produced file, with a comment noting that the probed duration is the truth, so the eleven-second-video class is already caught. What remains is genuinely absent and matters. Nothing correlates `match.start` with recorder liveness, so a camera that died at 9am is discovered at 4pm. QC is duration-only, so a file with video and no audio, or a black zero-bitrate file, passes; that is precisely the present-but-invalid class in the missing-videos thread. And `GetRecordStatus.outputActive` is [available on the obs-websocket socket the desk already holds open](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md).

**Where.** `apps/core/src/recorder.ts` (add a `match.start` subscriber), `apps/core/src/publish/queue.ts`.

**Effort.** Small. **Serves.** Program.

#### 10. Disk guard with hours-remaining and a clean roll

**What.** Measured bytes per minute per recorder, hours-remaining on the vitals board, warnings at two hours and one hour, and at a hard floor a clean finalize, a roll to a secondary path, then shedding ISO recorders to protect the program record. Plus a reaper for published, QC-passed segments older than a retention floor.

**Why.** Neither `recorder.ts` nor `ffmpeg.ts` reads free space and nothing reaps. A three-day multi-camera rolling record is exactly the workload that fills a laptop SSD by Saturday afternoon. `recorder.ts` already knows the graceful-close trick (`q` on ffmpeg's stdin, with a comment that a kill leaves the last file unplayable), so the ordered-shutdown machinery exists and needs a trigger. `GetStats` exposes `availableDiskSpace` for the encoder machine over the socket already open.

**Where.** `apps/core/src/recorder.ts`, surfaced on the vitals board.

**Effort.** Small. **Serves.** Program.

**Caveat.** The reaper is the dangerous half: require published AND QC-passed AND older than the floor, dry-run at the first event, and emit a DeskEvent per deletion so a missing file has an explanation.

#### 11. Load-out: a verified media offload gate

**What.** A tear-down gate: every camera card and every rolling recording verified by checksum into two locations before anything is reformatted or leaves the building, plus a case and asset manifest checked back in, a tear-down run-of-show, and a printed sheet naming exactly what is still unverified.

**Why.** The plan currently stops at the last match. The single unrecoverable failure of an event weekend is losing footage during tear-down, when the crew is exhausted, the lights are going off, and cards get reformatted to free space. Every other failure in this document is recoverable by replaying the log; this one is not. [ASC's Media Hash List](https://raw.githubusercontent.com/ascmitc/mhl/master/README.md) formalises exactly this chain of custody "from the media's initial download on set, all the way through to final archival", and is the right model to copy at a much smaller scale. Load-out is also the moment borrowed gear disappears, which determines whether a host lends equipment to the next event. [Volunteers already treat field setup, competition and teardown as three distinct staffed phases](https://www.chiefdelphi.com/t/431548/17).

**Where.** New print route plus a hash worker beside `recorder.ts`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Hashing hours of footage on a laptop at 9pm is slow enough that the crew will skip it. Run it continuously during the day against the rolling recordings so load-out verifies work already done.

### 1c. The show does not die quietly

#### 12. Doors-open preflight, including a proved network path

**What.** A `/s/preflight` surface that walks OBS scenes and capture sources by name, audio levels, disk headroom, YouTube token validity, the field bridge and registered displays, PIN state, log writability, and media coverage; refuses "ready" until each is green; emits a board plus a printable sheet the lead signs; and is re-runnable in thirty seconds mid-day. It includes a network row that *proves* reachability: the desk connects to itself over its LAN IP, and a volunteer scans a QR that reports back.

**Why.** Genuinely absent and it is the most adoption-shaped item on the program axis. The launcher does exactly two checks (Node present, one GET to Cheesy `/api/rankings`); the ingredients for the rest are scattered across `/api/stream`, `/api/cheesy`, `/api/recorder` and `/api/publish` and nothing rolls them up, prints or logs. Volunteers already expect this ritual: [FMS's own scorekeeper Day-0 page](https://fms-manual.readthedocs.io/en/latest/scorekeeper-reference/step-by-step/setup.html) is a sixteen-step numbered checklist including "Check that the FMS is connected to the internet", a Field Test where "All component LEDs should be Green", a Match Test coordinated with the FTA, an audio test and staging printer paper. And the crew running it has [no pre-event training and is told to "Follow direction from event technical leads or A/V contractors"](https://www.firstinspires.org/community/volunteers/roles/audio-visual-crew), which an offseason does not have. The network proof matters specifically here because Cheesy Arena binds the field network at 10.0.100.5, so the desk machine routinely sits on two subnets and the address it prints may be the wrong one; a loopback test proves nothing about the case that actually fails.

**Where.** New `apps/core/src/preflight.ts` aggregating the existing probes; new `surfaces/preflight/`; invoked by the launcher before it prints READY and re-runnable from `/s/desk`; print view reuses the 1080-card render path in `surfaces/_shared/card.js`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Do not include a sustained upload test in the default run. It collides head-on with the settled rule that uploads never compete with the live stream (`publish.mode` defaults to `deferred` for exactly this reason). Make it a separate, explicitly armed action that refuses to run while `matchStartedAt` is non-null.

#### 13. Desk vitals, with the audio watchdog folded in

**What.** A two-second-tick subscriber rendering one aggregate "is the show OK" light plus drill-down over bus lag, per-source heartbeat age, OBS `GetStats`, `GetRecordStatus`, YouTube `liveStreams` health, queue depth and clock offset, emitting every state change as a DeskEvent. Includes audio: `GetInputMute` and `InputMuteStateChanged` on the announcer and field inputs, plus `silencedetect` and an EBU R128 measure on the program record tap, alarming on mic-muted-during-match, bus silent during AUTO/TELEOP, and loudness drift.

**Why.** The pieces exist and nothing aggregates: three endpoints, no screen over any of them, and `docs/11` says so outright. `cue/obs.ts` is deliberately write-only, identifying with `eventSubscriptions: 0`, so `cpuUsage`, `availableDiskSpace`, `renderSkippedFrames` and `outputSkippedFrames` are sitting unread on a socket the desk already holds, and every audio fault is invisible. [The obs-websocket protocol](https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md) confirms `GetStats`, `GetRecordStatus`, `GetInputMute` and `InputMuteStateChanged` all exist; [YouTube's liveStreams resource](https://developers.google.com/youtube/v3/live/docs/liveStreams) confirms `healthStatus` and named `configurationIssues` including `videoIngestionStarved` and `noAudioStream`. The audio half matters more than it looks because the house/stream split makes silent-stream failure *more* likely: `docs/06` builds the stream bus as a mix-minus aux the operator is not monitoring, so nobody in the room hears it fail, and [viewers have reported stream faults the on-site crew did not notice](https://www.chiefdelphi.com/t/webcast-operators-please-include-the-net/497409).

**Where.** New `apps/core/src/vitals.ts` emitting `vitals.updated`; the first change to `eventSubscriptions` in `apps/core/src/cue/obs.ts`; strip on `/s/desk`, page on `/s/remote`, full board on a spare monitor.

**Effort.** Medium (one workstream; three items in the sweep). **Serves.** Both.

**Caveat.** Poll `GetStats` slowly (5 to 10s): polling a loaded encoder hard is how you cause the problem you are measuring. Gate the silence check on match state and suppress it outside AUTO/TELEOP, or it fires during a moment of silence and gets muted for the weekend.

#### 14. Program dead-man slate

**What.** `/s/program` heartbeats internally; after N consecutive missed beats it paints its own slate. Recovery requires one deliberate click so a flapping surface cannot strobe the broadcast.

**Why.** The built status cards cover "desk healthy, field is not". Nothing covers "the desk is the casualty", which is the case with no plan. The risk register already rates venue power outage High/High because it happened in 2025 and killed the Sunday stream, and [FIM Mt Pleasant lost all power mid-match](https://www.chiefdelphi.com/t/fim-mt-pleasant-event-power-outage/515742) for hours. Rejecting the sweep's mechanism: a separate watcher process driving OBS fights the volunteer double-click model and the single-OBS-client design. The page is already loaded as a browser source, so let it paint its own slate; that survives the desk process dying, which the watcher variant barely does better.

**Where.** `surfaces/program/program.js`, `surfaces/_shared/desk-client.js`.

**Effort.** Small. **Serves.** Program.

**Caveat.** Count consecutive missed beats, not elapsed time. A two-second threshold fires on a GC pause and puts a slate up mid-match. Tune against a full `harness-offline.mjs` run.

#### 15. Replay-on-boot state recovery

**What.** On start, replay the NDJSON log to restore current match, screen, media assignments, marks and QC state, re-arming nothing, with a recovery banner. Relaunch recorders into new numbered segments rather than resuming.

**Why.** Half-built, and the missing half is cheap because the architecture already pays for it: `bus.replay()` exists and is exercised by `npm run replay`, the publish queue reloads from disk, and `index.ts` already keeps the show up on a post-boot `uncaughtException`. What is absent is using replay at boot, so a crash at 2pm loses the current match, screen and marks. Restarting services was [the mid-event remedy in FIRST's own Newton postmortem](https://community.firstinspires.org/2026-newton-match-timing-what-happened-and-whats-next), and machines came back cold after the Mt Pleasant outage.

**Where.** `apps/core/src/bus.ts`, `apps/core/src/index.ts`.

**Effort.** Medium. **Serves.** Program.

**Caveat.** Restore read-only state only. Never restore armed cues (they start disarmed by design), never auto-resume a stream to a stale broadcast id, never auto-take program. Do not add a Windows service or startup entry: `docs/13` has an explicit "What the launcher deliberately does not do" section and the launcher already owns relaunch through its kill-on-close job object. Test by killing the process mid-run of `harness-offline.mjs`.

#### 16. Latching all-surface emergency and safety announcement

**What.** One operator action that takes over every surface simultaneously with a high-contrast safety message, ducks venue music, and latches until explicitly cleared, with pre-authored templates for evacuation, medical hold, weather hold, lost child and hands-off-robots.

**Why.** `StatusCard` in `types.ts` is `'delay' | 'review' | 'fault' | 'replay' | 'custom'` with a `backAt` estimate: informational, non-latching, scoped to match state, and it does not touch audio. [Nexus announcements](https://guides.frc.nexus/guides/announcements) are pit-admin authored, capped at four active, and reach team dashboards, the pit display and opted-in Slack/Discord, with no broadcast, no venue TVs, no priority and no takeover. So there is genuinely no path at a Cheesy-Arena offseason to put one message on every pixel in the building. The desk is the only component that owns every surface, and now that `apps/core/src/audio/` is committed it owns the house music bus too, so the duck is a call it can already make. A venue safety plan is a normal condition of a school facility agreement.

**Where.** A new latching kind alongside `StatusCard` in `types.ts`, rendered by every surface including the open ones; fires the existing `duck()` in `apps/core/src/audio/store.ts`.

**Effort.** Small. **Serves.** Program.

**Caveat.** Same discipline as the cue engine: PIN-gated, never reachable from an open surface, two-step confirm, and an audible reminder while latched.

#### 17. Broadcast pinning and one step-down macro

**What.** Set `enableAutoStop` off on the YouTube broadcast so a sixty-second dropout does not end it and orphan the URL already registered on TBA, and add one desk macro that steps the encoder down and fires the matching status card together.

**Why.** This is the scoped-down version of the "automatic degraded-mode ladder". The runbook already exists as prose in `docs/11` with five numbered moves and `docs/12` books it as built. The full ladder is the largest and riskiest item in the sweep and it cuts against this project's grain (per-cue arming, cues start disarmed, operator in the loop). Pinning the broadcast is small, protects an asset `docs/11` already owns, and removes the worst outcome. The macro removes the "read the runbook while queueing the next match" problem without handing a live broadcast to an automaton.

**Where.** `apps/core/src/publish/youtube.ts`, `surfaces/desk`.

**Effort.** Small. **Serves.** Program.

**Caveat.** Never auto-step-up. Announce every step-down on air, or viewers conclude the event got worse rather than the pipe.

#### 18. Independent match-clock check and a single desk time authority

**What.** Measure observed AUTO/TELEOP durations from the field-bridge stream against expected and flag deviations to `/s/desk` and the FTA audit log. Separately, make the desk the single time authority on its LAN: serve an offset that surfaces and recorders apply, never set system clocks.

**Why.** Both halves are absent and both are cheap here because the log is already dual-clocked and the desk is already an independent observer with its own timestamps. FIRST's [Newton postmortem](https://community.firstinspires.org/2026-newton-match-timing-what-happened-and-whats-next) verifies the whole chain: the 2026 timer rewrite moved from absolute to relative decrement messages, overload accumulated error, a team's *scouting data* surfaced it, and the ongoing control is monitoring logged match durations, which is exactly this check. The time-authority half matters for a different reason: `recorder.ts` aligns segments to wall clock with `-segment_atclocktime` and `clips.ts` does filename-to-start-time math, so a recorder whose clock disagrees with the log cuts in the wrong place, and an isolated field network has no route to NTP.

**Where.** `apps/core/src/clock.ts`, `apps/core/src/recorder.ts`, `GET /api/cheesy/audit`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Say plainly in the docs that CalGames runs Cheesy Arena, whose timer is a different implementation from the one that failed on Newton, so this is motivated by that incident but does not predict the same bug. Correlate against bridge stop reasons before flagging, or an e-stop reads as a defect.

### 1d. The day as data

#### 19. Run-of-show engine

**What.** A versioned run-of-show file where every line is a timed item, a cue, or an emcee read, bound to `pace.ts` so downstream clocks re-estimate as the day drifts; rendered to `/s/desk`, `/s/talent`, `/s/side` and a printable PDF. Immovable items (anthem, VIP, venue curfew) pin hard.

**Why.** This is the spine of the one-stop-shop axis: awards, sponsors, breaks, safety and the debrief all hang off it. No run-of-show, rundown or ceremony concept exists anywhere in the repo, and the gap is structural rather than incidental. [Cheesy Arena's complete report set](https://raw.githubusercontent.com/Team254/cheesy-arena/main/web/reports.go) is rankings, backup teams, coupons, schedule, teams, WPA keys, alliances, bracket, cycle time, FTA notes and judging schedule: no announcer report, no award script, no lineup cards. [FMS generates an "Award Script Day 1" and "Award Script Day 2"](https://wpilib.screenstepslive.com/s/fms/m/eventmanager/l/607901-reports) described as a script for emcee and announcer, plus an Announcer's Report. So an offseason choosing Cheesy Arena silently loses the one show-script artifact an official event gets for free, and [organisers ask each other for ceremony scripts on Chief Delphi](https://www.chiefdelphi.com/t/script-for-opening-ceremonies-for-offseason-event/162541). CalGames itself already publishes this object: the [2025 thread](https://www.chiefdelphi.com/t/calgames-2025-oct-3-5/502690) carries a minute-by-minute schedule across all three days naming Field & Pit Setup, Pits Open, Practice Matches, Opening Ceremonies, Quals, Lunch, Awards, Alliance Selection, Playoffs, Pits Close and Clean-up. It exists as a forum post and a printout, and the desk is the only thing at the event that knows when it is slipping.

**Where.** New `apps/core/src/rundown.ts` consuming `pace.ts`, emitting `rundown.updated`; renders to `surfaces/desk`, `surfaces/talent`, `surfaces/side`, plus a print view.

**Effort.** Medium to large. **Serves.** Both.

**Caveat.** Advisory only. It must never auto-advance the field or argue with the FTA, and any gap-fill must obey the existing per-cue arming contract. Read Cheesy's `setup_breaks` state via the `matchLoad` payload the desk already receives rather than restating the break schedule. Resist growing it into volunteer management.

#### 20. Drift-aware break and lunch clock

**What.** Bind Cheesy Arena's scheduled breaks to the existing pace model and publish live estimates for lunch, end of quals, alliance selection and awards to venue screens, phones, and a read-only link for the food vendor.

**Why.** The cleanest win on the program axis: the estimator exists, the surfaces exist, and the delta is narrow and genuinely absent. `pace.ts` currently feeds match starts only, and the three moments everyone in the building plans their day around are not re-estimated at all. [Cheesy Arena models breaks](https://github.com/Team254/cheesy-arena/tree/main/web) (`setup_breaks.go`), and `MatchLoadMessage` in `protocol.ts` already carries `BreakDescription` and `BreakNextMatchName` on the audience socket the desk is already subscribed to, so no new field-bridge path is needed. [Nexus's queuing guidance](https://guides.frc.nexus/guides/queuing) makes the point that predictability rather than earliness is the value, and the [Volunteer Coordinator role](https://www.firstinspires.org/community/volunteers/roles/volunteer-coordinator) owns meal breaks and meal counts.

**Where.** `apps/core/src/pace.ts` extended to non-match anchors; renders on `surfaces/side` and `surfaces/next`; vendor link is a new open, read-only route carrying times only.

**Effort.** Small. **Serves.** Program.

**Caveat.** A confident lunch time that slips 25 minutes is worse than nothing. Publish a range that widens after any hold. The vendor link carries times and nothing else, consistent with the project's no-sensitive-data-in-query-strings rule.

#### 21. Awards as data, with a real embargo

**What.** An awards config, an embargoed winner-entry surface only the Judge Advisor can write, auto-generated read scripts with pronunciation and presenter, a ceremony sequencer, and certificate/engraving/presenter-card output generated the moment winners are entered.

**Why.** `docs/12` covered the *graphics*; the workflow, the embargo boundary and the script generation are absent. [Cheesy Arena's Award model](https://raw.githubusercontent.com/Team254/cheesy-arena/main/model/award.go) is exactly `Id/Type/AwardName/TeamId/PersonName` with `JudgedAward/FinalistAward/WinnerAward` and only get and post handlers: no citation, no script, no ceremony state, no printable artifact. [FIRST's award entry portal](https://frc-events.firstinspires.org/awardentrysystem/eligibility/BCVI) is scoped to official events, and [offseasons run judged awards with custom names and volunteer-fabricated trophies](https://www.chiefdelphi.com/t/judged-awards-at-off-season-competitions/443234).

**Where.** New `apps/core/src/awards.ts` plus a gated `surfaces/awards/`; feeds the existing `awards` SEGMENT in `publish/naming.ts`; certificate template lives under `packages/theme/` so it swaps with the palette.

**Effort.** Medium. **Serves.** Both.

**Caveat.** The embargo cannot be a UI hide. This project's defining property is an append-only replayable NDJSON log, so a winner payload written to the bus before reveal is recoverable by anyone who can run `npm run replay`. That needs a redaction rule inside `EventBus.emit`, not a surface guard, and any generated certificate must be written to a directory excluded from every `OPEN_PREFIXES` entry in `access.ts`, the way `/clips/` already is. Paper entry with a scribe must stay supported.

#### 22. Offline fallback pack: print what Cheesy Arena does not generate

**What.** A one-click PDF bundle: Announcer's Report, lineup cards, head-ref tracking sheet, award scripts, run-of-show, volunteer post sheet, team-by-team schedule; each stamped with generation time and "valid through match N".

**Why.** [FMS produces all of them](https://wpilib.screenstepslive.com/s/fms/m/eventmanager/l/607901-reports) (the Announcer's Report is "detailed report all team details for each match"; Lineup Cards; Head Referee Tracking Sheet; Award Script Day 1 and 2). [Cheesy Arena implements none of them](https://raw.githubusercontent.com/Team254/cheesy-arena/main/web/reports.go). The delta over `/s/talent` is real: `/s/talent` is a live surface that dies with the network or the tablet battery, and it never covered head-ref or lineup paperwork, which is what an experienced volunteer asks for by name at check-in. Cheap here because the desk already holds schedule, rankings, teams and pronunciation in `DeskState` and already renders cards.

**Where.** New print routes rendering from `DeskState`, the rundown and the awards data; reuses `surfaces/_shared/card.js`. Degrade to PDF-on-a-tablet where there is no printer.

**Effort.** Small. **Serves.** Both.

**Caveat.** The "valid through match N" stamp is load-bearing, not decoration. Stale paper at a scoring table is worse than no paper.

#### 23. Roster of record

**What.** A roster import (CSV or Sheets) feeding a check-in surface and one roster of record every other surface keys off, with non-canonical identities treated as a supported case: no TBA key, no avatar, no rank history, possibly a duplicate 9999. Render a sane fallback and hard-block TBA publishing rather than pushing a bad key.

**Why.** This is the first thing an event actually does and the last thing the plan models. [CalGames registers teams and volunteers through Google Forms with a separate store cart](http://www.calgames.org/) and points at The Blue Alliance for teams and results, none of which the desk can see. [9999 is officially a Test Team number and offseasons temporarily assign it](https://www.chiefdelphi.com/t/456218/3) to pre-rookies and teams without a permanent number, so duplicate and non-canonical identities are normal rather than exotic. It is also the root cause of a whole class of downstream nulls: `/s/next`, the media locker, social cards, avatars and the talent tablet all key on team number and all break the same way on the same three teams.

**Where.** New import plus `Team` in `types.ts`; gate in `publish/tba.ts`.

**Effort.** Medium. **Serves.** Program.

**Caveat.** Registration data contains minors' names and contact details. Keep the roster of record to team-level fields and leave person-level data in the registration system. Importing the whole form drags the desk into a much higher privacy tier than match data.

#### 24. Sponsor recognition ledger and proof of performance

**What.** Sponsor inventory in config driving lower-third rotation, the `/s/side` scroll, a pit-monitor ticker, a presented-by strap on non-match segments and read prompts on `/s/talent`. Every placement logged, then a per-sponsor report of times shown, on-air seconds, reads delivered and venue-screen minutes, each fulfilment linked to its VOD chapter timestamp.

**Why.** Nothing in the repo touches sponsors at all, and `docs/12` never raised it across 42 findings, yet the money is verifiably sold against named visible things: [FIRST Robotics California sells "a Premier or Core Space like the Competition Field, Team Pits, Volunteer Lounge, Safety Glasses"](https://cafirst.org/sponsor/) and brand visibility on banners, materials, websites and social channels, and CalGames itself is ["presented by Woodside High School"](https://www.chiefdelphi.com/t/calgames-2025-oct-3-5/502690). [Cheesy Arena has `setup_sponsor_slides.go` and `setup_lower_thirds.go`](https://github.com/Team254/cheesy-arena/tree/main/web) with no obligation or fulfilment tracking, and Nexus has nothing here. The desk has a structural advantage nothing else in the building has: it is already recording the program feed, already uploading with day-VOD chapters via `chapters.ts`, and already records `firedAt` per cue. So "prove the read happened and link to the frame" is largely a join over data the system keeps. And the existing allowlisted, unread `/api/sponsor_slides` endpoint means zero duplicate data entry.

**Where.** New `apps/core/src/sponsors.ts`; obligations are cues in `cue/engine.ts`; the report joins against `chapters.ts`; the slide feed lands in `ingest/cheesy/adapter.ts` plus a `surfaces/side` rotation slot.

**Effort.** Medium. **Serves.** Program.

**Caveat.** Only count what a surface acknowledged rendering, or the report becomes a liability in a sponsor conversation. Label it honestly: a logged render is a render, not a verified human impression. Hard frequency cap and total exclusion from `?mode=clean`, or the clean feed becomes an infomercial.

#### 25. Event debrief and journal

**What.** Merge the status cards, cue fires, announcements, awards, segments, publish holds and cycle times the desk already records into one event-lead timeline, then emit a post-event debrief: delay by cause, actual versus scheduled for every anchor, sponsor obligations met, VOD chapter links.

**Why.** Among the cheapest items relative to what it produces: the bus already writes an append-only timestamped log of all of it, and `chapters.ts` already turns that log into a YouTube chapter list. The only standard after-action artifact an event gets today is a cycle-time report ([FMS](https://wpilib.screenstepslive.com/s/fms/m/eventmanager/l/607901-reports) and [Cheesy](https://raw.githubusercontent.com/Team254/cheesy-arena/main/web/reports.go) both stop there), which answers how long matches took and nothing about where the day went. Offseason committees turn over as students graduate, and a written debrief is the only thing that carries a lesson to next year, which is also what makes an adopting event trust the standard.

**Where.** New `apps/core/src/debrief.ts` reading `data/events/*.ndjson` through the replay path and joining `chapters.ts`; renders as a print view alongside the offline fallback pack.

**Effort.** Small. **Serves.** Both.

**Caveat.** Label causes exactly as the operator tagged them and never infer. Keep FTA, CSA and judge content out of any shareable version. Build the journal half first and add per-operator identity only if the crew is genuinely rotating: `docs/09` sets minimum viable crew at three, and for two people all weekend a sign-in is friction with no payoff.

#### 26. Post-event survey and a published event report

**What.** A QR on `/s/side`, an end-of-stream card and a link in every media locker pointing at a short role-segmented survey, auto-merged with de-identified event-log statistics (matches run, median cycle, delay minutes, videos published) into a one-page public event report.

**Why.** Cheap, and it is the artifact that makes the publishable-standard claim credible to the next event chair. The best-documented offseason in the community already does the survey half by hand and treats it as core practice: [Beach Blitz sends surveys to participating teams and volunteers right after the event](https://www.chiefdelphi.com/t/follow-along-as-we-plan-beach-blitz-2024-a-build-blog-for-an-offseason-of-sorts/466062) across a wide range of topics, feeding a committee wrap-up. The desk-log half costs nothing.

**Where.** `pace.ts`, the status-card path, `publish/queue.ts`, plus a print/publish view.

**Effort.** Small. **Serves.** Both.

**Caveat.** Surveys of this kind receive feedback naming individual volunteers. The public report must be aggregate and de-identified by construction, not by an operator remembering to redact.

### 1e. What teams and families take home

#### 27. Per-team media locker

**What.** One page per team generated from the event log: every match with a link to the already-cut video, a deep link into the day-VOD chapter, score and RP line, marked moments, award and alliance moments. Per-team token URL, QR card in the pit, on `/s/side`, mailed to the lead coach. The "remote watch" case (embedded live stream, next-match estimate, live rank) is a section of this page, not a separate surface.

**Why.** This is the last mile and it is short: the publish queue already keys items by `matchKey` and holds the resulting YouTube video id, and `chapters.ts` already turns the log into timestamps. Nothing aggregates by team and nothing hands the team the list. The demand is verified and slightly embarrassing: a team [could not find its own Monterey Bay finals or Las Vegas playoff matches](https://www.chiefdelphi.com/t/how-to-access-match-videos-vods/460856) and was told to hunt Twitch VODs via vodvod.top plus a Chrome extension plus "some sort of recording software to export the footage". `docs/12` books "remote family can find matches" as covered, but its recommendation routes families to TBA and adds a caveat about announcing deferred mode; it never proposes a per-team page.

**Where.** New `surfaces/locker/` plus a route in `server.ts`'s SURFACES array.

**Effort.** Small. **Serves.** Program, high value.

**Caveat.** Token URLs are a third auth mode alongside open and PIN-gated. Add it to `access.ts` deliberately, as an allowlist, and put nothing on the page that is not already public. Render a truthful "processing" state for items on a QC hold rather than a dead link. Note the "remote" framing has no hosting behind it: what is actually remote is the YouTube URL and the locker page served on the LAN, so do not promise more.

#### 28. Storyline and ticker engine

**What.** Typed storyline DeskEvents any surface can subscribe to: head-to-head and shared-alliance history for the six teams up next, first meeting, streaks, a rookie's first win or first RP, high score of the day, biggest comeback. Each carries its source match keys, feeding the ticker, `/s/side` and `/s/talent`, with a one-tap suppress.

**Why.** `docs/12` recommended one editable fact line seeded from TBA, so the idea is in the record, but as a manual field, and `/s/talent` shipped without it. The delta is a derived engine with provenance. A concrete enabler: `config` declares `tba.readKey` and nothing in `apps/core` consumes it, which is also why the avatar gap is still open. Demand is verified by an entire site existing for it: [FRCShowdown](https://www.chiefdelphi.com/t/frcshowdown-com-view-your-shared-match-histories/467827) does nothing but show two teams' shared history, is TBA-backed, "relies heavily on caching", and drew 7,819 views across 95 posts.

**Where.** New storyline module; first consumer of `tba.readKey`; build the Friday snapshot alongside it, which `docs/09`'s risk register already commits to.

**Effort.** Medium. **Serves.** Program.

**Caveat.** Provenance per factlet and a one-tap suppress on `/s/talent`. A wrong fact read on air is worse than no fact.

#### 29. Team media intake and consent posture (one workstream)

**What.** Two halves of the same record. A tokened per-team upload page linked from registration: robot photo, logo/avatar, optional intro clip, pronunciation, driver and human-player first names, one line on what is new. And three fields per team (`mediaConsent`, `nameDisplay`, a free-text note) defaulting to unknown plus number-only, read by `/s/media`, `/s/cards`, the alliance overview and any future interview content, plus a face-obscure brush reusing the `/s/draw` canvas.

**Why.** `media.ts` and `/s/media` are operator-side drag-drop only; the team-side half does not exist, and `docs/09` rates "too few robot photos" as a High-likelihood risk whose only mitigation is making the fallback look deliberate. `docs/07` has no consent, permission or privacy handling of any kind, and `Team` in `types.ts` carries only number, name, media, rank and record. The demand and the stakes are both documented: [families refuse photo permission for reasons including escaping abusive relationships](https://www.chiefdelphi.com/t/families-not-giving-media-permission/415852), teams report ["Faces are not blurred, due to the matter that it is beyond my capabilities"](https://www.chiefdelphi.com/t/what-are-your-teams-media-policies/501903), and [E117 of the 2026 manual](https://www.frcmanual.com/2026/event-rules-(e)) says "Do not record anyone at the event without their consent. Do not record interactions with anyone at an event, without the person's consent."

**Where.** `apps/core/src/media.ts`, `types.ts`, `surfaces/media`, `surfaces/cards`, `robotCard()` in `program.js`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Two real ones. The intake page must be reachable by teams weeks before the event, which breaks the LAN-only model and the "nothing needs internet except the stream" rule; decide that consciously, and note that a static form writing to a folder the lead syncs is a legitimate lighter answer. And the face obscure must be baked into the stored asset before publish, not applied as a program-only overlay, or scrubbing the rolling recording undoes it. Keep `unknown` permissive enough that the show still looks good, because Pit Admin will not reliably fill a third field on a busy Friday, and `docs/07`'s tier-3 gold-number plinth is the graceful degrade that already exists.

#### 30. Team-owned social kit and vertical cutdowns

**What.** Extend `/s/cards` to render team-owned assets into each team's locker as ready-to-post PNGs at 1080x1080 and 1080x1920 (alliance thank-you after selection and after playoffs, final placement card at event close), and emit a 20 to 45 second 9:16 version of every match cut, with the crop window driven by `/s/replay` marks rather than a centre crop.

**Why.** Small deltas over built surfaces. Someone else already discovered the template need by shipping it: [PitRadar's card generator](https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920) lists "Event Summary / Mid Event Update/Progress Report / Alliance partner thank you / Upcoming matches / Match summary", and "alliance partner thank you" appearing as a shipped template is strong evidence teams make that graphic by hand today. The vertical format and its cadence verify from the leading producer: [FUN's 2026 Pit Stops ship as youtube.com/shorts links and are "batched and posted at the end of the day"](https://www.chiefdelphi.com/t/behind-the-bumpers-pit-stop-interviews-frc-rebuilt/515918), which is exactly the rhythm the deferred publish queue already runs on. No new dependency: ffmpeg does the crop and the queue does the rest.

**Where.** `surfaces/cards/index.html`, `surfaces/_shared/card.js`, `apps/core/src/clips.ts`, `publish/queue.ts`.

**Effort.** Medium for both. **Serves.** Program.

**Caveat.** The vertical crop must follow the marked scoring window or the output is worthless on a wide field shot, and burned-in type must still clear the 28px broadcast floor at delivery resolution (check against `docs/08`). Gate the thank-you card on confirmed alliance results: naming the wrong partner is a memorable embarrassment. Render files and let a human post to non-YouTube platforms in v1 rather than taking on per-platform auth.

#### 31. Highlight packages, wrap show, spotlight queue

**What.** Three related assemblies over clips already on disk: a 60 to 90 second per-team reel (highest-scoring match, first win, closest finish) with a title card; a 10 to 15 minute end-of-day wrap assembled at each day's close; and a desk board tracking per-team coverage state (never featured, b-roll only, interviewed, highlighted) that suggests who to grab next.

**Why.** The ingredients are present: `clips.ts` does multi-range cuts with accurate seek, `markers.ts` already auto-marks bursts, lead changes and climbs, and `queueSegment()` already treats non-match segments as first-class with their own naming. The coverage-breadth argument is verified from the leading producer's own words: [FUN restructured to "a few Behind the Bumpers per week (typically 4-8) and many more Pit Stops to be able to focus on more teams"](https://www.chiefdelphi.com/t/behind-the-bumpers-pit-stop-interviews-frc-rebuilt/515918), a direct statement that breadth, not production capacity, is the binding constraint. A 42-robot offseason can give all 42 a package, which nobody in this ecosystem does.

**Where.** `apps/core/src/clips.ts`, `markers.ts`, `publish/queue.ts`, `publish/naming.ts`.

**Effort.** Medium. **Serves.** Program.

**Caveat.** Operator approve before publish is mandatory: ranking "best moment" on score deltas will sometimes pick a dull match. Be explicit in config about which audio library is stream-safe versus house-only. `docs/06`'s whole rule is that the house playlist never reaches the stream, so a published reel needs a *different* library from the one `audio/` manages; conflating them is how the VOD gets a Content ID claim. Wrap-show assembly competes with teardown for the rig and the operator, so it must run unattended and be publishable the next morning if it misses, queued strictly behind the match uploads teams actually want.

### 1f. Accessibility

Ranked here rather than in a separate axis because most of it is cheap, most of it also serves adoption, and the highest-value items are hours of work.

#### 32. Accessibility services card

**What.** An `accessibility` block in event config (quiet room location and hours, earplug pickup, accessible seating, gender-neutral restrooms, family space, coordinator contact) rendered three ways: a `/s/side` rotation card, a QR-linked phone page, and a scripted `/s/talent` prompt. Unfilled fields render as a visible gap.

**Why.** Best value per line in the entire sweep. Nothing exists in `config.example.json`, no surface, no doc. [FIRST's Quiet Room guide](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-quiet-rooms.pdf) asks for precisely the three outputs the desk already owns: "create a PowerPoint slide that can be displayed between matches, and provide information so the emcee can announce the Quiet Room at events", plus inclusion in venue maps and Pit Admin knowing the hours. [The accessibility guide](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-accessibility.pdf) states "accessibility is not a recommendation but a requirement by FIRST". The render-unfilled-as-a-gap design is exactly the accessible-by-default property goal 2 needs: a forking event has to actively decide not to provide a quiet room.

**Where.** `config.example.json`, `surfaces/side`, `surfaces/talent`, and the existing offline QR helper in `surfaces/_shared/qr.js`.

**Effort.** Small. **Serves.** Both.

**Caveat.** Require an attendant-coverage field before the card renders as "open": FIRST requires two Quiet Room attendants at all times, and advertising an unstaffed room is worse than none.

#### 33. Unmistakable visual match-state banner

**What.** A large, high-contrast, shape-differentiated phase banner (ARM / 3-2-1 / GO / TELEOP / ENDGAME-20s / STOP) on `/s/side` and the phone page, each state with its own glyph and text label, never colour alone.

**Why.** The data is fully present and unrendered: `DeskState` carries `phase`, `clockDisplay`, `matchStartedAt` and `lockdown`, and `/s/side` already renders room-scale type. What is absent is a phase banner distinct from the status cards, which answer "why are we stopped" rather than "what phase of play is this". The community ask is on the record in the clearest terms in the whole research set: ["Use of easily seen visual cues in addition to aural cues at events for things like the start of a match (lower an arm/flag when the GA/MC says 'go', that sort of thing)"](https://www.chiefdelphi.com/t/petition-to-make-closed-captions-standard/419594), with the reply quoting it back as "THIS". Latency is already handled by the architecture: surfaces derive `matchClock` client-side from `matchStartedAt` every frame, so the banner tracks the field's own `match.start`.

**Where.** `surfaces/side/index.html` plus the phone page.

**Effort.** Small. **Serves.** Program.

**Caveat.** Label it as spectator information so no drive team reads it as an authoritative start signal.

#### 34. Text announce bus

**What.** Give cues an optional text field and render the current authored announcement on `/s/side` and the per-team phone page: award names, alliance picks as they happen, delay notices, queuing calls, lost and found. Auto-generate from events the bus already has (`alliance_selection.update`, `award.presented`, `status.show`, `pace.updated`) and treat free-typed text as the exception.

**Why.** The mechanism is half-built: `StatusCard` already carries free text with a `custom` kind and already fans out to program, side screens and phones, so authored text reaching three surfaces at once is solved. What is missing is a non-alarm channel for it and the show-script content. This is the cheaper and more accurate half of the caption problem, because authored text is 100% correct and ASR is not. The demand is specific: [the Finger Lakes Regional runs an LED board Pit Admin controls for queueing and parts requests](https://www.chiefdelphi.com/t/d-deaf-and-hard-of-hearing-resource-development-input-needed/474492), with the reply "I don't think I've ever heard a pit announcement well enough to understand it", and bovlb's note that this "is not only for DHH people, but also applies to teams where English is not a first language".

**Where.** `Cue` in `apps/core/src/cue/engine.ts`, a rotation slot in `surfaces/side/index.html`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** `/s/side` real estate is already contested by on-deck, rankings and the QR card. Adding a fourth panel needs a rotation budget, not another box.

#### 35. Accessibility prompts on the announcer tablet

**What.** Extend `/s/talent` with describe-the-visual cues firing on purely visual moments, standing mic-technique reminders, and timed accessibility reads from the same config as the services card.

**Why.** Absent and unusually cheap. Alliance selection is the clearest case: the board updates silently and the desk knows the exact moment because it already publishes `alliance_selection.update`. The mic half compounds with every caption item, since better announcer audio directly lowers ASR error, and the complaint is on the record: ["enunciation is important. Removing background noise is important! Making sure mics are far enough from mouths to not pick up breathing, but close enough to pick up voices well"](https://www.chiefdelphi.com/t/petition-to-make-closed-captions-standard/419594), and ["sometimes the MC/GA mics are way too hot"](https://www.chiefdelphi.com/t/noise-levels-at-first-competitions/429188).

**Where.** `surfaces/talent/index.html`, triggered off `screen.change` and `alliance_selection.update`, which it already subscribes to.

**Effort.** Small. **Serves.** Both.

**Caveat.** Keep describe-the-visual prompts to genuinely visual-only moments and put them in the same place every time, or a fourth stream of nags gets ignored. Make no claim that this constitutes formal audio description.

#### 36. Caption and transcript sidecars in the publish queue

**What.** An offline Whisper pass over each auto-cut clip as it enters the publish queue, `.srt` attached via `captions.insert` on the same upload, a full-day transcript in the archive, and a word index against the `/s/replay` match clock.

**Why.** This is the tractable half of the caption problem and it invalidates part of the current plan. `docs/06` and `docs/11` both resolve captions to "enable YouTube Live automatic captions". Verified: [that feature is English only, normal-latency only, and gated to channels with more than 1,000 subscribers](https://support.google.com/youtube/answer/6373554). WRRF's channel may not qualify, and the normal-latency requirement fights the low-latency pit feed already in the design, so both docs need correcting regardless. Offline captioning has no latency budget and therefore materially better accuracy, it makes every published artifact carry its text by default, and the replay word-index is a compounding win nobody else has proposed. The community position is unambiguous: ["It really does feel like a low-effort, high-effect accessibility feature"](https://www.chiefdelphi.com/t/petition-to-make-closed-captions-standard/419594). The `youtube` manage scope already requested in `config.example.json` covers `captions.insert`.

**Where.** A new stage in `apps/core/src/publish/queue.ts` between cut and uploaded, reusing the existing held/retry state machine, running as a low-priority worker.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Mark machine-generated captions as such, or keep a human hold for award and ceremony segments. A caption backlog must never block a publish.

**Built 2026-08-11, in half, and the other half was declined.** `apps/core/src/publish/captions.ts` finds a sidecar for a queue item and the upload step attaches it, wrapped so a caption failure is a warning and never a stuck video. The scope note in this item is wrong and cost an afternoon to find: `captions.insert` needs `youtube.force-ssl`, NOT the `youtube` manage scope claimed above. Both doc corrections this item demanded have been made — `docs/06` and `docs/11` no longer promise live automatic captions.

The Whisper pass is **declined**, not deferred. It fails the two rules this repo is actually built on: it needs a model file and a native runtime (against no-build-step and double-click), and it contends for the same machine that is encoding the show, which `docs/09` names as the tight resource. It also loses on merit — YouTube already runs ASR on every upload for free and does it better than a laptop under load, so an unreviewed local transcript would be strictly worse output bought with the show's CPU. What survives is the part ASR cannot do: carry a file a human made. The word-index-against-the-replay-clock idea is genuinely good and orphaned by this; it is written down here rather than lost.

#### 37. Low-stim mode and a scheduled low-sensory window

**What.** A `?stim=low` variant of `/s/side` and the venue program path (no autoplay motion, no whip transitions, reduced saturation, longer dwell) plus a desk-scheduled window during which the cue engine suppresses stingers and bumpers and the house bus is capped.

**Why.** Every primitive already exists and nothing composes them: `lockdown` already suppresses decorative motion during endgame while keeping score and clock animating, `tokens.css` already has a `prefers-reduced-motion` block, the cue engine has per-cue arming, and `audio/store.ts` already has a `silent` house source. The scheduled low-sensory window *in the main hall* is the thing nobody offers, because [FIRST's answer is a quiet room elsewhere in the building](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-quiet-rooms.pdf), and the desk is the component that controls the hall's screens and music. The need is stated directly: ["it was hard for my teammates and myself to deal with the noise and the lighting... it can get some anxiety flowing"](https://www.chiefdelphi.com/t/noise-levels-at-first-competitions/429188).

**Where.** Query param honoured by `surfaces/side` and `surfaces/program`, plus a scheduled suppression flag on the CueEngine.

**Effort.** Small. **Serves.** Both.

**Caveat.** Frame it to the emcee as a scheduled segment with its own run-of-show line, not a degradation, or it gets vetoed. Practice day is the natural slot.

#### 38. Finish WCAG 2.2 AA on the phone surfaces

**What.** The actual remainder: 24x24 CSS px minimum targets, 200% reflow, and a persistent text-size control on `/s/next`, `/s/trivia` and `/s/quiz`.

**Why.** Scope this to the remainder or the roadmap reads as work already done. More is built than the sweep assumed: `/s/next` already has `aria-live="polite"` on the ETA and rank lines with a comment about guarding announcements so a reader fires only on real change; `/s/quiz` already has `aria-live` on category, question, verdict and score plus `role="alert"` on the join error; and `tokens.css` already honours `prefers-reduced-motion`, deliberately excluding only the endgame/E-stop pulse as live state. [FIRST's guidance](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-accessibility.pdf) asks for screen-reader optimisation and warns against linking raw URLs, and the lived complaint is about legibility under gym lighting: ["Lighting can also make it hard, too bright of lights and you can't see the video (and the closed captions)"](https://www.chiefdelphi.com/t/petition-to-make-closed-captions-standard/419594).

**Where.** `surfaces/next`, `surfaces/quiz`, `surfaces/trivia`.

**Effort.** Small. **Serves.** Both.

**Caveat.** Real device testing on VoiceOver and TalkBack, not automated checks alone.

### 1g. Legal and safety on the program axis

#### 39. No-PII crowd identity, plus a display-name filter and an operator kill

**What.** Make the crowd surfaces no-PII by construction: ephemeral per-device tokens scoped to the event and destroyed with it, no free-text names on screen by default (initials or a pick-a-mascot identity), no cross-event linkage. Keep a bundled wordlist check with leetspeak and homoglyph normalisation for any free text that does exist, with silent reassignment to a generated handle rather than rejection, plus a one-key operator kill on `/s/triviadesk` and an event-wide generated-names-only mode.

**Why.** Two problems that share one fix, and the sweep only found the smaller one. The taste problem is confirmed absent and confirmed blast-radius: `TriviaStore.join()` trims and truncates to `MAX_NAME` and does nothing else, there is no kick or remove control anywhere on `/s/triviadesk`, and the leaderboard renders on `/s/trivia`, which is an OBS overlay surface feeding the program; so an arbitrary phone-typed string reaches a livestreamed feed in front of a youth audience with no filter and no removal path. [Kahoot's published approach](https://support.kahoot.com/hc/en-us/articles/115002201267-How-to-handle-inappropriate-nicknames) is the model: check against a list, silently rename, and let the host click a nickname to remove that player. The larger problem is legal: [the COPPA Rule](https://www.law.cornell.edu/cfr/text/16/312.2) expressly counts "a screen or user name where it functions in the same manner as online contact information" and "a persistent identifier that can be used to recognize a user over time" as personal information, and [FIRST's own policy](https://www.firstinspires.org/about/privacy-policy) states youth under 13 are not permitted to provide personal data. This is the single item most likely to make a school district or a risk-averse adopter refuse the software, and it is far cheaper to design out now than to retrofit after the first event where a child's real name went on the jumbotron.

**Where.** `apps/core/src/trivia/store.ts`, a JSON wordlist beside `data/trivia.json`, a remove control on `surfaces/triviadesk`. [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) is CC BY 4.0 and bundles trivially in a no-build-step Node 22 project (27 languages, not 29 as the sweep stated).

**Effort.** Small. **Serves.** Both.

**Caveat.** Anonymous identities remove the "see your name on the big screen" hook that drives participation. Mascot or initials identities have to be designed to feel like a feature, not a compliance downgrade. The operator kill is the real control; the wordlist is defence in depth and will produce both false negatives and Scunthorpe false positives.

#### 40. Minor-on-camera guard and interview intake

**What.** A per-cue `minorsOnCamera` attribute where arming requires the operator to confirm an adult is in frame, every armed minors cue logging to the NDJSON stream; plus a small `/s/intake` tablet surface capturing subject, minor status, adult present and explicit tap-to-consent, emitting a DeskEvent the publish pipeline requires before an interview segment clears QC.

**Why.** One record satisfies two obligations. [YouTube states](https://support.google.com/youtube/answer/2801999?hl=en) that "Live streams with minors under 16 who are not visibly accompanied by an adult may be removed or have their live chat disabled" and that non-compliant channels "may temporarily or permanently lose their ability to live stream", and [that an adult must be visibly present](https://support.google.com/youtube/answer/2853834?hl=en) and engaged. The failure mode is not one clip: it is the event's stream dying mid-Saturday. Separately [E117](https://www.frcmanual.com/2026/event-rules-(e)) is unusually explicit and carves out exactly what a content desk does: consenting to appear in event footage does not authorise recording a specific interaction. The cue engine is the right home because per-cue arming, would-have-fired counters and NDJSON logging all already exist.

**Where.** A field on `Cue` in `apps/core/src/cue/engine.ts` checked in `setAutopilot`; new gated `surfaces/intake`; a consent gate in the segment branch of `publish/queue.ts`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** The current cue set is entirely screen and scene changes on match state; there are no pit-cam, interview or crowd-cam cues yet, so the attribute has nothing to attach to until that content exists. Build it with the interview intake, which creates the first content it guards. Make it a confirm-and-log gate, never a refusal, or the director routes around it. Three taps or fewer on intake, or a good interviewer routes around it and back-fills dishonestly. E117 binds at a WRRF offseason by adoption rather than by rule, so frame it as the house standard.

#### 41. Notice and signage pack

**What.** Generate from event config an entrance photography and recording notice, a pit-lane card, a desk-served privacy page behind the QR, and a lightweight opt-out registry feeding the per-team media posture flag.

**Why.** Cheapest item in the legal set and it is what makes every other consent claim defensible. [FIRST's privacy policy](https://firstinspires.org/about/privacy-policy) relies on the premise that "Attendees at public FIRST events in the U.S. and Canada... can expect broad use of photography and videography, including livestreaming", a premise that only holds if someone posts the notice, and at an offseason that someone is WRRF. The community observes that they often do not: ["There is a resource on signage for events and it is the code of conduct and does not say anything about photos"](https://www.chiefdelphi.com/t/families-not-giving-media-permission/415852). [FIRST puts youth protection and data protection measures on the Host Organization](https://www.firstinspires.org/resources/library/frc/off-season-events).

**Where.** A generator writing print-ready HTML from config, plus a served privacy page reachable from the existing offline QR in `surfaces/_shared/qr.js`.

**Effort.** Small. **Serves.** Both.

**Caveat.** Signage is notice, not consent, and must never be presented internally as consent: it does not authorise a close-up interview with a 15-year-old. Print with a placement checklist, and template nothing that resembles FIRST-issued signage.

#### 42. Music source ledger and the venue/transmission rights doc

**What.** Extend the `audio.updated` payload with source service, licence id and allowlist proof so the log carries a running per-track manifest; and write `docs/15-music-rights.md` separating the two rights the event needs, with a named safe source.

**Why.** The ledger half is close to free: `audio/store.ts` already publishes `audio.updated` carrying `NowPlaying{title, artist}` onto the append-only log every time the playlist changes; the missing fields are licence and source. The doc half matters because `docs/06` states the two-bus rule and the Content ID rationale but not the *reason*, and the reason is what a forking event needs. The statutory line is crisp and nowhere in the repo: [17 U.S.C. §110(4)](https://www.law.cornell.edu/uscode/text/17/110) exempts performance "otherwise than in a transmission to the public", so the nonprofit exemption that plausibly covers the gym excludes the stream by its own terms. Without it every adopter re-learns this via a claimed VOD, which is exactly what happened at scale: [official event Twitch VODs unpublished over copyright, and streams dropping mid-match](https://www.chiefdelphi.com/t/lets-solve-the-twitch-and-youtube-dmca-issues-from-streams/429168). [YouTube's own Audio Library](https://support.google.com/youtube/answer/3376882?hl=en) is the safe default and explicitly disclaims other "royalty-free" libraries.

**Where.** `apps/core/src/audio/store.ts`; new `docs/15-music-rights.md`.

**Effort.** Small. **Serves.** Both.

**Caveat.** Do not build the OBS track-mask assertion the sweep proposed: `docs/06` makes the split a cable fact ("an aux send on the venue console that simply has no music or console channels routed to it"), so the music never enters OBS and there is nothing for a track mask to assert. One exposure the research missed and the doc must name: the configured house source is Spotify (`audio/spotify.ts`), and Spotify's consumer terms prohibit public performance outright, which is a live problem for the room independent of §110(4) and a bigger one than the statutory analysis. Say plainly the doc is not legal advice.

#### 43. Copyright-claim watchdog and live-broadcast kids declaration

**What.** Poll `videos.list(part=status,contentDetails)` after upload and gate the TBA `match_videos` push on the result, parking hits in a remediation lane. Separately, carry the audience declaration on the live-broadcast path and record a one-per-event rationale.

**Why.** `publish/queue.ts` goes uploaded, then TBA link, then flip to public with no status check between, and the `deferred` default means an unattended overnight run is exactly when a claim lands. [The API fields exist](https://developers.google.com/youtube/v3/docs/videos): `status.rejectionReason` values include claim, copyright, legal, trademark. On the kids declaration, correct the sweep: `publish/youtube.ts` already sets `selfDeclaredMadeForKids: false` explicitly in `#startSession` and `setPrivacy` deliberately re-sends it with a comment explaining that `videos.update` is a replace, which is better than most production uploaders. The live-broadcast path is the only genuine remainder.

**Where.** About twenty lines in the uploaded branch of `#step` in `queue.ts`, reusing the existing `held` state and its release path; plus `setLiveBroadcastTitle`'s neighbourhood.

**Effort.** Small. **Serves.** Program.

**Caveat.** `rejectionReason` catches hard rejections, not routine monetization claims, so this covers severe cases only. Back it with a human Studio spot-check on Saturday night. Do not promise chat survives a correct declaration: [YouTube may disable it under the child-safety classifier regardless](https://support.google.com/youtube/answer/2801999?hl=en).

#### 44. Retention sweeper and takedown lineage

**What.** A machine-readable retention manifest and a sweeper (trivia identities at T+7, raw recordings at T+30, the FTA audit log at T+90, published derivatives indefinitely) with deletion receipts in the log and a plain-language "what we keep" panel behind the QR; plus a reverse index from a subject (team, person, timecode window) to every published artifact, with an `unpublish(subject)` operation that lists and retracts.

**Why.** Nothing prunes `data/events/*.ndjson` or `rec/`, and no policy doc exists. [The updated COPPA Rule](https://www.lw.com/en/insights/ftc-publishes-updates-to-coppa-rule) requires a written retention policy disclosed in the privacy notice, prohibits indefinite retention, and reached full compliance on 22 April 2026, before this event. The takedown half discharges an obligation this project has more of than anything else in FRC because it publishes to more surfaces: [FIRST honours removal requests for identifiable images "to the extent practicable"](https://firstinspires.org/about/privacy-policy) on platforms it manages, and a WRRF-run event on a WRRF channel is not one of them. `QueueItem` already carries `sourceId`, `ranges`, `matchKey` and `videoId`, so per-item provenance exists; the reverse index and the retraction path do not. This is the same index item 3 needs.

**Where.** New `docs/14`-series retention doc plus a sweeper alongside `apps/core/src/bus.ts`; index over `data/publish-queue.json` and the event log in `apps/core/src/publish/`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** A design tension the sweep did not name: the event log is append-only by design and *is* the replay artifact, so purging whole day-files is fine but redacting identities inside one breaks `npm run replay`. Either scope trivia identities out of the durable log at write time (which item 39 does anyway) or accept file-granularity deletion only. Any unpublish needs a dry-run listing and a two-person confirm because YouTube deletion is irreversible, and the doc must say plainly that third-party re-uploads and scouting-app caches are out of reach.

#### 45. Live chat posture runbook

**What.** A `docs/11` preflight section recording chat posture before go-live (blocked words, Strict hold, slow mode, two named moderators), plus a CHAT OFF control on `/s/remote` and `/s/desk` and a log entry per change.

**Why.** Nothing in the repo mentions chat at all, and the architectural warning is the valuable part: [YouTube independently disables chat on content depicting minors](https://support.google.com/youtube/answer/2801999?hl=en), so nothing in the desk should ever be built assuming chat exists. [Blocked-word lists and the None/Basic/Strict moderation levels](https://support.google.com/youtube/answer/9826490?hl=en) are Studio settings with no Data API v3 surface, so only the on/off toggle is automatable, mapping to `liveBroadcasts.update` next to the existing `setLiveBroadcastTitle`.

**Where.** `docs/11-distribution.md` plus one control.

**Effort.** Small. **Serves.** Program.

**Caveat.** If two moderators cannot be staffed at an offseason already thin on AV volunteers, the honest default is chat off for the whole event. Say that in the runbook rather than leaving it to Saturday.

### 1h. Finish the field bridge

Five small Cheesy Arena adapter items that are individually minor and collectively close most of the remaining "the desk does not know something the field already told it" gap. Grouped because they share one file and one review.

| Item | What | Why it matters | Where |
|---|---|---|---|
| Specific delay reasons | Map `arenaStatus`'s `CanStartMatch` and `StartMatchConditions` onto the status cards so "Field delay" becomes "Waiting on Blue 2 to connect", raising and clearing itself | Status cards are operator-fired, and during a scramble the person who knows what is wrong is the person too busy to press a button. [`generateArenaStatusMessage`](https://github.com/Team254/cheesy-arena/blob/main/field/arena_notifiers.go) returns exactly these fields on the notifier the adapter already handles; `ArenaStatusMessage` in `protocol.ts` does not include them | `protocol.ts`, `adapter.ts` |
| Playoff bracket and advancement | A `bracket` program screen and a post-match advancement strap, plus `tiebreakReason` on the final-score card | `/displays/bracket/websocket` is already in `ALLOWED_SOCKETS` and connected, and `#onScorePosted` discards `redWins`/`blueWins`, the destination strings, off-field team ids and `tiebreakReason` that arrive in the same payload ([verified at line 260](https://github.com/Team254/cheesy-arena/blob/main/field/arena_notifiers.go)) | `protocol.ts`, new `bracket` screen in `surfaces/program` |
| Sponsor slides | Consume the already-allowlisted, already-FTA-signed, entirely unread `GET /api/sponsor_slides` | Zero duplicate data entry for item 24 | `adapter.ts` plus a `side` rotation slot |
| Team identity pack | A setup-week script producing avatars, robot names from `/team/{key}/robots`, nickname/city/rookie year | "Team 254's robot, Barrage" is exactly the line `/s/talent` exists to supply, it is one HTTP call, and it appears nowhere in `docs/12`, `docs/07` or the code ([verified in tba.go](https://github.com/Team254/cheesy-arena/blob/main/partner/tba.go)) | setup script writing into `data/`, consumed by `media.ts` and `surfaces/talent` |
| Match-log adapter | Ingest `GET /match_logs/{matchId}/{stationId}/log` after each match and reduce to a few events: lost radio at 1:12, brownout below 7V, e-stopped, never connected | The connection-drop half is already served by `arenaStatus` markers; the new information is battery voltage, missed packets, trip time and SNR, the physical causes nothing else in the ecosystem exposes ([MatchLogRow verified](https://github.com/Team254/cheesy-arena/blob/main/web/match_logs.go)) | `adapter.ts`, `client.ts` |

**Effort.** Small each; match logs is medium. **Serves.** Program.

**Shared caveats.** Two implementation blockers apply across the bracket, avatar and match-log items: `CheesyClient.get<T>()` parses every response as JSON, and all three endpoints return CSV, SVG or bytes, so the raw-text variant of `get()` that `client.ts` already flags as missing has to land first. And `/match_logs/` is *not* on `ALLOWED_PATHS` and not on the FTA sign-off sheet in `docs/10`, so adding it requires the documented verify-then-add ritual and a re-sign, not a code edit. Re-render the bracket from data rather than embedding the upstream SVG, which would break the chamfer geometry, the 28px type floor and the luma-key contract. Keep blame-adjacent match-log detail off `/s/program`, and default the delay-reason card to neutral phrasing on public surfaces with team-specific strings confined to `/s/desk` and `/s/talent` (the `StartMatchConditions` strings are upstream UI copy that changes between Cheesy versions, so match on the structured booleans and treat the strings as display-only).

---

## Axis 2: becoming adoptable

Beyond B1 (licence and governance) and B2 (envelope versioning), which are listed as blockers because everything else waits on them.

### 2a. The three artifacts that make it a standard

#### 46. Event pack and theme contract

**What.** Split the design system in two: `packages/theme/contract.css` holding semantic token names with neutral defaults, and `events/<key>/` holding `tokens.json` in the W3C Design Tokens format, a logo slot set, and `event.json` carrying the *non-visual* inventory too: run-of-show, awards and ceremony order, sponsors, announcement templates, filler and explainer content, emcee script fragments, accessibility block. CSS custom properties generated at boot. Ship CalGames as `events/2026cacg/`, the reference pack rather than the default, plus one deliberately different blank pack.

**Why.** This is the concrete deliverable for goal 2 and it is bigger than the sweep estimated. `tokens.css` opens with a comment saying the palette is mandated and hardcodes the WRRF hexes directly; 62 files contain `CalGames`/`WRRF`/`Woodside` across 354 occurrences; 42 raw six-digit hex literals live outside `tokens.css`, and every one would silently survive a palette swap and make a rebranded fork look broken. The [Design Tokens Specification reached first stable on 28 October 2025](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) with explicit "theming and multi-brand support", so there is a format to use rather than invent. The working FRC precedent is [PitFUSION](https://www.chiefdelphi.com/t/introducing-pitfusion/517885), whose users adopted its logo auto-load and `--custom-bg-image` theming within days and filed bugs when it was half-done. And the copy-and-modify workflow this formalises is already how offseasons operate: [organisers trade and trim each other's ceremony scripts](https://www.chiefdelphi.com/t/script-for-opening-ceremonies-for-offseason-event/162541) and [maintain a shared annual offseason event list](https://www.chiefdelphi.com/t/2026-offseason-event-scrimmage-spreadsheet/520837). PitRadar's own thread carries [a direct request for "custom layout/branding(!)"](https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920) the author had not planned for.

**Where.** `packages/theme/`, new `events/`, and a CI check that no file outside `events/2026cacg/` contains the three brand strings.

**Effort.** Medium to large. **Serves.** Standard, critical.

**Caveat.** Theming that stops at colour tokens will not survive contact: the 28px type floor, chamfer geometry and luma-key rules are load-bearing and must live in the token file. Ship a token linter that fails on insufficient contrast against *both* alpha and luma backgrounds, because a light-on-light event pack will silently break keying. Make the CalGames pack immutable at runtime, since the WRRF palette is mandated and theming is the obvious route to brand drift at the home event. Keep packs as JSON plus asset directories, not a plugin API: the adopters are volunteers. Do the i18n string extraction during this work (see item 57), because it is cheap now and expensive afterwards. And validate by actually running CalGames 2026 out of the pack before publishing.

#### 47. Publish the DeskEvent stream as the contract

**What.** `schema/deskevent-1.0.json`, a published event-type registry generated from `types.ts`, `/api/v1/stream` as a WebSocket with resume-from-sequence, the same feed over SSE, a mapping table onto Cheesy Arena's notifier names, and one adapter endpoint in the flat-array shape vMix Data Sources consume. Plus a written source-adapter contract where an adapter emits DeskEvents and declares a capability set.

**Why.** The feed exists (the `/ws` handler already fans out `{t:'event', ev, state}` and `/api/state` is on the `OPEN_GET` list) and carries no credentials, so publishing it does not reopen the access question. What is absent is everything that makes it a contract: no version, no resume, no SSE, no schema file, and `DeskEventType` is a TypeScript union rather than a published registry. The ecosystem argument is the strongest evidence in the sweep and all three repos verify: [obs-ftc-stream-manager](https://github.com/FIRST-South-Carolina/obs-ftc-stream-manager), [obs-ftc-scene-switcher](https://github.com/FIRST-South-Carolina/obs-ftc-scene-switcher) and [ftc-livestream-switcher](https://github.com/zachies/ftc-livestream-switcher) are three independent tools built off one scorekeeper feed the vendor did not write. The counter-example is equally clear: an overlay author asking for FMS match data was told ["not with the official FMS", at least not at official events... "you'll have to figure out yourself how the data is communicated"](https://www.chiefdelphi.com/t/creating-custom-fms-synced-stream-overlays-in-obs/443301).

**Where.** `apps/core/src/server.ts` (`?since=` replay off the existing `bus.recent` ring), schema and registry as versioned files generated from `types.ts`, new `docs/` standard document.

**Effort.** Large. **Serves.** Standard, critical.

**Caveat.** Freeze v1 at the events actually emitted today and mark everything else experimental: a published schema is a compatibility promise you then owe adopters. Reject the sub-proposal to rename `DeskEventType` to Cheesy's camelCase notifier names; the dotted namespace (`match.loaded`, `score.realtime`) is a deliberate superset, not a copy, and renaming churns every surface. Ship a mapping table instead. And do not ship an Off-Season FMS adapter as part of this: `docs/09` decision 1 resolved that the FMS adapter is not being built, and an adapter reverse-engineered from SignalR traffic carries none of the structural safety guarantee `docs/10` rests on. Publish the SPI and let someone else write it.

#### 48. Golden-log conformance suite and config validation

**What.** Committed `conformance/fixtures/*.ndjson` covering a qual match, a score-review hold, an arena fault, an alliance selection, a playoff series and an arcade set, with expected state snapshots, replayed and diffed by `npm run conformance`. Plus a strict schema over `config.json` with `configVersion`, a `migrations/` directory, and a `--check-config` mode that prints human-readable errors and exits non-zero.

**Why.** More is built than assumed, which makes the remainder cheap: `bus.replay()` replays a log at speed, `harness-offline.mjs` runs the whole system headless against `fake-arena.ts` and prints a PASS/FAIL checkpoint table, and `index.ts` already refuses a value-carrying flag typed bare and validates the port with a sentence rather than a stack. The delta is the difference between driving a live fake and replaying a frozen log and diffing snapshots: only the latter can define conformance for a third party. And the legal argument for fixtures is stronger than the sweep stated: [Cheesy Arena's licence forbids redistributing modifications](https://raw.githubusercontent.com/Team254/cheesy-arena/main/LICENSE), so a patched Cheesy can never be a CI dependency or an adopter hand-out; recorded fixtures plus the existing clean-room `fake-arena.ts` are the only portable rig available. The config half prevents PitFUSION's exact wound, which this project has so far dodged by luck: a user reported ["I have to fix the api keys every update"](https://www.chiefdelphi.com/t/introducing-pitfusion/517885) and the maintainer replied "I have mixed feelings... a single file", mid-event. Related and immediate: `config.json` currently holds event identity *and* `youtube.refreshToken`, `tba.authSecret` and `startgg.token`, so "send me your config" leaks credentials; split secrets into a sidecar upgrades never touch.

**Where.** New `conformance/`; `apps/core/src/config.ts`; `harness-offline.mjs`.

**Effort.** Medium. **Serves.** Standard, critical.

**Caveat.** Make state-snapshot diffing the primary gate and keep image assertions to a small hand-picked set; screenshot diffing is flaky across font stacks. Split hard failures (unwritable log path, missing scene, invalid key) from warnings and route warnings to a preflight row, or the validator refuses to start on event morning over something cosmetic. Keep migrations additive-only and always write a timestamped backup of the pre-migration config. Scrub real team numbers and robot photos from any published fixture, or get permission.

### 2b. Interoperability: run at somebody else's venue

#### 49. Scoped machine tokens and `/api/v1`

**What.** Config-issued scoped bearer tokens for machine callers, an explicit `/api/v1` prefix freezing the existing handlers with the bare paths kept as deprecated aliases, an OpenAPI document generated from the route table, and a written deprecation policy.

**Why.** The prerequisite for every other interop item. `access.ts` is one shared PIN plus an `OPEN_SURFACES`/`OPEN_GET`/`OPEN_POST` allowlist in both directions, and the file's own comment names the threat: "the trivia QR code puts the desk's address on a projector in front of the whole gym". Handing that PIN to a Companion box on the venue network is the wrong shape. Meanwhile `server.ts` dispatches on bare paths (`/api/cues/`, `/api/publish/`, `/api/segments/`, `/api/media/`, `/api/cards/`) with no version prefix, so any published integration writes against endpoints that can move. [Companion's own HTTP API](https://companion.free/user-guide/v4.2/remote-control/http-remote-control/) is the shape to mirror: flat REST with stable paths.

**Where.** `apps/core/src/access.ts` (plus cases in the existing `access.test.ts`, which has a failing-test discipline worth extending rather than bypassing), `server.ts` route strings.

**Effort.** Small. **Serves.** Standard, critical.

**Caveat.** Carry two settled constraints into the design: no secrets in argv or query strings (the PIN is already POST-body-only for exactly this reason, and `OBS_PASSWORD` is env-only), and the field-bridge endpoints stay receive-only and GET-only regardless of what token is presented. A token must never widen the Cheesy allowlist. Keep the API deliberately narrow: it becomes a public contract constraining refactors of a codebase that is still moving.

#### 50. FMS scene vocabulary and sanctioned-event compliance mode

**What.** Ship the `FMS_*` names as a selectable SceneMap profile with an alias map. Separately, a config flag that suppresses the desk's own in-match scorebug and reflows every other surface above and below the mandatory FMS score bar, shipped with a matching OBS scene collection where FMS owns `FMS_SCORE`.

**Why.** This is the strongest genuinely new strategic item in the whole sweep, and the constraint it encodes decides the addressable market. [FIRST's own page](https://wpilib.screenstepslive.com/s/fms/a/1208601-obs-websockets) states verbatim that `FMS_SCORE` "must, at minimum, show the score bar generated by FMS without any modification from how it is provided by FIRST", lists the seven scene names, requires a chroma filter on SCORE/FULL/ALLIANCE/AWARDS, and warns in all caps that enabling the integration without websockets "MAY IMPACT MATCH PLAY". No doc in this repo records that custom overlays are barred at official events, so the fact that decides everything is currently unwritten here. The desk's headline surface is the one thing an official event may not use; without this mode the standard is offseason-only. With it, "the desk does everything the FMS bar does not" makes `/s/talent`, `/s/next`, `/s/side`, `/s/replay`, `/s/var`, `/s/cards` and the arcade legal at roughly 200 official events. The scene-name alias half is separately the cheapest adoption lever in the list, because `DEFAULT_SCENES` in `cue/engine.ts` is already overridable at construction. A [community overlay author found the same rule himself and asked whether a custom overlay is legal, and nobody answered](https://www.chiefdelphi.com/t/creating-custom-fms-synced-stream-overlays-in-obs/443301); a standard other events adopt has to answer it.

**Where.** SceneMap profile as a config entry consumed by `opts.scenes` in `cue/engine.ts`; a `config.event` flag read by `surfaces/program/program.js`; per-season safe-area numbers in the same `data/game-profile.json` as the framing mask.

**Effort.** Small for the aliases, medium for compliance mode. **Serves.** Standard.

**Caveat.** A direct code-level conflict to resolve structurally, not by documentation: `obs.ts`'s `suppressCheesySources` actively disables any source whose name says it renders a field-generated overlay, to keep one overlay on air. Compliance mode requires the inverse. The two must be mutually exclusive by construction. Compliance mode ships off by default, since a Cheesy Arena event has no FMS bar to show. The bar's geometry changes between seasons, so the reflow is a per-season measurement, not a constant. Word the claim as "follows the documented FMS Audience Display requirements as of \<date\>" with the link; do not promise legality you do not control.

Note also: do **not** rebuild the FMS Companion shim as an ingest path. `docs/01` already carries the full `FMS_*` table, all ten Companion states, the default port and the page/row/column semantics, and `docs/02` §`fms` specifies the three-leg adapter and records the decision not to build it because CalGames runs Cheesy Arena. That decision stands. What *is* worth adding is the arbitration setting `docs/02` never addressed, because it assumed the two would never run together: if FMS drives OBS and the desk drives OBS, one of them must be declared the owner, and echo suppression is required since the cue engine already drops its own `ev.source === 'cue'` events for the same reason.

#### 51. Switcher abstraction and a vMix driver

**What.** Replace `ObsClient | null` in `CueEngine`'s constructor with a narrower `SwitcherClient` interface, borrowing the shape from [Sofie's timeline-state-resolver](https://github.com/Sofie-Automation/sofie-timeline-state-resolver) rather than inventing it, then add `apps/core/src/cue/vmix.ts` against the HTTP API on 8088 and the TCP API on 8099.

**Why.** The single biggest structural barrier to goal 2, and the seam already exists: `CueContext` funnels every scene change through `ctx.scene(name)`, so a second driver is a file rather than a rearchitecture. vMix appears only in `docs/09`'s open decision 4 ("OBS or vMix", defaulted to OBS). Every technical claim verifies: [the vMix TCP API is on fixed port 8099](https://wp.vmix.com/help28/TCPAPI.html) with TALLY, FUNCTION, ACTS, XML, SUBSCRIBE and TALLY values 0=off/1=program/2=preview; and [the Web Browser input "supports transparent backgrounds and alpha channel"](https://www.vmix.com/help27/WebBrowser.html) when the body background is left unspecified, so `/s/program?key=alpha` drops straight in. The audience is real: [the FIM AV team runs vMix](https://www.chiefdelphi.com/t/frc-blog-2023-audience-displays/426918), and an OBS-only standard is unadoptable by a whole district. The TCP TALLY push also hands the tally item its inbound half for free.

**Where.** `apps/core/src/cue/engine.ts`, new `apps/core/src/cue/vmix.ts`.

**Effort.** Medium. **Serves.** Standard.

**Caveat.** vMix is Windows-only and paid, and the free tier's input limit is a real constraint for a four-camera plus three-browser-source show. Do the interface half regardless; it is cheap and it is what makes the ATEM driver a later decision rather than a rewrite.

#### 52. Companion: variables first, module second

**What.** Two steps in order. A small outbound publisher (`apps/core/src/companion.ts`) mirroring match number, next-match ETA, publish-queue depth, cue arming and stream health into Companion custom variables and repainting specific keys, with control inbound via the stock Generic HTTP module. Then `companion-module-wrrf-contentdesk` built from the official TypeScript template, published as a versioned `.tgz` on the release page with an importable button page.

**Why.** `docs/02`'s services table says plainly the Companion integration is not built and `docs/01` only ever treats Companion as an input. The variables step de-risks the module into something you learn from at a rehearsal instead of guessing at, and a TD who already owns a Stream Deck gets value on install day; the data already exists (`pace.nextStartAt` on `DeskState`, arming on `/api/cues`, depth on `/api/publish`). Every endpoint verifies against [Companion's v4.2 docs](https://companion.free/user-guide/v4.2/remote-control/http-remote-control/): `POST /api/custom-variable/<name>/value` and `POST /api/location/<p>/<r>/<c>/style?bgcolor|color|text`. The `.tgz` side-load path is the valuable insight for the module and it checks out: [Companion's docs](https://companion.free/user-guide/v4.2/config/modules/) say the import button takes "a .tgz file produced by building a single module, most likely distributed by the module author", and an offline module bundle exists for installs with no store access, which matters for a venue with no internet. FRC crews already run Companion because [FIRST ships its own FMS integration](https://fms-manual.readthedocs.io/en/latest/audience-display/automation/bitfocus-companion.html), and [`companion-module-base`](https://github.com/bitfocus/companion-module-base), [`companion-module-template-ts`](https://github.com/bitfocus/companion-module-template-ts) and the precedent of [`companion-module-h2r-graphics`](https://github.com/bitfocus/companion-module-h2r-graphics) all exist under the Bitfocus org.

**Where.** `apps/core/src/companion.ts` (disabled unless config names a host, so it costs nothing when absent); the module is a separate repo generating its action and variable list from the same `types.ts` `server.ts` uses.

**Effort.** Small then medium. **Serves.** Standard. **Depends on** item 49.

**Caveat.** Label the variables step as scaffolding: hand-styled buttons do not survive a Companion config reset, and nobody should treat it as the deliverable.

#### 53. Tally

**What.** A `/s/tally?cam=N` full-screen red/green phone page plus an endpoint matching an existing open tally protocol, and a tally row on `/s/remote`; consuming tally inbound once the vMix driver exists.

**Why.** No tally of any kind exists in code or docs (the only "tally" hits in the repo are the word "totally"). The desk is unusually well placed for it: it already emits `scene.change` on every cue and already drives OBS, so program state is free, and [volunteer camera operators arrive with no pre-event training](https://www.firstinspires.org/community/volunteers/roles/audio-visual-crew). [TallyArbiter](https://josephdadams.github.io/TallyArbiter/docs/intro) is the right reference (sources include Ross via TSL 3.1, ATEM, VideoHub, OBS and vMix; outputs include web/phone, blink(1), relay, GPO, M5StickC, webhooks, TCP, OSC and MQTT; it emulates a vMix tally server and integrates with Companion), and [wifi-tally](https://wifi-tally.github.io/index.html) establishes the cheap-hardware pattern. The inbound half is the genuinely additive part: the wide-shot lock in `cue/engine.ts` reasons about scene names, not about what a camera operator can see, and real tally would let it reason about the right thing.

**Where.** New `surfaces/tally/`, added to `OPEN_SURFACES` in `access.ts` (it must load with no PIN on a taped-up phone), subscribing to `scene.change` over `/ws`; scene-to-camera map in `config.json`.

**Effort.** Small. **Serves.** Both.

**Caveat.** FRC-specific demand is inferred rather than reported; no thread asks for it. Size it as the two-hour phone page, not a hardware programme, and do not build TSL UMD output. The honest limit: the desk knows which *scene* it asked OBS for, not which camera is in that scene, so the mapping is config that goes stale silently. Ship it two-state.

#### 54. Generated event kits

**What.** A `tools/kit` generator emitting an importable OBS scene collection, a `.companionconfig` page, a vMix preset and a printable wiring card, all derived from `config.json` and regenerated every release.

**Why.** Small, and it is the piece that turns the desk from a thing one person can run into a thing a stranger can install. The failure it prevents is verified and silent: [FIRST's own docs](https://wpilib.screenstepslive.com/s/fms/a/1208601-obs-websockets) require scenes "named exactly as specified", a typo produces a black screen mid-match, and the same page carries the match-play warning. Both prerequisites exist: `config.json` is the single source of event truth and `DEFAULT_SCENES` is already overridable, so both the `CG_*` and `FMS_*` profiles fall out of one generator. [Companion's offline module bundle](https://companion.free/user-guide/v4.2/config/modules/) means the kit can carry the module `.tgz` for a venue with no internet.

**Where.** New `tools/kit/` alongside `tools/launcher/`; shares the printable-card renderer with the doors-check sheet and the AV pattern book's patch sheets.

**Effort.** Small. **Serves.** Standard.

**Caveat.** In bold in the docs: an imported OBS scene collection can overwrite an existing one. The kit must import as a new named collection.

#### 55. AV pattern book, with the NDI recipe and PTZ documented rather than coded

**What.** A new `docs/14-av-pattern-book.md` plus an `av/` directory: three named costed tiers (one laptop one camera; the CalGames tier; NDI multi-cam), each with a BOM, signal-flow diagram, an addressing plan that avoids the field's 10.0.100.x, and a labelling scheme, plus patch sheets and cable labels generated from the event's own config. Includes the NDI distribution recipe (DistroAV for OBS, native NDI for vMix, receiver config for venue displays and pit monitors) and the zero-code PTZ tier.

**Why.** The most on-goal item in the AV area for goal 2. `docs/06` is genuinely good and genuinely one tier: the CalGames tier, with CalGames-specific advice down to the venue's own 2025 power outage. The gear diversity nobody has written down is verified: [four districts, four camera choices](https://www.chiefdelphi.com/t/who-is-using-ptzoptics-cameras-for-live-streaming-events/501850) (Panasonic AW-UE50KPJ at CAMB/CASJ/CABE, Marshall CV605BK with the FIRST Webcast Unit, Aida PTZ-X12/X20 in Texas, PTZOptics plus a Sony with AI face tracking at FIM), and the thread exists because none of it is documented. [AV Crew requires no pre-event training](https://www.firstinspires.org/community/volunteers/roles/audio-visual-crew) and the [Webcast Operator path](https://www.firstinspires.org/resource-library/frc/webcast-operator) is tied to the FIRST Webcast Unit and does not transfer to a self-equipped offseason. NDI belongs here rather than in code, and the evidence is an FRC offseason already doing it: [Spectrum 3847's TRI writeup](https://www.chiefdelphi.com/t/spectrum-3847-build-blog-2024/447471/600) lists [DistroAV](https://github.com/DistroAV/DistroAV) and describes using a third network jack to "distribute the event as an NDI stream across campus for the pits, concession stand, and volunteer lounge". Same for PTZ: [obs-ptz](https://github.com/glikely/obs-ptz) already does VISCA over RS232/RS422/UDP/TCP, Pelco-P/D, experimental ONVIF *and* automatic camera selection based on the active scene, and Spectrum's rack already runs it, so the desk changing OBS scenes plus that plugin gets most of the value for zero code.

**Where.** `docs/14-av-pattern-book.md` and `av/`; the generator belongs in `tools/kit` so it reads the same `config.json`.

**Effort.** Medium. **Serves.** Standard.

**Caveat.** The runbook must state the managed-switch/IGMP requirement and must forbid NDI on the field network, which `docs/06` and the [Cheesy field-network wiki](https://github.com/Team254/cheesy-arena/wiki/Field-Network-Setup) both establish as sacred. Explicitly record the decision *not* to link the NDI SDK (see Not doing).

#### 56. Keyboard contract, OBS dock, display identify

Three small, unrelated, cheap adoption levers, grouped because none needs a section of its own.

| Item | What | Why | Effort |
|---|---|---|---|
| Frozen shortcut contract | Consolidate the existing per-surface bindings into `surfaces/_shared/keys.js` with one frozen table using F13-F24 and Ctrl+Alt ranges, plus a printable card and a QMK/VIA keymap | Cheapest possible control surface, and it survives the failure where the Companion laptop dies, at an event whose risk register leads with a venue power outage. The pattern already exists (`/s/desk` has visible `kbd` hints); what is missing is the freeze and the collision-safe key choice | Small |
| OBS custom browser dock, and on-air reporting | Ship `/s/desk` as a dock URL, and have `/s/program` register `obsSourceActiveChanged`/`obsSourceVisibleChanged` and report back | Resolves the shortcut item's focus problem (a macropad cannot reach a background tab) with no native key listener. The second half closes a real blind spot: the cue engine already reports "it would have fired" so a producer can watch a cue be right before arming it, but nothing today can say whether the graphic it fired was on screen. [obs-browser's README](https://github.com/obsproject/obs-browser) verifies the whole API surface and the control levels 0 NONE through 5 ALL | Small |
| Display identify and per-output profiles | Persistent names for every venue screen, a big IDENTIFY mode (number, name, detected resolution, grid, overscan border), and saved profiles for resolution, safe area, letterboxing and brightness | Correcting the sweep: the desk has no registry of venue screens at all. `--display-id` is the desk registering *itself* with Cheesy Arena as one audience display. Load-in identification is what a second event notices on day one. Align with [Cheesy's own `setup_displays`](https://github.com/Team254/cheesy-arena/wiki/Field-Network-Setup) fleet concept rather than duplicating it | Small |

**Caveats.** Read-only OBS control level is enough; never request ALL. Docks run in CEF, so the console's drag-and-drop media upload path needs testing there. Identify only reaches screens running a desk surface, so it cannot help with a mislabelled HDMI patch upstream of the browser.

### 2c. Distribution and stewardship

#### 57. Public hosted demo

**What.** A static read-only instance of the surfaces replaying a canned event log at a public URL, with a surface picker and a compressed clock so quals through playoffs runs in a few minutes.

**Why.** This is the adoption funnel and the rest of axis 2 is downstream of someone seeing it work. Demo mode exists (`--demo`, `START-PRACTICE.cmd`, the launcher's press-D prompt) but every path to it requires downloading and running an exe first, so the person deciding whether to adopt must install software before seeing anything. The adjacent project that actually got adopted led with exactly this: [PitRadar's "if you enter 99999 for the team number it will load a synthesized demo event (it loops through an entire event every hour, 1 minute = 1 match)"](https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920), pitched as "No install, no account, no app store", reaching 3,801 views and 120 likes, with "We ran PitRadar at the Georgian event last weekend and loved it" arriving within days.

**Where.** `apps/core/src/demo.ts`, `data/events/*.ndjson`, served as a static export from the conformance fixtures on GitHub Pages, which avoids a permanent hosting bill for a project with no server.

**Effort.** Medium. **Serves.** Standard.

**Caveat.** Strip PINs, the field bridge, the publish queue and every real team photo.

#### 58. Adopter runbooks and a diagnostics bundle

**What.** A `docs/adopt/` tree organised by the job someone is doing that morning, each page assuming zero context and ending with "if it breaks, do this"; plus `/s/diag` and a Save diagnostics button writing one zip of versions, redacted config, recent DeskEvents, adapter state and browser/OS.

**Why.** Half covered from two directions, and the remainder is exactly the adopter-facing half. `docs/13` is already genuinely written for the person who has not read the other twelve, and README's "Where these commands go" spells out opening PowerShell, so the house style is right; `docs/12` already carries an unbuilt rookie-operator-training finding. The deltas are a tree that never says CalGames, and the diagnostics bundle, which is obviously next given `docs/13` already says `desk-log.txt` "is the first thing to ask for when somebody reports a problem over the radio". [Nexus's role-organised documentation](https://guides.frc.nexus/) across roughly twelve event roles is the benchmark, and both recent pit-display projects shipped [in-app bug reporting on day one](https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920).

**Where.** New `docs/adopt/`; new `/s/diag`.

**Effort.** Medium. **Serves.** Both.

**Caveat.** Make `docs/adopt/` the only tree the launcher and surfaces link to, and add the same CI brand-string check that guards the theming work. The diag bundle depends on the secrets split from item 48, or it ships credentials.

#### 59. Runtime floor and cross-platform packaging

**What.** First, try removing `--experimental-strip-types` from `package.json` against the embedded Node 22.23.2. Then add `start.command`/`start.sh` bootstraps and a documented git-clone path, and plan the signing story.

**Why.** Every npm script currently runs `--experimental-strip-types` and `engines` says `>=22.6`, so a developer at another event who clones and runs `npm start` gets a warning or a parse failure as their first experience. But type stripping is on by default in current Node, and the embedded runtime is already past that point, so this may be a one-line fix that preserves the no-build-step principle at zero cost. Check that before designing anything larger. The platform argument verifies: [115 off-season events in 2025](https://frc-events.firstinspires.org/2025/events/OffSeason) including two in Australia, two in Turkey, and events in Brazil, Canada, China, Israel and Mexico. `tools/launcher/` is Windows-only by construction (a C# launcher compiled by the in-box compiler, with `node-v22.23.2-win-x64.zip` embedded).

**Where.** `package.json`, `tools/launcher/`.

**Effort.** Small for the flag; large for packaging. **Serves.** Standard.

**Caveat.** `sharp` is an `optionalDependency` with native binaries, so the mac/Linux path must degrade gracefully with robot cutouts and social cards as the casualties. On signing: [Microsoft no longer guarantees EV-signed applications avoid SmartScreen warnings](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings) (note the sweep's claim that this changed in 2024 is unsupported by that page), and a paid signing subscription needs an organisation to hold it, which is the same WRRF governance conversation as B1. Document the macOS right-click-Open workaround explicitly rather than making volunteers find it. If you embed an exact Node, you own Node security updates for every adopter; say so in the README rather than discovering it in January.

#### 60. Season versioning and a game-rules-change policy

**What.** Version as `YEAR.MINOR.PATCH` matching the FRC season, cut a maintenance branch per season, document a release train that does not merge features during competition weekends, and publish a per-release compatibility statement plus a written game-rules-change policy.

**Why.** `package.json` is at `0.1.0`, which reads as not-of-this-world to an FRC adopter, and an event running in October 2026 has nothing to pin. The rules policy has concrete teeth, as B3 demonstrates: whether the ENERGIZED threshold is 100 or 240 is exactly the class of thing that should be a documented promise rather than an implementation detail scattered across three files.

**Where.** `package.json`, README.

**Effort.** Small. **Serves.** Standard.

**Caveat.** Keep the season branch to security and event-breaking fixes only and say so, or adopters expect backported features.

#### 61. Machine-checked accessibility gate

**What.** Turn the accessibility rules into failing tests: contrast across every palette pairing actually used, flash-rate analysis against the WCAG three-flash threshold, minimum hit targets on phone surfaces, and a caption-safe-area assertion.

**Why.** This argues with a decision the project made deliberately, but on grounds that did not exist when it was made. `docs/09` states the colourblind pass is "a Friday task with the graphics on the actual projector, not a code change, since every color-carrying element already has a non-color cue", which is sound for one event run by the people who built it. It stops being sound the moment goal 2 exists: an audit is a human pass that expires when someone forks and re-themes, and a downstream event swapping the palette inherits none of it. [FIRST's guidance](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-accessibility.pdf) notes "About 1 in 20 people are colorblind in some way".

**Where.** A new test file under `apps/core/src/` reading `packages/theme/tokens.css`, run by the existing `npm test`.

**Effort.** Medium. **Serves.** Standard.

**Caveat.** Ship only the computable half: contrast ratios from token values, flash rate from the motion system's declared durations, target sizes from CSS. Drop the CVD render-snapshot half; it needs a headless browser, which fights the no-build-step and double-click constraints, and snapshot diffs are flaky across font stacks. Provide a documented, logged override so a volunteer can ship a fix at 7am on match day.

#### 62. Message catalog, RTL rules, interpreter layout

**What.** Extract every user-visible string into `locales/en.json` during the theme work, and write the RTL-aware layout rules and a per-locale type-scale override into the token contract. Ship an `?interp=on` program variant reserving a fixed region for an interpreter PiP that no lower third, strap, status card or bumper may composite into.

**Why.** No i18n exists anywhere: every surface is `lang="en"` with strings inline across twenty HTML files. The catalog is the half that matters for goal 2, because it is the difference between "other events can translate it" and "other events can translate it without touching code", and the international base is verified above (115 events, seven countries outside the US). The sequencing insight is the load-bearing one: extraction is cheap while the token layer is being rebuilt and expensive afterwards. The interpreter layout is small and is exactly the kind of thing a published standard should ship so a forking event that finds an interpreter can use them the same afternoon: [the RECF asks the head referee to place interpreters where D/HH students can see both the HR and the interpreter](https://kb.roboticseducation.org/hc/en-us/articles/22353712963095-Needs-based-Special-Accommodations), and [FIRST recommends events work with teams to find one](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-accessibility.pdf).

**Where.** `surfaces/_shared/`, `packages/theme/contract.css`, a distinct layout in `surfaces/program/index.html`.

**Effort.** Medium for extraction; small for the interpreter layout. **Serves.** Standard.

**Caveat.** Do not attempt locales for 2026. An untranslated catalog must fail visibly ("not yet translated"), never silently. The 28px gym floor and chamfer geometry were tuned for English caps and need per-locale type-scale overrides. The interpreter region must be a distinct layout, not a toggle: reserving 25% of frame collides with the scorebug and analysis strap geometry in `docs/03`.

#### 63. Launch

**What.** An "Introducing…" Chief Delphi thread the week after CalGames 2026, led with the hosted demo, two weeks of staying in the thread, a PR adding the project to the Awesome-FRC index, GitHub Discussions linked from the README, and two or three named 2027 pilot events written up publicly.

**Why.** Measurable, not a guess. One Chief Delphi post took [PitRadar](https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920) from a personal project to multiple named Ontario events inside a week (3,801 views, 120 likes, 66 posts), and [PitFUSION](https://www.chiefdelphi.com/t/introducing-pitfusion/517885) got 2,143 views and 41 likes from one post about a single HTML file. There is no equivalent of the WPILib-installer bundling channel for event-side software, which is why Chief Delphi and the organiser network are the distribution you have. The launch-content lesson also verifies: PitFUSION's users immediately needed a theming guide and API-key handling and neither existed on day one, so ship items 46 and 48 first.

**Effort.** Small. **Serves.** Standard.

**Caveat.** Post *after* CalGames 2026, not before: launching ahead of running it in anger invites scrutiny you cannot answer. Start with GitHub Discussions rather than a Discord; a quiet Discord reads worse than none and is a permanent support obligation for a one-maintainer project.

#### 64. Surface plugin API

**What.** A surface as a directory with a `surface.json` manifest (id, route, title, subscribed event types, auth requirement, surface class), discovered from both `surfaces/` and `events/<key>/surfaces/`, with two worked examples.

**Why.** Accurate about the current state: `SURFACES` is a hardcoded array in `server.ts` line 48 and `/s/{id}` resolves against a fixed directory, so an adopter's own award screen or regional sponsor reel is a merge conflict every release. The maintainer-drowning pattern is documented: a [PitFUSION user asked for a resizable two-team super-pit layout](https://www.chiefdelphi.com/t/introducing-pitfusion/517885) and got a corner-case decline, while Statbotics, chat and themes were all requested by different people within days.

**Effort.** Medium. **Serves.** Standard.

**Caveat.** Rank this last of the adoption levers. Untrusted surface code in the same origin as the PIN-gated control surfaces is a real problem given `access.ts` is a deliberate allowlist in both directions: v1 must be read-only subscribers with no filesystem or network privileges of their own, and a plugin that can register a route is a hole in the thing protecting the show. Refuse to promise stability on internals.

---

## Ranked shortlist

The top of the list, if only ten things happen. Value is to an event; demand is the strength of the verified evidence.

| # | Item | Value | Demand | Effort | Axis |
|---|---|---|---|---|---|
| 1 | Licence, notice, trademarks, governance (B1) | Critical | Structural | Small | Standard |
| 2 | Coverage reconciliation ledger (8) | Critical | [Verified, named events](https://www.chiefdelphi.com/t/missing-event-videos/458269) | Medium | Both |
| 3 | Per-team media locker (27) | Critical | [Verified](https://www.chiefdelphi.com/t/how-to-access-match-videos-vods/460856) | Small | Program |
| 4 | Surrogate/DQ + card ledger (1, 2) | High | Manual-mandated | Small | Both |
| 5 | Doors-open preflight (12) | High | [Verified](https://fms-manual.readthedocs.io/en/latest/scorekeeper-reference/step-by-step/setup.html) | Medium | Both |
| 6 | Event pack and theme contract (46) | Critical | [Verified](https://www.chiefdelphi.com/t/introducing-pitfusion/517885) | Medium-large | Standard |
| 7 | Desk vitals + audio watchdog (13) | High | Verified | Medium | Both |
| 8 | Run-of-show engine (19) | High | [Verified](https://www.chiefdelphi.com/t/calgames-2025-oct-3-5/502690) | Medium | Both |
| 9 | Drift-aware break clock (20) | High | Verified | Small | Program |
| 10 | Accessibility services card (32) | High | [FIRST requirement](https://www.firstinspires.org/hubfs/web/program/frc/events/pg-accessibility.pdf) | Small | Both |

---

## Not doing

Recorded so nobody has to re-argue them. Each is a real idea with a real reason it is out.

| Item | Reason |
|---|---|
| **Native NDI SDK output (program, fill+key, SRT out)** | The load-bearing claim is false: `docs/06` already specifies a luma-keyed feed into the ATEM DSK as a first-class overlay path and `?key=luma` exists for exactly that, so an ATEM event is not blocked. The "headers are MIT" premise does not survive checking either: [docs.ndi.video's licensing page](https://docs.ndi.video/all/developing-with-ndi/sdk/licensing) describes a proprietary agreement with flow-through obligations, a required ndi.video link near every use and a trademark notice. Embedding it also collides with the single-runtime-dependency rule, the no-build-step rule and the double-click launcher. Documented recipe only (item 55). |
| **CasparCG HTML template contract** | No demand. CasparCG appears nowhere in this repo and nowhere in the FRC sources checked. Four functions bolted onto `program.js` is four functions of dead code a future refactor must keep working, on a page whose screen switching is driven entirely by `DeskState`. Revisit only if a specific adopting event with an SDI facility asks. |
| **Browser-based crew comms (WebRTC push-to-talk)** | Inferred demand only; no FRC thread asks for it. It collides with the risk register, which already lists telestrator Wi-Fi latency as live on a dedicated 5GHz AP, and real-time voice is strictly harder than ink strokes on the same network. A software bug that blasts a volunteer's headset in a room [measured at 90+ dBA](https://www.chiefdelphi.com/t/noise-levels-at-first-competitions/429188) is a safety exposure a school facility agreement will not forgive. The answer is cheap FRS radios, which is an ops purchase. **Salvage:** a text IFB line to `/s/talent` (one field, one event type, no audio), folded into item 34. |
| **dB(A) SPL logging and a loudness governor** | Three separate research items reached this and `docs/12` already settled it: PA levels belong to event ops and the sound contractor, and the desk's real lever, "treat the PA as unreliable and put everything that matters redundantly on-screen", is already implemented. The sweep's own risk note concedes uncalibrated consumer mics produce numbers worse than none, and publishing a compliance trace the project cannot stand behind creates liability for a volunteer organisation on a school campus. The thread also undercuts the fix: multiple posters report the loudest thing is the crowd, not the music. **Salvage:** a max-volume clamp on the desk's own music bus while the MC mic is keyed, in `audio/store.ts`, which is a rule on a bus the desk already owns. |
| **frc-colors per-team accents** | Rejected twice in writing. `docs/12` has a full finding and `docs/09` P2.5 closes it: the WRRF palette is mandated and alliance colours are semantic-only. The `/s/cards` carve-out fights that directly since the cards are the event's most-shared branded artifact. Nothing changed except the API being up, which was never the blocker. |
| **Judging and deliberation room** | The one item where risk most exceeds value. Judge notes about named students are the most sensitive data at the event, and this codebase's central property is an append-only replayable log that ships as a development fixture; the mitigation is not a config flag, it is a different storage model. It is also large, lands on a volunteer role that may simply refuse to use it, and is the furthest thing here from the desk's competence. [gms.pejaver.com](https://gms.pejaver.com/Overview.htm) already does it. **Salvage:** the pit-availability map alone, if item B4 says yes to Nexus. |
| **Full volunteer roster manager** | A general-purpose scheduling problem with mature free alternatives, and coordinators will not switch mid-event. Volunteer PII in a system whose log is append-only and shipped as a dev fixture is the same tension as judging. **Salvage:** CSV in, live coverage board out. The coverage board is the only part that benefits from knowing the drift-adjusted clock, and it is small. |
| **Assistive listening audio to phones** | Effort materially understated and two constraints bite: the dual bus is a physical mix-minus at the venue console, so the desk does not have the announcer leg in software and needs a new capture path first; and latency is the product (200-500ms usable, 3s not), which rules out the existing browser-friendly paths and points at WebRTC or a media server, a heavyweight dependency in a no-build-step project that starts by double-click. Never claim ADA compliance for a phone stream regardless. Post-event research at best. |
| **Live ASR captions on the announcer bus** | The headline argument ("the clean announcer bus is what makes ASR work, and this project has one") is already written in `docs/06` and repeated in `docs/11`, so it is not a new finding. Local ASR needs a model and a native runtime, fighting the no-build-step and double-click rules, and contends with encode on the show box, which `docs/09` already identifies as the tight resource. **Salvage:** the offline sidecar pass (item 36), the authored text bus (item 34), and a documented zero-build path via [the OBS captions plugin in Spectrum's stack](https://www.chiefdelphi.com/t/spectrum-3847-build-blog-2024/447471/600). Correct `docs/06` and `docs/11` either way, because the YouTube auto-caption plan is gated on a 1,000-subscriber threshold nobody has checked. |
| **Separately switched house program bus** | The evidence is thinner than presented: [the CA LAD thread](https://www.chiefdelphi.com/t/please-keep-full-field-view-on-the-webcasts-ca-lad/516992) is 5 posts and 413 views and the on-site posters conclude it was a one-match mistake. It also takes back the venue projector that `docs/06` deliberately assigns to Cheesy Arena's own audience display as one of three rules enforcing "one overlay system on air", which needs re-opening explicitly rather than implicitly. And with a minimum viable crew of three it needs an operator the event does not have. |
| **Phase-conditional secondary camera coverage roles** | Highest blast radius in the AV set, fights the project's own wide-shot lock (which exists because of the same thread), and needs more cameras and more volunteers than exist. The community objection is real and specific ([floor cameras "just take up screen real estate"](https://www.chiefdelphi.com/t/a-call-to-action-camera-angles/517913); split screen "a worse stream") but it argues for the *framing policy* `docs/12` already resolved. Not this cycle. |
| **Composited framing check surface** | The practice is already in `docs/12` in almost these words. The real blocker is not the mask: the desk has no camera ingest surface at all (`recorder.ts` is an ffmpeg subprocess, not a browser-reachable feed), so "each camera at 1:1 under the overlay" needs a per-camera preview the project does not have. **Salvage:** the `data/game-profile.json` half, which items 50 and 55 need anyway. |
| **Event Day Mode (mutating half)** | Pausing Windows Update and changing power policy needs elevation, and a UAC prompt for an unsigned in-house exe is exactly the trust problem packaging has. `docs/13` explicitly lists no service, no startup entry, no registry writes and no admin rights as deliberate. **Salvage:** detect and advise only, which needs no elevation: MDM/domain detection ([FMS's own requirements say "Do not install FMS Off-Season on machines that are school or business 'owned' or controlled"](https://fms-manual.readthedocs.io/en/latest/off-season-fms/configuration/about-off-season-fms-and-requirements.html)), battery check, sleep prevention via `SetThreadExecutionState`, and a printable note for the school's IT contact. |
| **Automatic degraded-mode ladder** | Automatic step-down on a live broadcast cuts against per-cue arming, cues-start-disarmed and operator-in-the-loop. **Salvage:** items 17's two pieces. |
| **ATEM driver** | `docs/06` already routes the desk's graphics to an ATEM via a luma-keyed DSK, so an ATEM event is not blocked. **Salvage:** the interface half, which item 51 does anyway. Build the driver when an adopting event asks. (Citation corrections for the record: the nrkno Sofie URL redirects to Sofie-Automation, and `brenapp/tm-switcher` does not exist; the real tool is [AlecH92/tm-obs-switcher](https://github.com/AlecH92/tm-obs-switcher), whose README confirms ATEM control on match queue/start but states neither a licence nor an event count.) |
| **HyperDeck record control** | Entirely contingent on hardware nobody has confirmed, and it would be the desk's first outbound write to production hardware other than OBS. Confirm the deck exists in the `docs/06` rack first, and if Cheesy's own Blackmagic integration is enabled the desk must not also drive it. |
| **Scouting ingest (QRScout / Purple Standard)** | Architecturally sound, but value at this event is speculative: a one-day offseason with no scouting culture may produce zero data, and `/s/talent` already has an operator-editable fact line that does the same job with one keystroke. The [Purple Standard thread's](https://www.chiefdelphi.com/t/the-purple-standard-a-unified-and-community-driven-standard-for-frc-scouting-data/449394) XSS objection would also be the operative constraint. Revisit after the standard has adopters. |
| **Rebuilding the FMS Companion shim as ingest** | Already researched in more detail than the sweep provided: `docs/01` carries the full scene table and all ten Companion states, `docs/02` specifies the three-leg adapter, and the decision not to build it stands because CalGames runs Cheesy Arena. |
| **Off-Season FMS adapter** | `docs/09` decision 1. An adapter reverse-engineered from SignalR traffic carries none of the structural safety guarantee `docs/10` rests on. Publish the SPI; let someone else write it. |
| **Stills pipeline** | Genuinely valuable and genuinely large, and the timestamp-to-teams join is something only this system can do. But camera clocks drift and are frequently wrong, so it needs a one-shot sync step and a confidence indicator before anything auto-publishes. Post-event. |
| **Jurisdiction profile** | Correct that the legal work is US-shaped and that [FIRST itself operates under GDPR with data in Germany](https://www.firstinspires.org/about/privacy-policy). But shipping jurisdiction profiles from a volunteer project reads as legal advice. Revisit when a non-US adopter actually asks, and frame it then as configuration plus a checklist their own counsel signs. |
| **Off-season legal packet generator** | Generating legal forms from a codebase is where a template bug becomes a real-world problem, multiplied across every adopter. **Salvage:** a checklist doc plus a slot for WRRF's own reviewed PDF, with form *status* (not documents) stored as the source for the media posture flag. Whether a listed offseason inherits FIRST's consent coverage is genuinely open; WRRF should ask FIRST rather than rely on anyone's reading. |
| **CLA** | Scares off students for no benefit at this scale. |

---

## Sequencing

Today is 11 August 2026. The event runs 16 to 18 October. Code freezes Monday 12 October, which is nine weeks out. Everything in the "before" column has to be rehearsable by the weekend of 3 to 4 October so there is a full dry run against `harness-offline.mjs` and a real fake-arena pass with time to fix what it finds.

### Week 0 (this week): decisions, not code

- **B3** ENERGIZED RP threshold verified against the REBUILT manual, all three constants corrected if needed.
- **B1** licence conversation opened with the WRRF board. The files can land the day the answer comes back.
- **B2** `schemaVersion` and `seq` on the envelope. Ten minutes, and it gets much more expensive after the event log exists as a reference fixture.
- **B4** Nexus yes/no. If no, items 3-and-friends (pit map, inspection, lineups-from-Nexus) leave the roadmap now rather than in week six.
- **B5** crew size named. Everything below is scoped against the answer.

### Weeks 1 to 3: correctness and the safety net

Nothing here is optional and nothing here is large.

1. Surrogate/DQ flags (1), card ledger (2), tiebreak order (7).
2. Doors-open preflight with the proved network row (12).
3. Desk vitals with the audio watchdog and the `eventSubscriptions` change (13); disk guard (10); recording liveness and real QC (9).
4. Coverage reconciliation ledger (8).
5. Program dead-man slate (14); broadcast pinning (17).
6. Field-bridge finishing: raw-bytes `get()`, delay reasons, bracket, sponsor slides (1h). The `/match_logs/` addition needs the FTA re-sign, so start that paperwork now or drop it.

### Weeks 4 to 6: the program

7. Run-of-show engine (19) and the drift-aware break clock (20). Break clock first: it is small and it is the piece that pays off even if the rundown slips.
8. Awards as data with the emit-path embargo (21); certificates and engraving fall out of it.
9. Per-team media locker (27) and the social kit (30).
10. Latching emergency announcement (16).
11. Offline fallback pack (22).
12. Roster of record (23) and the team media intake plus consent posture (29). Intake needs to be live for teams several weeks out, so if it happens it starts here at the latest.
13. Sponsor ledger (24) if sponsors are named by now; otherwise the config slot only.
14. Playoff lineups and backup pool (4), alliance selection rules engine (5), filler line (6). These three share a mechanism; build the lineup event once.

### Weeks 7 to 8: accessibility, privacy, rehearsal

15. Accessibility services card (32), phase banner (33), talent prompts (35), text announce bus (34), low-stim mode (37), phone-surface remainder (38).
16. No-PII crowd identity plus display-name filter and operator kill (39).
17. Notice and signage pack (41); music ledger and `docs/15` (42); claim watchdog and live kids declaration (43); chat posture runbook (45).
18. Replay-on-boot recovery (15), tested by killing the process mid-harness.
19. Result amendment lineage (3) if it fits; otherwise the print-only correction path and defer the automation.
20. Full dry run: fake arena, three simulated days, preflight signed, load-out gate exercised, printed pack produced.

### Freeze week (12 to 15 October)

Docs, printed sheets, run-of-show finalised, cue arming reviewed, no code. The offline caption sidecar (36), highlight packages and wrap show (31) and load-out hashing (11) are the natural things to cut if weeks 4 to 8 run long: none of them changes whether the event runs, and all three are better built once with real material than rushed.

### Post-event: the published version

Ordered by dependency, not by appeal.

1. **B1 files land** (if the board conversation is still open, this is the first thing after the event).
2. Event pack and theme contract (46), with i18n string extraction folded in (62). Everything downstream reads better once brand strings are out of code.
3. Golden-log conformance and config validation with the secrets split (48). Record the CalGames fixtures *from the real event log*, which is the single best artifact this event produces for the standard.
4. Publish the DeskEvent schema and the adapter SPI (47).
5. Scoped tokens and `/api/v1` (49).
6. Public hosted demo (57), served from those fixtures.
7. FMS scene aliases and compliance mode (50); generated event kits (54).
8. Adopter runbooks and diagnostics bundle (58); governance docs if not already done.
9. **Launch** (63). Not before all of the above: PitFUSION's users needed a theming guide and key handling on day one and neither existed.
10. Switcher abstraction and vMix (51); Companion variables then module (52); tally (53).
11. AV pattern book with the NDI and PTZ recipes (55); keyboard contract, OBS dock and display identify (56).
12. Runtime floor and packaging (59); season versioning (60); accessibility gate (61).
13. Surface plugin API (64), last, and read-only.
14. Event debrief and the published event report (25, 26) run against the CalGames 2026 log as the worked example.

The honest summary of the two axes: the program axis is mostly small items the desk already has the data for and simply does not render or check, which is why so much of it fits in nine weeks. The standard axis is four artifacts (a licence, an event pack, a schema, a conformance suite) and then a distribution act, and none of the four is hard, but nothing else on that axis can start until the first one exists.