# CalGames 2026 Content Desk: run the desk

### The short guide for volunteers

**Setting up?** Start with QUICK-START.pdf (one page). This guide is the next
step: which computer does what, what each screen says, and what to do when
something looks wrong. The desk itself says most of this on its front page and
in its **Doors check**, in plain words, at the moment it matters. The long
reference is docs/handbook-reference.md; nobody needs it to run the show.

---

## 1 · The AV table: which computer does what

Several Windows computers sit side by side at the AV table. **Only one of them
runs the Content Desk.** Every other computer either shows a desk page or runs
something the desk only reads. If you are not sure which computer is in front
of you, open the desk address in its browser: the first line of the front page
says either **This computer runs the Content Desk.** or **This computer does
not run the Content Desk.**, with the desk's address.

| Computer or screen | What runs on it | How you can tell | Leave it alone? |
| --- | --- | --- | --- |
| **The desk laptop** (CalGames) | `CalGamesContentDesk.exe`, the Content Desk itself, and its desk console in the browser | Front page: *This computer runs the Content Desk.* | Keep it on, plugged in, lid open, on the field network. Closing the browser does not stop the show; never end the desk in Task Manager during a match |
| **The graphics computer** (its HDMI goes through a Teranex into the switcher's overlay input) | A browser, full screen, on `ADDRESS/s/program` | Black, with the desk's score graphics once a match loads; Cheesy Arena's own score on black if the desk stops | Leave it full screen. It is the overlay on the stream and the LED wall |
| **The switcher computer** (rack PC) | ATEM Software Control: cameras, transitions, and the key that lays the graphics over the cameras | The ATEM control window | The AV crew's. The desk only reads the switcher and cannot change it |
| **The multiview monitor** | The ATEM's own picture of every input | A grid of camera pictures | Nothing to do |
| **The mixer computer** | X Air Edit: microphones, music and the stream's sound | The X Air Edit window | The AV crew's. Keep the music channel out of the mix that feeds the stream |
| **The field computer** | Cheesy Arena, the scoring system | Match play screens | The scorekeeper's and the FTA's. The desk only reads it |
| **The music machine** (the laptop wired to the hall's speakers) | A browser on `ADDRESS/s/house` | The House audio player page | Leave it open; it plays the walk-ups and clips the desk fires |
| **Projector or LED wall, venue TVs, pit TVs** | A browser, full screen, on a **Pick a screen** card | The picture itself | Nothing to do; they reconnect by themselves |
| **Announcer tablet, Judge Advisor's device** | **Announcer tablet** and **Judge Advisor** from the front page | Their own pages | Theirs |

The stream itself comes out of the switcher's program output through the Web
Presenter; no computer runs it. **Put a strip of tape on each monitor** with
its row name from this table. It takes two minutes and saves every question
later.

**Where the desk address is.** On the desk laptop's front page, in **Start
here**: *This desk on the event network*, for example `http://10.0.100.23:8720/`.
Write it on the whiteboard with the **Desk PIN** shown under it. Every other
computer types that address.

---

## 2 · Setting up, in order

Each step ends with what you should see. The desk finds the field and the
switcher by itself; nothing needs a file edited or a flag typed.

1. **Desk laptop.** Power, and a network cable into the field network (the
   switch Cheesy Arena and the ATEM are on). Copy `CalGamesContentDesk.exe`
   onto it and double-click it. Nothing appears for up to a minute the first
   time. A blue *Windows protected your PC* box is normal: **More info**,
   **Run anyway**. When Windows asks about its firewall, tick every network
   type and press **Allow access**.
   *You should see* the browser open on the front page, whose first line says
   **This computer runs the Content Desk.**
2. **Whiteboard.** Write the address and the **Desk PIN** from **Start here**.
3. **Codes.** In **Start here**, click **Change the codes**. **Event settings**
   opens with the settings code. Under **Access codes**, change the desk PIN,
   the settings code and the awards code; give the awards code to the Judge
   Advisor only. A change signs out everyone using the old code.
   *You should see* no *Still on the shipped default* line in **Start here**.
4. **Graphics into the switcher.** On the graphics computer, open the address
   and click **Put the graphics into the video switcher**, put the window on
   the screen that goes to the switcher, and press **F11**. The switcher's key
   stays exactly as it was set up for Cheesy Arena's overlay: same input, same
   luma key on DSK 1. Key only this one input.
   *You should see* black, and the desk's graphics once a match loads. On the
   desk laptop's front page, **Screens** names that computer.
5. **Projector, LED wall and TVs.** On each computer that feeds a display,
   open the address, click **Put the show on a projector or TV**, click the
   card for that display (table below) and press **F11**.
6. **Field and switcher.** Nothing to do. The front page says *Field:
   searching* until the field answers, then *Field: connected*; **Switcher**
   names the ATEM once it is found. If either stays searching once the
   hardware is up, see chapter 6.
7. **Music.** On the music machine, open `ADDRESS/s/house` and press **Turn
   this machine on as the house player**.
8. **Doors check.** On the desk laptop, open **This laptop runs the show**
   (the desk console) and read **Doors check**. Every row that is not green
   says what to do.
9. **Posters, and a look at every screen.** In **Start here**, **print the QR
   posters** for the doors, the stands and the pits. Before any real match,
   *Fill the screens with sample data* (the link in **Start here**) puts
   invented teams on every screen so you can check each display; all of it
   says SAMPLE and it clears itself when a real match loads.

**Pick a screen** shows these cards, in this order:

| For | Screen | Address | What it shows |
| --- | --- | --- | --- |
| The projector, or the stream | **Program** | `/s/watch?screen=program` | The main show picture: who is playing, the live score, the final score |
| The TVs beside the field | **Side screen** | `/s/watch?screen=side` | Who is on deck and the current rankings, rotating |
| Pit TVs | **When do we play?** | `/s/watch?screen=next` | When each team plays next, with start times that follow the field |
| The trivia monitor | **Trivia** | `/s/watch?screen=trivia` | The crowd game, with its join code between questions |
| The arcade TV | **Arcade** | `/s/watch?screen=arcade` | Scores from the side tournament |

---

## 3 · What the screens look like, and why

**Black or white?** `ADDRESS/s/program` opened by itself in a browser is graphics on black:
right for the switcher's luma key, which drops the black out. The projector
and TVs go through **Pick a screen**, which adds the purple CalGames backdrop.
A page that is see-through (inside OBS, or with `?key=alpha` in its address)
is painted white by a plain browser; the **Screens** line on the desk laptop's
front page names any computer showing that and the address to open instead.

**Cheesy's overlay as a backup.** The graphics computer's page keeps Cheesy
Arena's own score display loaded behind the desk's graphics. If the desk stops
answering for about 3 seconds, or loses the field for 10 seconds while Cheesy
still has it, that same input shows Cheesy's score instead, by itself, and
goes back to the desk's graphics once both are answering again. Nobody
presses anything, and the page never reloads while the desk is away.

**Scores.** Every number on air is solid white. When the field cannot send
the score and the desk manager types it, the final screen says **Leading** (or
**Level**) under the alliance instead of **Winner**, so a guess is never called
the result. The announcer's tablet still says when a score is a guess.

**RP chips** in the score bar and on the final screen: a ranking point earned
is a white chip in the alliance colour; one not yet earned is white on a dark
plate.

**What the projector says** before a match loads, under CALGAMES 2026:

| The line, word for word | What to do |
| --- | --- |
| *Connecting to the desk at http://ADDRESS.* | Wait a few seconds |
| *No field connection. Matches can be run from the desk console.* | The desk is not connected to the field yet. It finds the field by itself; meanwhile **Load a match by hand** works |
| *Connected to the field. Waiting for it to load a match (its Test Match does not count).* | Ask the scorekeeper to load a practice, qualification or playoff match |
| In yellow: *Cannot reach the desk at http://ADDRESS. Check that the desk computer is on and the Content Desk is running.* | The desk laptop is off or asleep, or this computer is on another network. It heals by itself |
| A second line, in yellow: *No picture from the field feed at HOST: check that the camera is on and its address is right. Until then the graphics show on this backdrop.* | Only with a field feed set on Event settings. Fix the camera or its address |
| The backdrop with no words | Somebody pressed **Blank**: press **Auto** |

The score bar fills the bottom of the frame with its numbers centered. A TV
that crops the edges of the picture (most LED walls and the stream do not)
can open the program with `?safe=1` on the address to keep the text clear of
the edge.

---

## 4 · Match day on the desk console

Open **This laptop runs the show** on the desk laptop and enter the PIN. The
console opens in **Simple**, only what a match day needs; **Everything** shows
every panel. With no OBS, the camera controls fold behind **Using OBS? Show
the camera controls**. Every key works in both views.

**The field drives the show.** When a match loads, the program shows the
alliance overview; the score bar comes in when the field arms; the clock and
scores run live; the final score appears when the score posts and stays until
the field's own audience screen moves on (about 20 seconds, never more than a
minute). Leave it alone.

| You want to | Use |
| --- | --- |
| Put a stuck main screen back on the show | **Main screen (program)**: **Auto** |
| Empty the main screen | **Blank** (`B`) |
| Explain a pause | **Delay card**: **Field delay** and the others; **Hide card** takes it down |
| Tell the whole building something urgent | **Safety message**: **Put on every screen** |
| Run an awards ceremony | **Awards ceremony**: **Show the award**, then **Reveal the winner** when the announcer says the name |
| Mark a replay moment | `Space` |
| Show a name strip | Lower third: `T` shows it, `Y` hides it |

**If the field goes down**, the console shows **Field down? Run matches by
hand** by itself: **Load a match by hand**, then the match steps, which
are Preview, Arm, Start, End, Post score, Abort (the keys 1 to 5, and 0
for Abort). Typed scores look the same on air; the final screen says
**Leading**, not **Winner**. Hand scoring keys: `Q W E` for red, `A S D` for
blue.

**Holding a key** does its action once. The console never takes a key while
you are typing in a box.

---

## 5 · Event settings

`ADDRESS/s/setup`, with the settings code. Changes apply at once unless the
page says otherwise.

- **Access codes**: the desk PIN (only from the desk laptop), the settings
  code and the awards code. The Judge Advisor can also change the awards code
  on their own page.
- **Connections**: **Field address (Cheesy Arena)**, **Video switcher address
  (ATEM)**, the **FRC Nexus API key** (for the queue on the side screens), and
  which switcher input carries the desk's graphics. Press **Save
  connections**. Each box shows what the desk sees right now. Leave the
  addresses empty to let the desk look by itself.
- **Restart the desk** (desk laptop only): the desk stops and starts again in
  a few seconds. Screens reconnect by themselves; consoles ask for the code
  again.
- The event's content: names, sponsors, the run of show, slides.

---

## 6 · When something is wrong

Read the front page first: its status lines and **Something not working?**
answer most things in a line or two, and the desk console's **Doors check**
says what to do for every row that is not green.

| You see | Do this |
| --- | --- |
| A white page | That computer has the see-through page. The **Screens** line on the desk laptop's front page names it and the address to open |
| Black on the graphics computer | Correct until a match loads |
| *Field: searching* that never ends | Check the desk laptop is on the field network (event Wi-Fi is usually a different network). Still searching: ask the FTA for the field's address and type it under **Field address (Cheesy Arena)** |
| **Switcher** says no switcher found | Fine on a setup without one. With the ATEM: type its address (four numbers, for example 10.0.100.40) under **Video switcher address (ATEM)** |
| **Switcher** says the switcher turned the desk down | It has no free connection: close any copy of ATEM Software Control nobody is using |
| Two score bars on the stream | Cheesy's overlay is keyed from its own computer as well. Key only the graphics computer's input |
| A TV cannot open the address | The firewall box from setup was missed, or the TV is on a Wi-Fi that keeps devices apart. Use the address in **Start here**, never `localhost` |
| Screens stop updating, or *reconnecting* | The desk stopped. Double-click the exe on the desk laptop again: the day comes back exactly as it was and every screen reconnects |
| A code does not work | Codes changed on Event settings sign out the old ones. The desk laptop's **Start here** shows the desk PIN |
| **Doors check** row **Event log** is red | The disk is full. Free space; do not restart the desk until it is green |

**The universal fix** is double-clicking the exe on the desk laptop. If the
desk is running it opens the front page; if it stopped, it starts again and
rebuilds the day from its own log: scores, cards, the run of show.

**The desk cannot** start a match, abort a match, change a score, or change
anything on the field or the switcher. It only reads them.

---

## 7 · The other jobs, in one paragraph each

**Announcer.** **Announcer tablet**: who is on the field, ranks, how close each
alliance is to its ranking points, and how to say team names, all in words
that can be read out.

**Judge Advisor.** **Judge Advisor**, with the awards code: enter each award's
winner as judging wraps up. Winners stay off every screen and feed until the
desk presses **Reveal the winner**.

**Trivia.** `ADDRESS/s/triviadesk`: one button whose label says what the next
press does. The crowd joins from the QR code on the trivia screen.

**Music.** The music machine plays the walk-ups and clips the desk fires.
Music never goes to the stream: the music machine is not wired to it, and on
the mixer its channel stays out of the stream's mix.

**Shout-outs.** People in the stands send them from the QR posters; nothing
reaches a screen until someone approves it on the desk console.

---

## Appendix · Every address

| Address | What | Who |
| --- | --- | --- |
| `ADDRESS/` | Front page: what each computer is for, status, help | Everyone |
| `ADDRESS/s/desk` | Desk console | Desk laptop, PIN |
| `ADDRESS/s/program` | Graphics for the switcher, on black | Graphics computer |
| `ADDRESS/s/watch` | **Pick a screen** for projectors and TVs | Display computers |
| `ADDRESS/s/setup` | Event settings | Content lead, settings code |
| `ADDRESS/s/awards` | Awards | Judge Advisor, awards code |
| `ADDRESS/s/talent` | Announcer tablet | Emcees, PIN |
| `ADDRESS/s/house` | House audio player | Music machine |
| `ADDRESS/s/testcard` | Test card for checking a display | Whoever sets up a display |
| `ADDRESS/s/poster` | QR posters to print | Setup crew |
| `ADDRESS/s/next`, `/s/quiz`, `/s/gp` | When do we play, trivia, shout-outs | Phones in the stands |
