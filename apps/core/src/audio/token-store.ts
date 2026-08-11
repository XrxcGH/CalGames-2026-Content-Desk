/**
 * Where a rotated Spotify refresh token lives.
 *
 * Spotify may hand back a NEW refresh token on any refresh, and when it does,
 * the old one stops working. The one in config.json is therefore only the
 * cold-start token: if a rotation is kept in memory, the desk works all
 * weekend and then fails to reach Spotify the next time it restarts, which is
 * Sunday morning.
 *
 * So rotations are written next to the event log rather than back into
 * config.json. Two reasons for not editing config.json: it is a file a human
 * owns and comments live in, and a process that rewrites its own credentials
 * file is one bad write away from locking everybody out.
 *
 * The file is gitignored. It is a bearer credential for the music account.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Which config token a stored rotation descends from.
 *
 * A hash, not the token: this file is already a bearer credential for the
 * refresh token it holds, and there is no reason to make it a second one for
 * the token in config.json as well. Truncated because all it has to do is
 * tell two operator-pasted tokens apart.
 */
const seedOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

const FILE = 'spotify-token.json';

const pathFor = (root: string): string => join(root, 'data', FILE);

/**
 * The token to start with: a stored rotation if there is one, otherwise the
 * one from config.json. Never throws; a missing or corrupt file just means the
 * config token is used, which is the correct fallback.
 */
export async function loadRefreshToken(root: string, fromConfig: string): Promise<string> {
  try {
    const saved = JSON.parse(await readFile(pathFor(root), 'utf8')) as
      { refreshToken?: string; seed?: string };
    if (saved.refreshToken) {
      // Unless the operator has pasted a NEW token into config.json, in which
      // case that is them telling us the stored chain is dead — and it is the
      // documented recovery, so it has to actually recover.
      //
      // Refresh tokens do die: revoked, or past the six-month life. The error
      // says "run npm run auth:spotify", the operator does, pastes the result
      // into config.json, restarts — and the old code loaded the dead rotation
      // right back over it and failed identically, forever, with no way out
      // that does not involve knowing this file exists. For a volunteer with
      // no terminal experience that is not a recovery path at all.
      //
      // A stored file with no seed predates this check. It is trusted, because
      // the alternative is throwing away a live rotation on upgrade.
      if (!saved.seed || saved.seed === seedOf(fromConfig)) return saved.refreshToken;
      console.log('[spotify] config.json has a new refresh token, dropping the stored rotation');
      await rm(pathFor(root), { force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[spotify] stored token unreadable, using the one from config:',
        (err as Error).message);
    }
  }
  return fromConfig;
}

/**
 * Persist a rotation. Written to a temp file and renamed, so a crash mid-write
 * cannot leave a half-token that reads as valid JSON with a truncated string.
 */
export async function saveRefreshToken(
  root: string, refreshToken: string, fromConfig: string,
): Promise<void> {
  try {
    const dir = join(root, 'data');
    await mkdir(dir, { recursive: true });
    const file = pathFor(root);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({
      refreshToken, savedAt: Date.now(), seed: seedOf(fromConfig),
    }, null, 2));
    await rename(tmp, file);
    console.log('[spotify] refresh token rotated and saved');
  } catch (err) {
    // The token in memory still works for this session; losing the file costs
    // a re-link later, and is not worth failing a playback command over.
    console.warn('[spotify] could not save the rotated token:', (err as Error).message);
  }
}
