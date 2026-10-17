# CalGames Content Desk: quick start

**One page: only what a person has to do.** The desk finds the field and the video switcher by itself, and its front page says what it found and what to do next. RUN-THE-DESK.pdf is reference: nobody needs to read it to run the show.

## Five steps

1. **Plug in the desk laptop:** power, and a network cable into the field network (the network switch Cheesy Arena and the video switcher are on). Copy `CalGamesContentDesk.exe` onto it.
   **You should see** the laptop charging, and a cable on the taskbar's network icon. There is nothing to install.
2. **Double-click the exe, and allow the firewall.** Nothing appears for up to a minute the first time. A blue *Windows protected your PC* box is normal: **More info**, **Run anyway**. When Windows asks about its firewall (it names Node.js), tick every network type and press **Allow access**.
   **You should see** your browser open by itself on *The desk is running. Pick what this computer is for.* Its top lines say what it found: *Field: connected* once Cheesy Arena is up (*searching* until then, which needs nothing from you), and **Switcher** names the ATEM. Write the **Start here** box's address (*This desk on the event network*) and **Desk PIN** on the whiteboard.
3. **Put the graphics into the video switcher.** On the computer that feeds the switcher's overlay input (the one that showed Cheesy Arena's score overlay), open the address the front page gives under that button: the whiteboard address with `s/program` on the end. Put it on the screen that goes to the switcher, press **F11**, and leave the switcher's key as it was.
   **You should see** black, with the desk's graphics once a match loads: the key drops the black out. If the desk stops, Cheesy's comes back on that input by itself, as long as that computer is on the field network. On the desk laptop, reload the front page: **Screens** names that computer, and anything to fix there.
4. **Put the show on each TV and the projector.** On the computer plugged into each display, open the whiteboard address with `s/watch` on the end, click the card for that display and press **F11**: **Program** (*For the projector, or the stream*), **Side screen** (*For the TVs beside the field*), **When do we play?** (*For pit TVs*), **Trivia** or **Arcade**.
   **You should see** on the projector the purple backdrop with one line saying what it is waiting for, until a match takes over by itself; on the TVs, who plays next and the rankings, turning by themselves.
5. **Change the codes before doors.** On the desk laptop, click **Change the codes** in **Start here**. Event settings opens with the settings code, `4567` until it is changed. Under **Access codes**, change the desk PIN, the settings code and the awards code (shipped as `1357`; give the new one to the Judge Advisor only).
   **You should see** no *Still on the shipped default* line in **Start here** when you reload it. Write the new PIN on the whiteboard. Then open **This laptop runs the show**: its **Doors check** lists anything still wrong, each with what to do.

**On match day it runs by itself:** the graphics follow the field. The desk console opens in **Simple**, only what a match day needs: **Auto** puts a stuck main screen back on the show, **Blank** empties it. The announcer opens **Announcer tablet**; the Judge Advisor opens **Judge Advisor**. **Using OBS?** It is not needed; the front page's **If you use OBS** note has it.

## If you see this

| You see | Where the desk explains it |
| --- | --- |
| **A white page, or black with nothing** | Black is right on the switcher's computer until a match loads. White: the **Screens** line on the desk laptop's front page names that computer and the address to open instead |
| An amber line on the front page | That line says what is wrong and what to do. More, a line or two each: **Something not working?**, lower on the same page |
| A TV cannot open the address | Front page, **Something not working?**: usually the firewall box from step 2 was missed |
| Words on the projector, not the show | They say what it is waiting for. *Connected to the field. Waiting for it to load a match*: the Test Match does not count, so ask the scorekeeper for a real one |
| The field goes down | The desk console shows **Field down? Run matches by hand** by itself: **Load a match by hand**, then the keys 1 to 5 |
| Screens stop updating, or *reconnecting* | The desk stopped. Double-click the exe again: the day comes back as it was, and every screen reconnects by itself |
