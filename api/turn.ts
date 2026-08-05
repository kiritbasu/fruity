/**
 * Mints short-lived Cloudflare TURN credentials for the browser.
 *
 * This has to be server-side. A Cloudflare TURN key is a long-term secret that
 * can generate unlimited credentials, so shipping it in client JavaScript would
 * hand anyone who opened devtools the ability to burn the account's quota. The
 * browser only ever receives an ICE server list that expires.
 *
 * Set these on the project (they are never read by the client bundle):
 *   CLOUDFLARE_TURN_KEY_ID
 *   CLOUDFLARE_TURN_API_TOKEN
 *
 * With them unset the endpoint reports `configured: false` and the game falls
 * back to STUN only, which is enough for most home networks.
 */

const CF_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * Comfortably longer than a three-minute match plus lobby faffing, short enough
 * that a leaked credential is worth little.
 */
const TTL_SECONDS = 3600;

interface IceResponse {
  iceServers?: RTCIceServerLike[] | RTCIceServerLike;
}

interface RTCIceServerLike {
  urls: string[] | string;
  username?: string;
  credential?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Credentials are per-session and time-limited; never cache them.
      'Cache-Control': 'no-store',
    },
  });

export default {
  async fetch(): Promise<Response> {
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    const token = process.env.CLOUDFLARE_TURN_API_TOKEN;

    if (!keyId || !token) {
      return json({ configured: false, iceServers: [], reason: 'TURN not configured' });
    }

    try {
      const res = await fetch(`${CF_ENDPOINT}/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      });

      if (!res.ok) {
        // Deliberately vague to the client: the upstream body can echo details
        // about the key that the browser has no business seeing.
        console.error('[turn] Cloudflare returned', res.status, await res.text().catch(() => ''));
        return json({ configured: false, iceServers: [], reason: `upstream ${res.status}` });
      }

      const data = (await res.json()) as IceResponse;
      // The API has returned both a bare object and an array across versions.
      const raw = data.iceServers;
      const iceServers = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return json({ configured: iceServers.length > 0, iceServers, ttl: TTL_SECONDS });
    } catch (err) {
      console.error('[turn] failed to mint credentials', err);
      return json({ configured: false, iceServers: [], reason: 'request failed' });
    }
  },
};
