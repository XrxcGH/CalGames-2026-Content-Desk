# 13: Deployment and the volunteer launcher

Everything in the other twelve documents assumes somebody has already got the desk running. This
one is about that step, and it is written for the person who has not read the other twelve.

The whole setup is one file. An AV volunteer copies `CalGamesContentDesk.exe` onto a machine,
double-clicks it, and reads one address off the screen. That is the entire procedure.

The volunteer's version of this is [QUICK-START.md](../QUICK-START.md) (QUICK-START.pdf in the
desk folder): one page, the five things only a person can do and where the desk itself explains
anything that looks wrong. With the front page, that is all a volunteer needs.

---

## What the launcher does

Four steps, printed as it goes so nobody is watching a blank window wondering whether it hung.

| Step | What happens | If it goes wrong |
| --- | --- | --- |
| 1 | Unpacks the desk into `Downloads\CalGames2026-ContentDesk` | Nothing else on the machine is touched |
| 2 | Finds Node, or installs a private copy | Needs no admin rights, no PATH change, no installer |
| 3 | Scans the local network for Cheesy Arena | Not finding it is fine; the desk keeps looking by itself (`--discover`) and runs in manual mode meanwhile |
| 4 | Starts the desk and opens a browser at the address | Raises a message box naming the reason and the log |

It then opens a browser at the desk's front page: what this computer is for, what the desk found
(the field, the video switcher, where the program graphics are showing, OBS), the Start here box
with the address, and **Something not working?**, the
common problems answered in a line or two each. Every screen with its address is folded away at
the bottom.

### Why it is built this way

**The payload is inside the exe.** A gym is the worst possible place to find out that the guest
Wi-Fi blocks nodejs.org, or that the venue has no uplink at all. The exe carries the desk, its one
runtime dependency, the image tools, and a full copy of Node. Nothing is downloaded at the event.
That is most of the 42 MB, and it is worth every byte.

**Node goes in `%LOCALAPPDATA%`, not Program Files.** A borrowed AV laptop rarely comes with an
admin password attached. A private copy under the user's own profile needs no elevation, collides
with nothing already installed, and can be deleted afterwards by deleting one folder. If the
machine already has Node 22.6 or newer, the launcher uses that instead and installs nothing.

**Your files are never overwritten.** `config.json`, `desk-pin.txt`, `data/settings.json` (the
codes and connections set on Event settings), `data/trivia.json`, `data/event-content.json` (the
edits made live on `/s/setup` and on the Judge Advisor's `/s/awards`), the event logs, and the
robot photo library all survive a re-run. The operator edits the question bank from the trivia
console during the event, and shipping a fresh copy over the top of that would quietly delete an
afternoon of somebody's work. Everything else is replaced, so re-running the launcher is also how
you update the desk.

**The field scan is read-only.** It sends one HTTP GET to `/api/rankings`, which is on the same
allowlist the running bridge uses, and it only ever talks to port 8080. It cannot start, abort, or
score a match, for the same structural reason the bridge cannot: see
[10-field-bridge.md](10-field-bridge.md).

### What the scan checks

`10.0.100.5` first, because at an FRC event that is nearly always right and it turns the whole scan
into a single request. Then the rest of `10.0.100.0/24`, then this machine's own `/24`. Anything
larger is left alone deliberately: sweeping a `/16` would be sixty-five thousand requests and would
look exactly like somebody attacking the venue network.

If more than one machine answers on 8080, the launcher checks each in candidate order and takes the
first that replies with Cheesy Arena's JSON. Somebody's dev server on 8080 does not fool it.

When the launcher's scan finds nothing, the desk keeps looking by itself, with the same check, every
30 seconds until the field answers, and then never again: the field network can come up after the
desk does, and nobody has to restart anything or type a flag. A field address typed on Event
settings is the first place each sweep looks. The desk also looks for an ATEM switcher on the same
networks (UDP 9910, at most 50 hellos a second, a sweep at most once a minute), and only ever reads
it; see the README, *Connecting to the field*.

On exit code 75, which is **Restart the desk** on Event settings, the launcher starts the desk
again with the same arguments, at most three times in ten minutes; any other exit behaves as it
always did.

---

## Running the event

### Friday, when the AV rack goes in

1. Copy the exe onto the desk laptop. Double-click it.
2. Note the address in the front page's **Start here** box. It looks like
   `http://172.22.0.23:8720/` (whatever the network the laptop is plugged into hands out; on the
   field network, a `10.0.100.x` address).
3. On the computer that feeds the video switcher's overlay input (the one that showed Cheesy
   Arena's score overlay), open the address with `s/program` on the end and press F11: graphics
   on black for the switcher's luma key, standing in for Cheesy's overlay (see below).
4. On the computer plugged into each other display (the projector, the TVs, the pit monitors),
   open the address with `s/watch` on the end, click the card that starts *For ...*, and press
   F11. **Program** is the one for the projector. No OBS is needed.
5. Only if the event streams through OBS: point OBS at `/s/program` as a Browser Source,
   1920×1080. It stays see-through in OBS, exactly as it always did.

The desk does not need the field network to be up first. It looks for the field by itself, every
30 seconds until it finds it, and connects on its own; the front page says *Field: searching*
until then. If it cannot find it, type the field's address on Event settings (`/s/setup`), under
**Connections**.

### Saturday morning

Double-click `START-DESK.cmd` in the desk folder. It restarts in place, keeps your config, and
picks the field back up.

### Checking the build before you hand it out

    npm run check:launcher

Eighteen seconds. It runs the real build, without the embedded Node copy, and
then asserts the four things that have actually gone wrong: that the build
completes at all, that the exe is a Windows GUI binary rather than a console
one, that `harness.mjs` (the arena writer) is not in the payload, and that the
desk itself is.

This exists because the launcher is the one deliverable with nothing else
checking it, and it shipped broken. The change that held `harness.mjs` out of
the payload used PowerShell's `-replace`, which takes a regular expression,
with a pattern of a single backslash, which is not one: `build.ps1` threw on
its first staging loop and produced no exe at all. A syntax check would not
have caught it, because the file parses and fails at runtime. Only running the
build catches that, so this runs the build.

### Stopping it

There is no window to close, on purpose. The launcher is built as a Windows application rather
than a console one, so a double-click leaves nothing on screen. A window that runs the show is a
window somebody closes: on a desk laptop it reads as leftover clutter from an install that has
already finished, and one click takes the broadcast off air mid-match. "Leave it open" is a
request, not a control.

Two ways to stop it, both of which take more than one careless click:

- Task Manager (Ctrl+Shift+Esc), find **CalGames 2026 Content Desk**, End task.
- PowerShell: `Stop-Process -Name CalGamesContentDesk -Force`

Either one stops the desk properly: the event log is flushed and the port is released, so the next
double-click starts cleanly. A double-click on a desk that is already running is answered before
anything is unpacked or the field is scanned: it opens the running desk in the browser, and if
start-only options were given (`/pin`, `/cheesy-host`, `/display-id`, `/no-cheesy`, `/demo`,
`/rehearsal`) a message box says they were ignored and how to stop the desk first. A running desk
in practice or replay mode also raises a warning box naming the mode and the Task Manager way
out (the launcher reads the mode from the desk's open `GET /api/info`). Running the launcher FROM
a PowerShell or cmd window still attaches to that window and prints everything, and Ctrl-C there
works as it always did.

The teardown is worth stating because it used to be false. Closing the window with the X button left
the desk running with no window attached, still holding port 8720, and the next launch died with
"port already in use" with nothing on screen to explain it. The desk is tied to the launcher three
ways, so it comes down even when the launcher is killed outright from Task Manager:

| Layer | What it covers |
| --- | --- |
| The desk watches its standard input, which the launcher holds open | The launcher exiting for any reason, including being killed. This is the graceful one: the desk shuts itself down and flushes the log |
| A console control handler in the launcher | The X button and Windows logoff/shutdown. .NET's own exit handler does not run for these, which is why closing the window used to leak a process |
| A Windows job object marked kill-on-close | The launcher dying so hard that no handler of ours runs at all |

If a stale desk is somehow still holding the port, the launcher now says so by name and offers to
stop it, rather than telling you to go find the window. It only offers that for a process that
answers as a content desk; anything else on that port is somebody else's program and gets left
alone.

### Trying it at home first

A kitchen table has no field, and blank screens make a first-timer assume it broke. So when the
launcher finds no field it asks: press **D** and every screen plays a pretend match. After the
first run there are two files in the desk folder that answer the same question by double-click:
`START-PRACTICE.cmd` runs the pretend match, `START-DESK.cmd` runs the real thing.

### Assigning the projector, the TVs and the pit monitors

Every venue display gets its picture the same way: a browser, full screen, on the computer whose
HDMI goes to it. The front page's **Put the show on a projector or TV** button
opens the chooser, `/s/watch` (headed **Pick a screen**), and the folded list at the bottom of the
front page puts these first, under **On a projector or TV**. Each card leads with
the display it is for, in the order a venue sets them up:

| For | Screen | URL | What it shows |
| --- | --- | --- | --- |
| The projector, or the stream | Program | `/s/watch?screen=program` | Who is playing, the live score, the final score, changing on its own as the field runs |
| The TVs beside the field | Side screen | `/s/watch?screen=side` | On deck and rankings, rotating, readable across a room |
| Pit TVs | When do we play? | `/s/watch?screen=next` | Per-team schedule with drift-adjusted start times |
| The trivia monitor | Trivia | `/s/watch?screen=trivia` | The crowd game, showing the join code between questions |
| The arcade TV | Arcade | `/s/watch?screen=arcade` | Scores from the side tournament |

The field feed behind the program overlay comes from the Event settings page, `/s/setup`, under
**Screens and stream**; the desk console links to that page but does not hold the control, and
the page takes the settings code rather than the desk PIN. Its seed is `kiosk.fieldStreamUrl` in
`config.json`. It
takes a YouTube live URL, an MJPEG stream off a capture box or IP camera, or any video URL a
browser plays on its own. With no feed set, Program and Arcade fill the whole display, edge to
edge on any screen shape, with the CalGames backdrop (that kiosk used to be solid black), and
Program shows a line saying what it is waiting for until the first match loads.

A feed is an address, not a picture, so the kiosk waits up to about four seconds for a first
picture before it layers the overlay over it. A camera that is off, on another network or typed
wrong gets the program on the backdrop with a yellow line, *No picture from the field feed at
HOST*, naming only the host and port; the kiosk keeps asking and switches to the video by itself
(one blink) when it answers. A camera that drops mid-show leaves the score on the backdrop, with no
words and no reload. A feed address with a user name and password in it will not play: the desk
strips them before handing the address to the displays (`/api/urls` is open to the whole venue
Wi-Fi), and browsers refuse them in an image address anyway. Allow anonymous viewing on the camera
on the venue network, or use a capture box.

Press F11 for full screen. Chrome and Edge both remember it.

### How a screen decides whether it is see-through

The program overlay, the telestrator render and the arcade overlay are built to sit over a camera
picture, and a see-through page in a plain browser is a white page. So each one decides, in this
order:

| Situation | Look |
| --- | --- |
| `?key=` names a mode (`alpha`, `luma` or `fill`) | That mode, always |
| Inside OBS (the `obsstudio` object, or `OBS/` in the user agent) | See-through, exactly as before |
| Framed by another page (`/s/watch` over a live feed) | See-through, so the feed shows through |
| A browser on its own, full screen | Graphics on black (luma), for a switcher input with a luma key |

So a projector or TV goes through `/s/watch`, which frames the program with `?key=fill` when there
is no feed to show through: the CalGames backdrop, and one line of words while there is nothing to
show (the handbook's chapter 4, *What the projector says*, lists them). `?key=fill` on any of the
three forces the backdrop; `?key=luma` forces black for a hardware keyer (an ATEM or a Roland
downstream key); `?key=alpha` forces see-through, which vMix, Wirecast, CasparCG and any other
software that layers the page without being OBS needs written in the address. An unknown `?key=`
is ignored. There is no chroma (green) mode: the WRRF palette carries a green and a blue, and a
chroma key would eat parts of the graphic.

On a switcher, the program on black also stands in for the field's own score display: while the
desk cannot give a score (it stopped, or its link to the field is down), that input shows Cheesy
Arena's audience display instead, loaded directly from the field by the browser feeding the
switcher. So key only the program's input, not the field's overlay as well, or the stream carries
two score bars. This needs the desk to have found the field (at start or since: the page asks
again by itself), and that computer to reach the field's address; the doors check's **Screens**
row warns when it cannot, while there is still time to move its cable. The timings: Cheesy's
display after the desk has been silent for about 3 seconds, or after the desk has lost the field
for 10; back to the desk's graphics once both have answered for 5. The page never reloads itself
while the desk is away, because a browser error page is light and would be keyed onto the stream.

This is also why a plain browser on `/s/program` gets luma rather than the backdrop: black keys out
on a switcher and reads as graphics on black on a projector, so one address is safe in both
places. `/s/watch` and the front page's projector choice ask for `fill` explicitly.

---

## The PIN

**Default: `0864`.** Audience screens need no PIN. Every control surface asks for it once, and the
session lasts the day.

Change it for your event on Event settings (`/s/setup`), under **Access codes**, from the desk
laptop itself; the change works at once and the launcher keeps it across restarts. Starting the
launcher with `/pin:1234`, or setting `REMOTE_PIN` before `npm start`, still works. There is no way
to turn the gate off from the launcher, and that is deliberate.

Who needs to know it: the content desk operator, the announcer, the replay operator, the analyst,
the trivia host, the arcade scorer, and the head referee. That is a real list of people, so treat
it as a door code and not a secret.

**There are two more doors, and neither is the PIN.** The awards code (set on Event settings or
the Judge Advisor's own page; `awards.pin` in `config.json` and the `JA_PIN` env var still work
underneath) is held by the Judge Advisor and not by the desk crew
until right before the ceremony; it opens exactly one thing, the awards system including the JA's
own staging page at `/s/awards`, and nothing else on the desk. The settings code (`setup.pin`, or
`SETUP_PIN`) is held by the content lead and opens `/s/setup`, where the event's content is
edited. The reasoning behind where those lines fall is in the README under *Who can drive it*.

Both ship with a working default (`1357` and `4567`), which is what makes a first run work out of
the box and what makes forgetting them expensive: the defaults are in this repository, and
`/s/awards` is open enough to load its sign-in box for anyone on the venue network. Leaving the
awards code alone hands the staged winners to the gym before the ceremony. Setting either value
to an explicitly empty string is the other option: that collapses the tier onto the desk PIN,
which is right for a small event where the producer is also the JA. Leaving the key out entirely
does not do that; it keeps the shipped default.

The launcher has no option for either code. The deployment path is Event settings (`/s/setup`,
**Access codes**): each code changes there at once, with no file and no restart, and is kept in
`data/settings.json`; the Judge Advisor can also change the awards code on `/s/awards`.
`awards.pin` and `setup.pin` in `config.json` still work underneath, as the value used until a
code is set on the page. The **Start here** box on
the desk laptop names every code still on its default, and the doors check shows the same thing
as an amber **Access codes** row. Neither the launcher nor `desk-log.txt` says which codes are
defaults: the log is the file a crew sends to whoever is helping, and the awards code opens the
staged winners.

---

## For the content desk lead: building the exe

The launcher is compiled by the C# compiler that ships inside Windows, so there is no toolchain to
install and the result needs no runtime.

Both commands go in a PowerShell window sitting in the repo folder: press the Windows key, type
`powershell`, press Enter, then `cd` to where the repo is checked out.

```powershell
npm install
```

```powershell
powershell -ExecutionPolicy Bypass -File tools\launcher\build.ps1
```

When it finishes, `dist\CalGamesContentDesk.exe` exists. That one file is the whole hand-out:
build it once, hand out copies.

| Option | Effect |
| --- | --- |
| `-NoEmbedNode` | Leaves Node out. About 8 MB instead of 42, but the first run needs internet |
| `-Output <path>` | Writes the exe somewhere other than `dist\` |

The Node version and its SHA-256 are pinned in both `tools/launcher/Launcher.cs` and
`tools/launcher/build.ps1`. The build verifies the checksum before embedding, and the exe verifies
it again before installing, so a corrupted or substituted download fails loudly at both ends rather
than quietly shipping something unexpected. Change the version in one place and the build will stop
until you change it in the other.

### Launcher options

These exist for the lead, not for the volunteer. The volunteer double-clicks.

| Option | Effect |
| --- | --- |
| `/pin:1234` | Set the event PIN |
| `/port:8721` | Serve on a different port |
| `/dir:D:\desk` | Install somewhere other than Downloads |
| `/cheesy-host:10.0.100.5:8080` | Skip the scan and use this address |
| `/no-cheesy` | Do not look for the field at all |
| `/demo` | Practice mode: a pretend match on a loop, no field needed |
| `/display-id:name` | How this desk names itself to Cheesy Arena (default `contentdesk1`). Agree it with the scorekeeper: docs/10 calls a display-ID collision the top real risk of the bridge, and until now the launcher could not set it |
| `/no-browser` | Do not open a browser window |
| `/no-wait` | Do not pause before closing the window |

### Recording

The desk records whenever `recording.sources` in `config.json` lists at least one camera. There
is no flag to remember and none to forget: listing the cameras is how you say you want them
recorded. That matters because everything downstream needs the recording. No recording means no
replays, no post-match clips, no match videos, and a publish queue with nothing to publish.

Two ways to check it is working. The Doors check's **Recording** row reads the sources rolling,
and files appear under `rec/` within a few seconds. If not, that row says which part is missing
(ffmpeg not installed, or no cameras listed), and `desk-log.txt` says why a listed camera could
not be opened.

There is no launcher option to turn recording off, and that follows from the paragraph above: the
camera list is the switch. For a laptop that should not fill its disk, set `"sources": []` under
`recording` in that machine's `config.json`. (The desk binary does take `--no-record`, which is
how `npm start` turns it off, but the launcher does not forward it and silently ignores anything
it does not recognise, so typing `/no-record` at the exe records anyway.)

Recording also needs ffmpeg, which the launcher does not install: see the ffmpeg note in the
README.

---

## When something is wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| A white page in the browser | A see-through graphic made for OBS, opened with nothing behind it, or an address with `?key=alpha` | On that display's computer open `/s/watch`, click **Program**, press F11 |
| The front page says *Field: searching* | The desk has not found the field yet; it keeps looking every 30 seconds by itself | Put the desk laptop on the field's network. Still searching once the field is up: type its address on Event settings, **Connections**. *Not connected, and not looking* means the desk was started with `/no-cheesy`: end it in Task Manager and double-click the exe |
| A new exe changes nothing | A double-click on a running desk only reopens it, before anything is unpacked | End the old desk in Task Manager first, then double-click the new exe |
| "port 8720 is already busy" | A desk is already running on this machine | Press **S** to stop it and start fresh, or **O** to open the one already running. If the launcher says the port is held by something that is not a content desk, it will not offer to kill it: start with `/port:8721` |
| "starting without it; the desk keeps looking for the field by itself" | The launcher's first look found no Cheesy Arena | Nothing to do: the desk keeps looking every 30 seconds and connects when the field answers |
| "The Node download does not match its published checksum" | The download was corrupted or intercepted | Try a different network. Do not work around it |
| "This is 32-bit Windows" | The bundled Node cannot run here | Use a 64-bit machine |
| A phone on the venue Wi-Fi cannot reach the desk | Client isolation, or the firewall | See below |
| A message box naming a failure | The desk did not start; the box names the reason | Read `desk-log.txt` in the desk folder |
| Double-clicked it and nothing happened | Expected: there is no window. The browser should open | If no browser opened, read `desk-log.txt` |

Everything the desk printed is in `desk-log.txt` next to its files, which is the first thing to
ask for when somebody reports a problem over the radio.

### Phones and pit monitors cannot reach the desk

Two things have to be true, and neither is the launcher's doing.

**Windows Firewall has to allow inbound TCP 8720.** Once, per machine, and it needs an
administrator window: press the Windows key, type `powershell`, right-click **Windows
PowerShell**, choose **Run as administrator**, answer Yes, then paste this line and press Enter:

```powershell
New-NetFirewallRule -DisplayName "CalGames Content Desk 8720" -Direction Inbound -Protocol TCP -LocalPort 8720 -Action Allow -Profile Private
```

When it works, it prints a short table describing the new rule. Note `-Profile Private`: do not
open the port on a public profile you do not control.

**The network has to permit client-to-client traffic.** Guest and captive-portal Wi-Fi almost always
enables client isolation, which blocks this no matter what the firewall says. Use the event's own
production access point, which [06-hardware-and-network.md](06-hardware-and-network.md) already
calls for on 5GHz clear of the field AP. A phone hotspot works for testing.

---

## What the launcher deliberately does not do

It does not install a service, add a startup entry, write to the registry beyond reading where
Downloads lives, or change anything outside the desk folder and its own Node directory. While the
desk runs it asks Windows to stay awake with SetThreadExecutionState (ES_CONTINUOUS and
ES_SYSTEM_REQUIRED), which needs no elevation, writes no setting, and is released when the desk
exits. Uninstall
is deleting two folders:

```
%USERPROFILE%\Downloads\CalGames2026-ContentDesk
%LOCALAPPDATA%\CalGamesContentDesk
```

It does not auto-update. A desk that changes underneath the crew on Sunday morning is worse than a
desk with a known bug in it. Updating is copying a newer exe over and running it again.

It does not turn on publishing, recording, OBS control, or show automation. Those are separate,
explicit acts for the reasons each of their own documents gives. The launcher gets you a running
desk and a working field connection, which is the part that has to be boring.
