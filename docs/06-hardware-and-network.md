# 06: Hardware, network, and show flow

## Network: the field is sacred

The FMS field network is VLAN-segmented so every team's driver station is isolated from every
other team's and from field electronics. FMS lives at `10.0.100.5`. **The content desk does not
live on that network.**

```
   ┌──────────────────────── FIELD NETWORK (FTA owns) ────────────────────┐
   │  FMS / Cheesy Arena  ·  team VLANs  ·  field AP  ·  station cabinets │
   └──────────────────────────────┬───────────────────────────────────────┘
                                  │  ONE cable. Read-only. FTA-approved.
                        ┌─────────▼──────────┐
                        │      bridge        │  2 NICs, no routing, no NAT
                        │  eth0: field side  │  · reads Cheesy Arena WS
                        │  eth1: production  │  · receives FMS Companion POSTs
                        └─────────┬──────────┘  · publishes to production only
                                  │
   ┌──────────────────────────────▼────────────────────────────────────────┐
   │            PRODUCTION LAN  10.20.0.0/24  (content desk owns)          │
   │  core · replay · OBS · ATEM · telestrator AP · consoles · side screens│
   └───────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **Never touch a team VLAN. Ever.** Not to debug, not "just to check."
2. The bridge is the **only** machine with a foot in both networks, it initiates no writes to the
   field side, and IP forwarding is off. It is a consumer, not a router.
3. Get **written FTA sign-off** on the bridge before load-in, and bring a printed diagram. "Can I
   plug this into your field network" answered at 8am on Friday goes better with a diagram.
4. The production Wi-Fi AP runs on **5GHz, channels well clear of the field AP**, and is separate
   from the venue/team Wi-Fi. The telestrator tablet lives on it and nothing else does. 40 teams
   on a shared SSID will destroy your <80ms latency budget.
5. If the FTA says no to the bridge: the whole system still runs on manual desk input. Degraded,
   not dead. Design for this: it's a realistic Friday-morning outcome.

## Access: the shared PIN

Core itself isn't as private as owning the production LAN suggests. The desk runs on the venue
network, and at an event that network has a few hundred phones on it; the trivia QR code puts
core's address on a projector in front of the whole gym, so being on the content desk's own LAN is
not the same as being hard to reach. `apps/core/src/access.ts` gates every operator console and
every request that changes something (starting a match segment, cutting a clip, arming a cue)
behind one shared PIN, while leaving the overlays, the venue TVs, the two audience phone pages
(`/s/quiz`, `/s/next`), and the pit monitor kiosk (`/s/watch`, which only wraps screens that are
already open) open, since an OBS Browser Source cannot type a PIN and a spectator should not
have to.

The gate is on by default with the PIN `0864`, which is printed in this repo and therefore
public. Set the event's own before the desk goes anywhere near the venue network, not after.
With the launcher ([13-deployment.md](13-deployment.md)) that is `/pin:4726`; from the source it
is one line in the PowerShell window you start the desk from (the README's
"[Where these commands go](../README.md#where-commands-go)" note says how to open one):

```powershell
$env:REMOTE_PIN = "4726"; npm start -- --cheesy --cheesy-host 10.0.100.5:8080 --display-id contentdesk1
```

Startup logs which mode it's in and warns loudly if a venue-facing box comes up with the gate
off (an explicit empty `REMOTE_PIN`, the kitchen-table escape hatch).
It's one PIN, not per-volunteer accounts: the crew is a handful of people who arrive on the day, and
a password reset at 8am on a Saturday gets worked around by propping the door open. Hand it out to
crew the way you would a radio channel, not somewhere a phone camera in the stands could catch it.
Sign in once at `/signin` and the session lasts the day. Full open/gated surface list in
[README.md](../README.md).

## Machines

| Box | Job | Spec notes |
| --- | --- | --- |
| **bridge** | field-side ingest | anything with 2 NICs, like an Intel NUC or a mini PC. Low stakes. |
| **core** | event bus, surfaces, cue engine | modest; SSD for the NDJSON log. Can co-locate with bridge if budget is tight. |
| **program** | OBS, stream encode, all browser sources | the expensive one. NVENC-capable GPU (RTX 3060+), 32GB, NVMe. |
| **replay** | rolling record + clip extraction | **separate box.** Recording is I/O-heavy and a crash here must not take program down. Big fast NVMe: 4 cams × 1080p60 at 12Mbps ≈ 22GB/hour total. |
| **arcade** | console capture | can be the program box if it has the USB bandwidth; separate is safer |
| **tablet** | telestrator draw pad | iPad + Apple Pencil. Pressure sensitivity is a genuine upgrade over a finger. |

Getting the desk software onto the core box (or any borrowed laptop) is one exe and a
double-click: the launcher in [13-deployment.md](13-deployment.md) installs nothing system-wide
and needs no admin rights, which matters on AV loaner machines that arrive locked down.

## Video

| Item | Recommendation | Why |
| --- | --- | --- |
| **Switcher** | Blackmagic **ATEM Mini Extreme ISO** | 8 HDMI in, multiview out, and it **ISO-records every input separately**, which is exactly the replay ingest described in [04](04-replay-and-telestrator.md), in hardware, for free. If you buy one thing, buy this. |
| **Field cameras** | 2× PTZ, HDMI or NDI | one wide (whole field, from the scoring table side), one tight/tracking |
| **Alliance cameras** | 2× fixed | one per alliance station: these are the angles that answer "did they actually climb?" |
| **Desk camera** | 1× on the analyst desk | needed the moment you have a telestrator; the audience should see who's talking |
| **Handheld** | 1× roaming | pits, celebrations, awards. Highest-value B-roll per dollar. |
| **Overlay path** | OBS Browser Source (alpha) **and** a keyed feed into the ATEM DSK (luma) | see the dual-key rule in [03-brand.md](03-brand.md) |

**One overlay system on air.** When the content desk's program overlay is live, Cheesy Arena's own
overlay pages must never composite with it. Two scorebugs clip and contradict each other. Three
rules enforce this:

1. **In OBS it's automatic.** Name any source that shows a Cheesy Arena page with `cheesy` in the
   source name (e.g. `Cheesy audience display`). The desk sweeps every scene at connect and once a
   minute, and switches those sources off. This is deliberate: keep the naming convention.
2. **On the ATEM DSK**, only one fill is ever keyed: ours. The Cheesy audience display machine
   feeds the *venue projector* (the field's own screen), never the stream chain.
3. **The scorekeeper keeps the audience display in "Blank" mode** on any machine that IS in the
   stream chain. Put it on the FTA checklist ([10-field-bridge.md](10-field-bridge.md)).

**Cable discipline:** HDMI over 25ft is unreliable. Use HDMI-over-Cat6 extenders or SDI converters
for the field camera runs. Label every cable at both ends on Friday. This advice is boring and it
is the difference between a good Saturday and a bad one.

## Audio: two buses, and music never leaves the room

Copyrighted music on the stream bus is the single most common way FRC event streams die:
muted mid-match, VODs unpublished, channels struck, and it would Content-ID-flag every
match video this desk uploads. The fix is structural rather than a matter of vigilance. The
venue console runs **two mixes**, and the music source is physically absent from one of them.

| Source | HOUSE bus (PA) | STREAM bus (OBS / recordings) |
| --- | --- | --- |
| **Event Spotify playlist** (the DJ machine) | Yes | **Never** |
| MC / GA / emcee mics | Yes | Yes |
| Desk mics (commentary/analysis), ducked under the announcer | Optional | Yes |
| Match sounds from the Audience Display machine (charge, endgame, buzzer) | Yes | Yes |
| Field ambience mic (crowd + robots) | n/a | Yes |
| Console game audio (arcade) | Yes | **Never** (see [05-arcade.md](05-arcade.md)) |

Rules that make it hold up all weekend:

1. **The stream bus is a mix-minus**: an aux send on the venue console that simply has no
   music or console channels routed to it. Nobody has to remember to mute anything: the
   fader that could ruin the stream doesn't exist on that bus.
2. **The event playlist plays through Spotify in-house only.** That keeps the PA energy
   without putting a single licensed track on YouTube. Nothing from that machine patches
   anywhere near the OBS input.
3. **Duck music under the announcer on the HOUSE bus** so the room can hear explanations
   (the perennial "announcer buried under music" complaint).
4. **No aggressive gating/compression on the stream bus.** Over-processed event recordings
   that chop crowd noise in and out are a documented community complaint; light leveling only.
5. **Rehearse both mixes Friday** and listen to the stream return feed from a phone.
   Echo and balance problems get called out by chat within minutes on show day.

**Closed captions** partly ride on this for free, but the earlier version of this paragraph
promised more than YouTube delivers and is corrected here. [Automatic captions on a LIVE
stream are English-only, normal-latency-only, and gated to channels above 1,000
subscribers](https://support.google.com/youtube/answer/6373554). Two of those bite: nobody has
checked WRRF's subscriber count against the threshold, and the normal-latency requirement
fights the low-latency pit feed this document already asks for. Plan the accessibility win on
what is actually reliable:

1. **Automatic captions on the ARCHIVE** are not gated the same way and appear on every VOD.
   Nothing to enable.
2. **A caption sidecar beats ASR** wherever somebody produced one. Drop a `.srt` or `.vtt` into
   `data/captions` named after the match key or the segment label and the publish queue attaches
   it to that video as a real track, which outranks the automatic one. See
   [11-distribution.md](11-distribution.md).
3. **The clean mic bus still matters most.** Every caption path, automatic or human, gets more
   accurate when the announcer's voice arrives without music under it. That is the argument
   for the two-bus split above, restated.

The half of the caption problem that is fully solved here is authored text: the status card and
safety message fan out to program, side screens and phones simultaneously and are 100% correct
by construction, which no speech recogniser is.

### The desk drives the house bus: `/s/house`

The rules above were a wiring diagram with no control surface. The playlist lived on a laptop
nobody at the desk could reach, so "pause the music, the announcer is talking" was a shout across
the gym, and playoff walk-ups meant somebody hunched over that laptop hunting for a track.

**The music machine opens `/s/house` and leaves it open.** That page is the only thing in the
system that makes a sound, and it runs on the machine already patched to the HOUSE bus, so the
guarantee above is unchanged: the audio still originates where it always did, and the desk only
sends it instructions. From the desk console or a phone the manager gets play, pause, skip,
volume, duck, a playlist picker, and one button per walk-up.

| Thing | Where it plays | Needs internet |
| --- | --- | --- |
| Walk-up clips and stingers | files on the music machine, played by `/s/house` | no |
| Background playlist | the Spotify desktop app on that machine, driven over Spotify Connect | yes, to *change* it |

Walk-ups are files rather than streamed tracks on purpose. An alliance introduction needs a
specific twelve seconds to start on the beat the announcer hands over, and a streaming service
starts when it feels like starting. Drop files into `media/audio/walkups` named for the team
(`254.mp3`, or `254 - Song.mp3` to show the title on the desk) and a button appears.

**Three interlocks**, because the one way software could break the two-bus rule is by playing
music somewhere OBS can hear it:

1. `/s/house` **refuses to play inside OBS.** OBS injects an `obsstudio` object into every page
   it renders and appends `OBS/<version>` to the user agent; the page checks both and shows a
   refusal instead of playing. This closes the "somebody pasted the music URL into a Browser
   Source" case.
2. The desk **counts armed house players** and says so when there are two, because the second one
   is usually on a machine that should not be making noise.
3. The page **says what bus it is on**, in gold, at the top.

The interlocks are worth having and they are not the real guarantee. A browser source defaults to
`reroute_audio = false`, which means the page's audio goes to the machine's default output and
OBS's first-run **Desktop Audio** capture puts it on the stream. That happens identically if
the music plays in Chrome, or in Spotify's own app, on that machine. **So the hard requirement is
unchanged and is physical: the music machine is not the OBS machine.** No amount of software
checks substitutes for that.

### Spotify: what it costs, and one thing to decide

Verified against Spotify's own documentation while this was built:

| Constraint | What it means here |
| --- | --- |
| Every playback-control endpoint requires **Premium** | The house music account must be Premium. A free account cannot be driven at all |
| Development-mode apps allow **5 authorized users**, and extended quota now needs 250k MAUs | One shared house account, forever. Not a Spotify login per volunteer |
| Redirect URIs must be `http://127.0.0.1:PORT`; `localhost` is rejected by name | `npm run auth:spotify` has to be run in a browser **on that machine**. A volunteer cannot re-link from a phone |
| Refresh tokens die **6 months** after authorization, used or not | Mint it close to the event. Put the re-link step on the run sheet |
| The Web API is a cloud round trip | With the uplink down the desk cannot change the music, but a **downloaded** playlist keeps playing. The desk shows "unreachable" separately from "stopped" for exactly this reason |

**Decided: CalGames runs Spotify.** For the record, since it was researched and asked: Spotify's
Developer Policy is written for commercial premises and speaks against public playback, and public
performance of recorded music is separately a PRO (ASCAP/BMI/SESAC) question belonging to the
venue. WRRF's call is that a non-monetized off-season robotics event is not the situation those
rules are aimed at, and that is the event's decision to make, not the software's. Noted here once
so nobody re-opens it in September, and so an event adopting this repo can reach its own
conclusion knowing what the rules say.

The music service still sits behind one small interface (`MusicController` in
[audio/store.ts](../apps/core/src/audio/store.ts)), because an adopting event may answer
differently and because a folder of owned tracks is the only option that survives a dead uplink.
Swapping it is one file.

## Power: learn from 2025

The CalGames 2025 Sunday stream died to a **venue power outage** and had to restart on a new
YouTube URL mid-event. That's the single most likely failure mode at a high school gym.

- **UPS on**: program, replay, core, bridge, switcher, and the network switch. Not the monitors.
  15 minutes of runtime is enough to survive a blip and to shut down cleanly if it isn't one.
- **Local recording never stops.** Even if the stream drops, the rolling record continues, so the
  archive and the replays survive. This is a second reason to prefer rolling record over the OBS
  replay buffer.
- **Pre-create the backup stream key** and have the fallback URL posted before the event, not
  scrambled for during it.
- Know which circuits the gym's outlets are on. Ask the facilities contact on Friday.

## Crew: plan for three, build for five

This is the constraint that decides more design here than the hardware does. The crew is a
RANGE, and both ends are real: three is what the event is guaranteed, five or more is what it
gets on a good day. The software has to be correct at the floor and better at the ceiling,
which is a stronger requirement than either on its own.

| Role | Responsibility |
| --- | --- |
| **Desk manager** | Runs everything software: the desk console, screens, replay, publishing, trivia, the arcade, house audio. **Switches the cameras too.** |
| **On-air talent** | Tests the mics and cameras, then does the analysis and the interviews. On camera during exactly the segments that need the most operating. |
| **Field tech** | The connections: field bridge, OBS, the scorekeeping system. Also the person who fixes whatever broke. |

That is the FLOOR. On a good day it looks like this instead:

| Best case | Changes |
| --- | --- |
| **Producer / desk manager** | Stops switching. Runs the rundown, replay, publishing and the gap content. |
| **Switcher** | Takes the camera cut, full time. |
| **On-air talent, several** | A play-by-play voice and an analyst, plus whoever is doing pit interviews. |
| **Field tech** | Unchanged, and finally able to stay ahead of problems rather than behind them. |

Everything between those two is a real staffing outcome, so nothing may assume either. The rule
that falls out of it: **every job is on a surface any console can open, and no job requires a
person who might not exist.** A dedicated switcher gets the same scene control the desk manager
has, on their own screen, rather than a separate application nobody has to learn twice.

**What this rules out.** There is no dedicated switcher, no replay operator, no graphics
operator, no arcade operator and no trivia host. Any feature whose design assumes somebody is
watching it and pressing things is a feature that will not run, and several ideas have been
dropped for exactly that reason ([14-gap-research.md](14-gap-research.md), *Not doing*).

**At the floor, the camera cut belongs to the desk manager**, on the same console as everything
else. That is the single most consequential thing on this page, because it means the person
cutting cameras may also be the person queueing a replay, posting a card and running trivia, and
during a match those compete for one pair of hands. When a switcher does exist they open the same
control on their own screen and the desk manager stops thinking about it. Three consequences the
software has to own either way:

- **The wide-shot lock stops being a nicety.** Autopilot cannot cut away from the field mid-match
  ([cue/engine.ts](../apps/core/src/cue/engine.ts)), which means the one cut that must never be
  wrong is the one nobody has to make.
- **Camera cuts live where the show already is.** Scene changes are cues on the desk console and
  the phone remote, not a second application to alt-tab into. An operator who has to find another
  window mid-match will not, and the shot will simply be wrong.
- **A missed cut must be survivable, not fatal.** The program screen switches on match state
  regardless of which camera is up, so the graphics stay correct even when the shot is stale.
  That is the whole reason screens and scenes are separate events in this system.

**What this demands instead**, and what the desk is built around:

1. **Automation carries the show, and the desk manager overrides it.** Cues still start
   disarmed, because trust is earned per cue over a session, but the target is that by Saturday
   afternoon the match cycle runs itself and the desk manager is watching rather than driving.
2. **Every routine action is one press.** Not a sequence, not a form. A three-person crew has no
   spare hands during the four minutes before a playoff match.
3. **The talent cannot operate anything while on camera.** Anything needed during an interview
   or an analysis segment is either automatic, or on the desk manager's console, or fired from a
   phone by whoever is closest.
4. **The field tech is not watching the broadcast.** They are looking at a field, a switcher and
   a scoring system in turn, so the desk has to notice its own problems and say so
   ([the doors check](../apps/core/src/vitals.ts)) rather than waiting to be inspected.
5. **Degraded mode is the normal mode.** One person leaving to fix something is not an incident;
   it is Saturday. The desk manager alone must be able to keep a watchable show on air.

Design every surface so it is operable by someone trained for twenty minutes on Friday night,
because that is who will be operating it.

## Show flow (per match)

| Cue | Trigger | Action |
| --- | --- | --- |
| **On deck** | `match.loaded` | queueing graphic on side screens, alliance overview up |
| **Intro** | `match.preview` | *planned, not built:* the 6-team intro card with the EPA form line is blocked behind the Statbotics feed ([03-brand.md](03-brand.md)), and no cue fires on `match.preview` yet. PxP reads teams off the overview instead |
| **Armed** | `match.armed` (every robot linked, before the announcer's countdown) | switch to field wide, score bar in, lockdown motion |
| **Live** | `match.start` | score bar live, hub indicator on, replay markers arm |
| **Endgame** | `matchClock` 110 | endgame chip. The camera stays wherever the switcher has it: the wide-shot lock stops autopilot from cutting away from the field mid-match, so a tight tower shot is the switcher op's call |
| **End** | `match.end` | hold field wide 4s for the celebration. Don't cut early |
| **Result** | `match.score_posted` | score reveal, RP pips, ranking movement |
| **Replay** | operator | gold wipe, clip, telestrate, back to desk |
| **Gap** | 3 min after a posted score, no match running | auto-cut to arcade |

Every row except Intro maps to a cue in the engine, each with a manual override. The autopilot
toggle is per-cue, not global, so the producer can trust the parts that work and drive the parts
that don't.
