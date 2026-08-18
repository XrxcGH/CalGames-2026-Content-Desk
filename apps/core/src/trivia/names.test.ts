import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus.ts';
import { TriviaStore } from './store.ts';
import { normalizeName, screenName } from './names.ts';

test('ordinary names are left alone', () => {
  // The expensive failure mode is not letting something through, it is
  // rejecting real people and teaching the room the game is broken.
  for (const name of [
    'Ana', 'Priya R', '846 Ben', "O'Brien", 'Jose-Luis', 'xX_Dan_Xx',
    'Cass', 'Scunthorpe', 'Dickinson', 'Hancock', 'Shitake Mushroom Fan',
  ]) {
    const v = screenName(name);
    assert.equal(v.ok, true, `${name} should be allowed: ${v.reason ?? ''}`);
  }
});

test('the obvious ones are refused', () => {
  for (const name of ['fuck', 'FUCK', 'a fucking name', 'bitch']) {
    assert.equal(screenName(name).ok, false, `${name} should be refused`);
  }
});

test('leet and padding do not get around it, which is the whole technique', () => {
  for (const name of ['sh1t', 'b!tch', 'f.u.c.k', 'fuuuuck', 'F U C K', 'SH!T']) {
    assert.equal(screenName(name).ok, false, `${name} should be refused`);
  }
});

test('the refusal never quotes the word back', () => {
  // Printing it in an error message on a shared phone is the same problem one
  // step removed.
  const v = screenName('fuck');
  assert.equal(v.ok, false);
  assert.doesNotMatch(v.reason ?? '', /fuck/i);
});

test('impersonating event staff is refused too', () => {
  assert.equal(screenName('Head Ref').ok, false);
  assert.equal(screenName('admin').ok, false);
  assert.equal(screenName('Adminah').ok, true, 'only the whole word, not a prefix');
});

test('a name of pure punctuation is refused rather than rendering blank', () => {
  assert.equal(screenName('...').ok, false);
  assert.equal(screenName('   ').ok, false);
});

test('the documented limit: a vowel swap gets through', () => {
  // "f0ck" folds to "fock", and closing that needs vowel-equivalence rules
  // that would start rejecting real names. Pinned so the trade is a decision
  // somebody made rather than a gap somebody missed. The host can kick it.
  assert.equal(screenName('f0ck').ok, true);
});

test('normalization folds lookalikes and runs', () => {
  assert.equal(normalizeName('F.U.C.K'), 'fuck');
  assert.equal(normalizeName('a55hole'), 'asshole');
  assert.equal(normalizeName('fuuuuuck'), 'fuuck', 'runs collapse to two, not one');
  assert.equal(screenName('fuuuuuck').ok, false, 'but the squashed form is still checked');
});

test('a refused name never costs a real player their slot', () => {
  // Screening runs with the other validation, BEFORE eviction: a phone posting
  // names it knows will be refused must not be able to empty a full room.
  const store = new TriviaStore(new EventBus(), []);
  const ana = store.join('Ana').playerId;
  for (let i = 0; i < 20; i++) {
    assert.throws(() => store.join('fuck'), /different name/i);
  }
  assert.equal(store.snapshot().players, 1);
  assert.ok(store.playView(ana).me, 'the real player is still here');
});

test('the host can take a name off the big screen in one action', () => {
  // The filter is a doorstop, not a guarantee, so removal has to be possible
  // while the thing is up there.
  const store = new TriviaStore(new EventBus(), []);
  store.join('Ana', 846);
  store.join('Something Rude');
  assert.equal(store.snapshot().players, 2);

  assert.deepEqual(store.kick('something rude'), { removed: 1 },
    'matched case-insensitively, because the host is reading a screen');
  assert.equal(store.snapshot().players, 1);
  assert.deepEqual(store.snapshot().standings.map(r => r.name), ['Ana']);

  assert.deepEqual(store.kick('nobody'), { removed: 0 });
  assert.throws(() => store.kick('  '), /Name the player/);
});

test('digit-separated slurs do not walk past the folder', () => {
  // '6' was the one common leet substitution missing from the fold table, and
  // it is the highest-traffic one for exactly the category this file says it
  // is strict about. Unfolded it read as a separator, so "ni66a" screened as
  // the two harmless words "ni" and "a".
  for (const name of ['ni66a', 'ni66er', 'fa66ot']) {
    assert.equal(screenName(name).ok, false, `${name} reached the projector`);
  }
});

test('folding cannot destroy a match either', () => {
  // The mirror of the above, and it bit the other way: "fuck1" folds its
  // trailing digit to a letter, giving "fucki" — no stem plus any real suffix
  // — so it passed while bare "fuck" was refused. The raw letter-split is
  // screened alongside the folded one.
  for (const name of ['fuck1', 'shit1', 'bitch1', 'fuck3']) {
    assert.equal(screenName(name).ok, false, `${name} reached the projector`);
  }
});

test('spelling it out does not work, with or without decoration', () => {
  // The whole-name join only ever compared the ENTIRE name, so one extra word
  // defeated it.
  for (const name of ['F U C K', 'f.u.c.k', 'F U C K yeah', 'xX F U C K Xx']) {
    assert.equal(screenName(name).ok, false, `${name} reached the projector`);
  }
});

test('a real name plus an initial is not a slur', () => {
  // The collapse pass introduced its own Scunthorpe: "Anu S" joins to a banned
  // word. Anu is a common given name, and name-plus-initial is the exact shape
  // the profile book prints for a student, so it turns up here constantly.
  assert.equal(screenName('Anu S').ok, true);
  assert.equal(screenName('J R Smith').ok, true);
  assert.equal(screenName('Mia K').ok, true);
});

test('the reserved list survives punctuation and leetspeak', () => {
  // It compared the raw lowercased string, so "admin" was refused while
  // "Admin.", "@dmin" and "4dmin" impersonated staff on the leaderboard.
  for (const name of ['Admin.', '@dmin', '4dmin', 'a d m i n']) {
    assert.equal(screenName(name).ok, false, `${name} could pose as staff`);
  }
});

test('the names it was always meant to allow still pass', () => {
  // Guarding the neighbours: every change above widens what gets refused.
  for (const name of ['Dickinson', 'Shitake', 'Scunthorpe', 'Cockburn', 'Hancock',
    'Penistone', 'Essex', 'bookkeeper', 'Matsushita', 'Priya Raman']) {
    assert.equal(screenName(name).ok, true, `${name} is somebody's actual name`);
  }
});

test('a pad letter no longer defeats the spelled-out pass', () => {
  // The join was matched for equality, so "F U C K x" became "fuckx", which
  // is no stem plus any real suffix, and one junk letter walked the whole
  // technique straight past the filter.
  for (const name of ['F U C K x', 'x F U C K x', 'Bob F U C K x',
    'F U C K y e a h', 'a S H I T b']) {
    assert.equal(screenName(name).ok, false, name);
  }
});

test('a lookalike letter cannot split a word in half', () => {
  // Anything the fold table does not know becomes a separator, so ONE pasted
  // Cyrillic or Greek letter turned a banned word into two harmless halves
  // while the projector showed the word intact. Accents did the same.
  assert.equal(screenName('sh\u0456t').ok, false, 'Cyrillic i');
  assert.equal(screenName('f\u00fbck').ok, false, 'circumflex u');
  assert.equal(screenName('n\u0456gger').ok, false, 'Cyrillic i in a slur');

  // A lookalike that folds to a DIFFERENT letter is not an evasion: Cyrillic
  // u renders as a y, so this reads "fyck" on the screen and is left alone.
  assert.equal(screenName('f\u0443ck').ok, true);
});

test('containment is confined to letter runs, where it is safe', () => {
  // Matching banned stems INSIDE a join is what catches the padded spell-out.
  // Letting it touch the ordinary whole-name join is the Scunthorpe problem
  // wearing a hat, and it refused a real mushroom.
  for (const name of ['Shitake Mushroom', 'Scunthorpe Town', 'Anna Lyst',
    'Shi Take', 'Ana Sofia', 'A B Smith', 'Class of 26', 'Xu Wei']) {
    assert.equal(screenName(name).ok, true, `${name} is somebody or something real`);
  }
});
