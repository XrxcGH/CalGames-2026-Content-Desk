# 04: Match replay + analyst drawing overlay

The two things that turn a livestream into a broadcast.

---

## Part 1: Match replay

### Design decision: rolling record, not replay buffer

OBS's replay buffer (`SaveReplayBuffer` / `GetLastReplayBufferReplay` over obs-websocket v5) is the
obvious choice and it's the wrong one here:

- The buffer is a fixed window; a 2:40 match plus setup exceeds a comfortable buffer.
- You can only save "the last N seconds," not "from 0:47 to 0:53."
- One buffer = one composited feed. You can't change camera angle after the fact.

**Instead: continuously record every camera to segmented files.**

```
ffmpeg -f dshow -i video="CAM1" -use_wallclock_as_timestamps 1 \
  -c:v h264_nvenc -preset p1 -b:v 12M \
  -f segment -segment_time 6 -segment_atclocktime 1 \
  -reset_timestamps 1 -strftime 1 \
  D:/rec/cam1/%Y%m%d-%H%M%S.mp4
```

6-second segments, wall-clock aligned, one directory per camera. Extracting "cam2, from
`matchClock` 44 to 56" becomes: look up match start wall-clock in the event log, find the two or
three segments spanning it, and `ffmpeg -ss/-to` concat them: done in well under a second on NVMe.

Benefits that matter on the day:
- **Every angle is always available.** The replay operator picks the camera *after* seeing the play.
- **Nothing is ever lost.** A crash costs at most 6 seconds of one camera.
- Doubles as the event archive and the source for TBA match-video uploads.

### Encoder selection: check this in August, not October

Measured on the dev laptop (RTX 4050, ffmpeg 8.1.2 full build), 1080p60:

| Encoder | Result |
| --- | --- |
| `h264_nvenc` | **Failed.** `Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0` |
| `libx264 -preset veryfast -tune zerolatency` | Works. **2.88× realtime** for one stream, ~1.5MB/s at 12Mbps |

**The NVENC trap:** ffmpeg builds track the NVENC API aggressively. ffmpeg 8.1.2 wants NVENC API
13.1, i.e. NVIDIA driver **610.00 or newer**; the laptop was on 596.49 and NVENC simply refused to
open. The failure is loud and immediate, which is the good news, but if you only ever test
capability lists (`ffmpeg -encoders | findstr nvenc` cheerfully lists `h264_nvenc`) you will not
find out until you try to record. **Always do an actual encode test, not a capability check.**

Fix either way: update the NVIDIA driver, or pin an ffmpeg build that matches the driver you have.

**The libx264 headroom math matters.** 2.88× realtime for *one* 1080p60 stream means a single
stream consumes roughly a third of the machine's encoding throughput. Four cameras would need
~139%. **CPU encoding four angles is not feasible on hardware like this.** So the recorder either
gets working NVENC (RTX 40-series allows 8 concurrent sessions on current drivers), or fewer
cameras, or lower resolution on the secondary angles.

This is the strongest practical argument yet for the **ATEM Mini Extreme ISO** in
[06-hardware-and-network.md](06-hardware-and-network.md): it ISO-records all 8 inputs to separate
files in hardware while switching, and makes the encoder question disappear entirely. If the
budget allows one purchase, it's this one.

Keep the OBS replay buffer configured anyway as a 30-second panic button. Belt and suspenders.

### Automatic markers

The replay operator should never hunt. Markers land on the timeline automatically, from the
`score.delta` events synthesized in [02-architecture.md](02-architecture.md):

| Marker | Trigger | Priority |
| --- | --- | --- |
| **Burst** | ≥ 5 fuel scored inside 1.5s | high |
| **Lead change** | red/blue leader flips | high |
| **Tower climb** | tower points +10/+20/+30 | high |
| **Auto end** | `matchClock` = 0 | always |
| **Hub flip** | hub active state changes | medium |
| **Endgame** | `matchClock` = 110 | always |
| **Card / foul** | `card.issued`, `foul.called` | high |
| **Robot dropped** | `arena.status` station goes unhealthy | medium (the "what happened to 254?" replay) |
| **Manual** | operator hits a key / Stream Deck button | highest |

The manual marker is the important one. Automation catches the scoring; a human catches the
*interesting*. One dedicated button, and it drops a marker at `now - 2s` because human reaction
time is real.

### Replay console

```
┌──────────────────────────────────────────────────────────────┐
│  Q42                                          ● linked        │
├──────────────────────────────────────────────────────────────┤
│  AUTO │ T │ SHIFT 1 │ SHIFT 2 │ SHIFT 3 │ SHIFT 4 │ ENDGAME  │
│  ──●──┼───┼──▲──●───┼─────────┼───●─────┼─────────┼──▲▲──    │
│      auto end   burst      climb            endgame          │
├──────────────────────────────────────────────────────────────┤
│  [ cam1 wide ] [ cam2 red ] [ cam3 blue ] [ cam4 hand ]      │
│  ┌────────────────────────────┐  in  0:44.2   out 0:56.8     │
│  │        clip preview        │  speed  1x  ½x  ¼x           │
│  └────────────────────────────┘  [SEND TO DESK] [TAKE ▶]     │
└──────────────────────────────────────────────────────────────┘
```

- Timeline is the **match clock**, phase-segmented, not a raw video scrubber. The operator thinks
  in "endgame," not "18:42:07."
- **SEND TO DESK** pushes whichever frame the clip preview is paused on to the telestrator as a
  frozen backdrop. **TAKE** plays the clip through OBS's `CG Replay Clip` media source in
  `CG_REPLAY`, cuts to it, and cuts back when the clip ends; autopilot holds its own cuts while it
  runs. It asks OBS first, so a cut the switcher made by hand during the clip is left alone, and
  back-to-back takes return to where the first one came from. It needs the desk connected to OBS on the same laptop; without that the console says it is
  not on air and how to play it by hand.
- 0.5x and 0.25x are trimmed first and then frame-blended with ffmpeg's `framerate` filter, so a
  10-second window renders in a few seconds. (Motion-compensated `minterpolate` was tried and was
  far too slow: a quarter-speed cut could not finish inside the five-minute limit.)

### Timing budget

Between-match gap at CalGames is roughly 4-6 minutes on a single field. That's luxurious. Target:
**clip selectable within 10s of match end, on air within 45s.** The constraint isn't the software,
it's the operator, which is why the timeline is pre-marked.

---

## Part 2: Analyst drawing overlay (telestrator)

### The two-surface split

Never draw on the program machine. Prior art (WebRTC-Telestrator, TransparentPaint, Dewdle) all
converge on this and they're right.

```
   iPad + Pencil                     core                    OBS
  ┌──────────────┐   stroke deltas  ┌──────┐   broadcast   ┌────────────┐
  │  /s/draw     │ ───── WS ──────▶ │ core │ ───── WS ────▶│  /s/tele   │
  │  frozen frame│                  │      │               │ transparent│
  │  as backdrop │ ◀──── frame ──── │      │               │  canvas    │
  └──────────────┘                  └──────┘               └────────────┘
```

**Send strokes, not pixels.** Each finished stroke becomes one durable event (per-sample points
travel on the relay path below, not the bus):

```ts
{ type: 'telestrator.stroke',
  payload: { id: 'smcqk3v40', tool: 'pen'|'arrow'|'ellipse'|'spotlight'|'path'|'tag',
             ink: 'gold'|'good'|'note'|'red'|'blue',
             width: 7, meta: { team: 846 },                 // tag pucks; null otherwise
             pts: [[0.412, 0.688], [0.418, 0.690], ...] } } // normalized 0-1
```

Normalized coordinates mean the tablet's aspect ratio doesn't have to match the program feed, and
a 60Hz stroke is a few hundred bytes. **Latency budget: <80ms from tablet to program**, which is easy on
a LAN and impossible over the venue Wi-Fi shared with 40 teams, hence the dedicated production AP.

### Two transport paths, deliberately

Strokes arrive at pointer rate: a Pencil reports at 120Hz. Putting that on the event bus would
bloat a three-day NDJSON archive with hundreds of thousands of coordinate pairs and add a
reduce-and-serialize step to every frame of every stroke.

So there are two paths:

| Path | Carries | Goes to the log? |
| --- | --- | --- |
| **Relay** (`{t:'relay', channel:'tele'}`) | `begin` / `pts` / `meta` / `end` / `undo` / `clear`, batched once per frame | **No.** Broadcast and forgotten |
| **Bus** (`telestrator.stroke`) | one event per *finished* stroke, with its full point list | Yes |

The archive still has everything needed to reconstruct an annotation for a post-match card, at one
record per stroke instead of one per sample. Measured on a four-stroke sequence: 18 stroke records
across several runs, 8.4KB, no pointer-rate traffic in the log at all.

The pad and the render surface run the **same renderer** (`surfaces/_shared/telestrator.js`). Two
renderers would drift, and the drift would only show up live.

### The frozen-frame trick

The single biggest usability win, and the thing off-the-shelf telestrators don't do: **the analyst
draws on the actual frame, not on a blank sheet.**

When the replay operator hits SEND TO DESK, `core` extracts the chosen frame as a JPEG and pushes
it to `/s/draw` as the canvas backdrop. The analyst now sees exactly what the audience sees, and
circles exactly the right robot. Without this, they're drawing blind at a screen they can only see
across the room, and every circle lands slightly wrong.

The program-side `/s/tele` renders **only the strokes**, transparent, layered over the same frozen
frame (or the live/looping clip) in OBS.

### Tools

| Tool | Behavior | Key |
| --- | --- | --- |
| **Pen** | freehand, pressure maps to width if the stylus reports it | `P` |
| **Arrow** | drag from start to end, arrowhead at end | `A` |
| **Ellipse** | drag to circle a robot; snaps to a nice aspect | `E` |
| **Spotlight** | dims everything outside a lassoed region to 55% purple-black | `S` |
| **Path** | dashed line with an animated dash-offset (shows intended route) | `R` |
| **Team tag** | tap a team puck, then drop it onto a robot. No key: the puck picks the team, so a bare shortcut would have nothing to tag | |
| **Undo / Clear** | `Z` / `C` | |
| **Hide** | instantly clears program without clearing the pad | `H` |

**Spotlight is the underrated one.** On a field with 6 robots, an ellipse says "look here" but a
spotlight says "ignore everything else," and it reads far better at 720p on a phone.

**Team tag is the CalGames-specific one.** The pad builds its puck row from whichever match is
loaded, so tagging a robot is one tap instead of typing a number blind while the field is live. The
puck itself is just the gold number, not an avatar or name, but no other telestrator knows what an
FRC team is, let alone which ones are on the field this match.

### Ink rules

Gold default, with a 2px black halo on every stroke. The field is red, blue, and gray carpet under
mixed gym lighting. Gold with a black outline is the only ink that survives on all of it. Every
stroke auto-fades 800ms into a 6s window, so the analyst never has to remember to clear; there's no
pin to hold one past that.

### On-air chrome

While strokes are live, program shows a small `ANALYSIS` chip with the analyst's name (bottom-left,
inside title-safe). It comes up with the first stroke and retires the moment the last one fades.
The audience should always know they're looking at opinion, not officiating.

### Failure mode

If the tablet drops off Wi-Fi *between* strokes, nothing is on air to go wrong: finished strokes
fade on their own schedule, and the pad's status dot shows the reconnect.

A drop *mid-stroke* is uglier, and worth being honest about: the render surface never receives
that stroke's `end`, so the partial line stays on air at full opacity until the analyst hits
Clear or Hide, or until the render surface itself reconnects (its reconnect handler closes out
any stroke still open). The relay protocol has no sync cursor, so nothing is re-sent when the
pad's socket comes back. If a resync is ever built, it belongs in the pad's reconnect handler
(re-send `end` for its open strokes); until then, Clear is the recovery.
