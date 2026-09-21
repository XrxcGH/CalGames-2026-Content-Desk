# Contributing

This runs a real event with volunteers who did not write it, on a day that
cannot be rescheduled. That single fact decides most of what follows.

## The short version

- Node 22.6+. `npm install`, `npm test`, `npm start -- --demo`. No build step.
- `npm run typecheck` and `npm test` must pass before you open a PR.
- Explain **why** in the code, not what. See [Comments](#comments) below.
- If you are changing something that goes on air, look at it on a screen.

## Running it

```bash
npm install
npm start -- --demo
```

Then open <http://localhost:8720>. `--demo` runs a simulated match loop, so
every surface can be worked on with no field, no cameras, and no accounts. If
something can only be developed against real hardware, that is usually a design
problem worth fixing rather than a setup instruction worth writing.

`npm run dev` is the same entry point under `node --watch`, which restarts the
desk on every save; it takes the same flags, so `npm run dev -- --demo` is the
watching version of the two lines above. Good for surface work, less good when
you are watching a long match loop, because the restart takes the match with
it.

```bash
npm test              # 420 tests, a couple of minutes, no network
npm run typecheck     # types
```

Every run of the desk writes an event log to `data/events/`, named for the
moment it started. Replaying one drives every graphic from real recorded
input, at whatever speed you ask for:

```bash
npm run replay -- data/events/2026-09-20-14-31-07.ndjson 4
```

Use a filename that is actually in your own `data/events/`. The logs are
gitignored and no sample one is committed, so a fresh clone has none: the
fastest way to get one is to run `npm start -- --demo` for a couple of
minutes and replay what it wrote.

## What good looks like here

**Degrade, never fail.** Every integration is optional and every one of them
will be down at some point on the day. A dead Spotify must leave the walk-up
clips working; a dead OBS must still switch the graphics; a dead field bridge
must leave a desk an operator can drive by hand. If your change introduces a
new dependency, decide what happens when it is missing before you write it.

**The show outranks the code.** A half-correct graphic on air is worse than a
missing one, an operator being unable to take over is worse than automation
being wrong, and anything that could interfere with the field is worse than
everything. See [docs/10-field-bridge.md](docs/10-field-bridge.md); the
allowlist there is enforced by a test that is supposed to fail loudly.

**Volunteers are the users.** Twenty minutes of training on Friday night, in a
loud room, holding a radio. If a feature needs a manual, it needs a redesign.

**Say why it is wrong to do the obvious thing.** Most of the surprising code
here is surprising because the obvious version broke something on a real
Saturday, and the comment is what stops the next person restoring the bug.

## Comments

Comment density in this repo is high and deliberate. The rule is:

- Explain the **reason**, the **constraint**, or the **failure that caused
  this**, not the mechanics. `// increment i` is noise; `// by id, not index,
  because the host reorders questions mid-show` is the whole point.
- If you fixed a bug, the comment records what broke, not that it was fixed.
- If you chose between two reasonable approaches, name the loser and why.
- Do not narrate the diff. Nobody reading this file in a year cares that it
  "now" does something.

## Tests

`node:test`, no framework. Tests live next to what they test
(`store.ts` / `store.test.ts`). Write the test that would have caught the bug,
and name it as a sentence about behaviour: `a stale clip-ended report cannot
cancel the walk-up that replaced it`, not `test clipEnded 2`.

Anything touching the field-bridge allowlist, the trivia answer contract, or
the publish queue's QC holds needs a test. Those three have all been broken by
a change that looked safe.

## Pull requests

- One thing per PR. "And while I was in there" is how a graphics fix takes down
  the publish queue.
- Say what you looked at. For a surface change, a screenshot at 1920x1080 is
  worth more than a paragraph.
- Breaking the `DeskEvent` contract in `apps/core/src/types.ts` is a bigger
  deal than it looks: recorded event logs replay through it, so a rename
  silently breaks every archive. Add fields, bump `schemaVersion`, migrate.

## Security

Do not open a public issue for anything involving credentials, the field
bridge, or the PIN. See [SECURITY.md](SECURITY.md).

## Forking it for your own event

Encouraged, and the reason this is Apache 2.0. Read
[TRADEMARKS.md](TRADEMARKS.md) first: the code is yours to change, the CalGames
and WRRF names are not. Rename your fork and you are done.

Start with `config.json` (copy `config.example.json`), then
`packages/theme/tokens.css` for the palette, then
`apps/core/src/ingest/` if your event runs a different field system. If you get
a different field system working, please send it back: the adapter seam exists
precisely so that nobody has to fork the whole desk to change one of them.
