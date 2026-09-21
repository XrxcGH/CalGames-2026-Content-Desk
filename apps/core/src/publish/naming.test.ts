import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcadeLabel, description, identify, isPractice, streamTitle, videoTitle } from './naming.ts';

test('qualification naming matches the official channel', () => {
  for (const input of ['Qualification 1', 'Qual 1', 'Q1', 'qm1', 'qualification #1']) {
    assert.deepEqual(identify(input), { name: 'Qualification 1', key: 'qm1' }, input);
  }
  assert.deepEqual(identify('Qualification 42'), { name: 'Qualification 42', key: 'qm42' });
});

test('playoff matches get the (Rn) suffix and sf keys', () => {
  assert.deepEqual(identify('Match 1 (R1)'), { name: 'Match 1 (R1)', key: 'sf1m1' });
  assert.deepEqual(identify('Playoff 1'), { name: 'Match 1 (R1)', key: 'sf1m1' });
  // The official bracket has five rounds: matches 1-4, 5-8, 9-10, 11-12, 13.
  // Every boundary is pinned because a wrong (Rn) is unfixable once uploaded.
  assert.deepEqual(identify('Match 5'), { name: 'Match 5 (R2)', key: 'sf5m1' });
  assert.deepEqual(identify('Match 7'), { name: 'Match 7 (R2)', key: 'sf7m1' });
  assert.deepEqual(identify('Match 9'), { name: 'Match 9 (R3)', key: 'sf9m1' });
  assert.deepEqual(identify('Match 11'), { name: 'Match 11 (R4)', key: 'sf11m1' });
  assert.deepEqual(identify('Match 12'), { name: 'Match 12 (R4)', key: 'sf12m1' });
  assert.deepEqual(identify('Match 13'), { name: 'Match 13 (R5)', key: 'sf13m1' });
});

test('finals are Final 1 to 3, and the tiebreakers after them are Overtime', () => {
  /*
   * The arena's own finals spec, from newFinalMatches():
   *
   *   Final 1    F1   f1m1   300s
   *   Final 2    F2   f1m2   300s
   *   Final 3    F3   f1m3   300s
   *   Overtime 1 O1   f1m4   600s, hidden until needed
   *   Overtime 2 O2   f1m5   600s, hidden until needed
   *   Overtime 3 O3   f1m6   600s, hidden until needed
   *
   * This file used to retitle Final 3 as "Final Tiebreaker", which disagreed
   * with the arena, the announcer reading off the field monitor, and TBA,
   * whose f1m3 is just the third final. A best-of-three going to a third
   * match is not a tiebreaker; the tiebreakers are the Overtime matches, and
   * those had no branch at all.
   */
  assert.deepEqual(identify('Final 1'), { name: 'Final 1', key: 'f1m1' });
  assert.deepEqual(identify('Finals 2'), { name: 'Final 2', key: 'f1m2' });
  assert.deepEqual(identify('Final 3'), { name: 'Final 3', key: 'f1m3' });
  assert.deepEqual(identify('Final Two'), { name: 'Final 2', key: 'f1m2' });
  // Still understood, because scorekeepers and older tools say it. It means
  // the third final.
  assert.deepEqual(identify('Final Tiebreaker'), { name: 'Final 3', key: 'f1m3' });
});

test('an overtime final gets a TBA key instead of being filed as practice', () => {
  /*
   * "Overtime 1" matched nothing, so identify() returned a null key, and the
   * queue's keyless branch assumed keyless meant practice: the item was
   * marked done with a log line reading "has no TBA match key (practice)".
   * The finals going to overtime is the one match everybody looks for
   * afterwards, and it would have uploaded unlinked, been flipped public
   * without ever being linked, and sent whoever investigated the wrong way.
   */
  assert.deepEqual(identify('Overtime 1'), { name: 'Overtime 1', key: 'f1m4' });
  assert.deepEqual(identify('Overtime 2'), { name: 'Overtime 2', key: 'f1m5' });
  assert.deepEqual(identify('Overtime 3'), { name: 'Overtime 3', key: 'f1m6' });
  assert.deepEqual(identify('O1'), { name: 'Overtime 1', key: 'f1m4' });
  assert.equal(videoTitle(identify('Overtime 1').name, 'CalGames'), 'Overtime 1 - CalGames');
});

test('round numbers follow the bracket that is actually being played', () => {
  /*
   * Cheesy builds two double-elimination brackets and they number their
   * rounds differently. Taken from the nameDetail strings the arena attaches
   * to each match:
   *
   *   8 alliances:  M1-4 R1, M5-8 R2, M9-10 R3, M11-12 R4, M13 R5
   *   4 alliances:  M1-2 R1, M3-4 R2, M5 R3
   *
   * The eight-alliance table was applied to both, so in a four-alliance
   * bracket M3 was titled R1 where the arena calls it Round 2 Upper, and M5
   * was titled R2 against Round 3 Lower. CalGames is an offseason and a
   * four-alliance bracket is a real possibility. A wrong title is not
   * fixable once it is on an uploaded video.
   */
  assert.equal(identify('Match 3').name, 'Match 3 (R1)', 'eight is the default');
  assert.equal(identify('Match 3', 8).name, 'Match 3 (R1)');
  assert.equal(identify('Match 3', 4).name, 'Match 3 (R2)');
  assert.equal(identify('Match 5', 4).name, 'Match 5 (R3)');
  assert.equal(identify('Match 13', 8).name, 'Match 13 (R5)');
  // The key does not move with the bracket size: sf{n}m1 either way.
  assert.equal(identify('Match 5', 4).key, 'sf5m1');
});

test('practice matches title normally but carry no TBA key', () => {
  // TBA has no keys for practice matches: the null key tells the queue to
  // skip the TBA link, not to refuse the video.
  assert.deepEqual(identify('Practice 3'), { name: 'Practice 3', key: null });
  assert.equal(videoTitle(identify('Practice 3').name, 'CalGames'), 'Practice 3 - CalGames');
});

test('FMS short names: P3 is a practice, never a playoff with a real TBA key', () => {
  // "P3" used to match the playoff regex's bare `p` alias, titling a
  // scrimmage "Match 3 (R1)" and linking its video to the real key sf3m1.
  assert.deepEqual(identify('P3'), { name: 'Practice 3', key: null });
  assert.deepEqual(identify('p 3'), { name: 'Practice 3', key: null });
  assert.equal(isPractice('P3'), true);
  // The playoff short form is M-numbered, and still resolves.
  assert.deepEqual(identify('M5'), { name: 'Match 5 (R2)', key: 'sf5m1' });
});

test('titles carry the year exactly once, however the config spells the event', () => {
  assert.equal(videoTitle('Qualification 1', 'CalGames', 2026),
    'Qualification 1 - 2026 CalGames');
  // The obvious config (name already carrying the year) must not double it.
  assert.equal(videoTitle('Qualification 1', '2026 CalGames', 2026),
    'Qualification 1 - 2026 CalGames');
  assert.equal(streamTitle(2026, '2026 CalGames', 2), '2026 CalGames - Day 2');
  assert.equal(streamTitle(2026, 'CalGames', 1), '2026 CalGames - Day 1');
});

test('arcade set labels read like a bracket, with the game in parentheses', () => {
  assert.equal(arcadeLabel('Winners Semifinal', 'smash'), 'Arcade Winners Semifinal (Smash)');
  assert.equal(arcadeLabel('Grand Final', 'mariokart'), 'Arcade Grand Final (Mario Kart)');
  assert.equal(arcadeLabel('Party 2', 'pacman'), 'Arcade Party 2 (Pac-Man)');
  // 'other' is whatever a team brings on Saturday: no name to print, so the
  // round stands alone rather than showing "(other)" on a video title.
  assert.equal(arcadeLabel('Showmatch', 'other'), 'Arcade Showmatch');
  assert.equal(arcadeLabel('  ', 'smash'), 'Arcade Set (Smash)');
});

test('titles carry the event suffix', () => {
  assert.equal(videoTitle('Qualification 1', 'CalGames'), 'Qualification 1 - CalGames');
  assert.equal(videoTitle('Final Tiebreaker', 'CalGames'), 'Final Tiebreaker - CalGames');
  assert.equal(streamTitle(2026, 'CalGames', 1), '2026 CalGames - Day 1');
});

test('description matches the official layout', () => {
  const out = description({
    title: 'Final Tiebreaker - CalGames',
    red: { teams: [6238, 1323, 254], score: 552 },
    blue: { teams: [6665, 1678, 9470], score: 527 },
    resultsUrl: 'https://frc-events.firstinspires.org/2026/cacg',
    credit: 'Uploaded by the CalGames Content Desk',
    copyright: '(c) 2026 Western Region Robotics Forum',
  });

  assert.equal(out, [
    'Final Tiebreaker - CalGames',
    'Red (Teams 6238, 1323, 254) - 552',
    'Blue (Teams 6665, 1678, 9470) - 527',
    'https://frc-events.firstinspires.org/2026/cacg',
    '',
    'Uploaded by the CalGames Content Desk',
    '(c) 2026 Western Region Robotics Forum',
  ].join('\n'));
});
