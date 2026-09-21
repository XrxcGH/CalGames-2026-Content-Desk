# 07: Team media library + pre-match alliance overview

RSN-style: robots on screen before the match, cut out on transparent backgrounds, one row per
team, with team names and numbers. Three per alliance in qualification; a playoff alliance can
carry a fourth (the backup that doesn't play this particular match but is still part of it), and
the screen sizes itself off however many teams it's actually given rather than assuming three.
It's the single graphic that most makes a broadcast look professional, and it's the one an
offseason event can actually pull off because the robots are sitting right there in the pits all
weekend.

---

## Pure black keys out

A luma downstream keyer cuts on brightness, so black anywhere in a graphic
becomes a hole with live field video showing through it. A robot photographed
against a dark pit curtain carries a lot of near-black; a sponsor wordmark
delivered as black-on-transparent PNG, which is how most of them arrive, is
black end to end.

Cheesy Arena hits the same wall and ships a script for it
(`fix_avatar_colors_for_overlay`, an ImageMagick pass replacing `#000` with
`#222` across every downloaded team avatar). The desk does the same thing in
two places:

- **Robot photos** are floored on import. Nothing to remember: upload as usual
  and any pixel darker than `#222` comes up to it, alpha untouched, so a
  cutout's transparent surround stays transparent.
- **Sponsor logos and slides** are dropped into `media/` by hand and never pass
  through that path, so they need the pre-event pass:

      npm run fix:logos

  Run it on Friday once the logos are in and before doors. It is safe to run
  twice. An SVG cannot be fixed this way, because its black is `fill="#000"`
  rather than a pixel; the tool lists any it finds so somebody can change them
  by hand or re-export a PNG.

`#222` is dark enough to still read as black in the room and far enough off the
floor that no sane keyer takes it.


## The screen

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          QUALIFICATION 42                                 │
│  ┌───────────────────────────┐          ┌───────────────────────────┐    │
│  │ ██  846   Funky Monkeys   │  ┌────┐  │   Wildhats     100   ██  │    │
│  │ ██  1868  Space Cookies   │  │ CG │  │       MVRT     115   ██  │    │
│  │ ██  253   Boba Bots       │  │ VS │  │ Homestead Rob. 670   ██  │    │
│  │        RED ALLIANCE       │  └────┘  │       BLUE ALLIANCE      │    │
│  └───────────────────────────┘          └───────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
```

Each team is a row, not a column: the cutout sits beside the number and name rather than above
them. **Blue mirrors red.** The two alliances face each other across the center logo the way they
face each other across the field, so blue's plates sit on the outside edge and its text runs back
toward the center. **Red left, blue right, always.** This matches the field as seen from the
scoring table, and the rule in [03-brand.md](03-brand.md) that alliance is never encoded by color
alone. The gold rule separates each alliance block from the purple chrome.

### Layout rules that make mismatched photos look like a set

1. **Normalize by height, not width.** FRC robots vary enormously in footprint but much less in
   height. Scale each cutout so its alpha bounding box is a fixed *height*, and every robot reads
   as part of the same family. Normalize by width and you get one robot the size of a bus next to
   one the size of a shoebox.
2. **Rows, not columns.** Stacking cutouts above their names left each name a third of the panel's
   width, and long ones had to shrink to fit. As a row, the name gets the whole width beside the
   plate instead, so "Homestead Robotics" sets at full size and a fourth team costs the row height
   (which there is spare of) rather than the row width (which there isn't).
3. **Never mirror a robot photo.** Flipping the blue side to face inward reverses bumper numbers
   and sponsor logos. Shoot every robot at the same 3/4 angle and let both alliances face the same
   direction. Nobody notices, and mirrored `846` is the kind of thing that ends up on Chief Delphi.
   Only the surrounding plate-and-text order mirrors for blue; the photo itself never flips.
4. **Row count follows the alliance, not a constant.** Three rows in qualification; a playoff
   alliance can supply a fourth, and both sides take the larger count so the two halves stay level
   even when one alliance is short a robot. The plate width and the number/name type both step
   down together once a side carries four, so nothing collides with the row below; the name still
   clips at roughly two lines rather than pushing into it.

A third line for rank, record, or EPA was part of the original design for this screen, but the
current row layout has no line for it: only the team number and name render today. If it's added
later, it should follow the rule everywhere else on the bus and hide rather than show a number
that's `estimated`.

Animation: each row is a Block Reveal, staggered 90ms per row and 380ms each, traveling up from
below (see [08-motion.md](08-motion.md)). Both alliances build at once, since the stagger index
restarts on each side rather than running across the whole screen. Stop animating in lockdown mode.

---

## Shooting the robots

Consistency beats quality. Six well-lit photos at the same angle look better than three great ones
and three phone snaps.

| | Spec |
| --- | --- |
| **Backdrop** | white seamless or foamcore, at least 2× robot width |
| **Angle** | front three-quarter, ~35° off axis, **same for every robot** |
| **Camera height** | robot mid-height, not standing eye level (shooting down makes robots look like toys) |
| **Framing** | full robot, wheels to top, ~10% headroom, bumpers legible |
| **Pose** | signature configuration: arm up, intake deployed. A folded robot is unrecognizable. |
| **Resolution** | ≥3000px long edge; a cutout displayed 700px tall at 1080p needs headroom for crops |
| **Format in** | RAW or max-quality JPEG. Not a screenshot of a Slack image. |

### The white-backdrop trap (read before shooting)

**Most FRC robots are bare aluminum, white polycarbonate, and chrome.** On a pure white backdrop,
those are exactly the pixels an automated background remover will delete. You will get robots with
holes punched through their superstructure and it will not be obvious until it's on the screen at
1080p.

Two mitigations, use both:

1. **Add a rim/kicker light**: one light from behind-left or behind-right, raking the robot's
   edge. That edge highlight gives the masking tool a boundary to find. This is the fix.
2. **Expose the backdrop about one stop brighter than the robot but do not blow it to 255.** A
   backdrop that reads ~235-245 still separates cleanly and preserves edge detail. Pure 255 clips
   and takes the robot's highlights with it.

If you can, shoot on **light gray (~#D8D8D8) rather than white.** It cuts out just as easily, and
white robots stop disappearing into it. Worth raising with whoever's running the photo booth.

Use subject-aware masking (Photoshop *Select Subject*, `rembg`, Remove.bg) rather than
magic-wand-on-white. Then **check every cutout at 100% against a dark background**, since that's where
white fringing and punched-through polycarb show up, and it's the background this graphic actually
uses.

---

## Asset spec

| | |
| --- | --- |
| Format | PNG-24 with alpha (WebP generated server-side) |
| Color | sRGB |
| Size | long edge 1600px, alpha bounding box trimmed to content |
| Weight | <1.5MB in, ~200KB out after processing |
| Shadow | **none baked in** (the render side draws the plinth shadow so it matches across all six) |
| Naming | anything; the upload UI binds it to a team |

## Upload workflow

A `/s/media` operator surface: drag a folder of PNGs, assign team numbers, done. Designed to be
usable by a volunteer photographer on Friday night with no training.

On upload, `core` automatically:

1. **Verifies there's a real alpha channel.** No alpha: reject with "this looks like a JPEG, the
   background needs to be removed first."
2. **Runs the uncut-photo check.** Warn loudly if it looks like a photo whose background was never
   removed. *Implementation note, learned the hard way:* the obvious version of this test,
   "what fraction of the bounding box is opaque?", **false-positives on real robots.** Plenty of
   FRC robots are a chassis-shaped brick that genuinely fills their own bounding box, and flagging
   those trains volunteers to ignore the warning. The discriminating signal is the **perimeter**:
   a genuine cutout has mostly-transparent top and side edges; an uncut photo is solid backdrop all
   the way round. The bottom edge is excluded, because a correctly cut robot sits flush on its own
   floor line. Verified against a robot-shaped silhouette (passes clean) and a full-frame opaque
   image (warns).
3. **Trims to the alpha bounding box** and records the original dimensions, so height
   normalization works without re-measuring at render time.
4. **Generates 400 / 800 / 1600px WebP renditions** (skipping widths larger than the source).
   The trimmed full-size PNG is the source of truth; there are no PNG width renditions.
5. **Writes a preview against `--cg-purple`** in the admin UI, so the operator sees it as the
   audience will, immediately.

There is no automated fringing check: nothing reads color channels, only alpha. The manual
100%-against-a-dark-background pass above is the fringing defense, so don't skip it.

### Storage

```
media/
  teams/
    846/
      robot.v2.png          # source of truth, trimmed
      robot.v2@400.webp
      robot.v2@800.webp
      robot.v2@1600.webp
      meta.json             # team, version, src, w, h, uploadedAt, warnings
```

The manifest (team number to current version and dimensions) is in-memory, rebuilt from the
per-team `meta.json` files on scan and served at `/api/media/manifest`. Nothing named
`manifest.json` exists on disk, deliberately: the files are the truth.

Versioned because robots change. A team that swaps an intake Saturday morning can re-upload, and
every surface picks it up on next load. The library is not event-scoped: paths are flat
`media/teams/{team}/`, so carrying it forward to CalGames 2027 means clearing out stale robots
by hand (or building the event key into the path then).

Preload the whole library on surface start: 42 teams × ~200KB ≈ **8MB**. Cache it Friday night and
the alliance overview never waits on the network mid-show.

## Fallback chain: the part that decides whether it ships

At a 42-team offseason event you will realistically get robot photos for **25-35 teams**, and some
of those will arrive Sunday morning. The graphic has to look deliberate with a hole in it.

| Priority | Asset | Rendering |
| --- | --- | --- |
| 1 | Uploaded robot cutout | full treatment |
| 2 | TBA team avatar | **designed, not yet wired up.** Avatars are 40×40, so the rule is not to upscale into the robot slot but to render it small, centered in a purple plinth, as an obviously different treatment |
| 3 | Nothing | large gold team number on a purple plinth, in Archivo, with the team name below |

`robotCard()` in `surfaces/program/program.js` currently only checks for an uploaded cutout and
falls straight to tier 3 when there isn't one; nobody has wired up `/api/teams/{id}/avatar` for the
overview yet, so tier 2 above is the design for whoever does, not something on screen today.

Tier 3 must look like a designed state, not a broken image. Get it right first and the whole
graphic degrades gracefully. That means you can ship the screen on Friday with zero photos
uploaded and improve it live all weekend as photos come in.

## Where this data lives on the bus

The alliance overview is a surface bound to `match.loaded` / `match.preview`. It needs:

- team numbers (from `matchLoad`): three in qualification, up to four for a playoff alliance
- names/nicknames, from the cached team list (Cheesy `/api/rankings`, FRC Events, or TBA)
- rank/record (from `rankings.updated`), hidden when `estimated`. See the note above: this isn't
  actually rendered on the current row layout yet
- robot cutouts: from the local media manifest, no network dependency

Nothing here requires a live FMS connection beyond the team numbers, so this screen works even in
fully-degraded manual mode: the producer types `Q42` and the graphic builds itself.

## Reuse

The pre-match overview is, today, the only screen that actually draws the uploaded cutout. Every
other surface that names a team shows its number and name as text, not its photo:

- **Post-match cards**, the 1080×1080 result graphic, list the winning alliance's roster by number
  and name
- **Arcade Team vs Team** prints the team number and name beside the Smash/Kart player card
- **Telestrator team tag** drops a numbered puck, picked from the loaded match's roster
- **Alliance selection board** shows team numbers as picks are made

`desk.mediaFor(teamNumber)` in `surfaces/_shared/desk-client.js` is already the one lookup any of
these would call to pull in the photo the way the overview does; nobody has wired it into the other
four yet. Don't describe them as photo-driven in a run sheet or a sponsor conversation until
someone does.

One photo session on Friday pays for itself once even though only the overview draws on it today:
the moment the other four reuses above get wired up, the hour spent shooting it properly pays out
five times over instead of once.
