/**
 * Display-name screening for crowd trivia.
 *
 * Anyone in the gym can type a name and it goes on a projector in front of a
 * room full of children, their parents, and the school that lent us the
 * building. Somebody will try it. This is the cheapest possible insurance
 * against the one that lands during the awards ceremony.
 *
 * Three decisions worth stating, because each has an obvious wrong answer:
 *
 * 1. REJECT, do not silently clean. A name quietly replaced with "Player 12"
 *    reads to the person who typed it as a bug, and they type it again. Told
 *    "pick another name", they pick another name.
 * 2. Fold lookalikes before matching, because "a55hole" is the entire
 *    technique. Leet substitutions and repeated letters collapse first.
 * 3. Match WHOLE WORDS, in two passes, because one pass cannot do both jobs.
 *    Collapsing separators is what catches "F U C K" and "f.u.c.k"; it also
 *    destroys the word boundaries that keep "Shitake" and "Dickinson" out of
 *    trouble. So there are two forms: a spaced form matched word by word, and
 *    a fully collapsed form matched only against the WHOLE name. The
 *    Scunthorpe problem is real, and a filter that rejects somebody's actual
 *    surname teaches the room the game is broken, which costs more than a
 *    "damn" on a leaderboard.
 *
 * This is not exhaustive and cannot be. Vowel-swapping ("f0ck" folds to
 * "fock") gets through, and closing that needs vowel-equivalence rules that
 * would start rejecting real names. It is a doorstop sized for the actual
 * threat, which is a bored teenager rather than a determined one, and the host
 * console can remove anything that gets past it.
 */

/** Leet and lookalike folding, applied before any comparison. */
const FOLD: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g', '+': 't',
  // Cyrillic and Greek letters that are pixel-identical to Latin ones in the
  // projector font. Anything foldWords does not recognise becomes a separator,
  // so ONE pasted lookalike split a banned word into two harmless halves while
  // the screen showed the word intact. These are the set that actually
  // collide; the rest of those alphabets look like themselves.
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h',
  '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03bf': 'o', '\u03c1': 'p',
  '\u03c5': 'u', '\u03c7': 'x', '\u0261': 'g', '\u0131': 'i', '\u0454': 'e',
};

/**
 * Words that may not appear whole. Kept short and obvious on purpose: every
 * addition is a chance to reject somebody's actual name, and the host can
 * always remove what gets through. Slurs are the category worth being strict
 * about; mild profanity is worth being relaxed about.
 */
const BANNED_STEMS = [
  'fuck', 'shit', 'cunt', 'bitch', 'dick', 'cock', 'penis', 'vagina',
  'nigger', 'nigga', 'faggot', 'retard', 'rape', 'nazi', 'hitler',
  'whore', 'slut', 'anus', 'asshole', 'bastard', 'wank', 'twat',
];

/** Impersonating the event's own voice is its own problem. */
const RESERVED = ['admin', 'moderator', 'referee', 'head ref', 'fta', 'announcer', 'calgames', 'wrrf'];

/**
 * Endings that still leave the word the word. "fucking" and "bitches" are the
 * same problem as their stems; "shitake" and "dickinson" are not, which is
 * exactly why this is a short list of real suffixes and not a prefix test.
 */
const SUFFIXES = ['', 's', 'es', 'ed', 'ing', 'er', 'ers', 'y', 'ie', 'ies', 'ish', 'head', 'face', 'hole'];

/**
 * Fold lookalikes and collapse runs, keeping anything that is not a letter as
 * a separator. This is the form that still has words in it.
 */
function foldWords(raw: string): string[] {
  // NFKD splits an accented letter into a plain one plus a combining mark,
  // and the mark is dropped here. Without it an accent read as a separator.
  const bare = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const folded = [...bare.toLowerCase()].map(c => FOLD[c] ?? c).join('');
  return folded
    .split(/[^a-z]+/)
    .filter(Boolean)
    // Runs collapse to two, not one: "fuuuuck" and "fuuck" are the same word,
    // and squashing to one would turn "bookkeeper" into something else.
    .map(w => w.replace(/(.)\1{2,}/g, '$1$1'));
}

/**
 * The same folding with separators removed, so "F U C K" and "f.u.c.k" both
 * land on one word. Only ever compared against a whole banned word: used for
 * substring matching it would flag every innocent name containing one.
 */
export function normalizeName(raw: string): string {
  return foldWords(raw).join('');
}

/**
 * Checked at both collapse depths. Runs normally collapse to two so that
 * ordinary doubled letters survive, but "fuuuuck" lands on "fuuck", so the
 * fully-squashed variant is tested as well. Squashing can only ADD matches:
 * it is compared against the banned list and nothing else, so the cost is a
 * real name that squashes exactly onto a banned word, and there is not one.
 */
const isBannedWord = (word: string): boolean => {
  const squashed = word.replace(/(.)\1+/g, '$1');
  return [word, squashed].some(form =>
    BANNED_STEMS.some(stem => SUFFIXES.some(suf => form === stem + suf)));
};

/**
 * A coarse screen for arbitrary text: a shout-out message, a typed slide line.
 *
 * Word-level only (pass one of screenName, over both the raw and the folded
 * split), because the whole-name collapse pass is meaningless on a sentence.
 * This is NOT a moderation gate and must never be treated as one: it exists to
 * spare the human moderator the worst of the queue, and the human is the gate.
 */
export function screenText(raw: string): boolean {
  const rawWords = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return ![...foldWords(raw), ...rawWords].some(isBannedWord);
}

export interface NameVerdict {
  ok: boolean;
  /** Shown to the person who typed it. Never names the matched word. */
  reason?: string;
}

/**
 * Is this name allowed on the big screen?
 *
 * The reason deliberately never quotes the offending word back: printing it in
 * an error message on a shared phone is the same problem one step removed, and
 * "pick another name" is all the information anybody needs.
 */
export function screenName(raw: string): NameVerdict {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'A name is required.' };

  const flat = trimmed.toLowerCase();
  // Checked on the FOLDED form as well as the raw one. "Admin.", "admin_",
  // "@dmin" and "4dmin" all sailed past a raw equality test and impersonated
  // staff on the leaderboard while plain "admin" was refused.
  const reservedForms = [flat, normalizeName(trimmed)];
  if (RESERVED.some(r => reservedForms.some(f => f === r || f.startsWith(`${r} `)))) {
    return { ok: false, reason: 'That name is reserved for event staff. Pick another one.' };
  }

  const words = foldWords(trimmed);
  if (!words.length) {
    // All punctuation or emoji. It renders as a blank row on the leaderboard,
    // which reads as a rendering fault rather than somebody's choice.
    return { ok: false, reason: 'Use some letters in your name.' };
  }

  // Pass one: any single word that IS a banned word, with or without an
  // ordinary ending. Word by word, so a stem buried inside a longer real word
  // is left alone.
  //
  // Run over the raw letter-split as well as the folded split, because folding
  // can DESTROY a match as easily as it creates one: "fuck1" folds its trailing
  // digit to a letter, giving "fucki", which is no stem plus any real suffix,
  // so it passed, while bare "fuck" was refused. Unfolded, the digit is a
  // separator and the word is plainly there.
  const rawWords = trimmed.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if ([...words, ...rawWords].some(isBannedWord)) {
    return { ok: false, reason: 'Pick a different name for the big screen.' };
  }

  // Pass two: the spacing taken back out, for the "F U C K" technique.
  //
  // Only ever an exact match against a whole banned word (substring matching
  // on this form is what would reject Scunthorpe), and only on the joins that
  // are themselves evidence of somebody spelling something out. A blanket
  // whole-name join is both too weak and too strong: it missed "F U C K yeah"
  // (one extra word defeats it) while refusing "Anu S", which is a real given
  // name plus a real initial.
  const singles = words.every(w => w.length === 1);
  // Two kinds of join, judged differently.
  //
  // runJoins come from letters that were separated on purpose, which is the
  // technique itself, so they are matched by CONTAINMENT: one pad letter used
  // to defeat the whole pass, because "F U C K x" joins to "fuckx", which is
  // no stem plus any real suffix.
  //
  // nameJoins are ordinary words pushed together, so they are matched by
  // EQUALITY. Containment here is the Scunthorpe problem wearing a hat: it
  // refuses "Shitake Mushroom".
  const runJoins: string[] = [];
  const nameJoins: string[] = [];
  if (singles) {
    // Every letter separated: that IS the technique, whatever it spells.
    runJoins.push(words.join(''));
  } else {
    // A run of three or more single letters inside a longer name. Three is the
    // floor that leaves initials alone: "Anu S" is a run of one and "J R
    // Smith" a run of two, while nobody's actual name contains three
    // consecutive initials that spell a slur.
    let run: string[] = [];
    for (const w of [...words, '']) {
      if (w.length === 1) { run.push(w); continue; }
      if (run.length >= 3) runJoins.push(run.join(''));
      run = [];
    }
    // And the plain whole-name join, unless the name ends in an initial:
    // the "Anu S" shape, which is also how the profile book prints a
    // student, so it turns up on this leaderboard constantly.
    if (words.length > 1 && words[words.length - 1]!.length > 1) {
      nameJoins.push(words.join(''));
    }
  }
  const spelledOut = runJoins.some(j => BANNED_STEMS.some(stem => j.includes(stem)));
  if (spelledOut || runJoins.some(isBannedWord) || nameJoins.some(isBannedWord)) {
    return { ok: false, reason: 'Pick a different name for the big screen.' };
  }

  return { ok: true };
}
