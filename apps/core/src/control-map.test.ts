import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_ACTIONS, controlGroups } from './control-map.ts';
import type { DeskEventType } from './types.ts';

test('every action has what a button needs and nothing it does not', () => {
  for (const a of CONTROL_ACTIONS) {
    assert.ok(a.id, 'an action with no id cannot be bound to a key');
    assert.ok(a.label.length <= 12,
      `"${a.label}" will not fit a Stream Deck key (72px), use fewer characters`);
    assert.ok(a.does, `${a.id} has no description for the setup page`);
    assert.match(a.path, /^\/api\//, `${a.id} points somewhere that is not an API route`);
  }
});

test('ids are unique, because a physical button is keyed on one', () => {
  const ids = CONTROL_ACTIONS.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length,
    'two actions share an id, so one button would run the wrong thing');
});

test('every emit action names a real event type', () => {
  // The compiler cannot check the string inside a body literal, so this does.
  // A typo here is a button that silently 422s at the event.
  const known: DeskEventType[] = [
    'match.preview', 'match.armed', 'match.start', 'match.end',
    'match.score_posted', 'match.aborted', 'screen.change', 'replay.marker',
  ];
  for (const a of CONTROL_ACTIONS.filter(x => x.path === '/api/emit')) {
    const type = a.emits?.type;
    assert.ok(type, `${a.id} posts to /api/emit with no type`);
    assert.ok(known.includes(type as DeskEventType),
      `${a.id} emits "${type}", which is not in the button allowlist`);
  }
});

test('groups are derived, so a new action cannot be orphaned', () => {
  const groups = controlGroups();
  for (const a of CONTROL_ACTIONS) {
    assert.ok(groups.includes(a.group), `${a.id} is in group "${a.group}", which is not listed`);
  }
  // Match first: it is the row that gets pressed forty times a day.
  assert.equal(groups[0], 'Match');
});

test('the safety message is the one action that needs typing', () => {
  // A fixed-body button that puts words on every screen would be a button that
  // puts the WRONG words on every screen.
  const raise = CONTROL_ACTIONS.find(a => a.id === 'emergency.raise')!;
  assert.equal(raise.needsInput, true);
  // Clearing it, though, must be one press with no typing at all.
  const clear = CONTROL_ACTIONS.find(a => a.id === 'emergency.clear')!;
  assert.ok(!clear.needsInput);
});

test('there is a camera button for every scene the show declares', () => {
  const scenes = CONTROL_ACTIONS.filter(a => a.path === '/api/scene')
    .map(a => (a.body as { scene?: string }).scene);
  for (const expected of ['CG_INTRO', 'CG_MATCH', 'CG_SCORE', 'CG_REPLAY', 'CG_DESK', 'CG_ARCADE']) {
    assert.ok(scenes.includes(expected), `no button cuts to ${expected}`);
  }
});

test('a button carries its own payload, so the caller cannot supply one', () => {
  // The route takes an action ID and emits what the map declares. An earlier
  // version took {type, payload} and allowlisted the type, which looked
  // equivalent: "Post score" is a legitimate button, so match.score_posted was
  // allowlisted, so anything reaching the route could post a fabricated score.
  const post = CONTROL_ACTIONS.find(a => a.id === 'match.score')!;
  assert.equal(post.emits?.type, 'match.score_posted');
  assert.equal(post.emits?.payload, undefined,
    'the score comes from the field, never from a button');

  // Screen buttons DO carry a payload, and it must be baked into the map
  // rather than left for the caller to choose.
  const screen = CONTROL_ACTIONS.find(a => a.id === 'screen.match')!;
  assert.deepEqual(screen.emits?.payload, { screen: 'match' });
});

test('the published request is the one the route accepts', () => {
  // The contract, and it was broken: the map published {type} for every emit
  // action while /api/emit accepts only {id}, so a Stream Deck configured
  // exactly as documented 422'd on the match row — the six buttons pressed
  // forty times a day. The route takes an id so a caller cannot choose a
  // payload, which means the id is what the map has to publish.
  for (const a of CONTROL_ACTIONS.filter(x => x.path === '/api/emit')) {
    assert.deepEqual(a.body, { id: a.id },
      `${a.id} publishes a body /api/emit will refuse`);
  }
  // And the reverse: nothing outside /api/emit should be carrying `emits`,
  // which would mean an action whose effect is not what its route does.
  for (const a of CONTROL_ACTIONS.filter(x => x.path !== '/api/emit')) {
    assert.equal(a.emits, undefined, `${a.id} declares an emit it does not make`);
  }
});
