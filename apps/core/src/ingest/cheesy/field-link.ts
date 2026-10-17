/**
 * FieldLink: the one place that knows whether the desk has a field bridge.
 *
 * The bridge used to be decided once, at boot, by a launch flag: index.ts
 * built a CheesyAdapter if --cheesy was given and handed it to the server and
 * vitals as a fixed value. That was right while the only way to find the
 * field was the launcher's scan, and wrong as soon as the field could turn up
 * later: the AV kit gets set up in whatever order the crew gets to it, so the
 * desk is often running before the field network is plugged in, and the
 * launcher's one look at startup found nothing. The desk then ran in manual
 * mode all day with nothing on screen saying why.
 *
 * So the adapter is held here, and everything that asks "is there a bridge"
 * reads field.adapter at the moment it asks. The finder (finder.ts) attaches
 * one when it finds the field; a desk started with the field already found
 * attaches at once, exactly as before.
 *
 * Deliberately small. It holds no timers and opens no sockets, so nothing
 * here can fail at a bad moment: building and starting the adapter stays in
 * index.ts, where it always was.
 */

import { EventEmitter } from 'node:events';
import type { CheesyAdapter } from './adapter.ts';

export class FieldLink extends EventEmitter<{ change: [] }> {
  #adapter: CheesyAdapter | null = null;
  #host: string | null = null;
  #searching = false;

  /** The bridge, once there is one. Null in manual mode and while searching. */
  get adapter(): CheesyAdapter | null { return this.#adapter; }
  /** The field's host:port, once attached. Null until then. */
  get host(): string | null { return this.#host; }
  /** True while the desk is looking for the field by itself. */
  get searching(): boolean { return this.#searching; }

  /**
   * The field, found. Once per process: a second adapter on the same bus
   * would put every field event on air twice, so a second call is ignored and
   * the first bridge stays. A different field address takes effect at the
   * next start, which is what the settings page tells the operator.
   */
  attach(adapter: CheesyAdapter, host: string): void {
    if (this.#adapter) return;
    this.#adapter = adapter;
    this.#host = host;
    this.#searching = false;
    this.#emitChange();
  }

  setSearching(on: boolean): void {
    // Searching ends for good when the field is found: the finder stops then,
    // and a late call from a sweep that was already in flight must not make
    // the vitals row say it is still looking.
    const next = on && !this.#adapter;
    if (next === this.#searching) return;
    this.#searching = next;
    this.#emitChange();
  }

  /**
   * A listener that throws must not take the caller down with it: attach()
   * runs inside the finder's sweep, and the finder runs inside the show.
   */
  #emitChange(): void {
    try { this.emit('change'); } catch (err) {
      console.warn('[cheesy] a listener for field changes failed:', (err as Error).message);
    }
  }
}
