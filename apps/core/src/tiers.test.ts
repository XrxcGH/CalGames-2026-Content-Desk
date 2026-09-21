/**
 * The two tier boundaries that a route, not a person, has to hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsAuth } from './access.ts';
import { DESK_EDITABLE_SECTIONS, EDITABLE_SECTIONS } from './content.ts';

test('the licensed audio library is not served to the venue', () => {
  /*
   * /media/ is open because every audience surface pulls robot cutouts from it
   * with no cookie, and the same mount serves media/audio: the walk-up songs
   * and stingers, which are somebody else's recordings licensed for one event
   * and the one category of file .gitignore says must never be redistributed.
   *
   * The file names are not a secret either. A walk-up is named for the team,
   * because the desk tells volunteers to name it that way, so the index is the
   * match schedule. The trivia QR code puts the desk's address on a projector
   * in front of the whole gym.
   */
  assert.equal(needsAuth({ method: 'GET', path: '/media/audio/walkups/254.mp3' }), true,
    'a phone in the stands cannot read the music library');
  assert.equal(needsAuth({ method: 'GET', path: '/media/audio/stingers/goal.mp3' }), true);

  // And the rest of /media/ stays open, or every audience surface loses its
  // robot cutouts.
  assert.equal(needsAuth({ method: 'GET', path: '/media/teams/254/robot.png' }), false,
    'robot cutouts still load on a page with no cookie');
  assert.equal(needsAuth({ method: 'GET', path: '/theme/tokens.css' }), false);
  assert.equal(needsAuth({ method: 'GET', path: '/shared/nav.js' }), false);
});

test('the settings code cannot rewrite the ceremony', () => {
  /*
   * `awards` has a sanitizer so the Judge Advisor's own edits can persist
   * through the content store, and that made it reachable from POST /api/setup
   * behind the settings gate alone. The settings code ships as 4567 and
   * collapses onto the desk PIN when setup.pin is empty, so in the documented
   * default that is the desk crew holding the power to write the whole
   * ceremony out of data/event-content.json.
   *
   * Nothing would look wrong, either: the live Awards instance keeps its
   * in-memory copy, so the loss surfaces at the next restart, and restarts
   * happen at events.
   */
  assert.ok(EDITABLE_SECTIONS.includes('awards'),
    'the store still sanitizes awards, because the JA persists through it');
  assert.equal(DESK_EDITABLE_SECTIONS.includes('awards'), false,
    'but the settings page cannot write that section');

  // Everything else the settings page is for is still there.
  for (const section of ['event', 'sponsors', 'rundown']) {
    assert.ok(DESK_EDITABLE_SECTIONS.includes(section), `${section} is still editable`);
  }
  assert.equal(DESK_EDITABLE_SECTIONS.length, EDITABLE_SECTIONS.length - 1,
    'exactly one section is held back');
});
