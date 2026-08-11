/**
 * The control map: every action the desk can be driven by, as data.
 *
 * This exists so a physical button can run the show. At the floor of the crew
 * range the desk manager is also cutting cameras (docs/06), and a Stream Deck
 * under their hand is worth more than a browser tab they have to find.
 *
 * It is deliberately DATA rather than a Bitfocus Companion module. A module is
 * a package built against Companion's SDK, released on their schedule, that
 * has to be installed and kept in step with this repo; publishing one is real
 * work and is post-event work. What every version of Companion can already do
 * today, with no module at all, is send an HTTP request from a button. So the
 * desk publishes exactly what those requests are, one entry per action, and a
 * generated page turns that into something somebody can set up in ten minutes.
 *
 * Being data has a second payoff worth more than the module would be: this is
 * the same list a conformance test, an adopting event's own hardware, or a
 * future module would all read, and it cannot drift from the routes because it
 * is checked against them.
 */

export interface ControlAction {
  /** Stable id. Safe to key a physical button on; renaming one is a breaking change. */
  id: string;
  group: string;
  /** What to write on the button. Short: a Stream Deck key is 72 pixels. */
  label: string;
  /** What it does, for the setup page. */
  does: string;
  method: 'POST' | 'GET';
  path: string;
  /**
   * The literal JSON body a client sends. This is a CONTRACT: a button
   * configured from this field must work, and for /api/emit actions it did
   * not — the map published `{type}` while the route accepts only `{id}`, so
   * every match-lifecycle button 422'd on the first press. The route takes an
   * id precisely so a caller cannot choose a payload, which means the id is
   * what the map has to publish.
   */
  body?: Record<string, unknown>;
  /**
   * What the desk emits when this action runs. NOT part of the request: the
   * caller cannot influence it, which is the whole point. Published so a
   * reader (and the test below) can see what a button does.
   */
  emits?: { type: string; payload?: Record<string, unknown> };
  /** True when the action needs a value typed in rather than a fixed body. */
  needsInput?: boolean;
}

/**
 * Every action, grouped the way somebody laying out a button page thinks.
 *
 * Order matters: this is the order the generated page prints, and it is the
 * order a page gets built in. Match lifecycle first, because that is the row
 * of buttons that gets pressed forty times a day.
 */
export const CONTROL_ACTIONS: ControlAction[] = [
  // ---- the match, the row pressed most ----
  { id: 'match.preview', group: 'Match', label: 'Preview', does: 'Alliance overview on the program.',
    method: 'POST', path: '/api/emit', body: { id: 'match.preview' },
    emits: { type: 'match.preview' } },
  { id: 'match.armed', group: 'Match', label: 'Arm', does: 'Score bar in, before the countdown.',
    method: 'POST', path: '/api/emit', body: { id: 'match.armed' },
    emits: { type: 'match.armed' } },
  { id: 'match.start', group: 'Match', label: 'Start', does: 'Start the match clock.',
    method: 'POST', path: '/api/emit', body: { id: 'match.start' },
    emits: { type: 'match.start' } },
  { id: 'match.end', group: 'Match', label: 'End', does: 'Buzzer.',
    method: 'POST', path: '/api/emit', body: { id: 'match.end' },
    emits: { type: 'match.end' } },
  { id: 'match.score', group: 'Match', label: 'Post score', does: 'Reveal the final score.',
    method: 'POST', path: '/api/emit', body: { id: 'match.score' },
    emits: { type: 'match.score_posted' } },
  { id: 'match.abort', group: 'Match', label: 'Abort', does: 'Stop the clock, hold the screen.',
    method: 'POST', path: '/api/emit', body: { id: 'match.abort' },
    emits: { type: 'match.aborted' } },

  // ---- screens ----
  ...['overview', 'match', 'score', 'analysis', 'arcade', 'selection', 'explain', 'sponsor', 'blank']
    .map((screen): ControlAction => ({
      id: `screen.${screen}`, group: 'Screen', label: screen,
      does: `Take the ${screen} screen.`,
      method: 'POST', path: '/api/emit',
      body: { id: `screen.${screen}` },
      emits: { type: 'screen.change', payload: { screen } },
    })),
  { id: 'screen.auto', group: 'Screen', label: 'Auto',
    does: 'Hand the screen back to the match lifecycle.',
    method: 'POST', path: '/api/emit', body: { id: 'screen.auto' },
    emits: { type: 'screen.change', payload: { screen: 'auto' } } },

  // ---- cameras ----
  ...['CG_INTRO', 'CG_MATCH', 'CG_SCORE', 'CG_REPLAY', 'CG_DESK', 'CG_ARCADE']
    .map((scene): ControlAction => ({
      id: `scene.${scene.toLowerCase()}`, group: 'Camera',
      label: scene.replace('CG_', ''),
      does: `Cut to the ${scene} scene in OBS.`,
      method: 'POST', path: '/api/scene', body: { scene },
    })),

  // ---- house audio ----
  { id: 'audio.play', group: 'Audio', label: 'Music on', does: 'Resume the playlist.',
    method: 'POST', path: '/api/audio/play' },
  { id: 'audio.pause', group: 'Audio', label: 'Music off', does: 'Pause the playlist.',
    method: 'POST', path: '/api/audio/pause' },
  { id: 'audio.duck', group: 'Audio', label: 'Duck', does: 'Drop the music under a voice.',
    method: 'POST', path: '/api/audio/duck', body: { on: true } },
  { id: 'audio.unduck', group: 'Audio', label: 'Unduck', does: 'Bring the music back up.',
    method: 'POST', path: '/api/audio/duck', body: { on: false } },
  { id: 'audio.console', group: 'Audio', label: 'Game audio',
    does: 'Give the room to the console.',
    method: 'POST', path: '/api/audio/source', body: { source: 'console', reason: 'Game audio' } },
  { id: 'audio.next', group: 'Audio', label: 'Skip', does: 'Next track.',
    method: 'POST', path: '/api/audio/next' },

  // ---- replay ----
  { id: 'replay.mark', group: 'Replay', label: 'Mark', does: 'Drop a replay marker at now minus two seconds.',
    method: 'POST', path: '/api/emit', body: { id: 'replay.mark' },
    emits: { type: 'replay.marker', payload: { kind: 'manual' } } },

  // ---- the gaps ----
  { id: 'sponsor.next', group: 'Gaps', label: 'Sponsor', does: 'Next sponsor in the rotation.',
    method: 'POST', path: '/api/sponsors', body: { action: 'next' } },
  { id: 'sponsor.hide', group: 'Gaps', label: 'Sponsor off', does: 'Take the sponsor card down.',
    method: 'POST', path: '/api/sponsors', body: { action: 'hide' } },
  { id: 'trivia.open', group: 'Gaps', label: 'Open Q', does: 'Open the current trivia question.',
    method: 'POST', path: '/api/trivia/open', body: { seconds: 20 } },
  { id: 'trivia.reveal', group: 'Gaps', label: 'Reveal', does: 'Reveal the answer.',
    method: 'POST', path: '/api/trivia/reveal' },
  { id: 'trivia.next', group: 'Gaps', label: 'Next Q', does: 'Move to the next question.',
    method: 'POST', path: '/api/trivia/next' },

  // ---- the day ----
  { id: 'rundown.advance', group: 'Day', label: 'Next segment',
    does: 'Finish the live segment and start the next.',
    method: 'POST', path: '/api/rundown', body: { action: 'advance' } },

  // ---- the ones worth a lid you have to lift ----
  { id: 'emergency.clear', group: 'Safety', label: 'Clear safety',
    does: 'Take the safety message off every screen.',
    method: 'POST', path: '/api/emergency', body: { clear: true } },
  { id: 'emergency.raise', group: 'Safety', label: 'Safety msg',
    does: 'Put a safety message on every screen. Needs the words typed in.',
    method: 'POST', path: '/api/emergency', needsInput: true,
    body: { kind: 'hold', message: '', detail: '' } },
];

/** Groups in printing order, derived so a new action cannot be orphaned. */
export function controlGroups(): string[] {
  const seen: string[] = [];
  for (const a of CONTROL_ACTIONS) if (!seen.includes(a.group)) seen.push(a.group);
  return seen;
}
