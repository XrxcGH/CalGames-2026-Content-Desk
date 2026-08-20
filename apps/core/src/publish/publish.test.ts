import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../config.ts';
import type { EventBus } from '../bus.ts';
import { SEGMENTS, segmentDescription, segmentName } from './naming.ts';
import { PublishQueue, QC_BOUNDS, matchUnderway, qcHold } from './queue.ts';

test('a known segment id gets the standard name, anything else stands as written', () => {
  assert.equal(segmentName('selection'), SEGMENTS.selection);
  assert.equal(segmentName('awards'), 'Awards Ceremony');
  assert.equal(segmentName("  FIRST Impact Award  "), "FIRST Impact Award");
});

test('a segment description carries no alliances and no score', () => {
  const text = segmentDescription({
    title: 'Alliance Selection - CalGames',
    note: 'Alliance 1: 254, 846, 1678',
    resultsUrl: 'https://example.org/results',
    credit: 'Uploaded by the CalGames Content Desk',
    copyright: '(c) 2026 Western Region Robotics Forum',
  });

  assert.equal(text.split('\n')[0], 'Alliance Selection - CalGames');
  assert.ok(text.includes('Alliance 1: 254, 846, 1678'));
  assert.ok(!/\bRed \(Teams/.test(text));
  assert.ok(!/\bBlue \(Teams/.test(text));
});

test('QC bounds differ by kind, so a ceremony is not held for being long', () => {
  // The failure this exists to catch: a truncated match video.
  assert.ok(qcHold('match', 11), 'an 11 second match cut must be held');
  assert.ok(qcHold('match', 1800), 'a 30 minute match cut must be held');
  assert.equal(qcHold('match', 210), null, 'a normal match passes');

  // A 40 minute awards ceremony is exactly right, and the match bounds
  // would have held every single one of them.
  assert.equal(qcHold('segment', 40 * 60), null);
  assert.ok(qcHold('segment', 5), 'a five second ceremony is still wrong');
  assert.ok(qcHold('segment', 3 * 3600), 'three hours means the operator forgot to stop');
});

test('every publish kind has bounds, so no kind can skip the check', () => {
  for (const [kind, bounds] of Object.entries(QC_BOUNDS)) {
    assert.ok(bounds.minSec > 0, `${kind} has no lower bound`);
    assert.ok(bounds.maxSec > bounds.minSec, `${kind} bounds are inverted`);
  }
});

test('the hold reason tells the operator what to do about it', () => {
  const reason = qcHold('match', 11)!;
  assert.match(reason, /11s/);
  assert.match(reason, /60-900s/);
  assert.match(reason, /release/i);
});

/**
 * A bus whose state describes a just-scored practice match. The times are
 * compressed so the cut falls under the QC floor and the item enters the
 * queue held: a held item never kicks the worker, so these tests leave no
 * backoff timers running behind them.
 */
const practiceBus = (): EventBus => {
  const startedAt = 1_000_000;
  return {
    emit: () => {},
    state: {
      // The buzzer already sounded: match.end cleared matchStartedAt and
      // only lastMatchStartedAt survives for the cut.
      matchStartedAt: null,
      lastMatchStartedAt: startedAt,
      matchEndedAt: startedAt + 2_000,
      scorePostedAt: startedAt + 3_000,
      match: { id: 'p3', displayName: 'Practice 3', red: [], blue: [] },
      score: { red: { total: 12 }, blue: { total: 9 } },
    },
  } as unknown as EventBus;
};

test('the automatic path respects autoQueuePractice; a manual queue always works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.publish.autoQueuePractice = false;

  try {
    const q = new PublishQueue(root, cfg, practiceBus(), null);
    await q.load();

    assert.equal(await q.queueMatch(), null,
      'with the gate off, the automatic path must skip a practice match');

    const item = await q.queueMatch({ manual: true });
    assert.ok(item, 'an operator pressing the button always wins over the gate');
    // The year rides in the title: WRRF's channel hosts every season, and
    // "Practice 3 - CalGames" would collide with next October's.
    assert.equal(item.meta.title, 'Practice 3 - 2026 CalGames');
    assert.equal(item.matchKey, null, 'TBA has no keys for practice matches');

    assert.equal(await q.queueMatch({ manual: true }), null,
      'the dedupe still applies to manual queues');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('practice matches auto-queue by default', async () => {
  // The gate ships open: anything that happens at the event should be able
  // to go online without someone remembering a button.
  assert.equal(DEFAULTS.publish.autoQueuePractice, true);
  assert.equal(DEFAULTS.publish.autoQueueArcade, true);

  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  try {
    const q = new PublishQueue(root, structuredClone(DEFAULTS), practiceBus(), null);
    await q.load();
    const item = await q.queueMatch();
    assert.equal(item?.label, 'Practice 3');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a keyless match skips TBA entirely; a segment still links as event media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.event.key = '2026cacg';
  cfg.tba = { authId: 'id', authSecret: 'secret', readKey: '' };
  cfg.publish.publicAfterLink = false;        // keep YouTube out of this test
  const bus = { emit: () => {} } as unknown as EventBus;

  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(new URL(String(url)).pathname);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const q = new PublishQueue(root, cfg, bus, null);
    await q.load();
    // Added held so the worker stays out until both are staged as uploaded,
    // which is exactly what a restart after a crash mid-publish would find.
    const practice = await q.add({
      kind: 'match', label: 'Practice 3', sourceId: 'program',
      ranges: [{ fromMs: 0, toMs: 1 }], matchKey: null,
      meta: { title: 'Practice 3 - CalGames', description: '' },
    }, 'QC hold: test');
    const segment = await q.add({
      kind: 'segment', label: 'Awards Ceremony', sourceId: 'program',
      ranges: [{ fromMs: 0, toMs: 1 }], matchKey: null,
      meta: { title: 'Awards Ceremony - CalGames', description: '' },
    }, 'QC hold: test');
    for (const item of [practice, segment]) {
      item.state = 'uploaded';
      item.videoId = `yt-${item.kind}`;
    }
    q.kick();
    await new Promise(r => setTimeout(r, 600));

    assert.equal(practice.state, 'done', 'the missing TBA link must not strand the item');
    assert.equal(segment.state, 'done');
    // Exactly one TBA request: the segment's media/add. A keyless match must
    // not fall through to media/add, which would file a scrimmage alongside
    // the ceremonies.
    assert.deepEqual(calls, ['/api/trusted/v1/event/2026cacg/media/add']);
  } finally {
    globalThis.fetch = orig;
    await rm(root, { recursive: true, force: true });
  }
});

test('release lifts deferred holds but leaves QC holds for per-item review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  // enabled=false keeps the worker inert, so nothing touches the network.
  const cfg = structuredClone(DEFAULTS);
  cfg.publish.enabled = false;
  cfg.publish.mode = 'deferred';
  const bus = { emit: () => {} } as unknown as EventBus;

  try {
    const q = new PublishQueue(root, cfg, bus, null);
    await q.load();
    const qc = await q.add({
      kind: 'segment', label: 'Awards Ceremony', sourceId: 'program',
      ranges: [{ fromMs: 0, toMs: 120_000 }], matchKey: null,
      meta: { title: 'Awards Ceremony - CalGames', description: '' },
    }, 'QC hold: test');
    // A flagged item must enter the queue already held. Holding it a moment
    // after adding left a window where a running worker picked it up.
    assert.equal(qc.state, 'held');
    qc.clipPath = join(root, 'clip.mp4');

    // The routine end-of-day release must NOT publish a QC-held cut: the hold
    // means a human has to eyeball the clip, and bulk release is exactly the
    // moment nobody is reviewing anything.
    assert.equal(await q.release(), 0);
    assert.equal(qc.state, 'held', 'QC hold survives the bulk release');

    // retry(id) is the per-item go-ahead once someone has looked at it, and it
    // must carry the durable released flag or the deferred-mode cut branch
    // re-parks the item on the spot.
    await q.retry(qc.id);
    assert.equal(qc.state, 'cut');
    assert.equal(qc.released, true);

    // Let the kicked worker settle before reading the file back, so the
    // restart below sees whatever it last persisted.
    await new Promise(r => setTimeout(r, 400));

    // Restart. The go-ahead must come back from disk, or an overnight crash
    // would silently re-park everything the operator already released.
    const q2 = new PublishQueue(root, cfg, bus, null);
    await q2.load();
    assert.equal(q2.items[0]?.released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release lifts a plain deferred hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.publish.enabled = false;
  cfg.publish.mode = 'deferred';
  const bus = { emit: () => {} } as unknown as EventBus;

  try {
    const q = new PublishQueue(root, cfg, bus, null);
    await q.load();
    const item = await q.add({
      kind: 'segment', label: 'Alliance Selection', sourceId: 'program',
      ranges: [{ fromMs: 0, toMs: 600_000 }], matchKey: null,
      meta: { title: 'Alliance Selection - CalGames', description: '' },
    });
    // Park it the way the worker's deferred-mode cut branch does: held with
    // no QC reason.
    item.state = 'held';
    item.error = null;
    item.clipPath = join(root, 'clip.mp4');

    assert.equal(await q.release(), 1);
    assert.equal(item.state, 'cut');
    assert.equal(item.released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a match with a video on the channel is never queued twice', async () => {
  // An item that uploaded fine and then exhausted its TBA-link retries (a
  // two-minute outage does it) sits in `failed` holding a live videoId. Score
  // corrections re-emit match.score_posted, as does pressing Post score twice,
  // and the dedupe excluded `failed`, so the queue re-cut and re-uploaded,
  // putting a second copy of the match on the channel. retry(id) is the path
  // for that item, and it reuses the video it already has.
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  try {
    const cfg = structuredClone(DEFAULTS);
    const bus = {
      emit: () => {},
      state: {
        matchStartedAt: null,
        lastMatchStartedAt: 1000, matchEndedAt: 160_000, scorePostedAt: 190_000,
        match: { displayName: 'Qualification 12', red: [], blue: [] },
        score: { red: { total: 96 }, blue: { total: 88 } },
      },
    } as unknown as EventBus;

    const q = new PublishQueue(root, cfg, bus, null);
    await q.load();
    const first = await q.queueMatch();
    assert.ok(first, 'queued once');

    // It uploads, then the TBA link gives up.
    first!.state = 'failed';
    first!.videoId = 'abc123';

    assert.equal(await q.queueMatch(), null, 'not a second video on the channel');

    // A failure with NO video is still re-queueable: that is what excluding
    // `failed` was for, and it must keep working.
    first!.videoId = null;
    assert.ok(await q.queueMatch(), 'a cut that never uploaded can be retried');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a score posted mid-match queues nothing, so the real video is never blocked', async () => {
  // Qualification 43 is live and someone fat-fingers Post score 100 seconds
  // in. The state then reads scorePostedAt=now with the clock still running,
  // and queueMatch used to cut [start-8s .. now+15s]: a video that ends
  // mid-match, passes the 60s QC floor, and whose queue entry then made the
  // label dedupe refuse the REAL video when the score finally posted. There
  // is no queue-item delete, so that block was permanent.
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  try {
    const startedAt = 1_000_000;
    const state = {
      matchStartedAt: startedAt as number | null,  // the clock is RUNNING
      lastMatchStartedAt: startedAt,
      matchLoadedAt: startedAt - 60_000,
      matchEndedAt: null as number | null,
      scorePostedAt: startedAt + 100_000,        // the fat-fingered post
      match: { displayName: 'Qualification 43', red: [], blue: [] },
      score: { red: { total: 0 }, blue: { total: 0 } },
    };
    const bus = { emit: () => {}, state } as unknown as EventBus;
    const q = new PublishQueue(root, structuredClone(DEFAULTS), bus, null);
    await q.load();

    assert.equal(await q.queueMatch(), null, 'the automatic path must refuse mid-match');
    assert.equal(await q.queueMatch({ manual: true }), null,
      'manual too: a truncated cut is never what the operator meant');
    assert.equal(q.items.length, 0, 'nothing entered the queue to block the real video');

    // The buzzer sounds and the real score posts. The times are compressed so
    // the cut lands under the QC floor and enters held, leaving no worker
    // timers behind (same trick as practiceBus).
    state.matchStartedAt = null;
    state.matchEndedAt = startedAt + 2_000;
    state.scorePostedAt = startedAt + 3_000;
    const item = await q.queueMatch();
    assert.equal(item?.label, 'Qualification 43', 'the real video still queues');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the trickle gate fails closed when a restart wiped match liveness', () => {
  // The trickle worker gates on matchUnderway. A bare matchStartedAt check
  // was blind right after a mid-teleop restart: the reducer reboots empty,
  // the adapter's reconnect replay re-emits match.loaded, but match.start
  // only fires on the auto transition, so matchStartedAt stays null for the
  // rest of that match and a parked multi-GB backlog upload started against
  // the live stream 250ms after boot.

  // A running match, as the reducer normally sees one.
  assert.equal(matchUnderway({
    matchStartedAt: 5, matchLoadedAt: 1, matchEndedAt: null, scorePostedAt: null,
  }), true);

  // The restart gap: loaded, never started, never ended, never scored. This
  // is the state the old gate read as an all-clear.
  assert.equal(matchUnderway({
    matchStartedAt: null, matchLoadedAt: 10, matchEndedAt: null, scorePostedAt: null,
  }), true, 'a loaded match with no end and no score must count as live');

  // The buzzer or the score reveal reopens uploads: that gap between matches
  // is exactly the window trickle exists to use.
  assert.equal(matchUnderway({
    matchStartedAt: null, matchLoadedAt: 10, matchEndedAt: 20, scorePostedAt: null,
  }), false);
  assert.equal(matchUnderway({
    matchStartedAt: null, matchLoadedAt: 10, matchEndedAt: 20, scorePostedAt: 30,
  }), false);

  // A truly idle desk (fresh boot, nothing ever loaded) may upload.
  assert.equal(matchUnderway({
    matchStartedAt: null, matchLoadedAt: null, matchEndedAt: null, scorePostedAt: null,
  }), false);
});

test('a re-sent segment request returns the queued item instead of a second copy', async () => {
  // The desk's POST for a ceremony times out in the browser while the server
  // actually processed it; the button re-enables and the operator presses
  // Queue again. queueSegment had no dedupe, so both requests uploaded and
  // the channel carried the ceremony twice.
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  try {
    const bus = { emit: () => {} } as unknown as EventBus;
    const q = new PublishQueue(root, structuredClone(DEFAULTS), bus, null);
    await q.load();

    // Five seconds is under the segment QC floor, so every item here enters
    // held and never kicks the worker (same trick as practiceBus).
    const first = await q.queueSegment({ segment: 'awards', fromMs: 1_000_000, toMs: 1_005_000 });
    assert.equal(first.state, 'held');

    // The venue-wifi retry: an identical request.
    const retried = await q.queueSegment({ segment: 'awards', fromMs: 1_000_000, toMs: 1_005_000 });
    assert.equal(retried.id, first.id, 'the retry gets back the item already queued');
    assert.equal(q.items.length, 1);

    // Two consoles marking the same ceremony land on overlapping, not
    // identical, ranges. Still the same footage, still one item.
    const second = await q.queueSegment({ segment: 'awards', fromMs: 1_002_000, toMs: 1_006_000 });
    assert.equal(second.id, first.id);
    assert.equal(q.items.length, 1);

    // A same-label segment in a different window is a legitimate repeat: the
    // day 2 ceremony must still queue.
    const day2 = await q.queueSegment({ segment: 'awards', fromMs: 2_000_000, toMs: 2_005_000 });
    assert.notEqual(day2.id, first.id);
    assert.equal(q.items.length, 2);

    // A failure with no video on the channel may be marked again, mirroring
    // the match dedupe's one exception.
    first.state = 'failed';
    const requeued = await q.queueSegment({ segment: 'awards', fromMs: 1_000_000, toMs: 1_005_000 });
    assert.notEqual(requeued.id, first.id, 'a cut that never uploaded can be marked again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
