# 13: Deployment and the volunteer launcher

Everything in the other twelve documents assumes somebody has already got the desk running. This
one is about that step, and it is written for the person who has not read the other twelve.

The whole setup is one file. An AV volunteer copies `CalGamesContentDesk.exe` onto a machine,
double-clicks it, and reads one address off the screen. That is the entire procedure.

---

## What the launcher does

Four steps, printed as it goes so nobody is watching a blank window wondering whether it hung.

| Step | What happens | If it goes wrong |
| --- | --- | --- |
| 1 | Unpacks the desk into `Downloads\CalGames2026-ContentDesk` | Nothing else on the machine is touched |
| 2 | Finds Node, or installs a private copy | Needs no admin rights, no PATH change, no installer |
| 3 | Scans the local network for Cheesy Arena | Not finding it is fine; the desk runs in manual mode |
| 4 | Starts the desk and prints the address | Prints the reason and holds the window open |

It then opens a browser at the desk's index page, which lists every screen.

### Why it is built this way

**The payload is inside the exe.** A gym is the worst possible place to find out that the guest
Wi-Fi blocks nodejs.org, or that the venue has no uplink at all. The exe carries the desk, its one
runtime dependency, the image tools, and a full copy of Node. Nothing is downloaded at the event.
That is most of the 42 MB, and it is worth every byte.

**Node goes in `%LOCALAPPDATA%`, not Program Files.** A borrowed AV laptop rarely comes with an
admin password attached. A private copy under the user's own profile needs no elevation, collides
with nothing already installed, and can be deleted afterwards by deleting one folder. If the
machine already has Node 22.6 or newer, the launcher uses that instead and installs nothing.

**Your files are never overwritten.** `config.json`, `data/trivia.json`, `data/event-content.json`
(the desk's own Event setup edits), the event logs, and the robot photo library all survive a
re-run. The operator edits the question bank from the trivia
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

---

## Running the event

### Friday, when the AV rack goes in

1. Copy the exe onto the desk laptop. Double-click it.
2. Note the address it prints. It looks like `http://10.0.100.23:8720/`.
3. Open that address on every pit monitor and pick a screen from the **On a pit monitor** group.
4. Point OBS at `/s/program` as a Browser Source, 1920×1080.

### Saturday morning

Double-click `START-DESK.cmd` in the desk folder. It restarts in place, keeps your config, and
picks the field back up.

### Stopping it

Close the launcher window, or press Ctrl-C in it. Either one stops the desk properly: the event
log is flushed and the port is released, so the next double-click starts cleanly.

That is worth stating because it used to be false. Closing the window with the X button left the
desk running with no window attached, still holding port 8720, and the next launch died with "port
already in use" with nothing on screen to explain it. The desk is now tied to the launcher window
three ways, so it comes down with the window even if the launcher itself is killed outright:

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

### Assigning the pit monitors

The index page lists these under **On a pit monitor**. Each is a full-screen picture with no OBS in
front of it, so a monitor needs nothing but a browser in full screen.

| Screen | URL | Good for |
| --- | --- | --- |
| Program with the field feed | `/s/watch?screen=program` | The broadcast picture, field feed with the live overlay on top |
| Side screen | `/s/watch?screen=side` | On deck and rankings, rotating, readable across a room |
| Arcade | `/s/watch?screen=arcade` | The side tournament over the game capture |
| Trivia | `/s/watch?screen=trivia` | The crowd game, showing the join code between questions |
| When do we play? | `/s/watch?screen=next` | Per-team schedule with drift-adjusted start times |

The field feed behind the program overlay comes from the desk's Event setup group (or its seed,
`kiosk.fieldStreamUrl` in `config.json`). It
takes a YouTube live URL, an MJPEG stream off a capture box or IP camera, or any video URL a
browser plays on its own. Leave it blank and the overlay draws on the CalGames backdrop instead of
a black rectangle, which is the right failure mode for a monitor nobody is watching yet.

Press F11 for full screen. Chrome and Edge both remember it.

---

## The PIN

**Default: `0864`.** Audience screens need no PIN. Every control surface asks for it once, and the
session lasts the day.

Change it for your event by starting the launcher with `/pin:1234`, or by setting `REMOTE_PIN`
before `npm start`. There is no way to turn the gate off from the launcher, and that is deliberate.

Who needs to know it: the content desk operator, the announcer, the replay operator, the analyst,
the trivia host, the arcade scorer, and the head referee. That is a real list of people, so treat
it as a door code and not a secret.

**The awards code is a second, separate door.** If `awards.pin` is set in `config.json` (or the
`JA_PIN` env var), the Judge Advisor holds that code and the desk crew does not, until right
before the ceremony. It opens exactly one thing, the awards system (including the JA's own
staging page at `/s/awards`), and nothing else on the desk. Unset, awards run on the ordinary
PIN, which is right for a small event where the producer is the JA. The reasoning behind where the line falls is in the README
under *Who can drive it*.

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
| `/no-browser` | Do not open a browser window |
| `/no-wait` | Do not pause before closing the window |

### Recording

The desk records whenever `recording.sources` in `config.json` lists at least one camera. There
is no flag to remember and none to forget: listing the cameras is how you say you want them
recorded. That matters because everything downstream needs the recording. No recording means no
replays, no post-match clips, no match videos, and a publish queue with nothing to publish.

Two ways to check it is working. The launcher window prints `recording N source(s)` a moment
after it starts, and files appear under `rec/` within a few seconds. If neither happens, the
window says why: usually ffmpeg is missing, or a camera in the list could not be opened.

Pass `/no-record` for a laptop that should not fill its disk. Recording also needs ffmpeg, which
the launcher does not install: see the ffmpeg note in the README.

---

## When something is wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| "port 8720 is already busy" | A desk is already running on this machine | Press **S** to stop it and start fresh, or **O** to open the one already running. If the launcher says the port is held by something that is not a content desk, it will not offer to kill it: start with `/port:8721` |
| "no field found, starting in manual mode" | The scan found no Cheesy Arena | Fine for rehearsal. At the event, check the cable and re-run, or pass `/cheesy-host:` |
| "The Node download does not match its published checksum" | The download was corrupted or intercepted | Try a different network. Do not work around it |
| "This is 32-bit Windows" | The bundled Node cannot run here | Use a 64-bit machine |
| A phone on the venue Wi-Fi cannot reach the desk | Client isolation, or the firewall | See below |
| The window closed instantly | A crash before the console could be read | Read `desk-log.txt` in the desk folder |

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
Downloads lives, or change anything outside the desk folder and its own Node directory. Uninstall
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
