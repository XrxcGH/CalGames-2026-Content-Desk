# 15: The planning committee's brainstorm, row by row

The CalGames 2026 planning committee keeps a brainstorm sheet of enhancements
and tasks ("CalGames Brainstorming - Tasks and Enhancements"). This document
walks every row of it and answers one question per row: **is any part of this
the content desk's job, and if so, is it built?**

Three kinds of verdict appear below:

- **Built** — the desk does it today, with a pointer to where.
- **Desk-adjacent** — the desk can carry the announcement/recognition half of
  it, but the thing itself is people and logistics.
- **Not a desk job** — listed anyway, so the next person who reads the sheet
  against this repo does not have to re-derive the boundary.

The committee's own risk table for the content desk row is addressed at the
end, because this repo is the direct answer to it.

---

## The rows the desk now covers

### Historical judged awards, with clear titles/definitions — *High*

**Built.** [awards.ts](../apps/core/src/awards.ts), the `award` screen on the
program overlay, and the Awards panel on the desk console. The award list
lives in `config.json` with a title and the definition; showing an award puts
both on the program plate so the GA reads the definition **to the room** —
the broadcast half of "delivered to teams in advance". The winner is revealed
on a second press, and never exists on any feed, socket, or phone until that
press: the reveal belongs to the stage, and the open state feed carries null
until it has happened. Presented awards tick off a checklist that survives a
desk restart, so the ceremony can be run down the list without skipping
anything. A custom award typed on the day works with no config at all.

The **Team Choice Award** (*Low*) and **Safety Award** (*Medium*) rows need
definitions and rubrics from the JA side; once they exist they are two more
entries in `awards.list` and present identically. If the Team Choice Award
ever wants crowd voting, the trivia phone infrastructure (join codes, one
response per player, name screening) is the obvious chassis — noted here so
nobody builds a second one.

### Volunteer setup/breakdown recognition — *Very High*

**Built.** The row itself says "coordinate event announcements/recognition
with Content Desk", and that coordination is now a text field:
[slides.ts](../apps/core/src/slides.ts) holds **recognition slides** — "Thank
you, Friday setup crew", with names — shown on the program by a desk take or
rotated ambiently by the side screens, one slide per rotation, all day. Slides
typed at the event persist to `data/slides.json`, so the Saturday-morning
volunteer list survives a desk restart. BOD, interns, judges, and anybody else
the committee wants thanked on screen is the same feature.

### SystemCore / Limelight information sessions — *Very High*

**Desk-adjacent, and the desk half is built.** Arranging Limelight and the
room is the committee's job. Getting the session in front of every team all
weekend is an **info slide** ("SystemCore session · Saturday 12:30 · Room
201") in the side-screen rotation, plus a [rundown](../apps/core/src/rundown.ts)
segment if it should appear in the day plan, plus the announcement bus for the
"starting in ten minutes" call. The same mechanics cover the
**information/training sessions** row (*Low*), the **coaches meeting**
(*Medium*), the **competition-wide social** (*Medium*), and **food truck
hours** (*Medium*): anything whose failure mode is "it was on a paper sign
nobody read".

### Gracious Professionalism / act-of-kindness submissions — *High*

**Built, with the caveat the committee's row implies.** [/s/gp](../surfaces/gp/index.html)
is a phone form anyone in the stands can reach: who did the gracious thing and
what was it. Submissions are name-screened, rate-limited per phone, capped —
and none of that is the gate. **The gate is a human at the desk pressing
Approve**, after which the shout-out joins the slide deck and rotates on the
side screens with attribution. The physical half (pins, stickers) stays with
the committee; the desk gives it the on-screen half the NorCal events do by
hand.

### Viewable-from-the-field timer during robot setup — *Low*

**Built** — this row names the content desk as its remediation. One press at
the desk (or one Stream Deck key) starts a countdown that takes over the side
screens at 380-pixel digits, ticks off the skew-corrected server clock, goes
gold in the last ten seconds, and clears itself the moment the match starts.
Turn one side-screen TV to face the field and the row is closed. The same
timer serves meeting countdowns, doors, and lunch.

### Nexus for match queuing — *Medium*

**Already built.** The [Nexus adapter](../apps/core/src/ingest/nexus/adapter.ts)
mirrors the queue and "now queuing" calls onto the side screens and phone
pages, receive-only, tolerant of the API disappearing mid-event.

### 4-team playoff alliances — *Very High*

**Flows through, verified.** The desk imposes no alliance size anywhere:
the selection board renders whatever Cheesy Arena sends (and reserves four
columns from the start), the final-score screen names the **whole** alliance
via the selection roster rather than the three on the field, and the
coverage/publish pipeline keys on matches, not alliance shapes. If the event
reverts to 3-team alliances with backups (the committee's own remediation),
nothing changes here either. The one thing worth a Friday check: load a
4-team alliance in a practice bracket and eyeball the selection and final
screens once.

### Human-only matches and Mentor matches — *Medium / Low*

**Desk-adjacent.** These run without FMS, and the desk's manual match mode
was built for exactly that: the number row drives the match beats, hand-typed
scores render honestly outlined, the scorebug and clock behave identically.
Name the match "Exhibition" in the segment publisher and the video cuts and
uploads like any ceremony. Waivers, field staff, and scheduling are people
problems.

### LED display board instead of projection — *Very High*

**Desk-adjacent, one paragraph of guidance.** Every desk screen is a
1920×1080 web page, and an LED wall's processor takes the same HDMI a
projector did — point a browser at `/s/watch?screen=side` (or the program
mix) in full screen and the wall is fed. Two checks when the board is chosen:
the processor accepts 1080p input (all common ones do), and if the wall is
much narrower than 16:9, tell the content desk lead early so the side-screen
layout can be checked against the real shape. The broadcast type floor (28px
at 1080p) was chosen for gym distances and survives LED pixel pitches at
these sizes comfortably.

---

## The rows that are not a desk job

Listed so the boundary is explicit, with the desk's nearest touchpoint where
one exists.

| Row | Priority | Nearest desk touchpoint |
| --- | --- | --- |
| Students shadowing volunteers | Low | The volunteer handbook's per-role chapters are written for exactly this kind of first-timer |
| Scouting-only areas in the stands | High | An info slide can say where they are |
| Team seating assignments | Medium | Same |
| Assigned pit locations | Very Low | Same |
| Machine shop / 3D printing / paper printing | Medium–Low | An info slide with hours and location |
| Modified inspection at load-in, video inspection | High / Medium | None — paper checklist territory |
| Safety Manager, CSAs, RIs staffing | High | The doors check verifies equipment, not people |
| Rotating lights and bubble machines | Low | None. (If adopted: mind the low-sensory considerations in docs/14 §37) |
| Detailed site map | Low | An info slide for the two lines that matter day-of |
| Logo contest | Medium | The winning logo lands in `packages/theme/`; the repo re-brands in one place |
| Volunteer shirts, trophies, volunteer food | Medium | The `awards.list` in config doubles as the definitive award list when ordering trophies |
| Signage | Low | None |
| Signup reminders, minimum volunteer participation | Medium / High | None |
| Robot parts list under $500 | Very Low | None |
| Advance judging interviews by video | Low | None (if ever recorded for air, the consent and minors rules in docs/07 apply) |

---

## The committee's risk table for the content desk itself

The brainstorm's own row for the content desk lists five risks. Each one is a
design constraint this repo was built against, so the answers are pointers:

| Committee risk | Where it is answered |
| --- | --- |
| "Interferes with or corrupts FMS" | The field bridge is receive-only by construction: GET-only, hard endpoint allowlist, no write path exists to fail open. [docs/10](10-field-bridge.md). The committee's own remediation — "pull not push" — is the architecture |
| "Fails to operate during final on-field testing" | The desk runs with no field at all (manual mode), and the practice launcher rehearses everything on a kitchen table. [docs/13](13-deployment.md) |
| "Fails during the event" | Every screen is a browser tab; if the desk dies, cameras, mics, MC and announcer are untouched, and OBS keeps streaming. A restart rebuilds the day from the event log in seconds. The failure mode is "the graphics revert to plain video", which is the committee's remediation, verbatim |
| "Inappropriate conduct while on air" | Everything crowd-writable is moderated (shout-outs) or screened (trivia names); students on camera air as first name and initial; the handbook's first page sets the conduct expectation |
| "Requires significant advanced planning" | True, and this repo is that planning: 380 tests, a volunteer handbook a first-timer can run the show from, and a preview folder showing every screen |

The remediation column assigns development "to WRRF Interns under Planning
Committee direction" — the repo is Apache-2.0 with a CONTRIBUTING.md written
for exactly that arrangement.
