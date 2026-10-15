/**
 * The desk's address on the venue network, resolved live instead of once.
 *
 * It used to be worked out a single time at boot and baked into /api/urls
 * (every QR code on the projectors, the side screens and the poster page) and
 * into the trivia join link. The laptop's address is not a constant of the
 * event: it gets a new lease when it roams between access points, it changes
 * when somebody swaps the cable for wifi, and on Saturday morning the desk is
 * often started BEFORE the laptop is plugged in. In every one of those cases
 * the boot-time answer stayed on every QR for the rest of the day, pointing
 * the whole gym at an address that no longer reached the desk, and nothing on
 * any screen looked wrong.
 *
 * So the answer is asked for per request and cached briefly. The probe
 * (os.networkInterfaces) is a system call, and a handful of screens loading at
 * once should not each pay for one, but half a minute is the longest a wrong
 * address is allowed to survive.
 *
 * Kept free of `os` and of the clock on purpose: the probe and the time are
 * injected, so the cache and the refresh rules are testable without a network
 * adapter to unplug.
 */

export interface LanBase {
  /**
   * The base URL a phone can reach right now, e.g. "http://172.22.0.23:8720",
   * or null when this machine has no address worth handing out. Cached.
   */
  get(): string | null;
  /** Probe again now, ignoring the cache. Returns what get() would. */
  refresh(): string | null;
}

export interface LanBaseOpts {
  port: number;
  /** The bare IPv4 address, or null when there is none. May throw. */
  probe: () => string | null;
  /** How long a found address is trusted. Default 30 seconds. */
  ttlMs?: number;
  /**
   * How long "no address" is trusted. Much shorter, because the person looking
   * at the warning is plugging the cable in right now and should not be told
   * to wait half a minute for a reload to notice. Default 3 seconds.
   */
  missTtlMs?: number;
  /** A monotonic clock in ms. The default is not wall time: a laptop that has
   *  just joined the network is exactly the machine whose clock steps. */
  now?: () => number;
  /**
   * Called whenever the answer changes, including the first time it is known
   * (`previous` is then undefined). A throw here is logged and swallowed: a
   * bad listener must never turn a QR code request into an error.
   */
  onChange?: (base: string | null, previous: string | null | undefined) => void;
}

export function createLanBase(opts: LanBaseOpts): LanBase {
  const { port, probe, onChange } = opts;
  const ttlMs = opts.ttlMs ?? 30_000;
  const missTtlMs = opts.missTtlMs ?? 3_000;
  const now = opts.now ?? (() => performance.now());

  // undefined means "never asked", which is not the same as null ("asked, and
  // there was nothing"): the first answer must always announce itself.
  let current: string | null | undefined;
  let checkedAt = 0;

  function resolve(): string | null {
    checkedAt = now();
    let address: string | null;
    try {
      address = probe();
    } catch {
      // os.networkInterfaces() can throw while an adapter is mid-change. The
      // last answer is a better guess than "no network", which would blank
      // the posters over a transient hiccup. Either way it is retried after
      // the usual wait (checkedAt is already stamped) rather than on every
      // request, and a first-ever failure counts as "nothing yet" so that a
      // later success announces itself.
      if (current === undefined) current = null;
      return current;
    }
    const next = address ? `http://${address}:${port}` : null;
    if (next !== current) {
      const previous = current;
      current = next;
      if (onChange) {
        try { onChange(next, previous); }
        catch (err) { console.warn('[lan] change listener failed:', (err as Error).message); }
      }
    }
    return next;
  }

  return {
    get(): string | null {
      if (current === undefined) return resolve();
      const fresh = now() - checkedAt < (current === null ? missTtlMs : ttlMs);
      return fresh ? current : resolve();
    },
    refresh: resolve,
  };
}
