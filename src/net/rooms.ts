/**
 * Client side of the room-code signalling relay.
 *
 * The whole point is that joining is one tap on a link. Everything here exists
 * to keep the guest from ever having to read, type or relay anything.
 */

export interface RoomInfo {
  code: string;
  backend: string;
}

const ROOM_API = '/api/room';

async function call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(path, { cache: 'no-store', ...init });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // A 404 from a static host returns HTML; treat it as "no relay deployed".
    throw new Error('Online invites are not available on this deployment.');
  }
  if (!res.ok) throw new Error(String(data.error ?? `Request failed (${res.status})`));
  return data;
}

/** Host: publish the offer, get back a four-digit code. */
export async function createRoom(offer: string): Promise<RoomInfo> {
  const data = await call(ROOM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer }),
  });
  return { code: String(data.code), backend: String(data.backend ?? 'unknown') };
}

/** Guest: fetch the host's offer for a code. */
export async function fetchOffer(code: string): Promise<string> {
  const data = await call(`${ROOM_API}?code=${encodeURIComponent(code)}`);
  const offer = data.offer;
  if (typeof offer !== 'string' || !offer) throw new Error('That game code has expired.');
  return offer;
}

/** Guest: hand the answer back to the host. */
export async function submitAnswer(code: string, answer: string): Promise<void> {
  await call(`${ROOM_API}?code=${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
}

/**
 * Host: wait for the guest's answer to show up. Polls rather than holding a
 * socket open, because the wait is short and a serverless function should not
 * be paid to sit idle.
 */
export async function awaitAnswer(
  code: string,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: () => boolean } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 1200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.()) throw new Error('cancelled');
    try {
      const data = await call(`${ROOM_API}?code=${encodeURIComponent(code)}&want=answer`);
      if (typeof data.answer === 'string' && data.answer) return data.answer;
    } catch {
      // Transient failures are expected while waiting; keep polling.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('They never joined — the invite timed out.');
}

/** Republish our full candidate list. One writer per side, so no append races. */
export async function putCandidates(
  code: string,
  side: 'host' | 'guest',
  ice: unknown[],
): Promise<void> {
  await call(`${ROOM_API}?code=${encodeURIComponent(code)}&ice=${side}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ice }),
  });
}

/** Fetch whatever the other side has published so far. */
export async function getCandidates(code: string, side: 'host' | 'guest'): Promise<unknown[]> {
  const data = await call(`${ROOM_API}?code=${encodeURIComponent(code)}&want=ice&side=${side}`);
  return Array.isArray(data.ice) ? data.ice : [];
}

/**
 * Reads a game code out of the URL so a shared link joins straight away.
 * Accepts /j/1234 (the pretty form, rewritten to the app in vercel.json),
 * plus #1234 and ?game=1234 as fallbacks for static hosting.
 */
export function codeFromUrl(): string | null {
  const path = location.pathname.match(/\/j\/(\d{6})\/?$/);
  if (path) return path[1];
  const hash = location.hash.replace(/^#/, '');
  if (/^\d{4}$/.test(hash)) return hash;
  const param = new URLSearchParams(location.search).get('game');
  return param && /^\d{4}$/.test(param) ? param : null;
}

export function inviteLink(code: string): string {
  return `${location.origin}/j/${code}`;
}

/** Strip the code once used, so a refresh doesn't try to rejoin a dead room. */
export function clearUrlCode() {
  if (codeFromUrl()) history.replaceState(null, '', '/');
}
