/**
 * Turns an SDP blob into something a person can paste into a chat window.
 *
 * There is no signalling server: the two players are already on a video call,
 * so they exchange one code each by hand. That keeps hosting to a plain static
 * site with no database, no accounts, and nothing to keep running.
 */

const b64urlEncode = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/*
 * The project pulls in both the DOM and WebWorker libs, whose ReadableStream
 * and CompressionStream declarations disagree about byte types. The runtime
 * behaviour is well defined; only the type overlap is ambiguous, so this
 * narrow shim keeps the casts in one place rather than scattered inline.
 */
interface Pipeable {
  pipeThrough(transform: unknown): unknown;
}
const blobOf = (part: string | Uint8Array) => new Blob([part as unknown as BlobPart]);
const pipe = (part: string | Uint8Array, transform: unknown): BodyInit =>
  (blobOf(part).stream() as unknown as Pipeable).pipeThrough(transform) as BodyInit;

async function gzip(text: string): Promise<Uint8Array> {
  const res = new Response(pipe(text, new CompressionStream('gzip')));
  return new Uint8Array(await res.arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  return new Response(pipe(bytes, new DecompressionStream('gzip'))).text();
}

const hasCompression = typeof CompressionStream !== 'undefined';

/**
 * SDP is mostly boilerplate and compresses roughly 4:1, which is the
 * difference between a code that pastes cleanly and one that does not.
 */
export async function encodeSignal(desc: RTCSessionDescriptionInit): Promise<string> {
  const payload = JSON.stringify({ t: desc.type, s: desc.sdp });
  if (!hasCompression) return `F1${b64urlEncode(new TextEncoder().encode(payload))}`;
  return `F2${b64urlEncode(await gzip(payload))}`;
}

export async function decodeSignal(code: string): Promise<RTCSessionDescriptionInit> {
  const trimmed = code.trim().replace(/\s+/g, '');
  const version = trimmed.slice(0, 2);
  const body = trimmed.slice(2);
  if (version !== 'F1' && version !== 'F2') {
    throw new Error('That does not look like a Fruity code.');
  }
  const bytes = b64urlDecode(body);
  const json = version === 'F2' ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  const parsed = JSON.parse(json) as { t: RTCSdpType; s: string };
  if (!parsed.s) throw new Error('That code is incomplete — copy the whole thing.');
  return { type: parsed.t, sdp: parsed.s };
}
