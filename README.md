# 🍉 Fruity

**[Play it →](https://fruity-rose.vercel.app)**

Slice flying fruit with your bare hand. A webcam tracks your hand, a sword
follows it, and anything you swing through gets cut in half. Two people can race
each other over a peer-to-peer link with nothing but a shared invite URL.

Hand tracking runs entirely in the browser — camera frames are never uploaded.
In a two-player match your hand position and score go directly to the other
player, peer-to-peer; camera video is sent only if you switch it on.

```bash
npm install
npm run dev          # http://localhost:5173
```

You need a webcam and a browser with WebAssembly SIMD (Chrome, Edge, Firefox,
Safari 16.4+). There is a mouse fallback if you have no camera.

---

## How to play

Raise a hand to the camera. The sword points the way your **palm** points — the
game reads orientation, not a specific hand shape, so any grip works. Sweep it
through the fruit and it splits along the blade. Let fruit fall and you lose a
life. Bombs pulse red; touch one with a moving blade and it takes the screen
with it.

Six authored levels ramp up by adding clutter and bombs rather than raw speed.
Past level six it generates harder variants indefinitely. Clearing a level
returns a life.

| Key | |
|---|---|
| `D` | performance overlay (frame time, inference cost, sample rate) |
| `M` | mute |
| `P` | pause |
| `R` | restart |
| `2` | open the two-player lobby |
| `V` | toggle sending your camera during a match |

### Two players

Hit **Play with a friend**. The host gets an invite link (`/j/123456`) copied to
the clipboard; the other player taps it, taps one button, and is in. A six-digit
code is shown as a fallback to read aloud.

You each play your own board but get **the same fruit in the same order**, so
it is a fair race — highest score after three minutes wins. Their sword is
ghosted onto your screen in pink so you can watch them going for the same
watermelon. There is no elimination: bombs cost points and break your combo
instead of a life, so nobody sits out watching.

---

## Architecture

```
src/
  tracking/            camera → hand position, and nothing else
    HandTracker.ts     capture pump, worker lifecycle, smoothing, extrapolation
    tracker.worker.ts  worker entry (pre-bundled to a classic script — see below)
    engine.ts          MediaPipe wrapper, usable from worker or main thread
    gestures.ts        landmark geometry → action point, hand scale, aim vector
    oneEuro.ts         1€ filter
    PointerInput.ts    mouse fallback behind the same interface
  game/                pure simulation + rendering, no knowledge of the network
    Game.ts            loop, phases, collision, scoring
    entities.ts        fruit, chunks, the motion ribbon
    sword.ts           sword sprite and the blade segment used for collision
    fruitDefs.ts       procedural fruit art
    sprites.ts         sprite baking, cut-face rendering
    effects.ts         pooled particles, rings, popups, splats
    levels.ts          level table and endless generator
    audio.ts           synthesised sound, no audio files
    hud.ts             DOM HUD and overlays
  net/                 multiplayer, bolted onto the side of the game
    Peer.ts            WebRTC: data channels, optional video, ICE
    Session.ts         match lifecycle, opponent mirror, input validation
    lobby.ts           invite / join UI
    rooms.ts           client for the signalling relay
    codec.ts           SDP → compact string
    protocol.ts        wire messages
  util/
    rng.ts             seeded PRNG — the basis of the shared fruit sequence
    math.ts, html.ts   geometry helpers; escaping and input coercion
api/
  room.ts              signalling relay (two blobs per room, 15-minute TTL)
  turn.ts              mints short-lived Cloudflare TURN credentials
```

The three layers are deliberately one-directional: `tracking` knows nothing
about the game, `game` knows nothing about the network, and `net` drives both
through narrow interfaces (`InputSource`, and a handful of callbacks on `Game`).
The mouse fallback exists because `InputSource` is the only thing the game
requires — which also makes the whole game testable without a camera.

### Input pipeline

Camera frames are downscaled to 320×240 and handed to a worker, which runs
MediaPipe's hand landmarker and returns 21 landmarks. From those the game needs
only three things: an action point (palm centroid), a hand scale
(wrist→middle-MCP, which makes every other measurement depth-invariant), and an
aim vector (the same wrist→middle-MCP direction, stable under wrist rotation and
indifferent to which fingers are extended).

Positions are 1€-filtered, then extrapolated forward by up to one tracker period
so the sword keeps up between samples. Rendering runs at 60Hz regardless.

### Why the visible arc is the hitbox

Camera tracking costs 55–70ms end-to-end that the player cannot feel or
compensate for. Testing collision only against the blade's current position
therefore asks them to lead the fruit by an invisible margin, and the game feels
like it is ignoring them.

Instead, fruit is tested against the **arc the player just drew** — the last
~140ms of it, plus the current and previous blade edges and the paths traced by
the tip and hilt. What you see is what cuts. This single change did more for
perceived responsiveness than every latency optimisation combined.

### Multiplayer without a game server

Only three things cross the network: a 32-bit seed at match start, hand
positions at ~30Hz, and scores. About 5 kbps.

Both clients generate identical fruit from that shared seed, so there is no
world state to reconcile and network latency cannot make the race unfair.
Physics are expressed in viewport-heights per second squared rather than pixels,
which is what lets two players on different screen sizes share one fruit
schedule. Spawn timing runs off elapsed wall-clock rather than accumulated
frame deltas, so two machines at different frame rates do not drift apart.

`api/room.ts` holds the WebRTC offer and answer just long enough for the
browsers to find each other, then drops out. It never sees gameplay or video.

---

## Performance

The target was a 2019 Intel Mac. GPU vs CPU delegate barely differs on MediaPipe
0.10.31+, so the wins came from architecture:

- **Inference in a classic Web Worker**, decoupled from rendering, with a
  main-thread fallback.
- **The capture pump samples at the camera's own rate.** Frames arrive every
  ~16–33ms, so a minimum send interval longer than one camera period quantises
  the real rate to `cameraRate / n` — asking for 24Hz off a 30Hz camera yields
  15Hz. Sending up to half a frame early lands on the nearest achievable rate.
- **One frame in flight**, driven by `requestVideoFrameCallback`.
- **Camera feed is a CSS layer, not a canvas blit** — saves a full-screen
  `drawImage` every frame.
- **Procedural fruit art baked once** into per-size offscreen canvases; the hot
  path is `drawImage`. Particles are pooled and batched by colour.
- **devicePixelRatio capped at 1.5**, with a governor that sheds particles, then
  the splat layer, then render scale as frame time slips.
- **The model is warmed up during the loading screen** — three passes, since one
  still left a ~190ms spike on the first real frame.

Press `D` in game to watch frame time, inference cost, measured vs target sample
rate, and which execution path is live.

### Two things that look like bugs and are not

**The tracking worker is pre-bundled by a Vite plugin.** MediaPipe's WASM loader
uses `importScripts()` and expects it to assign `ModuleFactory` onto the worker
global. An ES module worker has neither, so it dies with `ModuleFactory not
set` — and because the tracker catches that and silently falls back to
main-thread inference, the failure is invisible. Vite's `worker.format: 'iife'`
only applies to `vite build`; the dev server always emits a module worker. So
`vite.config.ts` compiles `tracker.worker.ts` to a classic IIFE with esbuild and
rebuilds it when anything under `src/tracking/` changes.

**`@types/node` is an explicit devDependency** even though nothing in `src/`
imports Node builtins. `vite.config.ts` does, and TypeScript resolves `@types`
by walking *up* the directory tree — so a stray copy in a parent folder can make
`tsc` pass locally and fail on a clean CI container.

---

## Security

Everything the other player sends is untrusted — they are whoever holds the room
code — so it is validated once, at the data-channel boundary in
`Session.handle`, rather than at each point of use. Names are reduced to inert
plain text; every numeric field is coerced to a finite, bounded number. Values
that reach an `innerHTML` template are escaped again there, so those templates
are safe on their own terms rather than by trusting a caller three modules away.

Room codes are six digits from `crypto.getRandomValues`, a room accepts exactly
one answer, and both blobs are size-capped. The signalling endpoint is
unauthenticated by design — that is what makes a link tappable — so it holds
nothing sensitive and expires everything after fifteen minutes.

`/api/turn` is also unauthenticated and will mint TURN credentials for anyone who
asks. For a game shared with family that is a reasonable trade; if you deploy
this publicly at scale, that endpoint is the first thing to put behind a check.

---

## Deploying your own

Vercel auto-detects it as a Vite project. `vercel.json` pins the framework, sets
cache headers for the ~40 MB MediaPipe runtime, rewrites `/j/*` to the app, and
pins functions to one region.

```bash
vercel deploy --prod
```

Deploy to **production, not preview** — Vercel's Standard Protection puts preview
URLs behind your own SSO login, so a preview link redirects your friend to a
sign-in page.

Nothing else is required. The signalling relay uses Vercel's Runtime Cache,
which needs no account, credentials or provisioning. That is normally the wrong
tool for shared state because it is per-region, but functions here are pinned to
a single region so both players always reach the same cache; the payload is
about a kilobyte and read within seconds of being written. If `KV_REST_API_URL`
and `KV_REST_API_TOKEN` happen to exist, Redis is used instead automatically.

### Optional: TURN relay

About one home network in five is behind a NAT strict enough to block a direct
peer connection. Without a relay those players cannot connect to each other;
everything else still works.

1. Cloudflare dashboard → **Realtime → TURN Keys** → create a key.
2. Set the credentials (these prompt, so nothing lands in shell history):

   ```bash
   vercel env add CLOUDFLARE_TURN_KEY_ID production --sensitive
   vercel env add CLOUDFLARE_TURN_API_TOKEN production --sensitive
   vercel deploy --prod
   ```

3. Check it took: `curl -s https://your-deployment/api/turn` should report
   `"configured": true`.

The key is a long-term secret that can mint unlimited credentials, so it stays
server-side; the browser only ever receives an ICE list with a one-hour TTL.
Cloudflare's free tier is far beyond what a handful of players will use.

### Optional: analytics

`@vercel/analytics` is wired up in `src/main.ts` and no-ops unless the app is
served from Vercel with Web Analytics enabled on the project. It records
anonymous page-level traffic only, and is never told anything about the camera,
the hand data or the peer connection. Delete the `inject()` call to remove it.

---

## Developing

```bash
npm run dev          # dev server with HMR
npm run build        # typecheck + production build into dist/
npm run typecheck    # tsc --noEmit
npm run assets       # re-vendor the MediaPipe runtime and model
```

`npm install` vendors the MediaPipe WASM runtime out of `node_modules` and
downloads the ~8 MB gesture model into `public/` (see `scripts/fetch-assets.mjs`),
so the game loads same-origin and works offline after the first run. Both
directories are generated and gitignored.

Some things worth knowing before you change them:

- **Spawn randomness must stay deterministic.** Anything that affects *what*
  spawns draws from the seeded `Rng`; cosmetic randomness uses `Math.random()`.
  Mixing them breaks two-player fairness. `Game.launch()` draws all its random
  values *before* checking the fruit pool, because bailing out early would
  desynchronise the two peers' RNG streams.
- **Tuning constants live at the top of `Game.ts`** — cut threshold, the trailing
  "hot" window, hit padding, starting lives.
- **`gestures.ts` still classifies open / fist / pinch** even though the game no
  longer gates on pose. It feeds the debug overlay and is the hook to hang extra
  verbs on. Pose gating was removed because it was the largest single cause of
  the game feeling unresponsive: a mid-swing frame that read as the wrong shape
  silently did nothing.
- **Testing without a camera**: the mouse fallback implements `InputSource`, so
  the entire game and multiplayer flow can be exercised in a normal browser tab.

## Licence

MIT — see [LICENSE](LICENSE).
