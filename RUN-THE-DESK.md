# Running the CalGames Content Desk

### A complete setup and operating guide for volunteers

**CalGames 2026 · Woodside High School · October 16-18 · Western Region Robotics Forum**

---

## Read this first

This guide assumes you have never run this program, never used OBS, and never
touched a video switcher. That is the expected starting point. Nothing here
requires you to type commands, edit code, or understand how any of it works.

**You do not need to read all of it.** Find your job below and read that
chapter plus the two short ones before it. The whole thing takes about forty
minutes end to end; your chapter takes ten.

| If you are... | Read chapters |
| --- | --- |
| **The only volunteer** | 1, 1a, 2, 6 |
| Setting up on Friday | 1, 2, 3, 4, 5 |
| **Desk manager / producer** | 1, 2, 6, 7, 11 |
| **On-air talent** (announcing, analysis, interviews) | 1, 2, 8 |
| **Field tech** | 1, 2, 3, 9 |
| Replay operator | 1, 2, 7 |
| Trivia host or arcade scorer | 1, 2, 10 |
| Anyone who just needs a screen on a TV | 1, 2, 5 |

**The one rule.** If something looks wrong on the broadcast, the fix is almost
never in this program. It is a person pressing the wrong button, and the
person who notices should say so out loud. Nobody gets in trouble for calling
out a wrong graphic. The show is a team sport.

---

## Chapter 1 · What this thing is

The content desk is one program that runs on one laptop. Everything else
(every screen, every control panel, every phone) is just a web page pointed at
that laptop.

That is the single most useful idea in this guide, so it is worth saying twice:

> **There is one program. Everything else is a browser tab.**

So there is nothing to install on the pit monitors, nothing to install on the
announcer's tablet, and nothing to install on anyone's phone. You type an
address, and a screen appears.

### What it does

- Draws the **scoreboard and graphics** that go on the stream and on the TVs
  in the hall.
- Tells the **announcer** who is playing, what their record is, and what they
  need to do to earn a ranking point. In words, not jargon.
- Cuts **replays** and **match videos**, and uploads them.
- Runs the **crowd trivia** and the **arcade** side tournament between matches.
- Runs the **house music** in the hall.
- Answers **"when does my team play?"** on any parent's phone.

### The three jobs

Three people is the comfortable shape of this show, and the rest of this guide
is written for it. It is not a floor: one person can run it, and chapter 1a is
how. Read this section anyway, because it says what each job is for, and a
one-person crew is doing all three.

**Desk manager (producer).** Sits at the desk laptop. Drives the graphics,
switches cameras, keeps the show moving. If there is only one person who knows
how the desk works, it is this one.

**On-air talent.** Announces, analyses, does interviews. Works off a tablet
showing the talent view, which tells them everything they need to say.

**Field tech.** Owns the connections: is the desk talking to the field, is OBS
up, is the stream live, is the recording running. Checks the pre-show list in
chapter 3 and fixes what it flags.

**Adding people.** The jobs above are the first three. After them, in order:
a **dedicated switcher** (so the desk manager stops cutting cameras), a
**second talent** (so the announcer has somebody to talk to), a **replay
operator**, then the trivia host and the arcade scorer.

Each one takes over a console that already exists, so nobody has to be
retrained and nothing has to be reconfigured: hand them the address, give them
the event PIN, and they open a page. A volunteer who turns up at lunchtime can
be useful within five minutes. The consoles stay in step with each other
because they all read the same desk, so two people never have to agree about
anything by talking.

---

## Chapter 1a · If you are the only one here

It happens. Two people said yes and neither arrived, or they are both in the
pits fixing a robot. This chapter is the whole show, run by one person, and it
is deliberately short because you are busy.

**The show still works.** Nothing in this program needs a second operator.
Every automatic behaviour the desk has exists for exactly this: the screens
follow the match on their own, the score bar follows the field, the side
screens rotate by themselves, and the "when does my team play?" page answers
parents without you.

**Do these four things before doors.**

1. **Arm every cue.** Open **Show automation** on the desk console and press
   **Arm every cue**. This is the opposite of the advice in chapter 6, which
   tells you to watch each cue be right first, and that advice assumes three
   people. Alone, you want the desk cutting cameras and ducking music by
   itself, because the alternative is that nobody does it. You can still take
   anything by hand.
2. **Put the side screens and the pit TVs on first.** They run unattended all
   day. Chapter 5.
3. **Run the doors check** and fix what it flags, because nobody else will
   notice later. Chapter 3.
4. **Decide what you are not doing** (below) and do not open those pages.

**What to run, and what to leave shut.**

| Open it | Leave it shut |
| --- | --- |
| The desk console | The replay console |
| The talent view, if you are announcing | The telestrator pad |
| | The trivia host and arcade consoles |
| | The team media page |

Leaving a console shut costs nothing. Nothing breaks, nothing queues up
waiting, and no screen goes blank because a page is not open: every surface
reads the desk, and the desk is running. The replay console in particular is
pure upside when staffed and pure distraction when not.

**The one thing to plan for: the awards ceremony.** This is the only part of
the weekend where being alone is genuinely harder, because the Judge Advisor
has to hand you their code and the ceremony has a rhythm you cannot pause.
Read chapter 6's awards section before doors, not during. Stage nothing
yourself: the JA loads the winners from their own tablet, and all you do is
press **Show** and then **Reveal** when the announcer says the winner's name.

**Things that will feel wrong, and are fine.**

- Nobody is cutting cameras between matches. The cues are. Let them.
- The announcer is you, and you are also driving. Put the delay card up
  (chapter 6) and take ten seconds. An explained pause reads as process.
- You will miss a replay. There is no replay operator. This costs the show
  nothing that the audience will notice.

**If a second person turns up**, hand them the replay console first: it is the
job with the best ratio of value to instruction, and chapter 7 explains it in
two minutes. After that, the talent view.

---

## Chapter 2 · Starting the desk

### Step 1: Copy one file

Copy `CalGamesContentDesk.exe` onto the desk laptop. Put it anywhere:
the Desktop is fine.

That is the whole installation. There is no installer, no admin password, and
nothing goes into Program Files.

### Step 2: Double-click it

A black window opens and prints what it is doing. It takes about a minute the
first time and a few seconds after that.

Windows may show a blue **"Windows protected your PC"** box. This is normal for
any program that has not paid for a code-signing certificate. Click **More
info**, then **Run anyway**. If you are not comfortable doing that, get the
content desk lead. Do not click past a security warning on somebody's word
alone, including this document's.

### Step 3: Read the address

When it is ready the window prints something like:

```
READY
    http://10.0.100.23:8720/
    PIN 0864
```

**Write that address on the whiteboard.** Every screen in the building is going
to need it. Write the PIN there too. It is a door code, not a secret; roughly
eight people need it.

The desk actually has **three codes**, one per job, and only the first goes
on the whiteboard:

| Code | Who holds it | Opens | Shipped default |
| --- | --- | --- | --- |
| Desk PIN | The desk crew | Every operator console | `0864` |
| Awards code | The Judge Advisor | `/s/awards`, winner entry and the reveal | `1357` |
| Settings code | The content lead | `/s/setup`, the event's content | `4567` |

The defaults exist so a practice run works out of the box. **Change all three
before the event.** Anyone holding this handbook knows them, and the desk
prints a warning in its own window about every one still in use.

Changing them is the content desk lead's job on Friday, not the field tech's
on Saturday morning. The desk PIN has a launcher option; the other two do
not, and come from a file instead:

| Code | How the lead changes it |
| --- | --- |
| Desk PIN | Add `/pin:4726` when starting: `START-DESK.cmd /pin:4726`, or `CalGamesContentDesk.exe /pin:4726` on the very first run |
| Awards code | `awards.pin` in `config.json` |
| Settings code | `setup.pin` in `config.json` |

**There is no `config.json` until somebody makes one.** In the desk folder
(`Downloads\CalGames2026-ContentDesk`, unless the lead picked somewhere
else), there is a file called `config.example.json`. Copy it, name the copy
`config.json`, open it in Notepad, and change the two `"pin"` values: one
under `"setup"`, one under `"awards"`. Save. Restart the desk. Re-running the
launcher later never overwrites that file, so the codes survive an update.

If the awards code is the one that slips, that is the expensive one. `/s/awards`
opens its sign-in box for anyone on the venue Wi-Fi, so a default awards code
means the whole building can read the winners before the ceremony.

The numbers will be different at your event. Use what your browser shows, not
what is printed here.

### Step 4: There is no window, and that is deliberate

Nothing stays on screen after the desk starts. Your browser opens on the page
listing every screen, and that is the whole interface. There is no black
window sitting on the taskbar.

That is on purpose. A window that runs the show is a window somebody closes:
it looks like leftover clutter from an install that already finished, and one
click on the X takes the broadcast off air in the middle of a match. Asking
people to leave it open is not a control.

**If you want to see what it is doing**, open `desk-log.txt` in the desk
folder. Everything the old window printed is in there, including the address
and the PIN.

**To stop the desk when the event is over**, either:

- Open Task Manager (**Ctrl+Shift+Esc**), find **CalGames 2026 Content Desk**,
  select it, and press **End task**. Or
- Open PowerShell and type:

```
Stop-Process -Name CalGamesContentDesk -Force
```

Either one takes the desk down cleanly and releases the address, so the next
start works. Both take more than one careless click, which is the point.

### If it will not start

| What you see | What to do |
| --- | --- |
| "Port already in use" | An older copy is still running. The launcher offers to stop it. Say yes. |
| It prints a field-scan failure | Fine. The desk runs without the field; see chapter 9. |
| Nothing happens at all | The file did not finish copying. Copy it again. |
| A blue "Windows protected your PC" box | More info → Run anyway. See step 2. |

### Trying it at home first

You do not need a field, a camera, or an event to practice. When the desk finds
no field it asks whether you want a **pretend match**; press **D** and every
screen plays a full match on a loop with realistic scores.

After the first run, two files appear in the desk folder:

- **START-DESK.cmd**: the real thing.
- **START-PRACTICE.cmd**: the pretend match.

Both are double-click. Practice on the second one as much as you like; it
cannot touch a real field or upload anything.

---

## Chapter 3 · The pre-show check (field tech)

Open the desk address in a browser on the desk laptop. You get an index page
listing every screen. Open **Desk console** (`/s/desk`). It asks for the PIN
once.

The desk console's header carries the **doors check** verdict at all times,
next to the link light: *all good*, *needs a look*, or *something is broken*.
Click it, or the **Doors check** chip in the jump strip, and it takes you to
the check itself and opens the fold it lives in.

It answers one question: *is this thing ready?* Every row is green, amber or
red, and every row also spells its level out as a word (**OK**, **WARNING**,
**FAILED**, **UNKNOWN**, **OFF**), so the printed sheet carries the verdicts
and nobody has to tell the colours apart.

If the verdict ever reads **not answering**, the check itself has stopped
running, and the rows underneath go faint because they are the last thing it
managed to say rather than the state of the building now. Press **Run the
check**. If it stays that way the desk window has probably closed; chapter 2
starts it again.

Run it **at doors**, meaning when the audience is let in, not five minutes
before the first match.

This is every row it can show, in the words the screen uses. **Stream health**
only appears once OBS is connected:

| Check | What it means when it is not green | What to do |
| --- | --- | --- |
| **Field bridge** | The desk cannot see the scoring system | Chapter 9 |
| **OBS** | The desk cannot drive the camera switching | Chapter 4 |
| **Stream health** | OBS is dropping frames on the way out: amber past one in a hundred, red past five | The uplink is struggling. Tell the content desk lead now, not when it gets worse |
| **Recording** | Nothing is being recorded, so there will be no replays or videos | Check the capture device is plugged in |
| **Disk** | Running out of room: amber under five hours of recording left, red under two | Free up space or change disks now, not at lunch |
| **Publishing** | YouTube is not set up | Videos will not upload. Talk to the content desk lead |
| **Microphones** | A mic is muted in OBS | Unmute it |
| **House audio** | The music machine is not connected, or two machines are both armed | Chapter 10 |
| **Coverage** | A match has been played and no video was ever queued for it | Tell the content desk lead before the recording rolls off the disk |
| **Access codes** | At least one of the three codes is still the shipped default. It names which | Read the two paragraphs below. Do not skip this one |

A row can also be **grayed out**, which means that part is switched off rather
than broken: no field connection asked for, no recording running, no stream
started yet. At a real event most of them should not be gray by the time the
doors open.

**Amber is not red.** Amber usually means "this will work, but you should
know". A missing Blue Alliance key is amber: videos still upload, they just do
not get linked.

**Access codes is the one amber you do not shrug at.** If it is amber and the
words *awards code* are in it, go and find the content desk lead. The shipped
awards code is printed in this handbook and in the public code, and the Judge
Advisor's page opens its sign-in box for anyone on the venue Wi-Fi. That amber
means the building can read the winners before the ceremony. Chapter 2, step 3
says how to change it. It needs a restart, so it is a doors job, not a
four-o'clock job.

Everything red on this list will be noticed by somebody in the audience within
an hour. That is the entire point of running it early.

---

## Chapter 4 · Setting up OBS

OBS Studio is the free program that actually sends the video to YouTube. The
content desk does not stream anything itself: it draws the graphics, and OBS
puts them on top of the camera picture.

If somebody else has already set up OBS at this event, skip to chapter 5.

### Step 1: Install OBS

Download OBS Studio from **obsproject.com** and install it. Take every default.

### Step 2: Make the scenes

A "scene" in OBS is one arrangement of pictures: a camera, a graphic, a title.
You switch between scenes to change what the audience sees.

Create six scenes with **exactly these names**. Capitalisation and underscores
matter, because the desk switches them by name:

| Scene name | What it shows |
| --- | --- |
| `CG_INTRO` | The opening title, before the day starts |
| `CG_MATCH` | The field camera, the main one |
| `CG_SCORE` | The field camera, for the final score reveal |
| `CG_REPLAY` | The replay playback |
| `CG_DESK` | The analysis desk camera |
| `CG_ARCADE` | The video game capture, for between matches |

To add a scene: in the **Scenes** box at the bottom left, click **+**, type the
name, press Enter.

If you get a name wrong, the desk's camera buttons will do nothing and nothing
will explain why. Check the spelling twice.

### Step 3: Add the match overlay

This is the important one. It is the scoreboard.

1. Select the **CG_MATCH** scene.
2. In the **Sources** box, click **+** → **Browser**.
3. Name it `Overlay` and click OK.
4. Fill in the box exactly like this:

| Field | Value |
| --- | --- |
| **URL** | `http://10.0.100.23:8720/s/program` (use *your* address) |
| **Width** | `1920` |
| **Height** | `1080` |
| **Use custom frame rate** | leave unticked |
| **Shutdown source when not visible** | **UNTICK THIS** |
| **Refresh browser when scene becomes active** | **UNTICK THIS** |

Those last two matter. If either is ticked, the overlay reloads every time you
cut back to the camera, and the audience watches the scoreboard flash and
re-animate mid-match.

5. Click OK. The scoreboard appears over your camera.
6. Drag it so it fills the frame exactly. Right-click it → **Transform** →
   **Fit to screen** does this in one step.

### Step 4: Copy the overlay to the other scenes

The scoreboard belongs on the score scene and the replay scene too.

Do **not** add a second Browser Source: that runs a second copy of the
overlay and doubles the load on the laptop. Instead:

1. Right-click the `Overlay` source → **Copy**.
2. Select `CG_SCORE`, right-click in the Sources box → **Paste (Reference)**.
3. Do the same for `CG_REPLAY`.

**Paste (Reference)**, not **Paste (Duplicate)**. A reference is the same
overlay showing in two places. A duplicate is two overlays, and they will drift
out of step with each other.

### Step 5: The telestrator (optional)

If your analyst is going to draw on replays:

1. Select `CG_REPLAY`.
2. **+** → **Browser**, name it `Telestrator`.
3. URL `http://YOUR-ADDRESS/s/tele`, 1920 × 1080, same two boxes unticked.
4. Drag it **above** the Overlay in the Sources list.

### Step 6: The arcade overlay (optional)

Same recipe on the `CG_ARCADE` scene, with URL `/s/arcade`.

### Step 7: Let the desk drive OBS

This lets the desk manager cut cameras from the desk console instead of
reaching for OBS.

1. In OBS: **Tools** → **WebSocket Server Settings**.
2. Tick **Enable WebSocket server**.
3. Click **Show Connect Info** and note the **Server Password**.
4. Click OK.

Then tell the desk about it. Ask the content desk lead to start the desk with
OBS enabled. This is one of the few things that needs a person who is
comfortable with a command line, and it is a two-minute job.

You can run the entire show without this. The desk manager just switches scenes
in OBS by hand instead. Everything else works identically.

### Step 8: Check it

Load a practice match (chapter 6) and look at your OBS preview. You should see
the scoreboard over the camera, with the clock counting.

If the overlay is **black instead of transparent**, the Browser Source lost its
transparency. Delete it and add it again. Do not add a Color Correction
filter, which is the usual wrong fix.

### A note for events with a hardware switcher

If you are going through an ATEM or similar rather than OBS, add `?key=luma` to
the overlay URL:

```
http://YOUR-ADDRESS/s/program?key=luma
```

That swaps the transparent background for solid black so a luma key works.
Without it the graphics will key out into nothing. On the OBS path, leave it
off.

---

## Chapter 5 · The screens around the hall

Every TV, monitor and phone in the building shows a web page. None of them need
the PIN.

### The easy way

On the monitor, open a browser and go to the desk address. Click **Pick a
screen**. Choose from the list. Press **F11** for full screen.

That is it. The page remembers full screen, so if the monitor loses power and
comes back, F11 once and it is right again.

### The screens, and where each one belongs

| Screen | Address | Put it |
| --- | --- | --- |
| **Program with the field feed** | `/s/watch?screen=program` | Pit monitors, concession TVs: the broadcast picture without needing OBS |
| **Side screen** | `/s/watch?screen=side` | The big TVs beside the field. Shows who is on deck and the current rankings, rotating on its own |
| **When do we play?** | `/s/watch?screen=next` | Anywhere parents gather. Also the QR code on the side screens |
| **Trivia** | `/s/watch?screen=trivia` | A monitor the crowd can see between matches |
| **Arcade** | `/s/watch?screen=arcade` | Over the video game capture |

### Side screens specifically

The side screens are the ones most people in the hall will actually look at.
They rotate on their own between "who plays next" and the rankings, with no
operator.

They are designed to be read from thirty feet away, which means the type is
large and there is not much on screen at once. That is deliberate. Do not
try to fit more on.

If a side screen goes blank or shows "reconnecting", the desk laptop went away.
The screen recovers by itself when the desk comes back; you do not need to
touch the monitor.

### Checking a display with the test card

Before trusting any TV, projector, or LED wall, open `ADDRESS/s/testcard` on
it, full screen. Four looks and you are done:

- **All four corner marks visible?** If not, the display is cropping the
  edges, and it will crop the scoreboard the same way.
- **Is the circle round?** An ellipse means the picture is stretched.
- **Can you tell the dark gray steps apart?** If the left end of the gray
  ramp merges into black, the display will crush the broadcast's purple too.
- **Is the clock ticking?** A frozen clock means a frozen signal.

The dashed rectangles are the exact safe areas the graphics keep to, so
whatever the display does to them, it does to the score bar.

### The field feed behind the program screen

`/s/watch?screen=program` shows the overlay on top of a live picture of the
field. That picture comes from a setting the content desk lead fills in on
the event settings page, not on the desk console: `ADDRESS/s/setup`, then
**Screens and stream**, then **Field feed URL**. That page takes the
**settings code**, which is not the desk PIN (chapter 6, Event settings). If
the box is blank you get the overlay on the CalGames backdrop instead, which
looks intentional and is fine.

---

## Chapter 6 · The desk console (desk manager)

Open `/s/desk`. Enter the PIN once.

This is the main control panel and it is built to be driven by keyboard. The
buttons all say what they do; this chapter covers the order you use them in.

### The rhythm of a match

The field drives most of this by itself. What follows is what you do when the
field connection is working, which is the normal case.

| When | The desk does this by itself | You do this |
| --- | --- | --- |
| Match is queued | Shows the alliance overview with robot photos | Cut to `CG_MATCH` |
| Field arms the match | Score bar comes in | Nothing |
| Match starts | Clock runs, scores update live | Watch the show, not the desk |
| Buzzer | Clock stops | Cut to a wide, or to the desk |
| Referees finish | Nothing | If a card was given, chapter 7 |
| Score posts | Final score screen appears | Cut to `CG_SCORE` |
| Gap before the next match | Nothing | Sponsor, trivia, arcade, or an interview |

**If the field connection is down**, you press those beats yourself: the match
lifecycle buttons across the top of the console are Preview, Arm, Start, End,
Post score, Abort. The graphics behave identically.

### Keyboard shortcuts

The console is built to be driven by keyboard, because reaching for a mouse
during a match is how you miss the thing you were watching for.

The match beats, along the number row:

| Key | Does |
| --- | --- |
| `1` | Preview: alliance overview |
| `2` | Arm: score bar in |
| `3` | Start the match clock |
| `4` | End: buzzer |
| `5` | Post the score |
| `0` | Abort |

Everything else worth learning on day one:

| Key | Does |
| --- | --- |
| `Space` | **Mark a replay moment.** The one to learn first |
| `T` | Show the lower third (the name strip) |
| `Y` | Hide it |
| `B` | Blank the program screen |

The next keys are only for scoring by hand, when the field connection is down.
Red on the left of the keyboard, blue below it, the way they sit on the field:

| Key | Red | | Key | Blue |
| --- | --- | --- | --- | --- |
| `Q` | +1 fuel | | `A` | +1 fuel |
| `W` | +5 fuel | | `S` | +5 fuel |
| `E` | +10 tower | | `D` | +10 tower |

Anything you type this way renders **outlined** on air, so the audience is
never shown a guess dressed as a result. See chapter 8.

Camera scenes are buttons on the console rather than keys, because cutting to
the wrong camera by fumbling a key is worse than reaching for a mouse.

The console never steals a key while you are typing in a box, and it leaves
Ctrl and Alt combinations to the browser: Ctrl+0 resets zoom rather than
aborting the live match.

### Putting people on camera

When somebody sits down for analysis or an interview:

1. In the **On camera** section, tick their name in **Saved profiles**. If they
   are new, type their name and role and press **Add**.
2. Check the order in **On air, in screen order**. Seat 1 is the audience's
   **left**. Use the arrows to move people.
3. Press **Put on air**.

Their name cards appear across the bottom of the screen, spaced evenly.

**If any of them is a student, tick "Student".** Their card then shows a first
name and a family initial ("ALEX R.") instead of a full name. Everyone in the
hall still knows exactly who they are; a search engine does not, and the video
is public forever. Adults doing a job under their own name (mentors, coaches,
the commentators) stay in full.

If you put students on with no adult on the panel, the console tells you so.
Check the shot before you cut to it: YouTube can disable chat or take a stream
down over minors on camera without a visible adult, and getting that wrong ends
the stream, not the clip.

Press **Hide** when they get up.

### Status cards and safety messages

Two different things, deliberately.

- **Status card**: "Field delay", "Back in ten minutes". Explains a pause. It
  **stays up until you press Hide card**: only the automatic *Field timeout*
  card clears itself. The Delay card section tells you on screen whenever one
  is live, and the jump strip has a **Delay card** chip to get back to it.
  The five buttons cover almost everything. If you type your own, keep it
  short: the card holds about ninety characters, the box stops you at that,
  and it counts the last thirty down beside the field so you can see the end
  coming. Fill in **Back in** and the time appears on its own line under the
  message, which is the part the hall actually wants.
- **Safety message**: covers every screen in the building, and stays until you
  clear it. This is for an evacuation or a hold. It is not for a long queue.

Both go to the program, the side screens and every phone at once. When you send
a safety message the console goes red so that whoever walks up next can see one
is live.

### Awards

Awards involve a second code, and it is not yours.

**CalGames runs two ceremonies.** Saturday presents the community and
volunteer awards (Directors', Volunteer of the Year, Mentor of the Year).
Sunday presents the team awards, nine of them, opening with the Founders'
Award and closing with the Judges' Award. Both the Judge Advisor's page and
your Awards section group by ceremony and number each award in running
order, so you are only ever looking at tonight's list.

The **Judge Advisor holds the awards code**. All day, as judging wraps up, the
JA loads each award's winner from their own page (`ADDRESS/s/awards`, which
takes only their code, not the desk PIN). That page is also where the award
list itself gets built: **Add an award** for each judged award in ceremony
order, **Edit wording** to fix a typo, **Remove from the ceremony** if plans
change. No file editing, ever. While that is happening, your
Awards section shows only the lock and its code box; even the award titles
wait behind it. That is deliberate. Nobody at the desk can see, type, or reveal a winner, so
nobody at the desk can leak one, even by accident, even with a camera pointed
at the console.

**Right before the ceremony, the JA gives you the code.** Type it into the
Awards section's unlock box. Then, for each award:

1. Pick the award from the list. Ones marked **winner loaded** are ready:
   the JA's answer rides along invisibly.
2. Press **Show the award**. The title goes up with one line under it saying
   what the award is for. The GA reads the full definition aloud from the
   slides; the screen does not reprint it, because a paragraph on the big
   screen is a wall nobody in the hall reads.
3. On the GA's cue ("...and the winner is"), press **Reveal the winner**. The
   line comes off and the winner takes the frame.
4. Press **Clear** before the next one. Presented awards tick off the list,
   and the ceremony heading counts down ("4 of 9 presented").

The winner box on the desk is only for last-second corrections (the envelope
on stage disagrees with what was loaded); leave it blank otherwise. The
winner genuinely does not exist anywhere the audience can reach until Reveal,
so there is nothing to leak. The lock means that now includes this console.

Each award carries two pieces of text, and the difference matters. The
**full definition** is the committee's wording: what the GA reads aloud and
what the projected slides show. The **on-air line** is the single line the
broadcast puts under the title. The JA can edit both; leaving the on-air line
blank falls back to the definition's first sentence, which is usually the
right line anyway.

The desk ships with a default awards code (1357), so the lock exists from
the first boot; change the code for the event, the same as the PIN. An event
small enough that the producer IS the Judge Advisor can set `awards.pin` to
empty in `config.json`, which removes the lock and runs awards on the desk
PIN: then type the winner yourself before Show, and do not read it aloud to
anyone standing behind the desk.

### Slides and shout-outs

Slides are the between-matches cards: thank-yous for volunteer crews,
session announcements, event info. The side screens rotate the whole deck on
their own all day; **Next slide** steps through the same deck on the program
when you want one on the big screen.

To add one during the event: pick a kind, type a title and lines (separate
lines with `|`), press **Add**. It is saved immediately and survives a desk
restart.

The **shout-out queue** below it fills from `/s/gp`, a phone page where
anyone in the stands can submit a Gracious Professionalism moment they saw.
**Nothing from that queue reaches any screen until you press Approve.** Read
each one; approve the good ones into the deck; reject the rest. Nobody is
notified of a rejection.

### The event timer

**Field setup 2:00** starts a countdown that takes over the side screens in
digits readable from the far end of the gym; turn one side-screen TV to face
the field and the drive teams have their setup clock. It clears itself the
moment the match starts. The label and minutes boxes run any other countdown:
meeting starts, doors, end of lunch.

### Seeing what the screens look like, before there is a show

A desk with no field attached and no match loaded draws nothing at all. Every
overlay is empty, which looks broken and is not: there is simply nothing to
report yet.

For setting a pit monitor up, aiming a projector, or showing somebody what the
broadcast looks like, the desk console has **Sample data** in the field-down
kit. One press fills every screen with invented teams, scores, rankings and
slides. It is for testing, not for the show:

- Everything it puts up is tagged as sample, so scores draw **outlined**, the
  same way a desk-typed guess does, and none of it can be published.
- The button refuses outright while the field bridge is running, because a
  desk talking to the field is a desk at an event.
- Load a real match, or restart the desk, and it is gone.

### Show automation

Near the top of the console, under **Show automation**, is a list of cues. A
cue is the desk doing one thing by itself: cutting to the field when the match
arms, dropping the music when the announcer opens up, putting the score up
when a result posts.

**Every cue ships switched off, and that is the right way to start.** An off
cue still watches the show and counts what it *would* have done, so the row
tells you things like *off, would have run 4x*. Run a few matches by hand,
read those counts, and arm the ones that were right every time. There is no
prize for arming them all on Saturday morning.

- **Arm** lets one cue run by itself from then on. **Turn off** stops it.
- **Run now** fires a cue once, by hand, whatever it is set to.
- **Arm every cue** does the whole list at once, and asks first.

You can always take anything by hand afterwards. Autopilot never cuts away
from the field in the middle of a match.

If OBS is not connected, the cues that cut an OBS scene grey out their **Run
now** and the panel says how many. The rest, the music cues and the end game
chip, keep working: they never touch OBS. Arming works for all of them either
way, and an armed cue starts working the moment OBS comes back.

If a cue fails, its row says so in words and keeps saying so until it next
succeeds. That row is the only place a failed cue is reported, which is the
other reason to read this panel between matches.

### Event settings: names, sponsors, and the run of show

Event content lives on its own page: `ADDRESS/s/setup`, behind the
**settings code**, which is not the desk PIN and not the awards code. The
content lead holds it. It is a before-doors tool: everything about the
event that used to require editing a file lives there, saves the moment you
press the section's Save button, takes effect immediately, and survives a
restart. The desk console links to it from the Setup fold.

- **Event**: the event name and year (stream titles use them), the TBA event
  key, and the results link that goes in video descriptions.
- **Bonus RP thresholds**: the offseason committee's numbers. Saving moves
  the badges and the talent view together, immediately.
- **Screens and stream**: the field feed URL behind the pit monitors, and
  the webcast URL registered on TBA.
- **Sponsor list**: name, tier, one line the announcer can read, and an
  optional logo path. Tier decides how often a card comes round, never how
  big it is drawn.
- **Run of show editor**: the day as a list. A matches block takes a match
  COUNT and times itself from measured pace; everything else takes minutes.
  Editing mid-day keeps the progress of every segment that kept its label.
- **Accessibility services**: each line is something a person in the
  building can act on, plus who to ask. Never list a service the event does
  not have.

Two things stay in `config.json` on the desk machine on purpose: credentials
(API tokens, the codes) and machine wiring (the camera list). If a section
on that page asks for something you do not have, that is a question for
whoever set the desk up, not a file for you to edit.

The awards list is the one content list NOT here: it belongs to the Judge
Advisor's own page, behind the awards code (chapter 6, Awards).

---

## Chapter 7 · Cards, replays, and the awkward moments

### When a team gets a card

The field usually tells the desk, and a small mark appears next to that team's
number: an outlined square for yellow, a filled block for red. Different
*shapes*, not just different colours, so it survives a compressed stream.

For the announcement itself, use the **card call** screen. This puts a
full-screen card up after the buzzer and before the score, so the announcer has
something on air while they explain it.

1. Pick the team from the list: it only offers the six who just played.
2. Pick yellow or red.
3. Type the reason **in the words the announcer will say**. It goes on screen
   200 pixels tall in front of the whole gym.
4. Press **Put the card up**.
5. Press **Clear** before the score reveal.

If the desk says the card is still up after you press Clear, press Clear again.
It will tell you if it failed; it will not leave you guessing.

### Replays

Press `Space` any time something interesting happens. You do not need to be exact:
the mark lands a couple of seconds *before* you pressed, because everybody
presses late.

The replay console (`/s/replay`) lists the marks. The desk has also marked
things on its own: scoring bursts, lead changes, the end of auto.

### Surrogates

If a team is playing a surrogate match, one that does not count for their
record, the graphics say so. Nothing for you to do; it is there so the
audience is not told a team lost a match that was never theirs to lose.

---

## Chapter 8 · The talent view (on-air talent)

Open `/s/talent` on a tablet. It asks for the PIN once.

Everything on this page is something you can say out loud. That is the design
rule: no jargon, no raw numbers that need translating.

### What is on it

- **Who is playing**, with team names, records, and ranks.
- **What each alliance needs for a ranking point**, in a sentence. Not
  "ENERGIZED: 87/100" but "thirteen more fuel for Energized".
- **Pronunciation notes**, where somebody has written one in.
- **Cards a team is carrying**, so you are not surprised.
- **Whether a team is a surrogate**, so you do not say the wrong thing about
  their record.
- **How the day is running**, ahead or behind schedule, in minutes.

### A number with an outline around it

If a score renders as an **outline instead of solid**, it means the desk is
*guessing*, usually because the field connection dropped and somebody at the
desk is typing scores in by hand.

**Do not read an outlined number as final.** Say "unofficial" or wait. When the
real score posts it goes solid.

This is the single most important thing on this page. The graphics will never
present a guess as a fact, and neither should you.

### Interviews

The desk manager puts your guests' names on screen. Give them a moment to do it
before you throw to the interview: the cards animate in, and starting the
question before the name lands means the audience never learns who is talking.

---

## Chapter 9 · The field connection (field tech)

The desk can read the scoring system so the graphics follow the real match
without anyone pressing anything.

### It is read-only, by construction

The desk **cannot** start a match, abort a match, change a score, or touch the
field in any way. That is not a policy: the connection is built so that those
requests do not exist. You can hand this document to the FTA and the head
referee and that sentence is the whole of it.

### Setting it up

Usually nothing. The launcher looks for the field on the standard event network
when it starts, finds it, and says so.

If it does not:

1. Check the desk laptop is on the **same network** as the scoring system.
   Event Wi-Fi and the field network are often not the same thing.
2. Check the scoring computer is on and its display is up.
3. Restart the desk (close the window, double-click again). The scan runs at
   start.

### If it stays down

The show runs anyway. Tell the desk manager, who switches to driving the match
beats by hand (chapter 6). Everything looks identical to the audience except
that scores are typed rather than read. Those render outlined, so nobody is
misled.

This is worth rehearsing once on Friday. A field connection that drops during
finals is a much better experience for everyone if the desk manager has done it
before.

### The other connections you own

| Thing | How you check it | If it is down |
| --- | --- | --- |
| **OBS** | The doors check, and the OBS window itself | Chapter 4 |
| **Stream** | YouTube Studio shows it live | Restart the stream in OBS; the desk is unaffected |
| **Recording** | Doors check says Recording | Replays and videos stop; the live show is unaffected |
| **Disk space** | Doors check says Disk, in *hours* | Free space now |

---

## Chapter 10 · Trivia, the arcade, and the music

### Crowd trivia

Open `/s/triviadesk`. The job is one button, and its label always tells you
what the next press does: **Open question** puts it on the board and starts
the clock, then it reads **Reveal** (with the seconds left, so you know when
the window closes), then **Next**. Press it when it says the thing you want.

The crowd joins on their phones from the QR code the trivia screen shows. There
are more than thirty questions loaded already, in rounds, so you can play a
round after one match and pick up a different round after the next. Scores
carry across the day.

A round that has been played through will refuse to replay: that is on
purpose, because replaying one pays everybody twice and quietly corrupts the
leaderboard.

Names the crowd types are screened before they go on screen. Some will still
get through that a reasonable person would not want on a projector; you can
remove any name from the host console.

### The arcade

Open `/s/arcadedesk`. Score the game sets by hand: two players head-to-head, or
three-to-four free-for-all. The overlay shows the standings.

Each info box on the arcade overlay can be shown or hidden on its own, so you
can clear the screen when the game itself is the thing to watch.

### House music

**This is the one part that runs on a different computer.**

The music machine is whatever laptop is plugged into the hall's PA. Open
`/s/house` **on that machine** and leave it open.

Why a separate machine: music played in the hall must not reach the stream. A
recorded track on a YouTube video can get the whole archive muted or blocked,
and the archive is what teams watch afterwards. Keeping the music on a machine
that is not wired to the stream makes that structural rather than a thing
somebody has to remember at 4pm on a Sunday.

The page refuses to run inside OBS for the same reason. If you see it refuse,
that is it working.

The manager does all of this from the desk console, without leaving their seat:
pause the music, resume it, duck it under an announcement, fire a team's
walk-up song, or hand the room to the video game audio.

---

## Chapter 11 · When something goes wrong

Ordered by how often it happens.

| What you see | Almost certainly | Fix |
| --- | --- | --- |
| A screen says "reconnecting" | The desk laptop went to sleep or the window got closed | Wake it / start it again. Screens recover on their own |
| The overlay is frozen | The Browser Source has "shutdown when not visible" ticked | Chapter 4, step 3 |
| Scores are not updating | Field connection dropped | Chapter 9. Drive it by hand meanwhile |
| A score has an outline around it | The desk is guessing, and saying so | Nothing. It goes solid when the real score posts |
| Camera buttons do nothing | OBS is not connected, or a scene is misspelled | Chapter 4, steps 2 and 7 |
| Music is coming out of the stream | The house page is on the wrong machine | Chapter 10: this one matters |
| No robot photos | None uploaded for those teams | Fine. It falls back to a gold team number |
| A wrong name on screen | Somebody typed it | Forget that profile, add it again spelled right, tick it, press Put on air |
| "Port already in use" on start | An old copy is still running | The launcher offers to stop it. Say yes |

### The universal fix

Close the black window. Double-click the desk again. It comes back in a few
seconds and remembers the day: cards, coverage, the run of show, sponsor
counts. Every screen in the building reconnects on its own.

You do not lose the day by restarting. That is deliberate, and it was built
because laptops get their power cables kicked out.

### When to escalate

Get the content desk lead for: anything involving credentials, uploads going to
the wrong channel, or a message on screen that should not be there and will not
clear. Everything else on this page is yours to fix.

---

## Appendix A · Every screen, in one table

Replace `ADDRESS` with what the desk window printed.

### On air: these go into OBS

| Screen | URL | Notes |
| --- | --- | --- |
| Program overlay | `ADDRESS/s/program` | 1920×1080 Browser Source. The scoreboard |
| Telestrator render | `ADDRESS/s/tele` | Transparent. Layer over the replay |
| Arcade overlay | `ADDRESS/s/arcade` | Over the game capture |
| Trivia overlay | `ADDRESS/s/trivia` | Crowd game |

### Run the show: these need the PIN

| Screen | URL | Who uses it |
| --- | --- | --- |
| Desk console | `ADDRESS/s/desk` | Desk manager |
| Talent view | `ADDRESS/s/talent` | On-air talent |
| Replay console | `ADDRESS/s/replay` | Replay operator |
| Telestrator pad | `ADDRESS/s/draw` | Analyst's tablet |
| Arcade console | `ADDRESS/s/arcadedesk` | Arcade scorer |
| Trivia host | `ADDRESS/s/triviadesk` | Trivia host |
| House audio player | `ADDRESS/s/house` | **On the music machine only** |
| Judge Advisor: awards | `ADDRESS/s/awards` | JA only. Takes the awards code, not the desk PIN |
| Head referee review | `ADDRESS/s/var` | Head referee. Read-only |
| Phone remote | `ADDRESS/s/remote` | Anyone away from the desk |

### Before the event

| Screen | URL | Who uses it |
| --- | --- | --- |
| Team media | `ADDRESS/s/media` | Whoever has the robot photos |
| Post-match cards | `ADDRESS/s/cards` | Social media |
| Event settings | `ADDRESS/s/setup` | The content lead, with the settings code |

### For everyone: no PIN

| Screen | URL | Notes |
| --- | --- | --- |
| Pick a screen | `ADDRESS/s/watch` | Hand this to anyone setting up a monitor |
| Screen test card | `ADDRESS/s/testcard` | Full-screen it on a TV, projector or LED wall before you trust it. Chapter 5 |
| Side screen | `ADDRESS/s/side` | Venue TVs, full screen. Never an OBS source |
| When do we play? | `ADDRESS/s/next` | Parents, on their own phones |
| Trivia play | `ADDRESS/s/quiz` | The crowd's phones |
| Shout-outs | `ADDRESS/s/gp` | Submit a Gracious Professionalism moment. Moderated at the desk |

---

## Appendix B · The Friday setup list

Print this. Tick it off.

**AV rack**

- [ ] Desk laptop on the event network, plugged into power
- [ ] `CalGamesContentDesk.exe` copied across and run once
- [ ] Address and PIN written on the whiteboard
- [ ] Field connection confirmed (chapter 9)

**OBS**

- [ ] OBS installed
- [ ] Six scenes created, names checked twice (chapter 4, step 2)
- [ ] Program overlay added to `CG_MATCH`, both boxes unticked
- [ ] Overlay pasted *as reference* into `CG_SCORE` and `CG_REPLAY`
- [ ] Stream key entered, test stream run and stopped
- [ ] Recording tested: record thirty seconds and play it back

**Screens**

- [ ] Test card checked on every display: corners visible, circle round, clock ticking
- [ ] Side screens up, full screen, rotating
- [ ] Pit monitors up
- [ ] Trivia monitor up, QR readable from where the crowd stands

**Audio**

- [ ] Music machine identified and `/s/house` open on it
- [ ] Announcer mics tested through the stream, listening on a phone
- [ ] Confirmed music does **not** appear on the stream

**Practising without leaving a trace**

The desk rebuilds the day from the day's event log every time it starts. A
practice run on the event machine therefore comes back as if it really
happened: practice cards on the announcer's ledger, matches nobody played in
the coverage report, and a practised award reveal ticking that award off as
presented, to a team that did not win it.

**START-PRACTICE.cmd is already safe**: the pretend match it runs is tagged,
and the desk sets its log aside. What needs the flag is a rehearsal you drive
by hand on the real desk, which looks identical to the show. Start it with:

```
START-DESK.cmd /rehearsal
```

Everything behaves exactly as it does on the day; only the log is set aside.
The desk says so at startup. Start it normally again before doors.

**People**

- [ ] Everyone has read their chapter
- [ ] Desk manager has run a practice match end to end, started in practice
      mode so it does not become the day's history (see below)
- [ ] Desk manager has run one match with the field disconnected, on purpose
- [ ] Talent has seen the talent view and knows what an outlined number means

**Content**

- [ ] Robot photos uploaded (`/s/media`)
- [ ] Sponsors entered (`/s/setup`, settings code)
- [ ] Run of show entered (`/s/setup`, settings code)
- [ ] Event name, year, and TBA key checked (`/s/setup`, settings code)
- [ ] All three codes changed from the shipped defaults; settings code given
      to the content lead
- [ ] Walk-up songs in place for playoff introductions
- [ ] Award list checked against this year's ceremony scripts, both days, in
      running order (the JA's page, `/s/awards`). The twelve 2026 awards ship
      with the desk; confirm the wording and the order before doors.
- [ ] Awards code set and given to the Judge Advisor (and to nobody else);
      JA shown their page (`/s/awards`)
- [ ] Recognition and info slides entered (setup crew names, session times)

---

## Appendix C · Words this guide uses

| Word | Means |
| --- | --- |
| **Browser Source** | An OBS source that shows a web page. How the graphics get on the stream |
| **Scene** | One arrangement of pictures in OBS. You switch between them |
| **Overlay** | The graphics on top of the camera picture: score bar, clock, names |
| **Lower third** | The name strip along the bottom |
| **Program** | What the audience is seeing right now |
| **Cut** | Switch instantly from one scene to another |
| **On deck** | The match after the one being played |
| **Surrogate** | A team playing an extra match that does not count for their record |
| **Luma key** | A way hardware switchers lay graphics over video, using black as transparent |
| **Doors** | When the audience is let in. The deadline the pre-show check exists for |

---

*This guide is part of the CalGames Content Desk, which is open source under the
Apache 2.0 licence. Corrections are welcome and genuinely useful: if something
here was wrong or confusing while you were standing in a gym trying to make it
work, that is a bug in this document.*
