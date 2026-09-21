# Trademarks and brand assets

Short version: **the code is yours to fork and change. The branding is not.**

This project is deliberately not white-labelled. It ships as the CalGames
content desk, with WRRF's palette, wordmarks and voice baked in, because
pretending to be a neutral product would have cost real design quality and
nobody asked for a neutral product. The Apache 2.0 licence in
[LICENSE](LICENSE) covers the code and, per its section 6, expressly does not
grant trademark rights. This file says what that means in practice, so you can
fork with confidence instead of guessing.

## You may

- Fork the repository, run it at your own event, and change anything in it.
- Keep the code under Apache 2.0, or combine it with your own work under any
  terms that licence permits.
- Say your event's system is **based on**, **built on**, or **a fork of** the
  CalGames Content Desk. Accurate description of origin is not infringement,
  and we would rather you said so.
- Keep our comments, our docs, and our reasoning. That is the useful part.

## Please do not

- Ship your event's system **called** "CalGames Content Desk", or use the
  CalGames or WRRF wordmarks or logos as the identity of your fork. Rename it.
  Your event has a name; use it.
- Imply that WRRF endorses, supports, or is responsible for your fork.
- Use the WRRF palette as *your* brand. Using purple and gold because you
  forked this and have not re-themed yet is fine and expected; presenting them
  as your organisation's identity is not.

## What is actually restricted, file by file

| Thing | Status |
| --- | --- |
| Everything under `apps/`, `surfaces/`, `packages/`, `tools/` | Apache 2.0. Fork away, with the one carve-out below |
| `surfaces/_shared/icons.js` | Ours except the Lucide path data it vendors, which is ISC (the Feather-derived icons MIT). Keep the notices in [NOTICE](NOTICE) with any copy |
| `docs/` | Apache 2.0, same as the code |
| The names "CalGames", "WRRF", "Western Region Robotics Forum" | WRRF's marks. Not licensed here |
| WRRF and CalGames logos, if any are added to this repo later | WRRF's. Not licensed here |
| The palette in `packages/theme/tokens.css` | The hex values are facts and not protectable; using them *as your brand identity* is the part to avoid |

## FIRST's marks

"FIRST", "FRC", "FIRST Robotics Competition" and the FIRST logos belong to
FIRST. This project is not affiliated with, endorsed by, or sponsored by
FIRST. It refers to them descriptively, which is what nominative fair use is
for. If you distribute a fork, keep it descriptive: do not name your project
in a way that suggests it is an official FIRST product.

Alliance red `#ED1C24` and blue `#0066B3` appear in this codebase because they
are the colours the audience already reads as "red alliance" and "blue
alliance". They are used semantically and never decoratively, which is a design
rule documented in [docs/03-brand.md](docs/03-brand.md) and worth keeping in a
fork for the same reason: an audience that has learned a colour code all
weekend should not have it broken by a graphic.

## Third-party services

Running this against Cheesy Arena, The Blue Alliance, FIRST Nexus, Statbotics,
start.gg, YouTube or Spotify means agreeing to each of their terms yourself.
Some of them constrain what an event may do; [docs/06](docs/06-hardware-and-network.md)
records the one that came up for us and how CalGames answered it. Your event
may answer differently, and the code is arranged so that it can.

## If you are not sure

Ask. Open an issue, or contact WRRF. Nobody here is looking for a reason to
object to a robotics event running better software.
