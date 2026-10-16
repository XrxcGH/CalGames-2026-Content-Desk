/**
 * The desk console's keyboard: one press, one action.
 *
 * desk.js is a browser module that needs the whole page, so this lifts its
 * keydown handler out of the source as written and runs it against a stub of
 * the three things it touches (the KEYS table, the connection, the status
 * line). The code under test is the shipped handler, not a copy of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

type KeyEvent = {
  key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
  target: { matches(sel: string): boolean; closest(sel: string): unknown };
  preventDefault(): void;
};

/** The console's own keydown listener, wired to a KEYS table that counts. */
function deskKeys(connected = true) {
  const src = readFileSync(join(HERE, '..', '..', '..', 'surfaces', 'desk', 'desk.js'), 'utf8');
  const from = src.indexOf("addEventListener('keydown', e => {");
  assert.ok(from >= 0, 'desk.js has its keydown listener');
  const to = src.indexOf('\n});', from);
  assert.ok(to > from, 'and it ends');
  const body = src.slice(from, to + '\n});'.length);

  const fired: string[] = [];
  const KEYS: Record<string, () => void> = {};
  for (const k of ['1', '2', '3', '4', '5', '0', 'q', ' ']) KEYS[k] = () => { fired.push(k); };
  const status = { textContent: '' };
  let listener: ((e: KeyEvent) => void) | null = null;
  const addEventListener = (type: string, fn: (e: KeyEvent) => void) => {
    if (type === 'keydown') listener = fn;
  };
  new Function('KEYS', 'desk', '$', 'addEventListener', body)(
    KEYS, { connected }, () => status, addEventListener);
  assert.ok(listener, 'the listener registered');

  let prevented = 0;
  const press = (key: string, repeat = false) => listener!({
    key, repeat, ctrlKey: false, metaKey: false, altKey: false,
    target: { matches: () => false, closest: () => null },
    preventDefault: () => { prevented++; },
  });
  return { press, fired, status, prevented: () => prevented };
}

test('a held number key posts the score once, not thirty times', () => {
  // Chrome auto-repeats a held key at about thirty a second after half a
  // second. Every repeat used to fire: 5 held for a second posted the score
  // thirty times, each one a played match in the run of show.
  const keys = deskKeys();
  keys.press('5');
  for (let i = 0; i < 29; i++) keys.press('5', true);
  assert.deepEqual(keys.fired, ['5']);
  assert.equal(keys.prevented(), 30, 'the repeats are still swallowed, so a held Space cannot scroll');

  // Two real presses are two actions.
  keys.press('0');
  keys.press('0');
  assert.deepEqual(keys.fired, ['5', '0', '0']);
});

test('a repeat while the desk is reconnecting says nothing new and sends nothing', () => {
  const keys = deskKeys(false);
  keys.press('3', true);
  assert.deepEqual(keys.fired, []);
  assert.equal(keys.status.textContent, '', 'only a real press is worth the warning');
  keys.press('3');
  assert.match(keys.status.textContent, /NOT sent/);
  assert.deepEqual(keys.fired, []);
});
