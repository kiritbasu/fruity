import { getCache } from '@vercel/functions';

/**
 * Minimal signalling relay so joining a game is "tap a link" rather than
 * "copy an 800-character string, then relay another one back".
 *
 * It holds two short-lived blobs per room — the host's offer and the guest's
 * answer — and nothing else. Once the browsers have swapped those they talk
 * peer-to-peer, so this never sees a frame of gameplay or video.
 *
 * Storage, in preference order:
 *
 *  1. Redis, if KV_REST_API_URL / KV_REST_API_TOKEN exist. Nothing needs this,
 *     but it is picked up automatically if a store is ever added.
 *  2. Vercel's Runtime Cache — no account setup at all. It is a per-region
 *     store, which would normally rule it out for shared state, except that
 *     this project pins functions to a single region (see `regions` in
 *     vercel.json), so both players always reach the same cache. The payload is
 *     ~1 KB and is read within seconds of being written, so LRU eviction is not
 *     a practical concern.
 *  3. Process memory, so `vite dev` works offline. Unreliable in production
 *     because two requests can land on different instances.
 */

const TTL_SECONDS = 900;
const CODE_ATTEMPTS = 8;
/** A compressed SDP is around 1 KB; this is generous but bounds what we store. */
const MAX_BLOB = 16_000;

const KV_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = !!(KV_URL && KV_TOKEN);
const onVercel = !!process.env.VERCEL;

type Backend = 'redis' | 'runtime-cache' | 'memory';
const backend: Backend = hasRedis ? 'redis' : onVercel ? 'runtime-cache' : 'memory';

const memory = new Map<string, { value: string; expires: number }>();

async function redis(command: (string | number)[]): Promise<unknown> {
  const res = await fetch(KV_URL!, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return ((await res.json()) as { result?: unknown }).result;
}

async function get(key: string): Promise<string | null> {
  if (backend === 'redis') {
    const v = await redis(['GET', key]);
    return typeof v === 'string' ? v : null;
  }
  if (backend === 'runtime-cache') {
    const v = await getCache().get(key);
    return typeof v === 'string' ? v : null;
  }
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

async function set(key: string, value: string): Promise<void> {
  if (backend === 'redis') {
    await redis(['SET', key, value, 'EX', TTL_SECONDS]);
    return;
  }
  if (backend === 'runtime-cache') {
    await getCache().set(key, value, { ttl: TTL_SECONDS, tags: ['fruity-rooms'] });
    return;
  }
  memory.set(key, { value, expires: Date.now() + TTL_SECONDS * 1000 });
}

/**
 * Claims a room code. Redis does this atomically; the other backends read then
 * write, which can race — with a million codes and two players the odds are
 * negligible, and the worst case is one of them being told the code expired.
 */
async function claim(key: string, value: string): Promise<boolean> {
  if (backend === 'redis') {
    return (await redis(['SET', key, value, 'EX', TTL_SECONDS, 'NX'])) === 'OK';
  }
  if (await get(key)) return false;
  await set(key, value);
  return true;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * Six digits. Still something an adult can read aloud and a child can tap into a
 * numeric keypad, but a million combinations rather than ten thousand — four
 * digits is small enough to enumerate against an open endpoint in seconds.
 * The invite link carries the code anyway, so nobody normally types it.
 */
const CODE_DIGITS = 6;
const CODE_MAX = 10 ** CODE_DIGITS;
const newCode = () =>
  String(crypto.getRandomValues(new Uint32Array(1))[0] % CODE_MAX).padStart(CODE_DIGITS, '0');
const isCode = (c: string | null): c is string => !!c && /^\d{6}$/.test(c);
const keyFor = (code: string, which: string) => `fruity:room:${code}:${which}`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');

    try {
      // Guest fetches the offer; host polls for the answer.
      if (request.method === 'GET') {
        if (!isCode(code)) return json({ error: 'bad code', backend }, 400);
        const which = url.searchParams.get('want') === 'answer' ? 'answer' : 'offer';
        const value = await get(keyFor(code, which));
        if (which === 'offer' && !value) return json({ error: 'no such game', backend }, 404);
        return json({ [which]: value, backend });
      }

      if (request.method === 'POST') {
        const body = (await request.json()) as { offer?: string; answer?: string };

        // Guest posts its answer into an existing room.
        if (isCode(code)) {
          if (!body.answer) return json({ error: 'missing answer', backend }, 400);
          if (typeof body.answer !== 'string' || body.answer.length > MAX_BLOB) {
            return json({ error: 'answer too large', backend }, 413);
          }
          if (!(await get(keyFor(code, 'offer')))) {
            return json({ error: 'no such game', backend }, 404);
          }
          // One answer per room: without this, anyone who learns the code could
          // overwrite the guest's answer and take over the game.
          if (await get(keyFor(code, 'answer'))) {
            return json({ error: 'that game already has a second player', backend }, 409);
          }
          await set(keyFor(code, 'answer'), body.answer);
          return json({ ok: true, backend });
        }

        // Host creates a room.
        if (!body.offer) return json({ error: 'missing offer', backend }, 400);
        if (typeof body.offer !== 'string' || body.offer.length > MAX_BLOB) {
          return json({ error: 'offer too large', backend }, 413);
        }
        for (let i = 0; i < CODE_ATTEMPTS; i++) {
          const candidate = newCode();
          if (await claim(keyFor(candidate, 'offer'), body.offer)) {
            return json({ code: candidate, ttl: TTL_SECONDS, backend });
          }
        }
        return json({ error: 'could not allocate a code, try again', backend }, 503);
      }

      return json({ error: 'method not allowed', backend }, 405);
    } catch (err) {
      console.error('[room]', err);
      return json({ error: 'signalling unavailable', backend }, 500);
    }
  },
};
