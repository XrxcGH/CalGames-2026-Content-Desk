# 12. Community research: FRC event complaints vs. this desk

What the FRC community actually complains about: webcast/AV quality, between-match
pacing, spectator experience, and volunteer tooling. Researched across Chief Delphi,
Reddit, FIRST official blogs, and ecosystem project pages (July 2026), then deduplicated
and judged against what the desk implemented at the time of the audit. 42 findings from
66 raw citations across six research angles.

**Statuses are the audit's, kept as the record of why each piece was built.** The P2.5 build
([09-roadmap-and-risks.md](09-roadmap-and-risks.md)) has since closed most of the gap list;
findings that are now shipped carry a *Built since this audit* note.

Statuses: **not-implemented** (a real gap), **partial** (we cover half),
**already-implemented** (community validation of a shipped feature),
**out-of-scope** (event ops, not broadcast software, with the desk-adjacent lever noted).


## Not implemented: the gap list

### Announcer/emcee has no data support: build the talent view and adopt gatool

*widespread*

Merged from four raw findings. Announcers mispronounce team names, mis-explain penalties, and lack ranks/RP thresholds in front of them; the community ships gatool.org and a yearly Game Announcer Cheat Sheet because the alternative is '60 sheets of paper', and gatool now works with Cheesy Arena at offseasons (announcer must be on the Cheesy network, mixed-content browser caveat, not Safari). The best GAs do heavy manual prep (per-team history spreadsheets, pronunciation checks). The desk's architecture diagram (docs/02) lists an 'Announcer / analyst tablet' surface but nothing exists in surfaces/ and the docs never mention gatool.

**Recommendation:** Two-track fix. (1) Zero-code: add gatool to the ops runbook (GA device on the production LAN reachable to the Cheesy host, note the unencrypted-content browser caveat, confirm on the FTA sign-off sheet). (2) Cheap build: a read-only /s/talent page off the existing event bus with next-match team cards (name, rank, W-L, pronunciation note, one editable fact line seedable from TBA/Statbotics), live RP-threshold progress (same data driving the badges), and a producer-pushed storyline note; link the REBUILT cheat-sheet PDF. Ensures what the PA says matches what the overlay shows.

**Built since this audit:** `/s/talent` covers track (2): next-match team cards, ranks, RP
progress in words, and pronunciation notes that persist on the device. It links gatool.org as
the zero-code companion.

- <https://www.chiefdelphi.com/t/what-makes-a-good-emcee-and-ga/364583>
- <https://www.chiefdelphi.com/t/first-game-announcer-tool-is-now-available-for-everyone/501909>
- <https://www.chiefdelphi.com/t/rebuilt-game-announcer-cheat-sheet/510633>
- <https://www.chiefdelphi.com/t/first-game-announcer-tool-now-works-with-cheesy-arena/504876>
- <https://gatool.org/>
- <https://github.com/arthurlockman/gatool-api>
- <https://www.chiefdelphi.com/t/ftc-game-announcing-any-tips/520944>
- <https://www.chiefdelphi.com/t/any-advice-for-a-new-fll-game-announcer/418690>
- <https://www.chiefdelphi.com/t/2023-iri-stream-is-actually-really-good/438732>
- <https://www.chiefdelphi.com/t/2026-scoreboard-graphics/513120>

### Run a second, clean static full-field stream alongside the produced show

*recurring*

Where events run two streams (PNW, PCH DCMP, Einstein 2025's alternate feed) the community is unanimous that one must be a clean static full-field view, since it reconciles produced-show whip-around coverage with scouting/picklist needs. The Einstein alternate feed was called a 'lifesaver' when the main show shrank the field for driver cams.

**Recommendation:** Cheap with existing infrastructure: the rolling-record pipeline already ingests the field-wide camera, so add a second OBS output (or second encoder, subject to NVENC session limits in docs/04) streaming the static wide shot with only the minimal score bar to a second YouTube destination. Make it the first thing shed when uplink bandwidth is tight, consistent with the deferred-upload philosophy.

- <https://www.chiefdelphi.com/t/a-call-to-action-camera-angles/517913>
- <https://www.chiefdelphi.com/t/at-least-there-is-a-second-stream/499776>
- <https://www.chiefdelphi.com/t/a-plea-to-event-av-crews/402017>

### Alliance selection has zero broadcast support; offseason pick clocks are proven

*recurring*

Selection is a long on-stage segment where spectators watch students walk across a floor, with no graphics support at most events. IRI's experimental pick clock (2023, refined 2024) got strong community feedback; threads debate time limits but agree the segment stalls the show. The desk's feature list has no alliance-selection support of any kind.

**Recommendation:** Build an alliance-selection board overlay: live alliance grid, remaining ranked teams (from the rankings poll the hub already does), accepted/declined states, and an optional pick-clock countdown graphic so CalGames can run an IRI-style timed selection.

**Built since this audit:** the program's `selection` screen draws captains in seed order, the
ranked pool graying out as teams are taken, and Cheesy Arena's own pick clock.

- <https://www.chiefdelphi.com/t/split-thread-alliance-selection-time-limits-iri/438736>
- <https://www.chiefdelphi.com/t/2024-iri-alliance-selection/468464>
- <https://www.chiefdelphi.com/t/time-limits-on-alliance-selection/463464>

### Video-Assisted Referee (VAR): the top new offseason feature runs on the desk's existing replay stack

*recurring*

Chezy Champs 2025 adopted a full VAR addendum (credited to Sunset Showdown): Head Ref or dedicated VAR reviews any call using only official field cameras, one playoff challenge coupon per alliance captain, 120-second review cap. Community pressure for video review is long-running and loud: official rules bar it, so score disputes stall events while refs deliberate from memory and the call stands even when wrong; offseasons are explicitly the pilot ground. The desk's rolling multi-cam record + markers + clip-seek is exactly the hardware/software a VAR seat needs, but there is no ref-facing workflow.

**Recommendation:** If CalGames adopts VAR (or even informal head-ref replay-on-request), give the head ref a dedicated read-only replay view (timeline + frame-step, no cut/publish controls) fed from desk recordings, kept entirely outside the Cheesy field bridge. Pair with the 'Match Under Review' broadcast state (see review-states finding) so the 120-second window isn't dead air.

**Built since this audit:** `/s/var` gives the head referee a frame-step view of the recording,
read-only by construction: no cut, no send to air, no publish, no route to the field.

- <https://media.team254.com/2025/09/978607e3-CC2025-RuleChanges-v2.pdf>
- <https://www.chiefdelphi.com/t/chezy-champs-2025/500661?page=3>
- <https://www.chiefdelphi.com/t/proposal-limited-video-review-for-red-card-calls-in-frc/518490>
- <https://www.chiefdelphi.com/t/offseason-video-review-pilot-volunteers/150483>
- <https://www.chiefdelphi.com/t/video-review-needs-to-happen-now/150451>
- <https://www.chiefdelphi.com/t/lack-of-referee-replay-leads-to-lack-of-gracious-professionalism/463164>

### No closed captions on the stream (accessibility)

*occasional*

Raised in the DMCA/stream-audio thread as a cheap accessibility win ('even the poorly-done live OBS services instead of NOTHING'), and FUN's Tyler Olds added it to his checklist on the spot. FRC streams almost universally ship without captions. Merged from two raw findings citing the same thread.

**Recommendation:** Enable YouTube Live automatic captions (zero effort) or an OBS captioning plugin fed by the announcer/desk mic bus, which works well only if the dual-bus audio split (see stream-audio findings) keeps that bus clean. Also makes the archived VOD searchable.

- <https://www.chiefdelphi.com/t/lets-solve-the-twitch-and-youtube-dmca-issues-from-streams/429168>

### QR codes bridging venue screens to score detail, stream, and schedule

*occasional*

Since 2025 FIRST's own audience displays put a QR code on every match-results screen linking to the detailed breakdown on FRC Events, and parents' guides lean on QR/app links as the answer to 'what just happened?'. No QR codes exist anywhere in the desk's surfaces.

**Recommendation:** Add a small QR to the final-score screen (venue projector path), a rotating QR on side screens (TBA event page, live stream URL, phone-facing next-match view), and a TBA-match-page QR on the 1080×1080 social cards. Cheap canvas render; matches what spectators now expect from official events.

**Built since this audit:** the side screens carry a vendored-QR corner card pointing at
`/s/next`, no third-party QR service, so it works on a LAN with no internet.

- <https://www.chiefdelphi.com/t/frc-blog-2025-scoreboard-and-live-stream-graphics/491037>
- <https://www.chiefdelphi.com/t/2026-scoreboard-graphics/513120>
- <https://community.firstinspires.org/2026-scoreboard-and-live-stream-graphics>

### frc-colors.com per-team brand colors as graphic accents

*occasional*

frc-colors.com provides a free public API returning verified primary/secondary colors per team (auto-extracted from avatars when unverified); ecosystem tools use it for team-focused UI. The desk's brand system is strictly WRRF palette + official alliance red/blue; nothing in the repo references it.

**Recommendation:** Optional polish: pull frc-colors during the Friday cache pass and use team primary color as an accent on team lower thirds and social cards, subject to the brand rule that alliance red/blue stay semantic-only, with contrast-checking against the purple/gold chrome.

- <https://www.chiefdelphi.com/t/announcing-frc-colors-com/444254>
- <https://github.com/jonahsnider/frc-colors.com>
- <https://frc-colors.com/>

### FIRST team avatars are allowlisted but nothing renders one yet

*recurring*

Team avatars are the official per-team identity mark on FIRST's own scoreboard/stream graphics, fetchable via TBA APIv3. The bridge's read allowlist covers `/api/teams/{id}/avatar` (docs/10), and docs/04's team tag and docs/07's photo fallback chain were both designed around one, but no surface actually fetches or draws an avatar today: the alliance overview falls straight from an uploaded cutout to the plain gold-number plinth, and the telestrator tag is a number puck with no image.

**Recommendation:** Wire up the tier-2 avatar fallback in `surfaces/program/program.js`'s `robotCard()` first, since that is the one place a small, deliberately-not-upscaled avatar (docs/07) was actually planned. Revisit the telestrator tag and the other text-only reuses (docs/07) once that exists.

- <https://www.chiefdelphi.com/t/frc-blog-2026-team-avatars/511664>
- <https://www.chiefdelphi.com/t/frc-blog-2026-scoreboard-and-live-stream-graphics/513783>
- <https://www.thebluealliance.com/apidocs>

## Partially covered: the missing half

### Full-field in-match camera view is the community's #1 production rule: codify it and check the composited frame

*widespread*

Merged from four raw findings; the single most repeated demand across Chief Delphi. Failure modes: main cams that 'literally see 0 robots' at match start or crop field corners so human players, corner scoring, and stack lights are invisible (5 of 10 sampled 2025 week-1 webcasts didn't show the full net); playoff whip-around coverage that leaves out half the field; overlays and location titles occluding the field once the match starts (camera ops and FTAs see the raw camera, never the composited output); decorative borders eating pixel area. Scouts consume hundreds of archived matches, so a cropped scoring element ruins the archive. Events with a true static full-field view (FIM, Tech Valley, PCH DCMP) get explicit praise; acceptable embellishments are split-screen endgame insets and cuts only between matches.

**Recommendation:** The cue engine switches to field-wide on match.armed and the hardware plan has a wide PTZ plus two alliance cams, but nothing codifies the policy. Add: (a) autopilot rule locking program to the field-wide shot between match.start and match.end (tight/corner cams are for replays, endgame insets, and the analysis desk only); (b) a load-in/pre-quals framing checklist covering all four corners, every scoring element, human-player zones, and stack lights in frame at 1080p, re-verified for drift mid-event; (c) a Friday composited-output check: run a practice match, watch the actual stream, confirm score bar and lower thirds occlude nothing load-bearing. The rolling-record pipeline makes (b)+(c) easy: record 30 seconds and review before going live.

- <https://www.chiefdelphi.com/t/a-call-to-action-camera-angles/517913>
- <https://www.chiefdelphi.com/t/please-keep-full-field-view-on-the-webcasts-ca-lad/516992>
- <https://www.chiefdelphi.com/t/a-wishlist-for-the-polish-of-frc-events/367016>
- <https://www.chiefdelphi.com/t/a-plea-to-event-av-crews/402017>
- <https://www.chiefdelphi.com/t/why-does-any-event-ever-do-camera-zoom-ins-on-event-streams/402333>
- <https://www.chiefdelphi.com/t/webcast-operators-please-include-the-net/497409>
- <https://www.chiefdelphi.com/t/frc-blog-2025-scoreboard-and-live-stream-graphics/491037>

### Venue/DJ music on the stream bus gets streams muted, banned, and VODs killed (DMCA/Content ID)

*widespread*

Merged from four raw findings; the most-discussed AV pitfall in FRC. Official event Twitch VODs are unpublished and never re-posted for DMCA fear ('the entire event is gone forever'); team restreams get struck '80% of the time'; several official FIRST Twitch channels were banned mid-event in September 2025; YouTube Content ID scans live streams in realtime and can flag uploaded match videos that picked up house music on crowd mics. The converged community fix is a dual audio bus: venue/DJ mix never reaches the stream; the stream gets announcer + field sound + a licensed/allowlisted bed (PNW runs Spotify to the venue and licensed Monstercat to the stream off one console; veteran streamers take an FX/aux send of just MC mics and field sound). OBS multi-track audio lets the recording/VOD track omit music entirely.

**Recommendation:** Extend the dual-bus policy to the main program: stream bus = announcer + field FX + licensed bed only; venue bus keeps the DJ music. Use OBS multi-track so replay clips and uploads carry a music-free track; add a pre-upload audio check to the publish queue.

**Built since this audit:** docs/06 now specifies exactly this in "Audio: two buses, and music never leaves the room", with the music source physically absent from the STREAM bus and the wiring documented at the mixer. Still open from the recommendation: OBS multi-track on the recordings and a pre-upload audio check in the publish queue.

- <https://www.chiefdelphi.com/t/lets-solve-the-twitch-and-youtube-dmca-issues-from-streams/429168>
- <https://www.chiefdelphi.com/t/opinions-on-twitch-as-an-frc-streaming-platform/458993>
- <https://www.chiefdelphi.com/t/several-first-channels-banned-from-twitch/506468>
- <https://www.chiefdelphi.com/t/event-livestreaming/145356>
- <https://www.chiefdelphi.com/t/music-copyright-issues/456392>
- <https://www.chiefdelphi.com/t/frc-regional-dj-guide/130483>
- <https://www.chiefdelphi.com/t/event-recordings-and-audio-quality/520141>
- <https://www.chiefdelphi.com/t/2023-iri-stream-is-actually-really-good/438732>

### Announcer buried under music and over-processed audio on stream/recordings

*widespread*

Long-running complaint that the mix makes speech unintelligible, 'like the adults in the old Charlie Brown cartoons.' A 2026 thread reports FIRST event recordings apply so much noise cancellation/compression that crowd moments cut in and out (author emailed FIRST, no reply). At scale everything runs through one console; the ask is a stream mix where MC/announcer mics are isolated from music and not aggressively gated. Same root cause and same fix as the DMCA finding (single venue-mixer feed), but a distinct complaint: intelligibility rather than copyright.

**Recommendation:** Request an aux/stream mix from the venue console with announcer and field-mic channels separate from music; duck music under the announcer on the stream bus; avoid aggressive noise gating on the stream/recording path; rehearse the mix Friday: echo and level problems get called out live even at praised events.

- <https://www.chiefdelphi.com/t/event-recordings-and-audio-quality/520141>
- <https://www.chiefdelphi.com/t/a-wishlist-for-the-polish-of-frc-events/367016>
- <https://www.chiefdelphi.com/t/the-music-is-too-loud/499828>

### Events run chronically behind schedule: compute and surface drift-adjusted match times

*widespread*

TBA built predicted match times because published schedules are meaningless: events run up to 2+ hours behind (rarely >15 min early), qual cycles center ~7 min with 120s standard deviation, and slow cycles accumulate irreversibly. CD threads confirm 7-10 minute cycles at typical events and note the manual's 'expected start time' lets the printed schedule drift all day.

**Recommendation:** The desk polls schedule/rankings but computes no drift. Add a rolling actual-cycle-time estimator (TBA-style: median of recent cycles, excluding breaks/outliers) and surface 'running X min behind / est. start HH:MM' on side screens, the on-deck queue, the phone-facing schedule view, and optionally a broadcast lower third.

**Built since this audit:** `apps/core/src/pace.ts` implements the median-cycle estimator, and
drift-adjusted start estimates now appear everywhere a schedule does.

- <https://blog.thebluealliance.com/2017/05/11/tech-talk-how-tba-predicts-match-times/>
- <https://www.chiefdelphi.com/t/time-to-overhaul-match-schedules/461557>
- <https://www.chiefdelphi.com/t/match-scheduler-criteria/386813>

### Unexplained field delays read as dead air: add audience-facing status messaging

*widespread*

Merged from three raw findings. Robot/radio connection problems (not field reset) are the dominant slow-cycle cause (VH-109 heat/link threads, CA offseasons piloting revised match-start processes), and spectators experience these as unexplained idle time; long stoppages 'suck the energy out of the crowd' (Einstein primetime thread, Israel DCMP Q62's marathon field fault). For families who came to see one team, an unexplained 40-minute hold with no on-screen status is the worst part of the day. The desk detects robot-dropped-connection (as replay markers) and arms screens before countdown, but nothing tells the room or stream why the field is waiting.

**Recommendation:** Add an audience-facing field-status card ('Waiting on robot connection', 'Field reset in progress', 'Field delay, back at HH:MM') derived from allowlisted Cheesy Arena state, auto-shown on program and side screens when the gap exceeds a threshold, plus a single 'unplanned delay' macro on the desk console that flips to the trivia/arcade rotation with a 'back shortly' bug in one keystroke.

**Built since this audit:** one desk button raises a status card (Field delay / Score review /
Arena fault / Match replay, with an estimated return time) on program, side screens, and phones
at once.

- <https://www.chiefdelphi.com/t/time-to-overhaul-match-schedules/461557>
- <https://www.chiefdelphi.com/t/frc-vividhosting-vh109-radio-heat-and-delay-problem/484792>
- <https://www.chiefdelphi.com/t/a-new-match-start-process/507748>
- <https://www.chiefdelphi.com/t/frc-einstein-almost-ready-for-primetime/136966>
- <https://www.chiefdelphi.com/t/israel-dcmp-q62-world-record-field-fault/407228>

### Per-team, phone-and-pit-facing schedule/queue view ('when does team X play next')

*widespread*

Merged from four raw findings; the most tool-solved spectator/team pain in the community. PitRadar (4+ pages of traction) exists because most people at an event can't see the field or a schedule reflecting reality; Nexus sends queuing notifications at 140+ events; parent guides tell families to install TBA just for match alerts; at 2026 Champs LTE was so bad the Nexus website wouldn't load and the top ask was physical displays in the pits; a small team reported 'no one was coming by to tell us to get to queue.' A pit-display ecosystem (Nexus pit display, PitFUSION, PitRadar) fuses queue + rankings + stats onto one glanceable screen.

**Recommendation:** The room-scale side screens (on-deck queue + rankings) cover the main venue but are not per-team and not reachable from a phone or pit TV. Serve the side-screen data as a lightweight LAN page any phone or pit TV can open (the trivia phone stack and REST-polling surface architecture already prove the pattern), showing current match, next 3 queue calls, 'when does team X play next', and drift-adjusted estimated times; put its QR on side screens and social cards.

**Built since this audit:** `/s/next` answers "when do we play?" on any phone, reached by the
side screens' QR card, and `/s/watch` wraps any open screen for a pit TV that has nothing but a
browser.

- <https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920>
- <https://pitradar.app/>
- <https://www.chiefdelphi.com/t/nexus-2024-queuing-notifications-more/454370>
- <https://www.chiefdelphi.com/t/game-day-prep-what-to-pack-to-spectate-in-frc/378026>
- <https://www.chiefdelphi.com/t/the-nexus-website-is-insufficient-for-queueing-notifications-at-champs/519694>
- <https://www.chiefdelphi.com/t/change-my-mind-some-match-turnaround-times-are-too-tight/497488>
- <https://guides.frc.nexus/guides/pit-display>
- <https://github.com/mpking828/PitFUSION>

### Nexus is the de facto event-management layer: integrate or at least don't contradict it

*widespread*

Nexus (formerly FRC Queue) ran at 140+ events in 2024 including Champs, became a nonprofit in 2025, and solves the top team complaint (when to queue) via queuer-driven push notifications, announcements, parts requests, and alliance-selection check-in. It exposes a public API (live event status, match-timing estimates, push webhooks) that PitFUSION and PitRadar already consume. The desk's side screens show the on-deck queue from Cheesy Arena; nothing reaches team phones and there is no Nexus link in the codebase beyond a reference in docs/01.

**Recommendation:** If CalGames runs Nexus (queuers use it independently of the desk), consume the Nexus API for the side-screen queue view so venue screens and team phones agree, or embed the Nexus pit display as an alternate side-screen rotation. At minimum add Nexus to the ops runbook as recommended tooling and verify side screens never contradict Nexus queue statuses.

- <https://www.chiefdelphi.com/t/nexus-2024-queuing-notifications-more/454370>
- <https://www.chiefdelphi.com/t/nexus-is-now-a-nonprofit-is-launching-3-new-apps-for-events/506500>
- <https://frc.nexus/en/api>
- <https://guides.frc.nexus/guides/queuing>

### Newcomers and parents don't understand the game: no explainer content exists

*widespread*

Team 2363 prints tri-fold spectator brochures because 'I had no idea what was happening' comes up repeatedly from parents, grandparents, and sponsors; community members argue FRC games have 'convoluted scoring mechanics that aren't visibly obvious'; third-party parent guides (FRC Zero) exist because events don't explain the game to families on site.

**Recommendation:** RP badges with icons, hub-state text, and scorebug-education trivia questions help, but there is no dedicated explainer. Add a 30-60s 'how to watch REBUILT' graphics loop for pre-session and gap time (auto, then teleop, then endgame, what hub shifts mean, what an RP is) plus a printable/QR one-pager modeled on the Triple Helix tri-fold that side screens can point to.

**Built since this audit:** the program's `explain` screen loops six cards, twelve seconds each,
in the gaps: what fuel is, why only one hub scores, why a losing alliance is celebrating.

- <https://www.chiefdelphi.com/t/2019-spectators-guide/348609>
- <https://www.chiefdelphi.com/t/frc-doesnt-need-to-be-a-spectator-sport-to-change-culture/386829>
- <https://www.frczero.org/competition/parents-guide-to-competition/>

### Scorebug polish: event name on graphics, low-contrast RP states, and a scores-settling state

*recurring*

Merged from three raw findings. The desk is ahead of official graphics on the biggest asks (live bonus-RP progress with icons, hub-state indicator with text, red-left/blue-right locked to the scoring-table view, auto/teleop/foul final breakdown). Remaining community asks it doesn't cover: the event name on the score overlay/results screen ('my kingdom for the event name'), which also brands every uploaded match-video frame; grayed-out RP indicators indistinguishable on washed-out projectors; and viewer confusion when the display freezes at T=0:00 while scoring counts until T+0:03, so the frozen realtime score is mistaken for final.

**Recommendation:** Add event name/branding to the score bar and final-score screen; verify achieved-vs-unachieved RP badge states survive a washed-out-projector/720p-phone test; add a brief 'scores settling' state between the buzzer and score post; and confirm at the venue that the broadcast camera actually sits on the scoring-table side so the red-left/blue-right lock matches what viewers see.

- <https://www.chiefdelphi.com/t/frc-blog-2025-scoreboard-and-live-stream-graphics/491037>
- <https://www.chiefdelphi.com/t/frc-blog-2026-scoreboard-and-live-stream-graphics/513783>
- <https://www.chiefdelphi.com/t/2026-scoreboard-graphics/513120>
- <https://www.chiefdelphi.com/t/fuel-is-counted-until-t-0-03-but-not-on-the-audience-display/515863>
- <https://www.chiefdelphi.com/t/2023-iri-stream-is-actually-really-good/438732>

### Secondary angles miss the human element: human players, stack lights, consistent layouts

*recurring*

Broadcasts often show only one alliance's human players; viewers asked to see driver-station stack lights; scouts found mid-season secondary-angle swaps 'frustrating and disorienting'; corner cams are praised only when they answer endgame questions. Pattern: secondary angles should be consistent match-to-match and cover what the wide shot can't.

**Recommendation:** The two fixed alliance cams are already the 'did they actually climb?' angles and the endgame cue cuts to a tight tower camera. Add framing guidance: alliance cams include the human-player zone and station stack lights in frame, and the secondary-angle layout stays identical across every match of the event.

- <https://www.chiefdelphi.com/t/a-call-to-action-camera-angles/517913>
- <https://www.chiefdelphi.com/t/frc-blog-2025-scoreboard-and-live-stream-graphics/491037>

### Match-replay, arena-fault, and score-review broadcast states

*recurring*

Merged from two raw findings. FIRST's own 2026 Newton FMS timer post-mortem shows field software derails timing with communication limited to next-morning announcements; arena-fault and 'match affecting' replay threads (Hopper Q110) show referee deliberation is opaque and slow from the stands; score disputes stall events while refs deliberate from memory and the crowd waits with no explanation. Replays inject unplanned extra cycles. FIRST's 2025 graphics package includes a 'Match Under Review' state; the desk has none.

**Recommendation:** Add operator-fireable broadcast states: 'score under review' / 'arena fault under review' holding banner (so deliberation reads as process, not dead air), a 'this match will be replayed' cue, and a re-run indicator on the pre-match overlay when a match number repeats in the Cheesy schedule. Pairs with the VAR finding if CalGames adopts review.

- <https://community.firstinspires.org/2026-newton-match-timing-what-happened-and-whats-next>
- <https://www.chiefdelphi.com/t/hopper-q110-replay-and-match-affecting-field-faults/519776>
- <https://www.chiefdelphi.com/t/clarification-on-arena-fault-definition-versus-head-referee-judgement/432659>
- <https://www.chiefdelphi.com/t/video-review-needs-to-happen-now/150451>
- <https://www.chiefdelphi.com/t/lack-of-referee-replay-leads-to-lack-of-gracious-professionalism/463164>

### Award ceremonies read as filler: pre-built winner graphics and social cards

*recurring*

Long delays for awards and speeches between playoff matches 'suck the energy out of the crowd' (FIRST eventually moved most awards to division level); closing ceremonies run long; families who leave early ask for recorded ceremonies. Ceremony length is event ops, but the broadcast can make ceremonies feel produced.

**Recommendation:** Pre-build award-winner lower thirds / full-screen cards driven by a desk-console list, and extend the existing 1080×1080 social-card generator to auto-build award-winner cards.

- <https://www.chiefdelphi.com/t/frc-einstein-almost-ready-for-primetime/136966>
- <https://www.chiefdelphi.com/t/recorded-award-ceremony/516458>

### Colorblind accessibility audit of red/blue coding and status indicators

*recurring*

Recurring across bumper-color, driver-station, and scouting-tool threads: ~8% of males have color vision deficiency; red/green codings fail them and some red/blue-adjacent ones too; SystemCore hardware moved to red/yellow/blue indicators specifically for distinguishability. The desk already de-risks some of this (hub-state text label, icon-based RP badges, value-contrast gold rule), but alliance identity on the score bar rests on the red/blue fills alone.

**Recommendation:** Run every surface through a CVD simulator (Color Oracle/Coblis), keep the fixed red-left/blue-right convention with small RED/BLUE text labels on the score bar, and audit operator consoles for red/green status pips.

- <https://www.chiefdelphi.com/t/split-thread-legal-bumper-colours/456604>
- <https://www.chiefdelphi.com/t/2025-bumper-rules-changes/478756>
- <https://www.chiefdelphi.com/t/looking-for-feedback-on-color-blind-friendly-heat-map-options/492764>

### Statbotics EPA prediction board is blocked: unblock with fallback, label the offseason caveat

*recurring*

EPA is the community-standard prediction metric with a free API and prediction displays are a recurring community project. The desk plans a prediction board (docs/02: pre-match prediction bar, 'biggest EPA delta', alliance-selection value board) but README marks it blocked on api.statbotics.io/v3 500s. Ecosystem caveats: EPA never updates from offseason matches (docs already plan an on-air 'season form' label); Peekorobo's ACE is the closest offseason-updating alternative.

**Recommendation:** Fall back to the Statbotics v2 API or a cached pre-event pull (the design already caches Friday); evaluate Peekorobo ACE as an offseason-aware alternative or secondary number; keep the planned 'season form, not current form' on-air label.

- <https://www.statbotics.io/blog/epa>
- <https://www.chiefdelphi.com/t/statbotics-2026-season/515311>
- <https://www.chiefdelphi.com/t/peekorobo-2026-season/514459>
- <https://www.chiefdelphi.com/t/presenting-frc-splat-a-comprehensive-event-and-season-monte-carlo-simulator-for-frc-powered-by-the-blue-alliance-and-statbotics/509593>

### Degraded-uplink runbook for the live encoder (venue internet is spotty and shared)

*recurring*

Offseason webcasters can't share the field's internet drop and buy their own (hundreds to $1k+) or use cellular; viewers report spotty streams and mock low bitrates. Deferred upload mode protects the uplink from the match-video queue and docs/11 notes uploads causing visible bitrate drops. The missing half is the live encoder side.

**Recommendation:** Define a degraded-uplink runbook: pre-configured low-bitrate OBS profile to switch to, local recording always on so archive and replay survive uplink loss, and a stream-health readout (dropped-frame percentage) on the dark operator console so the desk sees trouble before chat does.

**Built since this audit:** docs/11 now carries that runbook. It has the low-bitrate fallback profile, the local-recording-never-stops rule, and watch-the-encoder guidance (OBS's own dropped-frame percentage as the early warning). Still open: surfacing that dropped-frame figure on the desk's stream panel rather than in OBS's corner.

- <https://www.chiefdelphi.com/t/event-livestreaming/145356>
- <https://www.chiefdelphi.com/t/webcasts-2015/142529/42>
- <https://www.chiefdelphi.com/t/webcast-operators-please-include-the-net/497409>

### Low-latency program feed for pit areas

*occasional*

Teams watching from their pits resort to USB-tethered phones and LTE routers because venues provide no pit Wi-Fi and the public stream runs 30+ seconds behind; historic championship pits had a wired video feed teams could plug into. In-room distribution is treated as part of production at well-run events.

**Recommendation:** Side screens cover the venue floor but carry no video. Cheap options: one or two HDMI-over-cat5 runs or a LAN-local low-latency HLS/SRT endpoint of program output for pit TVs, keeping teams off cellular and off the delayed YouTube feed. Raise at the venue AV walkthrough before building software.

- <https://www.chiefdelphi.com/t/match-streaming-in-pits-how/522563>

### 'Pick the winner' audience predictions on the trivia stack

*occasional*

Team 971's FRC.bet ran a no-money prediction market at Madtown Throwdown with real engagement (8+ page thread, plus debate about gambling framing); FRCCast runs in-season prediction markets. The desk's crowd trivia is the same phones+leaderboard mechanic.

**Recommendation:** Add a 'pick the winner' question type auto-resolved from the Cheesy bridge's final-score event, reusing phone/leaderboard infrastructure. Avoid money/market framing (community sensitivity); simple pick-em with streak scoring. Could feed a 'crowd pick vs EPA pick' pre-match graphic.

**Built since this audit:** the pick-the-winner round exists. `trivia.pick()` queues a prediction on the loaded match, the host opens it in the pre-match gap, and reveal resolves it against the posted score (docs/09 lists it done). Still open: the 'crowd pick vs EPA pick' pre-match graphic.

- <https://www.chiefdelphi.com/t/prediction-market-app-by-frc971-public-beta-at-madtown/507971>
- <https://www.chiefdelphi.com/t/frccast-prediction-markets-for-on-season/514709>

### Make the automation override contract explicit so operators never fight autopilot on-air

*occasional*

Viewers described watching 'the webcam operator fighting the automated/programmed movement of the new PTZ cameras every 3rd shot' with 'match graphics popping up at seemingly random times.' The complaint is not automation but automation the operator can't see coming or cleanly override.

**Recommendation:** Per-cue autopilot toggles are the right shape; add a visible 'autopilot armed' state per cue on the desk console, a one-keystroke pause-all, and a rule that a manual operator action within N seconds of a scheduled auto-fire suppresses the auto-fire so the two never double-trigger on stream.

- <https://www.chiefdelphi.com/t/webcast-operators-please-include-the-net/497409>

### Rookie operator training curriculum on top of demo mode

*occasional*

Rookie field volunteers describe being thrown in with thin, informal person-to-person training and no safe place to practice; veteran trainers acknowledge training is inconsistent across regions. Demo mode with dummy data and the offline fake-field harness are exactly the right practice environment: the curriculum is missing.

**Recommendation:** Write a one-page training script per desk seat (program op, replay op, telestrator analyst, arcade/trivia host) that a rookie runs against demo mode in ~20 minutes the week before the event, ending with a simulated match cycle including a failure drill (field drops, autopilot pause).

- <https://www.chiefdelphi.com/t/past-event-reflection-an-intresting-fta-and-a-rant/506111>
- <https://www.chiefdelphi.com/t/a-new-match-start-process/507748>

## Already covered: community validation

### Gap-time analysis programming: replays, breakdowns, analysis desk (GameDay Live / FUN model)

*widespread*

Merged from three raw findings. Dead, silent streams between matches are a known production failure ('really boring to watch'); the community's answer is the GameDay Live formula (shoutcasters breaking down the previous match, instant replays, playoff analysis), and events doing it (IRI per-match highlight replays, NorCal's analysis desk called 'awesome... interesting to both experienced and inexperienced viewers', Tyler Olds' Kettering recaps remembered a year later) are the top-tier reference cases.

**Recommendation:** Covered: analysis-desk and arcade bumpers, multi-cam replay with slow-mo and auto markers, telestrator with analyst chip, arcade side tournament, crowd trivia, licensed music bed. One refinement from FUN's pattern: pre-plan a replay-heavy playoff rundown, since quals can run lean while playoffs are where replay staffing pays off.

- <https://www.chiefdelphi.com/t/lets-solve-the-twitch-and-youtube-dmca-issues-from-streams/429168>
- <https://www.chiefdelphi.com/t/fun-week-4-show-schedule/158266/6>
- <https://www.chiefdelphi.com/t/webcasts-2015/142529/42>
- <https://www.chiefdelphi.com/t/roboteer-rumble-2024/465242>
- <https://www.chiefdelphi.com/t/2023-iri-stream-is-actually-really-good/438732>
- <https://www.chiefdelphi.com/t/at-least-there-is-a-second-stream/499776>
- <https://www.chiefdelphi.com/t/chezy-champs-2022/410821>

### YouTube-first streaming with same-day match uploads linked to TBA

*widespread*

Merged from three raw findings. Same-day HD match videos on YouTube linked to TBA are now the community expectation ('auto parsing and youtube upload has been a game changer'); YouTube is strongly preferred over Twitch (blocked on school/work networks, VODs auto-unpublished, no rewind-while-live); the ecosystem repeatedly built this itself (FRC Live Replay, FRC-YouTube-Uploader).

**Recommendation:** Covered: YouTube Live RTMP with backup stream key, durable publish queue, resumable uploads, official naming, TBA match-video linking, deferred-upload mode. This is validation, not a gap. See the separate QC-gate and non-match-clip-types findings for the remaining work.

- <https://www.chiefdelphi.com/t/opinions-on-twitch-as-an-frc-streaming-platform/458993>
- <https://www.chiefdelphi.com/t/a-call-to-action-camera-angles/517913>
- <https://www.chiefdelphi.com/t/2023-iri-stream-is-actually-really-good/438732>
- <https://www.chiefdelphi.com/t/chezy-champs-2022/410821>
- <https://www.chiefdelphi.com/t/frc-live-replay-match-videos-automatically-recorded-and-uploaded-in-minutes/159204>
- <https://www.chiefdelphi.com/t/frc-youtube-uploader-match-uploading-program/348887>

### A QC gate now holds an implausible cut before it publishes

*widespread*

FIRST's auto splitter/uploader has repeatedly produced 11-15 second 'match videos', uploaded the wrong match, or dropped whole mornings (Kettering Q55-Q80, several FMA events); fixes depend on one volunteer's spare time. Scouts call timely, correct match video essential for picklists.

**Recommendation:** Covered: every publish-queue item kind carries a plausible duration range (`QC_BOUNDS` in `apps/core/src/publish/queue.ts`, e.g. 60-900s for a match), and a cut outside its range is parked `held` with a reason rather than moving on to upload. An operator releases it with `POST /api/publish/release` after a look, the same action that lets a `deferred`-mode queue go at end of day; there is no desk-console panel over the queue yet, so the look means `GET /api/publish`. See [11-distribution.md](11-distribution.md).

- <https://www.chiefdelphi.com/t/missing-event-videos/458269>
- <https://www.chiefdelphi.com/t/first-webcast-unit-video-issues/352827>
- <https://www.chiefdelphi.com/t/tba-not-showing-denver-code-regional-matches-yet/460514>

### Non-match segments and day-VOD chapters are in the publish queue

*recurring*

Beyond match clips, viewers ask for the full uncut day VOD (Twitch deletes them; teams restream to unlisted YouTube just to keep an archive), dedicated alliance-selection and per-award videos, recorded award ceremonies for families who leave early, and a chapter index so one match is findable in an eight-hour recording.

**Recommendation:** Covered: `queueSegment()` adds alliance selection, awards ceremony, and opening/closing segments as their own publish-queue item type, each named from `SEGMENTS` in `apps/core/src/publish/naming.ts` (anything else typed in becomes a literal title, for a single award's own video). The full-day stream stays public after the event for free, since it is the same YouTube Live archive this desk already uses. `apps/core/src/chapters.ts` turns the event log into a YouTube chapter list (`GET /api/chapters`), enforcing YouTube's strict, silently-failing rules (0:00 first, three chapters minimum, ten seconds each, ascending) before handing the paste-ready text back. See [11-distribution.md](11-distribution.md).

- <https://www.chiefdelphi.com/t/opinions-on-twitch-as-an-frc-streaming-platform/458993>
- <https://www.chiefdelphi.com/t/missing-event-videos/458269>
- <https://www.chiefdelphi.com/t/recorded-award-ceremony/516458>
- <https://www.chiefdelphi.com/t/frc-video-splitter-4/444971>
- <https://github.com/tytremblay/frc-video-splitter>
- <https://www.chiefdelphi.com/t/how-to-access-match-videos-vods/460856>

### Crowd trivia is the community's standard delay playbook, now being productized

*recurring*

Merged from two raw findings. When a technical delay hits, the accepted emcee practice is grabbing the mic and running crowd trivia; Nexus (used at 96% of 2025 events) launched 'Versus', a paid crowd-engagement trivia platform, confirming schedule-gap engagement is a recognized need, not a gimmick.

**Recommendation:** Covered: phone-based crowd trivia with leaderboard plus the arcade side tournament, at no per-event fee (the counter-argument if the committee ever considers paying for Versus). The one-keystroke delay macro is folded into the delay-messaging finding.

- <https://www.chiefdelphi.com/t/what-makes-a-good-emcee-and-ga/364583>
- <https://www.chiefdelphi.com/t/any-advice-for-a-new-fll-game-announcer/418690>
- <https://www.chiefdelphi.com/t/nexus-is-now-a-nonprofit-is-launching-3-new-apps-for-events/506500>

### Match-flow automation matches where CA offseasons are heading, but never synthesize the countdown

*recurring*

California offseasons (Tidal Tumble, Beach Blitz, both drawing the same volunteer pool as CalGames) face scorekeeper scarcity and are automating match flow: automated audience-display switching, handheld FTA match-start, Nexus-fed playoff lineups. The desk's OBS scene automation, per-cue autopilot, and armed-before-countdown transitions are exactly this. Critical caution from the same experiments: the audience hated the AI countdown voice ('I hate the ai countdown voice so much, please bring the normal mc countdown back').

**Recommendation:** Encode one rule: never synthesize the match countdown. The armed cue hands off to the human emcee's voice, which the clip cutter already anticipates ('three, two, one, GO' pre-roll).

- <https://www.chiefdelphi.com/t/a-new-match-start-process/507748>
- <https://www.chiefdelphi.com/t/so-many-volunteers-but-why/471079>

### Field-reset dead air is covered by gap content: verify cues are interruptible

*recurring*

The 2026 field was called 'time consuming to reset for volunteers'; reset length is unpredictable dead air between score reveal and next-match preview, and turnaround pacing is a perennial complaint. Gap content plus armed-before-countdown transitions are the desk's core answer; reset staffing itself is event ops.

**Recommendation:** One verification: every gap-content cue must be interruptible mid-segment so an early field-armed signal never strands the arcade or trivia on stream.

- <https://www.chiefdelphi.com/t/2026-first-lessons-learned-the-negative/519978>
- <https://www.chiefdelphi.com/t/change-my-mind-some-match-turnaround-times-are-too-tight/497488>
- <https://www.chiefdelphi.com/t/frc-blog-making-volunteering-for-first-even-better/160309>

### TBA GameDay webcast listing

*recurring*

TBA GameDay is the community's multi-stream viewing hub; events get on it via the Trusted API webcast flow, and viewers complain when a stream isn't listed. In the Trusted API v1 the webcast list is a field on `POST info/update` that overwrites the whole list; there is no dedicated webcast endpoint (docs/11 covers this).

**Recommendation:** Execute it: obtain the TBA Trusted API credentials for the event (the remaining blocker per README), and put the register-on-stream-start step on the day-of checklist, since nothing fires it automatically yet.

- <https://www.thebluealliance.com/gameday>
- <https://www.chiefdelphi.com/t/tba-week-7-stream-issues/518792>
- <https://www.thebluealliance.com/apidocs>

### YouTube upload caps and API quota mitigations are already planned

*recurring*

District upload volunteers hit YouTube's daily per-channel upload limits (PNW rate-limited early each season; Ontario spread videos across channels as a workaround); new channels have low caps that grow with history. The desk's docs/11 and roadmap risk table already distinguish channel caps from API quota, plan to use WRRF's established channel, and stage uploads across the weekend via the `deferred` default. A quota-exhausted item is not paused-and-resumed automatically: it goes `failed` after its retries and needs a per-item `POST /api/publish/retry/{id}` (docs/11, Failure handling).

**Recommendation:** Keep the existing plan, including the config note about enabling live streaming 24h in advance on the channel.

- <https://www.chiefdelphi.com/t/lets-solve-the-twitch-and-youtube-dmca-issues-from-streams/429168>

### Remote family can find matches, with a deferred-mode messaging caveat

*recurring*

Parent guides route families to TBA because events rarely communicate where to watch; the post-event ask is per-team findable match video, quickly. The desk's publishing pipeline (durable queue, official naming, TBA linking) is exactly what delivers this.

**Recommendation:** Two caveats: when deferred upload mode is active, tell the room and stream ('match videos post tonight'); and surface the stream URL + QR on side screens and social cards so remote relatives can find the broadcast during the event (overlaps the QR finding).

- <https://www.frczero.org/competition/parents-guide-to-competition/>
- <https://www.chiefdelphi.com/t/introducing-pitradar-a-free-live-competition-dashboard-for-pit-displays-spectators/517920>
- <https://www.chiefdelphi.com/t/frc-blog-2025-scoreboard-and-live-stream-graphics/491037>

### Robot photo shoot matches Chezy Champs' photo-booth practice

*occasional*

Chezy Champs runs a robot photo booth and publishes the set for teams; STEMley Cup made robot trading cards. Consistent robot photos are what make RSN-style pre-match alliance graphics possible. docs/07 specifies the shoot (3/4 angle, height normalization, gray backdrop avoiding the white-robot masking trap) and the roadmap assigns a photographer with a Friday photo block.

**Recommendation:** Optional extension in the Chezy spirit: publish the processed cutout library to teams after the event, since the social-card pipeline already produces shareable assets.

- <https://www.chiefdelphi.com/t/chezy-champs-2022/410821>

## Out of scope for the desk: event-ops levers noted

### Venue loudness and hearing safety

*widespread*

Merged from two raw findings. A decade-plus complaint chain: 90 dB sustained at scoring tables, 105+ dB at 2019 Champs, smartwatch hearing warnings, earplugs as standard spectator kit, inclusion concerns for neurodivergent attendees, and newcomers unable to hear the emcee explanations they need. This is in-venue PA operation by the event's AV contractor, not the broadcast.

**Recommendation:** PA levels belong to event ops/the sound contractor. Desk-adjacent notes: keep the stream mix independent of the venue mix so the broadcast doesn't inherit the loudness war, and treat the PA as unreliable for information delivery: everything that matters (score, RP status, who's next, delay reasons) should be redundantly on-screen. Optionally document a music/PA level guideline in the ops docs.

- <https://www.chiefdelphi.com/t/the-music-is-too-loud/499828>
- <https://www.chiefdelphi.com/t/noise-levels-at-first-competitions/429188>
- <https://www.chiefdelphi.com/t/first-making-it-too-loud/129443>
- <https://www.chiefdelphi.com/t/osha-noise-standards-and-first-events/89507>
- <https://www.chiefdelphi.com/t/game-day-prep-what-to-pack-to-spectate-in-frc/378026>

### Seat scarcity and seat-saving: mitigate with overflow viewing

*recurring*

Near-universal seat-saving despite the Admin Manual ban (a volunteer screamed at trying to seat his mom at Einstein); bleachers 'notoriously packed'; standing teams block sightlines; walk-in newcomers get the worst of it. Seating policy is venue/event ops.

**Recommendation:** The desk's lever is overflow viewing: program feed plus a side screen in the lobby/cafeteria/pit area, and a stream-URL QR on side screens so anyone in a bad seat can watch the field feed on their phone.

- <https://www.chiefdelphi.com/t/frc-rules-around-seating-need-to-change/152068>
- <https://www.chiefdelphi.com/t/game-day-prep-what-to-pack-to-spectate-in-frc/378026>

### Commentary staffing: pro anchor plus rotating FRC guest analysts

*recurring*

IRI 2023 is the reference case: a professional play-by-play voice paired with a published hourly rotation of FRC guest analysts; 'the combination of a professional commentator with limited robotics knowledge and an experienced FRC mentor leads to good commentary for everyone.' RSN at Champs is the gold standard; dead air and uninformed commentary are the recurring complaints. Staffing, not software.

**Recommendation:** The desk already supports it (separate ducked desk-mic channel, analyst chip, name/title lower thirds with auto-dwell). Recommend the committee recruit one anchor voice plus a published rotation of guest analysts in 45-60 minute slots, introduced via lower thirds.

- <https://www.chiefdelphi.com/t/2023-iri-stream-is-actually-really-good/438732>
- <https://www.chiefdelphi.com/t/at-least-there-is-a-second-stream/499776>
- <https://www.chiefdelphi.com/t/chezy-champs-2022/410821>

### Real-time TBA match data is Cheesy Arena's job, but verify it's configured

*recurring*

Offseason events reach the fan ecosystem (TBA app notifications, Statbotics, PitRadar, GameDay match bar) via TBA's Trusted API; Cheesy Arena publishes schedule/results/rankings natively. The desk deliberately scopes this out ('We publish video and webcasts only. Cheesy Arena owns match data on TBA') with a correctly minimal tba.ts allowlist, but the whole downstream ecosystem depends on someone remembering to configure Cheesy's TBA keys.

**Recommendation:** Keep the division of responsibility, but add a pre-event checklist item (FTA sign-off sheet, docs/10) verifying Cheesy's TBA publishing is configured with the event's Trusted API keys, and a desk health check that alerts if TBA match data stops flowing during quals. Desk video linking and the fan ecosystem both depend on it.

- <https://blog.thebluealliance.com/2017/06/13/tech-talk-how-the-blue-alliance-gets-data/>
- <https://www.thebluealliance.com/apidocs>
- <https://github.com/Team254/cheesy-arena/blob/main/README.md>
