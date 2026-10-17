# Running the CalGames Content Desk

### A complete setup and operating guide for volunteers

**CalGames 2026 · Woodside High School · October 16-18 · Western Region Robotics Forum**

**The desk's front page and QUICK-START.pdf (one page; QUICK-START.md is the same text) are all a volunteer needs.** The desk finds the field and the video switcher by itself, the front page says what it found and what to do next, and the desk console's doors check names anything still wrong, with what to do. Everything below is reference, for looking one thing up. Nobody needs to read it to run the show.

---

## Read this first

This guide assumes you have never run this program, never used OBS, and never
touched a video switcher. That is the expected starting point. Nothing here
requires you to type commands, edit code, or understand how any of it works.

**You do not need to read any of it to run the show**: the quick start and
the desk's own front page cover that. If you want the background to your job,
find it below and read that chapter.

| If you are... | Read chapters |
| --- | --- |
| **The AV coordinator** (you run the desk, the screens and the sound) | **Start here**, then 2, 4 (*Without OBS* first), 5, 6, 10, 11 |
| **An emcee** (you announce, host trivia, read shout-outs) | **Start here**, then 8, 10 |
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

## Start here: the AV coordinator and the emcees

At CalGames 2026 two kinds of people run this: **the AV coordinator**, who
owns the computer, the screens and the sound, and **the emcees**, who own the
microphone. Everybody is doing this for the first time. That is fine: almost
everything here runs by itself once it is set up, and setting it up is a list
of steps with a check at the end of each one.

**The goal for Friday is one thing: a practice match where every screen does
the right thing on its own.** Once that works, the rest of the weekend is
mostly leaving it alone.

### The weekend at a glance

From the event schedule (updated 2026-09-30). The rows in bold are the ones
the desk crew plans around.

| When | What | For the desk crew |
| --- | --- | --- |
| Fri 8:30 AM - 4:00 PM | Field and pit setup | Rack the desk laptop, do the first hour below |
| Fri 4:30 - 6:00 PM | Field open for calibration | Connect the field (step 7) |
| **Fri 6:00 - 7:45 PM** | **Practice matches** | **Your test. Run the practice checklist below** |
| Sat 8:00 AM | Pits and arena open | Desk on, doors check green |
| Sat 9:45 AM | Opening ceremonies | |
| Sat 10:00 AM - 12:00 PM | Qualification matches | |
| Sat 12:00 - 1:00 PM | Lunch | Shout-outs and thank-you slides rotate |
| Sat 1:00 - 5:30 PM | Qualification matches | |
| **Sat 5:30 - 5:45 PM** | **Awards ceremony** | **JA hands over the awards code** |
| Sun 8:40 AM | Opening ceremony | |
| Sun 9:00 AM - 12:30 PM | Qualification matches | |
| **Sun ~12:30 - 1:00 PM** | **Alliance selection** | **The selection board goes up by itself** when the scorekeeper puts Alliance Selection on the arena's audience display (if you are holding a screen, press Selection), and gives way to Match 1's overview when Match 1 loads |
| **Sun 2:00 - 5:00 PM** | **Playoffs and awards** | **Second awards ceremony** |

### Three things that are true at CalGames 2026

- **There are 38 teams, and three of them are second robots.** The field calls
  them 9999, 9998 and 9997. Every screen prints them as **100B** (The
  Wildhats), **6036B** (Peninsula Robotics) and **4159B** (CardinalBotics).
  If you type a team into the "when do we play" page, 100B works.
- **Queuing runs on FRC Nexus** (frc.nexus/cacg). The desk can show who is
  being called to queue on every side screen, but only with an API key: get
  one at frc.nexus/api and paste it on **Event settings** (`/s/setup`), under
  **Connections**, **FRC Nexus API key**, then **Save connections**. It takes
  effect at once. Without a key everything still works; the desk works out
  the queue from the field instead. That needs the field connected (step 7):
  with **neither** the key nor the field, the side screens and the "when do
  we play" page have no queue to show. Either way, the match on the field and the next one to start are
  always at the top of the on-deck list, even after a queuer has marked the
  next match "On field" in Nexus.
- **Every team's pit is known** (Aisle 1 is pits A and B, Aisle 2 is C and D,
  Aisle 3 is E and F). The "when do we play" page shows a followed team's
  pit.

### The AV coordinator's first hour

Do these in order. Each step ends with **You should see**; do not move on
until you do.

1. **Start the desk.** Plug the desk laptop into power and into the field
   network (the network switch Cheesy Arena and the video switcher are on).
   Copy `CalGamesContentDesk.exe` to it and double-click it. Nothing appears for up to a minute the first time (it is
   unpacking). Then your web browser opens by itself.
   **You should see** *The desk is running. Pick what this computer is for.*, a row of big buttons, and the **Start here** box under them. A red error
   box instead says what is wrong and that nothing is running. If Windows asks
   about its firewall (it names **Node.js JavaScript Runtime**), choose **Allow access** and tick every network type (chapter 2, step 2): otherwise no other
   screen in the building can reach the desk.
2. **Write the address and the PIN on the whiteboard.** Both are in the
   **Start here** box. Every other screen in the building needs the address;
   the people at the consoles need the PIN.
   **You should see** an address like `http://172.22.0.23:8720/`. If the box
   says the desk has no address, the laptop is not on the event network yet:
   plug in the network cable, wait a few seconds, and reload the page. No
   restart is needed.
3. **Prove the screens work before anything else is connected.** In the
   **Start here** box, click **Fill the screens with sample data**, sign in
   with the PIN, and press the button. Then, in another tab, open the address
   with `s/watch` on the end and click **Program**.
   (Once the desk has found the field it refuses, because real matches are
   coming: skip this step then.)
   **You should see** a score bar with two outlined numbers at the bottom, on
   the purple CalGames backdrop, and **100B** among the red teams. Outlined means "a guess",
   which is right: this is sample data. Everything sample says SAMPLE on it,
   nothing is saved, and it **clears itself the moment a real match loads**.
   Two sample teams get a drawn SAMPLE robot in the photo slot; a real photo
   already uploaded for either comes back when the sample clears. A team that
   has said no to its photo gets no drawing either, and saying no on the Team
   media page takes the drawing off at once.
4. **Put the graphics into the switcher, and the show on the projector.** On
   the computer that feeds the video switcher's overlay input (the one that
   showed Cheesy Arena's score overlay), open the address with `s/program` on
   the end and press **F11**. On the computer whose HDMI cable goes to the
   projector, open it with `s/watch` on the end, click **Program**, press
   **F11**. Chapter 4 has the details, and OBS if this event streams through it.
   **You should see** the score bar from step 3: on black on the switcher's
   input, on the purple backdrop on the projector. Reload the front page on
   the desk laptop: its **Screens** line names each computer showing the
   graphics and says what to change there, if anything (a window that is not
   full screen, or a resolution the switcher does not run).
5. **Put the venue screens up.** On each TV, open the whiteboard address with
   `s/watch` on the end and click **Side screen** (*For the TVs beside the field*) or **When do we play?** (*For pit TVs*). Press F11.
   **You should see** the on-deck list and rankings, changing by themselves
   every fifteen seconds or so. Leave them alone from here on. If a TV cannot
   open the address at all while the desk laptop can, it is the firewall (step
   1) or a Wi-Fi that keeps devices apart: chapter 11.
6. **Put the music on the music machine, not the stream machine.** On the
   laptop wired to the hall's speakers, open the address and pick **House audio player**. Chapter 10 explains why it must be a different computer.
   **You should see** the player page. Press **Turn this machine on as the house player**, then use **Add a clip** on that page to upload one walk-up
   or stinger sound. Press that clip's button on the desk console and hear it
   in the hall but **not** on the stream (listen to the stream on a phone with
   headphones). The desk's **Play music** button needs a Spotify setup done
   off-site by the content desk lead; without it, only clips play.
7. **Check the field and the switcher.** With the laptop on the field
   network (step 1; ask the field tech, the FTA, for a port), the desk finds
   the field by itself, looking every 30 seconds until it does, and finds the
   video switcher on the same network; nothing needs restarting. If you cannot
   get on it Friday, skip this: the desk runs without the field and you type
   scores.
   **You should see** *Field: connected* on the front page (reload it), and a
   **Switcher** line naming the ATEM. The
   desk console's **Doors check** reads **Field bridge: OK**. The dot next to
   *linked* at the top of the console is NOT the field: it only shows that the
   console can reach the desk, and it is green with no field at all. Still
   *searching* once the field is up: chapter 9.
8. **Print the QR posters.** In **Start here**, click **print the QR posters**.
   Tape them at the doors, the stands and the pits. They send people to the
   shout-out form, the trivia game and the "when do we play" page.
9. **Change the three codes** before doors (chapter 2). Practice works on the
   shipped ones; the event must not.

### Testing during practice matches

Practice matches are your rehearsal. You do not need to clear the sample
data first: it disappears from every screen by itself when the first real
match loads. (The **Clear sample data** button on the desk console does the
same by hand.) With the field connected, watch one match and tick these off:

- [ ] When the match loads, the program shows both alliances (the overview).
- [ ] When the match starts, it switches to the score bar by itself, and the
      clock counts down.
- [ ] The numbers are **solid** (not outlined) when the field is connected.
- [ ] When the score posts, the program shows the final score by itself, and
      the next match's overview follows once the field's own audience screen
      moves off the score (about 20 seconds, never more than a minute).
- [ ] The side screens show the next matches, without anyone touching them.
      On Friday those are the next **practice** matches; Saturday's matches
      take over once practice is done. If the field crew runs the field's Test
      Match to check a robot, nothing on the desk moves: that is correct. If
      the practice schedule was made with the wrong date, practice still stays
      on the side screens while practice matches are being played; a desk
      restarted in the middle of that shows Saturday's matches until the next
      practice match starts.
- [ ] The music ducks when the emcee talks, if you armed that cue
      (chapter 6, *Show automation*).
- [ ] The projector shows the match full screen. With OBS: it is
      recording, and the stream (on a phone) has no music.
- [ ] The **Doors check** on the desk console is green (chapter 3).
- [ ] When 100B, 6036B or 4159B plays, the screens say so, not 9999.

If all nine pass, you are ready. If one fails, chapter 11 lists the usual
cause.

### The emcee's card

You need one thing: a tablet or phone open on **Talent view** (the address,
then *Talent view*, then the PIN). It shows the teams on the field, their
ranks, how close each alliance is to its bonus points, and how to say team
names. Chapter 8 explains every line of it.

Things the emcees usually do, and where each one lives:

| You want to... | Do this |
| --- | --- |
| Know who is playing next | Talent view, or look at any side screen |
| Run crowd trivia between matches | **Trivia host** page: one button, press it when its label says what you want next. Chapter 10 |
| Read out shout-outs | The approved ones rotate on the side screens. The AV coordinator approves them on the desk console |
| Give out an award | The AV coordinator presses Show, you read, they press Reveal when you say the name. Chapter 6, *Awards* |
| Explain a delay | Ask the AV coordinator for the delay card, then talk. An explained pause reads as process |

A number with an outline around it means the desk is guessing. Do not read an
outlined score as final; wait for it to go solid.

### What runs by itself, and what to leave alone

**By itself, all weekend, with nobody touching it:** the program switching
screens to follow the match, the score bar, the side screens' rotation, the
on-deck list, the "when do we play" page, the thank-you slides for the WRRF
Board, the WRRF Interns, the CalGames Planning Committee, the volunteers and
Woodside High School, and the shout-out QR code on the side screens.

**Needs a person:** approving shout-outs (they wait in a queue until somebody
reads them), the awards ceremony, and trivia if you want to run it.

**Leave alone:** the desk laptop's lid and power cable, the OBS settings once
they work, and any screen that is already showing the right thing. Nothing
gets better for being clicked, and every page reconnects on its own if the
network blips. While the desk runs it keeps the laptop from going to sleep
by itself, but closing the lid or pressing the power button still sleeps it:
keep the lid open (or set closing the lid to Do nothing in Windows Settings,
Power) and keep it plugged in. The display may still turn off; that is fine.

**If anything goes wrong mid-event**, double-click the exe again. If the desk
is still running it just reopens it in the browser; if it stopped, it starts
again and the day comes back exactly as it was: scores, cards, the run of
show. Every screen in the building reconnects by itself. Consoles that need the PIN (the desk, talent view, replay,
telestrator pad, arcade, trivia host, ref review, cards and the music
machine) go to the sign-in page by themselves after a restart: type the PIN
and each comes back to the page it was on. The on-air overlays and the venue
TVs never ask.
Chapter 11 has the rest.

## Checking it works before the event

Start the desk with nothing attached and most screens are empty, because there
is no field, no match and no event yet. That is correct, and it is also
useless for finding out whether the thing works.

So: open the desk console, switch to **Everything** at the top, find **Sample
data**, and press **Fill the screens with sample data**. (The Start here box's
link to it opens Everything by itself.)

Every screen then has something on it, and you can walk the buttons in the
console's **Main screen (program)** row (Pre-match, Match, Final, Analysis,
Arcade, Selection, Explainer, Sponsor) and see each one. The side screens, the
pit monitor and the phone page fill in too. **When you have finished, press
Auto.** Every screen button takes the program screen and holds it there until
someone presses Auto; until then the program will not follow the matches,
and the practice checklist fails for no visible reason.

Things to know:

- **All of it says SAMPLE.** The teams are real numbers but the slide, the
  sponsor, the people on camera and the award all say so on their face. If any
  of it ever reaches a projector by accident, the room can tell.
- **Scores draw outlined, not solid.** That is the desk's way of saying a
  number is a guess. It is how you can tell a sample apart from the field at a
  glance, and it is why you can leave this up while you set a monitor.
- **Nothing is saved.** The sample slides, people and robot photos exist only
  while the desk is running. Restart and they are gone, and the real event
  files are untouched.
- **It refuses once the desk has found the field**, answering or not: that
  desk is at an event, and invented teams have no business on a screen.
- **The delay card, the safety message and the countdown are not filled in.**
  Each of those covers the whole screen, which would hide what you came to
  look at. Press them yourself from the console when you want to see them.
- **No award winner is ever shown.** That is the one thing the desk keeps
  secret until the reveal, and a sample does not get an exception.

`START-PRACTICE.cmd` does the same filling in and then runs a match on a loop,
which is the better choice if you want to watch the clock and the score move.


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
be useful within five minutes.

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

1. **Arm every cue.** Open **Show automation** on the desk console (press
   **Everything** at the top first: the Simple view leaves it out) and press
   **Arm every cue**. This is the opposite of the advice in chapter 6, which
   tells you to watch each cue be right first, and that advice assumes three
   people. Alone, you want the desk cutting cameras and ducking music by
   itself, because the alternative is that nobody does it. You can still take
   anything by hand. They stay armed through a restart.
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
waiting, and no screen goes blank because a page is not open: every screen
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

Nothing appears straight away. The first time, the desk spends up to a minute
unpacking itself; after that it starts in a few seconds. Then **your web
browser opens on its own**, on the desk's front page. That is the whole
interface: there is no other window, on purpose (step 4).

If something is wrong, a red error box pops up and says what. It also says
nothing is running, so it is always safe to double-click again.

Windows will probably also ask about its **firewall**, once or twice (once for
the desk, once for the part of it that serves the screens; the box names
**Node.js JavaScript Runtime**). Choose **Allow access** and tick every kind
of network it offers. If it asks for an administrator, fetch one: without
this, the desk works on this laptop and nowhere else, and every TV, tablet and
phone in the building just fails to load the address. Missed the box? Search
Start for **Allow an app through Windows Firewall**, press **Change
settings**, and tick **Node.js JavaScript Runtime**.

Windows may show a blue **"Windows protected your PC"** box. This is normal for
any program that has not paid for a code-signing certificate. Click **More
info**, then **Run anyway**. If you are not comfortable doing that, get the
content desk lead. Do not click past a security warning on somebody's word
alone, including this document's.

### Step 3: Read the address

The front page opens with *The desk is running. Pick what this computer is
for.*, a short status (the field, the switcher, the screens and OBS, as of when
the page loaded: reload to check again), and big buttons: **This laptop runs
the show**, **Put the graphics into the video switcher**, **Put the show on a
projector or TV**, **Announcer tablet** and **Judge Advisor**. The **Start
here** box is under those buttons. On the
desk laptop it shows something like:

```
This desk on the event network: http://172.22.0.23:8720/
Desk PIN: 0864
```

Under it, **Something not working?** answers the common problems in a line
or two each, and two folded sections hold every screen with its address and a
note for anyone using OBS.

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
before the event.** Anyone holding this handbook knows them. The **Start
here** box and the doors check's **Access codes** row name every one still in
use, on the desk laptop only: no other computer is told which shipped codes
still work.

Changing them is the content desk lead's job on Friday, not the field tech's
on Saturday morning, and it needs no file and no restart. In the **Start
here** box, click **Change the codes**: that is **Event settings**
(`/s/setup`), which opens with the settings code. Under **Access codes**, each
code has its own box: the current code, the new one twice, and a button. A
change works at once, and anyone using the old code types the new one. The
desk PIN can only be changed from the desk laptop itself. The Judge Advisor
can also change the awards code on their own page (`/s/awards`): tell them
the new one if you change it for them. Each code is 4 to 8 digits, and no two
can be the same. No code lives in `config.json` any more: the desk keeps what
Event settings saves, and it outlasts a restart and a new copy of the exe.

If the awards code is the one that slips, that is the expensive one. `/s/awards`
opens its sign-in box for anyone on the venue Wi-Fi, so a default awards code
means the whole building can read the winners before the ceremony.

The numbers will be different at your event. Use what your browser shows, not
what is printed here.

The PIN only appears on the desk laptop itself. The same page opened on any
other device on the network shows the address alone, because that page is
open to everyone on the venue Wi-Fi.

**Lost the browser tab?** Double-click the exe again. If the desk is already
running it just opens it again; it never stops a running show.

### Step 4: There is no window, and that is deliberate

Nothing stays on screen after the desk starts. Your browser opens on the
front page, and that is the whole interface. There is no black window sitting
on the taskbar.

That is on purpose. A window that runs the show is a window somebody closes:
it looks like leftover clutter from an install that already finished, and one
click on the X takes the broadcast off air in the middle of a match. Asking
people to leave it open is not a control.

**If you want to see what it is doing**, open `desk-log.txt` in the desk
folder. Everything the old window printed is in there, including the address.
The PIN is not: it is on the **Start here** box on this laptop, so the log can
be sent to whoever is helping without handing them the door code.

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
| "Port already in use": an older copy is still running | Double-click the exe again: that reopens the running desk and stops nothing. For a genuinely fresh start, end it first (Task Manager, **CalGames 2026 Content Desk**, End task) and double-click again. The stop-or-open question only appears when you start it from a console window |
| A new copy of the exe changes nothing | The old desk is still running, and a double-click only reopens it. End it in Task Manager first, then double-click the new exe |
| It says the field was not found | Fine. The desk keeps looking by itself and connects when the field is up; see chapter 9. |
| A red box: *This copy of the desk is missing some of its own files* | Nothing on this computer needs fixing. Get a new copy of the exe from the event lead and double-click that |
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

Open the desk address in a browser on the desk laptop and press **This laptop
runs the show** (`/s/desk`, the desk console). It asks for the PIN once. The
doors check is in both the Simple and the Everything view.

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
only appears once OBS is connected, and **Match timing** only when the field
disagrees with the desk:

| Check | What it means when it is not green | What to do |
| --- | --- | --- |
| **Desk mode** | Amber: the desk is in PRACTICE (started with `/rehearsal`, `START-PRACTICE.cmd` or `/demo`) or REPLAY, so nothing done on it becomes the day's history | End the desk in Task Manager and double-click the exe before doors |
| **Settings file** | Gray: there is no `config.json`, which is fine: the codes and connections are set on Event settings. Red: `config.json` has a typo near the line it names, so none of it is in use: any code set in it (not one set on Event settings) is back to the shipped default, and OBS is off. Amber, which does not hold the doors: a section is written twice (it names the section and its lines; only the last one counts), or a section is not a group in `{ }`, for example `"obs": true` (it names the section, which is ignored, so for `"obs"` OBS is off) | Red: fix that line (check the quotes and commas), save, restart the desk. Amber: merge the repeats, or write the section as a group copied from `config.example.json`, save, restart |
| **Field bridge** | The desk cannot see the scoring system. Gray and *searching*: it has not found the field yet, and keeps looking every 30 seconds. Gray and *not looking*: the desk was started with `/no-cheesy`. Amber, *not answering*: it found the field and lost it | Put the desk laptop on the field's network. Still searching once the field is up: type the field's address on Event settings, **Connections** (chapter 9) |
| **Match timing** | Amber: the field's match periods differ from the standard ones this desk is built for | Ask the scorekeeper to put the standard periods back, or expect the endgame chip and the countdown to be off by that much |
| **Switcher** | Gray: no video switcher found, which is fine on a setup without one. Amber: two overlays keyed on air at once; a match running with the graphics input not keyed; the switcher turned the desk down; an address on Event settings it cannot use; or the switcher lost | The row says what to do, in the switcher's own words where it has them. Chapter 9, *The video switcher* |
| **Screens** | Amber: no program page open anywhere; one in a window instead of full screen; one at a resolution or refresh rate the switcher does not run; one showing the see-through OBS version on white; one that cannot reach Cheesy Arena's own display, so it has no fallback; or one showing Cheesy's overlay because the desk or the field link was down a moment ago | The row names each computer and what to do there. Chapter 4, *Without OBS* |
| **OBS** | The desk cannot drive the camera switching. Gray means it is switched off, which is right for an event without OBS | Only if this event uses OBS: chapter 4, step 7 turns it on in `config.json` |
| **Stream health** | OBS is dropping frames on the way out: amber past one in a hundred, red past five | The uplink is struggling. Tell the content desk lead now, not when it gets worse |
| **Recording** | Nothing is being recorded, so there will be no replays or videos. Gray says which part is missing: ffmpeg not installed, or no cameras listed in `config.json` | Chapter 4, step 9, or accept a show without replays. Red with a camera listed: check the capture device is plugged in |
| **Disk** | Running out of room: amber under five hours of recording left, red under two | Now, not at lunch: empty the Recycle Bin and move other files off this drive. Then move the oldest camera files (named by date and time, practice first) out of the camera folders in the `rec` folder inside the desk folder. Never touch `rec/clips`, which holds the cut match videos |
| **Event log** | Red, and it holds the doors: the day is not being written down. The row names the error, usually a full disk. A restart now would rebuild the day only up to the moment it stopped | Free disk space (see Disk). The desk tries a fresh file by itself every 30 seconds and the row clears. Do not restart the desk until it is green |
| **Publishing** | YouTube is not set up | Videos will not upload. Talk to the content desk lead |
| **Microphones** | A mic is muted in OBS | Unmute it |
| **House audio** | The music machine is not connected, or two machines are both armed | Chapter 10 |
| **Coverage** | A match has been played and no video was ever queued for it | Tell the content desk lead before the recording rolls off the disk |
| **Access codes** | At least one of the three codes is still the shipped default (amber; it names which, and only on the desk laptop), or the desk PIN is empty (red, and it blocks: every control is open to anyone on the venue Wi-Fi; gray instead if the desk only listens on this laptop, 127.0.0.1, where nobody else can reach it) | Read the two paragraphs below. Do not skip this one. If it is red, set a desk PIN on Event settings, on the desk laptop |

A row can also be **grayed out**, which means that part is switched off rather
than broken: no field connection, no recording set up, no stream started yet.
Gray **Recording** is fine on a desk without the optional recording setup;
**Field bridge** and **OBS** should not be gray by the time the doors open if
you are using them.

**Amber is not red.** Amber usually means "this will work, but you should
know". A missing Blue Alliance key is amber: videos still upload, they just do
not get linked.

**Access codes is the one amber you do not shrug at.** If it is amber and the
words *awards code* are in it, go and find the content desk lead. The shipped
awards code is printed in this handbook and in the public code, and the Judge
Advisor's page opens its sign-in box for anyone on the venue Wi-Fi. That amber
means the building can read the winners before the ceremony. Chapter 2, step 3
says how to change it: a minute on Event settings, with no restart, so do it
now rather than at four o'clock.

Everything red on this list will be noticed by somebody in the audience within
an hour. That is the entire point of running it early.

---

## Chapter 4 · The program screen: without OBS, or with it

The program screen is the match graphics: who is playing, the live score, the
final score, the awards. Most venues no longer run OBS: they put the program
on the projector, a TV or a video switcher straight from a browser, which is
the first section below. From **Step 1: Install OBS** on is only for an event
that streams through OBS.

### Without OBS: a browser, full screen

1. On the computer whose HDMI cable goes to the projector or the TV, open a
   browser at the desk address with `s/watch` on the end, for example
   `http://172.22.0.23:8720/s/watch` (the front page's **Put the show on a projector or TV**). On the desk laptop itself, open
   `http://localhost:8720/s/watch` in a new window dragged onto the projector.
2. Click **Program**, the card that says *For the projector, or the stream*.
3. Press **F11** for full screen.

Until a match loads it shows the purple CalGames backdrop, **CALGAMES 2026**
and one line saying what it is waiting for (*What the projector says*, at
the end of this chapter). When the field loads a match the graphics take over
by themselves, and once a match has loaded the line stays away.

**The video switcher.** On the venue kit a computer's HDMI goes into the
switcher's overlay input, which the switcher keys over the cameras (DSK 1 on
this kit); it used to show Cheesy Arena's score overlay. On that computer open
`ADDRESS/s/program` and press F11 (the front page's **Put the graphics into
the video switcher**). It is graphics on black, and the luma key drops the
black out. While the desk works, its graphics replace Cheesy's overlay; when
the desk cannot give a score, the same input shows Cheesy's by itself, so key
only this one input. Use a luma key, not a chroma (green) key: the CalGames
colors include a green and a blue. An input the switcher cuts to, rather than
keys, takes `ADDRESS/s/watch?screen=program`, like a projector.

**How the hand-off to Cheesy's overlay works.** The program page keeps
Cheesy Arena's own audience display loaded, unseen, behind the desk's
graphics, straight from the field (so that computer must be on the field
network). It shows Cheesy's in their place when the desk has not answered for
about 3 seconds, or when the desk is up but has lost the field for more than
10 seconds (Cheesy has the real score then). It goes back to the desk's
graphics once the desk and the field have both been answering for 5 seconds.
It never reloads itself while the desk is away, because a reload then would
be a light browser error page keyed onto the stream. Nobody presses
anything. The doors check's **Screens** row says when a program page is
showing Cheesy's, and warns ahead of time when that computer cannot reach
Cheesy's display, while there is still time to move its cable. Do not also
key Cheesy's overlay from its own computer: two overlays on air is the
**Switcher** row's first warning. The desk finds the switcher by itself and
only ever reads it (chapter 9, *The video switcher*).

**Why a page can look white or black.** `ADDRESS/s/program` opened by itself
in a browser is graphics on black, for a luma key, with nothing on it until a
match loads; the telestrator render and the arcade overlay are the same.
Inside OBS, or with `?key=alpha` in the address, they are see-through, which a
plain browser paints white. So a projector always goes through `/s/watch`.
Software that layers pages without being OBS (vMix, Wirecast, CasparCG) needs
`?key=alpha` in the address.

### With OBS

OBS Studio is the free program that sends the video to YouTube: the desk draws
the graphics, and OBS puts them over the camera picture. A setup made before
this change works exactly as it did: a Browser Source pointed at `/s/program`
is still see-through and never shows the lines in *What the projector says*.
Skip to chapter 5 if this
event does not stream through OBS, or if somebody has already set OBS up.

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
| **URL** | `http://localhost:8720/s/program` |
| **Width** | `1920` |
| **Height** | `1080` |
| **Use custom frame rate** | leave unticked |
| **Shutdown source when not visible** | **UNTICK THIS** |
| **Refresh browser when scene becomes active** | **UNTICK THIS** |

Those last two matter. If either is ticked, the overlay reloads every time you
cut back to the camera, and the audience watches the scoreboard flash and
re-animate mid-match.

Use `localhost`, not the address on the whiteboard, for every OBS source on
this laptop (the Overlay, the Telestrator, the arcade overlay): `localhost`
always means this laptop, while the whiteboard address can change if a cable
is moved or the network renews it, and an OBS source left on the old address
goes blank on air. The whiteboard address is for the other screens.

5. Click OK. The scoreboard appears over your camera.
6. Drag it so it fills the frame exactly. Right-click it → **Transform** →
   **Fit to screen** does this in one step.

### Step 4: Copy the overlay to the other scenes

The scoreboard belongs on the score scene and the replay scene too.

Do **not** add a second Browser Source: that runs a second copy of the
overlay and doubles the load on the laptop. Instead:

1. Right-click the `Overlay` source → **Copy**.
2. Select `CG_SCORE`, right-click in the Sources box → **Paste (Reference)**.
3. Do the same for `CG_REPLAY` and `CG_DESK`. (`CG_INTRO` is only the
   pre-show title and carries no Overlay; the desk cuts away from it when a
   plate goes up.)

Every scene that can be on air while you use name cards, a delay card, a
safety message, a slide or the awards needs the Overlay: it is the only thing
that draws them. Shoot the awards ceremony on a scene that has it (`CG_MATCH`
or `CG_DESK`).

**Paste (Reference)**, not **Paste (Duplicate)**. A reference is the same
overlay showing in two places. A duplicate is two overlays, and they will drift
out of step with each other.

### Step 4b: The replay player

Replays play through OBS itself, in the replay scene.

1. Select `CG_REPLAY`.
2. **+** → **Media Source**, name it exactly `CG Replay Clip`.
3. Tick **Local File** and leave the file empty: the desk loads each clip into
   it by name.
4. Tick **Restart playback when source becomes active** and **Close file when inactive**. Untick **Loop**. OK.
5. Drag it **below** the Overlay in the Sources list (the Telestrator, if you
   add one, goes above the Overlay).

### Step 5: The telestrator (optional)

If your analyst is going to draw on replays:

1. Select `CG_REPLAY`.
2. **+** → **Browser**, name it `Telestrator`.
3. URL `http://localhost:8720/s/tele`, 1920 × 1080, same two boxes unticked.
4. Drag it **above** the Overlay in the Sources list.

### Step 6: The arcade overlay (optional)

Same recipe on the `CG_ARCADE` scene, with URL `http://localhost:8720/s/arcade`.

### Step 7: Let the desk drive OBS

This lets the desk manager cut cameras from the desk console instead of
reaching for OBS.

1. In OBS: **Tools** → **WebSocket Server Settings**.
2. Tick **Enable WebSocket server**.
3. Click **Show Connect Info** and note the **Server Password**.
4. Click OK.

Then tell the desk about it, in `config.json` in the desk folder. There is no
`config.json` until somebody makes one: in the desk folder
(`Downloads\CalGames2026-ContentDesk`), copy `config.example.json`, name the
copy `config.json`, and open it in Notepad. It already has an `"obs"` block,
copied from the example: find it, change `false` to `true`, and put the
password between the quotes, so it reads:

```
"obs": { "enabled": true, "host": "127.0.0.1:4455", "password": "THE SERVER PASSWORD" }
```

Do not add a second `"obs"` line: the later one wins, silently. Keep every
comma, and type the quotes in Notepad rather than pasting them from a
document (curly quotes break the file). If the file has a typo, the desk
says so on the **Start here** box and ignores the whole file until it is
fixed.

Save, and restart the desk (on this laptop, Event settings, **Restart the
desk**; or Task Manager, **CalGames 2026 Content Desk**, End task, double-click
the exe). The **Doors check** on the desk console shows OBS
green once it is connected. OBS has to be on this same laptop.

You can run the entire show without this. The desk manager just switches scenes
in OBS by hand instead, and everything else works identically, with one
exception: **Take to program** on the replay console needs this. Without it the
replay console says *NOT on air*, names the clip file, and tells you how to play
it by hand (program screen on Blank, load the file into `CG Replay Clip`, cut to
`CG_REPLAY`).

### Step 8: Check it

Load a practice match (chapter 6) and look at your OBS preview. You should see
the scoreboard over the camera, with the clock counting.

If the overlay is **black instead of transparent**, the Browser Source lost its
transparency. Delete it and add it again. Do not add a Color Correction
filter, which is the usual wrong fix.

### Step 9: Recording, replays and match videos (optional)

Replays, **Take to program** and the automatic match videos all cut from a
recording the desk makes of the program feed. The exe does not include the
recorder's video tool, so this is a one-time setup on the desk laptop, and
the show runs without it (no replays, no match videos):

1. Install ffmpeg: open PowerShell and run `winget install Gyan.FFmpeg`.
   Then restart the desk.
2. In OBS: **Start Virtual Camera** (bottom right). The desk records that.
3. In `config.json`, find `"recording"` and replace `"sources": []` with
   `"sources": [ { "id": "program", "label": "Program feed", "role": "program", "input": ["-f", "dshow", "-i", "video=OBS Virtual Camera"] } ]`
4. Restart the desk. The **Doors check** row **Recording** should read one
   source rolling. Leave OBS's Virtual Camera on all day.

### A note for events with a hardware switcher

Covered under *Without OBS* at the start of this chapter: an input the
switcher keys over the cameras takes `ADDRESS/s/program`, which is graphics on
black by itself in a browser (`?key=luma` says so explicitly, and `?key=fill`
puts the CalGames backdrop behind them instead); an input it cuts to takes
`ADDRESS/s/watch?screen=program`. On the OBS path, leave `?key=` off.

### What the projector says

| The line under CALGAMES 2026, word for word | What to do |
| --- | --- |
| *Connecting to the desk at http://ADDRESS.* | Wait a few seconds |
| *No field connection. Matches can be run from the desk console.* | The desk is not connected to the field. It finds the field by itself once the laptop is on the field network (chapter 9); meanwhile run matches with **Load a match by hand** |
| *Connected to the field. Waiting for it to load a match (its Test Match does not count).* | Ask the scorekeeper to load a practice, qualification or playoff match. The desk ignores the Test Match on purpose |
| In yellow: *Cannot reach the desk at http://ADDRESS. Check that the desk computer is on and the Content Desk is running.* | The desk laptop is off or asleep, the desk was ended, or this computer is on another network. It heals by itself |
| A second line, in yellow: *No picture from the field feed at HOST: check that the camera is on and its address is right. Until then the graphics show on this backdrop.* | Only with a field feed set. Fix the camera or its address (chapter 5); the video then appears by itself |
| The backdrop with no words | Somebody pressed **Blank**: press **Auto** |

---

## Chapter 5 · The screens around the hall

Every TV, monitor and phone in the building shows a web page. None of them need
the PIN.

### The easy way

On the computer plugged into the display, open a browser at the desk address
with `s/watch` on the end, for example `http://172.22.0.23:8720/s/watch` (on
the front page, that is **Put the show on a projector or TV**). The page is headed **Pick a screen**. Click the card for the
display you are standing at: each one starts with a gold *For ...* line.
Press **F11** for full screen.

That is it. The page remembers full screen, so if the monitor loses power and
comes back, F11 once and it is right again.

### The screens, and where each one belongs

In the same order as the cards on **Pick a screen**:

| For | Screen | Address | What it shows |
| --- | --- | --- | --- |
| The projector, or the stream | **Program** | `/s/watch?screen=program` | The main show picture: who is playing, the live score, the final score. It changes on its own as the field runs |
| The TVs beside the field | **Side screen** | `/s/watch?screen=side` | Who is on deck and the current rankings, rotating. Built to be read from across the room |
| Pit TVs | **When do we play?** | `/s/watch?screen=next` | When each team plays next, with start times that follow the field running early or late. Also the QR code on the side screens |
| The trivia monitor | **Trivia** | `/s/watch?screen=trivia` | The crowd game. Shows the join code between questions |
| The arcade TV | **Arcade** | `/s/watch?screen=arcade` | Scores from the side tournament, for a TV beside the game consoles |

With no field feed set, Program and Arcade fill the whole display, edge to
edge on any screen shape, with the CalGames backdrop. Until a match loads,
Program shows the line from chapter 4's *What the projector says*.

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
looks intentional and is fine. For one display only, add `&feed=` and the
feed's address to that display's address.

With a feed set, the display waits up to about four seconds for the camera's
first picture before it decides; a working camera usually answers in under a
second, and then the video fills the display with the score over it.

- **The camera is off, on another network, or its address is wrong.** The
  display shows the program on the CalGames backdrop, with a second line in
  yellow: *No picture from the field feed at HOST: check that the camera is on and its address is right. Until then the graphics show on this backdrop.*
  It never goes black, and it names only the camera's host and port, never the
  rest of its address. It keeps asking every few seconds, and when the camera
  answers, the video appears under the score by itself (the graphics blink
  once). Nobody needs to touch the display.
- **A working camera drops in the middle of the show.** The score stays up on
  the CalGames backdrop instead of a black screen, with no words, and the
  video comes back by itself when the camera does.
- **Do not put a user name and password in the feed address**
  (`http://user:pass@camera/...`). Browsers refuse those, so the camera is
  never even asked. Set the camera to allow viewing without a login on the
  venue network, or use a capture box.
- **A YouTube feed** behaves as before: YouTube's own player says when the
  video is unavailable.

---

## Chapter 6 · The desk console (desk manager)

Open `/s/desk`. Enter the PIN once (again only after a desk restart, when the
console takes you to the sign-in page itself).

This is the main control panel and it is built to be driven by keyboard. The
buttons all say what they do; this chapter covers the order you use them in.

### The rhythm of a match

The field drives most of this by itself. What follows is what you do when the
field connection is working, which is the normal case. Without OBS there
is nothing to cut in the *You do this* column: the projector follows by itself.

| When | The desk does this by itself | You do this |
| --- | --- | --- |
| Next match is up (after the score has had its time) | Shows the alliance overview with robot photos | Cut to `CG_MATCH` |
| Field arms the match | Score bar comes in | Nothing |
| Match starts | Clock runs, scores update live | Watch the show, not the desk |
| Buzzer | Clock stops | Cut to a wide, or to the desk |
| Referees finish | Nothing | If a card was given, chapter 7 |
| Score posts | Final score screen appears, and stays until the field's own audience screen moves off the score: about 20 s (30 s after a playoff match that is not a final), never more than a minute, and at once if the next match starts or the scorekeeper re-runs the match just played | Cut to `CG_SCORE` |
| Gap before the next match | Nothing | Sponsor, trivia, arcade, or an interview |

**If the field connection is down**, you press those beats yourself: load the
match with **Load a match by hand**, then the **Match steps** buttons near the
top of the console are Preview, Arm, Start, End, Post score, Abort. The
graphics behave identically.

**Simple and Everything.** The console opens in **Simple**, only what a match
day needs, plus *Field down? Run matches by hand* while the field is not
connected. **Everything** shows every panel; with no OBS set up, its cameras
fold behind **Using OBS? Show the camera controls**. Every key works in both.

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
| `0` | Abort: the clock stops and the program goes back to this match's overview |

Holding a key down does its action once. To do it again, let go and press it
again.

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

1. In the **On camera** section (*Names for the people on camera*, in
   Everything), tick their name in **Saved profiles**. If they
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

A lower third (the single name strip, `T`) leaves by itself after its time
on screen unless **Pin (stays up)** was ticked, and stays gone when OBS or a
screen reloads the overlay. A pinned one stays until you press **Hide** (`Y`).

### Status cards and safety messages

Two different things, deliberately.

- **Status card**: "Field delay", "Back in ten minutes". Explains a pause. It
  **stays up until you press Hide card**: only the field's own break card
  clears itself. That one names the break ("Awards Break", "Lunch", or "Field
  timeout" for a plain timeout) with its end time, goes when the field comes
  back or the next match starts, and on the stream steps aside while an award
  or slide plate is up. The Delay card section tells you on screen whenever one
  is live, and the jump strip has a **Delay card** chip to get back to it.
  The five buttons cover almost everything. If you type your own, keep it
  short: the card holds about ninety characters, the box stops you at that,
  and it counts the last thirty down beside the field so you can see the end
  coming. Fill in **Back in** and the time appears on its own line under the
  message, which is the part the hall actually wants. Once any card's time
  has passed (an Awards Break often runs over), every screen says "Back soon"
  instead of a time that has gone, so update or hide the card if the pause
  runs long.
- **Safety message**: covers every screen in the building, and stays until you
  clear it. Type it and press **Put on every screen**; **Clear** takes it
  down. This is for an evacuation or a hold. It is not for a long queue.

Both go to the program, the side screens and every phone at once. The side
screens show a safety message on their next frame; phone pages pick it up
within 5 seconds (When do we play) or 8 (shout-outs, crowd trivia); the
trivia and arcade screens show the same safety plate, so a trivia or arcade
monitor and the `CG_ARCADE` scene carry it too. When you send a safety
message the console goes red so that whoever walks up next can see one is
live. A restart does not lose it: it comes back
with the desk.

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
empty in `config.json` (it applies only while nobody has changed the awards
code on Event settings or the Judge Advisor's page), which removes the lock
and runs awards on the desk PIN: then type the winner yourself before Show, and do not read it aloud to
anyone standing behind the desk.

### Slides and shout-outs

Slides are the between-matches cards: thank-yous for volunteer crews,
session announcements, event info. The side screens rotate the whole deck on
their own all day; **Next slide** steps through the same deck on the program
when you want one on the big screen, and **Hide** takes it down again.

To add one during the event: pick a kind, type a title and lines (separate
lines with `|`), press **Add**. It is saved immediately and survives a desk
restart.

**The thank-you slides are already loaded.** The WRRF Board of Directors,
the WRRF Interns, the CalGames Planning Committee, the volunteers and
Woodside High School each have one, plus a slide inviting the crowd to send
shout-outs. They rotate on the side screens from the first start. To name
people (a setup crew, the planning committee by name), add a slide of your
own.

The **shout-out queue** below it fills from `/s/gp`, a phone page where
anyone in the building can thank a volunteer, a team, a mentor, the ref crew.
They say **who it is for** and **what they did**; approved, it airs as
*Shout-out to (who)* with the message and *From (name)* underneath.

People find the form three ways: the QR code in the corner of every side
screen switches to it whenever a slide is up, the QR posters you printed
(Start here, step 8), and the "Send a shout-out" slide in the rotation.

**Nothing from that queue reaches any screen until you press Approve.** Read
each one; approve the good ones into the deck; reject the rest. Nobody is
notified of a rejection. Check the queue between matches: it is the one part
of the desk that waits for you.

### The event timer

In Everything, under **Countdown on the side screens**: **Field setup 2:00** starts a countdown that takes over the side screens in
digits readable from the far end of the gym; turn one side-screen TV to face
the field and the drive teams have their setup clock. It clears itself the
moment the match starts. The label and minutes boxes run any other countdown:
meeting starts, doors, end of lunch.

### Seeing what the screens look like, before there is a show

With no field and no match there is nothing to show: the program says so
(chapter 4, *What the projector says*), and the other overlays are empty.

For setting a pit monitor up, aiming a projector, or showing somebody what the
broadcast looks like, the desk console has a **Sample data** panel, in the
**Everything** view under *Field down? Run matches by hand*. One press fills every screen with invented teams, scores, rankings and
slides. It is for testing, not for the show:

- Everything it puts up is tagged as sample, so scores draw **outlined**, the
  same way a desk-typed guess does, and none of it can be published.
- The button refuses outright while the field bridge is running, because a
  desk talking to the field is a desk at an event.
- Load a real match, or restart the desk, and it is gone.

### Show automation

In the Everything view, under **Show automation**, is a list of cues. A
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

What you arm is remembered: a restart brings every cue back armed or off
exactly as you left it. A desk started in practice mode starts with every cue
off and remembers nothing you change in it.

You can always take anything by hand afterwards. Autopilot never cuts away
from the field in the middle of a match. While an award or a slide is on the
program, or a screen you took by hand, autopilot leaves the camera where you
put it: On deck, Score reveal and Fill the gap all wait. The one exception is
the field itself: when it goes ready or starts a match, Armed and Live still
cut to `CG_MATCH`. Press Auto to hand the program back; automatic cuts resume
as soon as the program moves off the plate, at the next match load. To take
a plate down at once, press **Hide** for a slide and **Clear** for an award.

**Plates on the stream**: `CG_ARCADE` and `CG_INTRO` carry no Overlay, so an
award, a slide, a sponsor card or the selection board put up while the stream
is on one of them would never be seen. When you press Show the award, Reveal,
show a slide or a sponsor card, or Selection while OBS is on either, the desk
cuts to `CG_MATCH`, armed or not; on any other scene it does nothing. The
same cut back for the selection board going up by itself also runs disarmed
when Fill the gap made the cut to the arcade in that same gap, so with only
Fill the gap armed the board still reaches the stream. In any other gap the
board's automatic cut waits for this cue to be armed.

If OBS is not connected, every **Run now** still works: the graphics still
switch, and only the camera cut is missing, which you take by hand in OBS.
The panel says how many cues that applies to. The exception is **Take
replay**: it runs whenever the replay console takes a clip, armed or not, and
it needs OBS. With OBS down it refuses, and the replay console says why,
instead of cutting to an empty replay scene. Autopilot never cuts away from a
replay while it plays. **Fill the gap** fires only when a score has been up
three minutes and no next match is loaded (the end of a session, or a stall),
and never over an award, a slide, a held screen, the selection board or a
replay. The music cues and the end game chip never touch OBS anyway. Arming works for all of them either way, and an
armed cue starts cutting cameras again the moment OBS comes back.

If a cue fails, its row says so in words and keeps saying so until it next
succeeds. That row is the only place a failed cue is reported, which is the
other reason to read this panel between matches.

### Event settings: names, sponsors, and the run of show

Event content lives on its own page: `ADDRESS/s/setup`, behind the
**settings code**, which is not the desk PIN and not the awards code. The
content lead holds it. It is a before-doors tool: everything about the
event that used to require editing a file lives there, saves the moment you
press the section's Save button, takes effect immediately, and survives a
restart. The desk console links to it from the Setup fold (in Everything).

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
- **Access codes**: the desk PIN, the settings code and the awards code, each
  changed with the current one (chapter 2, step 3). The desk PIN only on the
  desk laptop.
- **Connections**: **Field address (Cheesy Arena)**, **Video switcher address (ATEM)**, the switcher input carrying the desk's graphics, and the **FRC Nexus API key**. Leave the addresses blank and the desk looks by itself;
  type one only when it cannot find it. **Save connections** says which
  change, if any, waits for a restart.
- **Restart the desk**: on the desk laptop only, between matches. Every
  screen reconnects by itself and every console asks for its code again.

The codes, the Nexus key and the field and switcher addresses used to mean
editing `config.json`; none of them does now. What stays in that file is
the rest of the machine wiring (OBS, the camera list for recording) and
upload credentials. If a section on that page asks for something you do not
have, that is a question for whoever set the desk up, not a file for you to
edit.

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

To air one: click a mark (it frames 6 seconds before the moment and 4 after)
or a spot on the timeline, then **Cut clip** (`Enter`). Half and quarter speed
are ready in seconds. Then `T` or **Take to program**. *On program* means OBS
is playing it, and the stream cuts back by itself when the clip ends: to
where the show was before the first of any back-to-back replays, or to where
autopilot wanted to go while the clip ran. If the switcher has already cut
somewhere else in OBS during the clip, that cut stands and nothing cuts
back. *NOT on air* says why, and how to air it by hand. While a
replay plays, automatic cuts wait for it; the field arming takes the stream
back at once. **Cut full match video** greys out while it cuts, and so does
**Cut clip**: press it again after *Ready*. Holding a key down does its action
once. The desk encodes at most two clips at a time and the rest wait their
turn, so a replay cut can wait a little behind a full match video.

### Surrogates

If a team is playing a surrogate match, one that does not count for their
record, the graphics say so. Nothing for you to do; it is there so the
audience is not told a team lost a match that was never theirs to lose.

---

## Chapter 8 · The talent view (on-air talent)

Open `/s/talent` on a tablet. It asks for the PIN once, and again only if the
desk restarts; it takes you to the sign-in page by itself.

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

Usually nothing. The desk looks for the field by itself: the launcher looks
once as it starts, and the desk keeps looking every 30 seconds until it finds
the field, then connects on its own. Nothing needs restarting, so the desk
can be started before the field network is plugged in. The front page says
*Field: searching* until then.

If it still says *searching* once the field is up:

1. Check the desk laptop is on the **same network** as the scoring system.
   Event Wi-Fi and the field network are often not the same thing.
2. Check the scoring computer is on and its display is up.
3. Ask the FTA for the field's address and type it on **Event settings**
   (`/s/setup`, the settings code), under **Connections**, **Field address (Cheesy Arena)**, then **Save connections**. The desk looks there first,
   straight away.

If the front page says *not connected, and this desk is not looking for it*,
the desk was started with `/no-cheesy`. End it in Task Manager and
double-click the exe: a plain double-click always looks.

### The video switcher

The desk reads the ATEM switcher, read-only like the field: it can see what
is on program, which keys are on air and the video format, and it has no way
to change any of it. It finds the switcher by itself, trying the field
network (10.0.100.x, where the kit's ATEM lives at 10.0.100.40) and then this
laptop's other networks, and the front page's **Switcher** line names it.

| The Switcher line says | What to do |
| --- | --- |
| No video switcher found (gray) | Nothing, on a setup without one. With one: check it is on and on the field network, or type its address under **Video switcher address (ATEM)** on Event settings |
| It would not let the desk connect (amber) | The switcher has no free connection. Close any copy of ATEM Software Control nobody is using; the desk tries again by itself |
| The address on Event settings cannot be used (amber) | Type four numbers with dots, such as 10.0.100.40, with no port, or clear the box to let the desk look |
| Lost the switcher (amber) | Check its power and network cable. The switcher keeps running the show either way |

If the graphics reach the switcher on a known input, pick it under **Switcher
input carrying the desk's graphics**: the doors check then warns when a match
is running with that input not keyed on air.

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
| **Video switcher** | The front page's **Switcher** line, or the doors check | Chapter 9, *The video switcher*. The show runs either way |
| **FRC Nexus** | The side screens show who is called to queue | Paste the key on Event settings, **Connections**; it takes effect at once |
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

**Pick the winner** asks the crowd who takes the match that is up. Queue it
and open it before that match starts; once its score is posted it can no
longer be queued. Reveal it any time after the score posts, even after the
next match has loaded. In a playoff it pays the alliance the field declared
the winner, tiebreaks included. If the field moves on without posting that
match, the host console says so, and **Next** drops the round with nobody
paid.

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

By how often it happens. Short answers: the front page's **Something not working?**, and QUICK-START.pdf.

| What you see | Almost certainly | Fix |
| --- | --- | --- |
| A white or black page, nothing on it | An address for OBS or a switcher, on a projector. On the switcher's computer, black is right until a match loads | `ADDRESS/s/watch`, **Program**, F11. White on any computer: the front page's **Screens** line, on the desk laptop, names it and the address to open instead |
| The switcher's overlay input shows Cheesy Arena's own score, not the desk's | The desk stopped, or it lost the field for more than 10 seconds | Nothing: it goes back by itself 5 seconds after both answer. Find out why on the front page |
| Other screens cannot open the address at all, but the desk laptop can | Windows Firewall on the desk laptop said no, or the Wi-Fi keeps devices apart (common on guest networks) | Allow access (chapter 2, step 2), or have an administrator allow inbound TCP 8720; for Wi-Fi that isolates devices, use the wired network or ask the venue to turn isolation off |
| The program screen does not follow the match | A screen button was pressed, which holds the screen | Press **Auto** on the desk console |
| A screen says "reconnecting" | The desk laptop went to sleep, or the desk was ended | Wake it, or double-click the exe again. Screens recover on their own |
| The overlay in OBS is frozen | The Browser Source has "shutdown when not visible" ticked | Chapter 4, step 3 |
| Scores are not updating | Field connection dropped | Chapter 9. Drive it by hand meanwhile |
| A score has an outline around it | The desk is guessing, and saying so | Nothing. It goes solid when the real score posts |
| Camera buttons do nothing | OBS is not connected, or a scene is misspelled | Chapter 4, steps 2 and 7 |
| Music is coming out of the stream | The house page is on the wrong machine | Chapter 10: this one matters |
| No robot photos | None uploaded for those teams | Fine. It falls back to a gold team number |
| A wrong name on screen | Somebody typed it | Forget that profile, add it again spelled right, tick it, press Put on air |
| The final score sits for a full minute after every match | The field's automatic audience display is off (Cheesy, `/setup/settings`, **Enabled automated audience display**), so the desk waits out its one-minute limit | Ask the scorekeeper to tick it, or to press Intro on their audience display |
| The final score came off almost at once | The scorekeeper changed the field's audience screen, or started the next match | Nothing: the desk follows the field |

### The universal fix

Double-click the exe again. If the desk is still running, that simply reopens
it in the browser, at once (before it unpacks anything or looks for the
field). If you added an option such as `/pin` or `/cheesy-host`, a box says it
was ignored because a desk is already running. If it really has stopped (the
laptop restarted, or it crashed), that starts it, and it comes back in a few
seconds remembering the day: cards (on Sunday, Saturday's qual cards too),
which cues are armed, coverage, the run of show, sponsor counts, the day
video chapters, quiz scores, the match pace, and any safety message, delay
card, countdown or announcement that was up (a countdown that ran out
meanwhile stays gone; the field's own break card keeps the field's end time,
and comes down by itself if the break ended while the desk was down). Every screen in the building reconnects on its
own. Consoles that need the PIN (the desk, talent view, replay,
telestrator pad, arcade, trivia host, ref review, cards and the music
machine) go to the sign-in page by themselves after a restart: type the PIN
and each comes back to the page it was on. The on-air overlays and the venue
TVs never ask. The music machine needs the PIN again too, and the music
stays stopped until it gets it.

If the desk is running but misbehaving and you want a genuinely fresh start,
press **Restart the desk** on Event settings, on the desk laptop: it comes
back by itself with the same field, switcher and codes. Or end it: Task
Manager (Ctrl+Shift+Esc), find **CalGames 2026 Content Desk**, End task, then
double-click the exe.

You do not lose the day by restarting. That is deliberate, and it was built
because laptops get their power cables kicked out.

### When to escalate

Get the content desk lead for: anything involving credentials, uploads going to
the wrong channel, or a message on screen that should not be there and will not
clear. Everything else on this page is yours to fix.

---

## Appendix A · Every screen, in one table

Replace `ADDRESS` with the address in the front page's **Start here** box.
The front page has the same list, folded away under **Every screen, with its
address**.

**On a projector or TV, no PIN:** `ADDRESS/s/watch`, then the card for the
display. Chapter 5 lists the five. **On the video switcher's overlay input:**
`ADDRESS/s/program` (chapter 4).

### Graphics for OBS or a video switcher

| Screen | URL | Notes |
| --- | --- | --- |
| Program overlay | `ADDRESS/s/program` | The scoreboard. See-through 1920×1080 in OBS; graphics on black by itself in a browser, for a switcher's luma key, with Cheesy's overlay behind it when the desk stops (chapter 4) |
| Telestrator render | `ADDRESS/s/tele` | See-through over the replay in OBS; ink on black on its own |
| Arcade overlay | `ADDRESS/s/arcade` | Over the game capture in OBS; on black on its own |
| Trivia overlay | `ADDRESS/s/trivia` | Crowd game. A full picture with its own background: cut to it rather than laying it over a camera |

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
| Pick a screen | `ADDRESS/s/watch` | Every display in the venue: pick the card that says *For ...*, then F11. Hand this to anyone setting up a monitor |
| Screen test card | `ADDRESS/s/testcard` | Full-screen it on a TV, projector or LED wall before you trust it. Chapter 5 |
| Side screen | `ADDRESS/s/side` | Venue TVs, full screen; easiest through Pick a screen. In OBS, a full picture to cut to |
| When do we play? | `ADDRESS/s/next` | Parents, on their own phones |
| Trivia play | `ADDRESS/s/quiz` | The crowd's phones |
| Shout-outs | `ADDRESS/s/gp` | Submit a Gracious Professionalism moment. Moderated at the desk |

---

## Appendix B · The Friday setup list

Print this. Tick it off.

**AV rack**

- [ ] Desk laptop on the field network, plugged into power
- [ ] `CalGamesContentDesk.exe` copied across and run once
- [ ] Address and PIN written on the whiteboard
- [ ] Front page: *Field: connected*, and the **Switcher** line names the ATEM (chapter 9)
- [ ] Switcher's overlay computer on `/s/program`, full screen; the front page's **Screens** line has nothing to fix
- [ ] With that page up, stop the desk (or pull its cable) for 5 seconds: the input shows Cheesy Arena's score on black, then the desk's graphics again once it is back

**OBS** (skip this group if the event does not stream through OBS)

- [ ] OBS installed
- [ ] Six scenes created, names checked twice (chapter 4, step 2)
- [ ] Program overlay added to `CG_MATCH`, both boxes unticked
- [ ] Overlay pasted *as reference* into `CG_SCORE`, `CG_REPLAY` and `CG_DESK`
- [ ] `CG Replay Clip` Media Source in `CG_REPLAY`, under the Overlay (chapter 4, step 4b)
- [ ] `"obs"` set in `config.json` if anyone will take replays to program (chapter 4, step 7)
- [ ] Stream key entered, test stream run and stopped
- [ ] Recording tested: record thirty seconds and play it back

**Screens**

- [ ] Test card checked on every display: corners visible, circle round, clock ticking
- [ ] Program full screen on the projector (`/s/watch`, **Program**, F11): the CalGames backdrop or the match, never a white page
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
The **Start here** box and the Doors check say so while it is running. To go
back to normal before doors, **end the desk in Task Manager first** (Ctrl+Shift+
Esc, **CalGames 2026 Content Desk**, End task), then double-click the exe: a
double-click while it is still in practice mode pops a warning box saying so
and how to end it, then reopens the practice desk.

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
| **Browser Source** | An OBS source that shows a web page. How the graphics get into OBS, at an event that uses it |
| **Full screen** | F11 in Chrome or Edge. How every venue display shows its screen without OBS |
| **Scene** | One arrangement of pictures in OBS. You switch between them |
| **Overlay** | The graphics on top of the camera picture: score bar, clock, names |
| **Lower third** | The name strip along the bottom |
| **Program** | What the audience is seeing right now |
| **Cut** | Switch instantly from one scene to another |
| **On deck** | The match after the one being played |
| **Surrogate** | A team playing an extra match that does not count for their record |
| **Luma key** | A way hardware switchers lay graphics over video, using black as transparent |
| **Switcher** | The video switcher (on this kit, an ATEM) that cuts the cameras and keys the graphics over them |
| **Doors** | When the audience is let in. The deadline the pre-show check exists for |

---

*This guide is part of the CalGames Content Desk, which is open source under the
Apache 2.0 licence. Corrections are welcome and genuinely useful: if something
here was wrong or confusing while you were standing in a gym trying to make it
work, that is a bug in this document.*
