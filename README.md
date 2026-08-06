# 🍉 Fruity

**[Play it →](https://fruity-rose.vercel.app)**

![Two players racing: a watermelon splitting along the blade, the player's sword
and trail in blue, the opponent's ghosted in pink, with the match clock and their
live score](docs/screenshot.png)

Slice flying fruit with your bare hand. A webcam tracks your hand, a sword
follows it, and anything you swing through gets cut in half. Two people can race
each other over a direct browser-to-browser link by sharing one URL.

Hand tracking runs in the browser. Camera frames are never uploaded. In a
two-player match your hand position and score go straight to the other player;
camera video is sent only if you turn it on.

```bash
npm install
npm run dev          # http://localhost:5173
```

You need a webcam and a reasonably current browser (Chrome, Edge, Firefox, or
Safari 16.4+). There is a mouse fallback if you have no camera.

---

## How to play

Raise a hand to the camera. The sword points the way your palm points. The game
reads orientation, not a specific hand shape, so any grip works. Sweep the sword
through the fruit and it splits along the blade. Let fruit fall and you lose a
life. Bombs pulse red. Touch one with a moving blade and it clears the screen.

Six hand-written levels get harder by adding more fruit and more bombs rather
than by speeding everything up. After level six the game generates harder
variants on its own. Clearing a level gives you a life back.

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
the clipboard. The other player taps it, taps one button, and is in. A six-digit
code is also shown if it is easier to read it out loud.

You each play your own board, but you both get the same fruit in the same order,
so it is a fair race. Highest score after three minutes wins. Your opponent's
sword is drawn on your screen in pink, so you can watch them going for the same
watermelon you are. Nobody gets knocked out: bombs cost points and break your
combo instead of taking a life.

---

## Architecture

```
src/
  tracking/            camera in, hand position out
    HandTracker.ts     capture loop, worker lifecycle, smoothing, prediction
    tracker.worker.ts  worker entry (pre-bundled to a classic script, see below)
    engine.ts          MediaPipe wrapper, works in a worker or on the main thread
    gestures.ts        landmarks to action point, hand size, aim direction
    oneEuro.ts         the smoothing filter
    PointerInput.ts    mouse fallback, same interface
  game/                simulation and rendering, knows nothing about the network
    Game.ts            loop, phases, collision, scoring
    entities.ts        fruit, cut halves, the motion trail
    sword.ts           sword sprite and the blade segment used for collision
    fruitDefs.ts       fruit artwork, drawn in code
    sprites.ts         sprite baking, cut-face rendering
    effects.ts         pooled particles, rings, score popups, splats
    levels.ts          level table and endless generator
    audio.ts           synthesised sound, no audio files
    hud.ts             DOM HUD and overlays
  net/                 multiplayer, bolted onto the side of the game
    Peer.ts            WebRTC: data channels, optional video, ICE
    Session.ts         match lifecycle, opponent state, input validation
    lobby.ts           invite and join screens
    rooms.ts           client for the signalling relay
    codec.ts           SDP to a compact string
    protocol.ts        wire messages
  util/
    rng.ts             seeded random numbers, the basis of the shared fruit order
    math.ts, html.ts   geometry; escaping and input coercion
api/
  room.ts              signalling relay (two blobs per room, 15-minute expiry)
  turn.ts              issues short-lived Cloudflare TURN credentials
```

Dependencies only point one way. `tracking` knows nothing about the game.
`game` knows nothing about the network. `net` drives both through small
interfaces: `InputSource`, plus a few callbacks on `Game`. The mouse fallback
works because `InputSource` is all the game asks for, which also means you can
exercise the whole game without a camera.

### Input pipeline

Camera frames are scaled down to 320×240 and sent to a worker. The worker runs
MediaPipe's hand landmarker and returns 21 points. The game only needs three
things from those:

- **Where the hand is.** The centre of the palm, which is steadier than the
  wrist.
- **How big the hand is.** The distance from wrist to middle knuckle. Dividing
  every other measurement by this makes them work at any distance from the
  camera.
- **Which way it points.** The direction from wrist to middle knuckle. This
  holds up when you rotate your wrist and does not care which fingers are out.

### Smoothing the hand position

Raw landmarks jitter by a few pixels every frame, even when your hand is
perfectly still. Averaging them fixes the jitter but adds lag, and lag is the
thing this game can least afford.

`oneEuro.ts` implements a filter that changes how hard it smooths based on how
fast your hand is moving. Hand still: smooth hard, so the sword sits steady.
Hand moving: barely smooth at all, so the sword keeps up with your swing. You
get a stable sword at rest and a responsive one mid-swipe, instead of trading
one for the other. (It is called the One Euro filter, after the paper
that described it. It is named for being cheap to compute.)

On top of that, the position is projected forward by up to one tracking interval
so the sword does not visibly lag between camera samples. Rendering runs at 60Hz
whatever the camera is doing.

### Why the visible trail is the hitbox

Hand tracking costs 55 to 70ms between you moving and the screen updating, and
the player cannot feel or correct for it. If collision only tested the blade's
current position, you would have to lead the fruit by an amount you cannot see,
and the game would feel like it was ignoring you.

So fruit is tested against the trail you just drew: roughly the last 140ms of
it, plus the current and previous blade positions and the paths the tip and hilt
swept between frames. Whatever you can see cuts. This mattered more for how
responsive the game feels than any of the latency work.

### Multiplayer without a game server

Three things cross the network: a 32-bit seed when the match starts, hand
positions at about 30Hz, and scores. Roughly 5 kbps.

Both browsers generate identical fruit from that seed. There is no shared world
state to keep in sync, so network lag cannot make the race unfair. Two details
make this hold:

- Physics are measured in screen heights per second, not pixels, so two players
  on different sized screens get the same fruit in the same places.
- Spawn timing runs off the clock rather than off accumulated frame times, so
  two machines running at different frame rates do not drift apart.

`api/room.ts` holds the WebRTC offer and answer long enough for the two browsers
to find each other, then drops out. It never sees gameplay or video.

---

## Performance

The target machine was a 2019 Intel Mac. GPU and CPU inference perform about the
same on MediaPipe 0.10.31+, so the speed came from structure instead:

- Inference runs in a classic Web Worker, off the render thread, with a
  main-thread fallback if the worker cannot start.
- The capture loop samples at whatever rate the camera actually runs at. Frames
  arrive every 16 to 33ms, so any minimum interval longer than one camera frame
  rounds the real rate down to `cameraRate / n`. Asking for 24Hz from a 30Hz
  camera gets you 15Hz. Sending up to half a frame early avoids that.
- Only one frame is in flight at a time, driven by `requestVideoFrameCallback`.
- The camera feed is a CSS layer behind the canvas, not something drawn into it.
  That saves a full-screen copy every frame.
- Fruit artwork is drawn in code but only once, into offscreen canvases. Per
  frame it is just `drawImage`. Particles are pooled and batched by colour.
- Device pixel ratio is capped at 1.5. If frame times slip, a governor drops
  particles first, then the splat layer, then render scale.
- The model runs three warm-up passes behind the loading screen. One pass was
  not enough and left a 190ms stall on the first real frame.

Press `D` while playing to see frame time, inference cost, target versus actual
sample rate, and which code path is running.

### Two things that look wrong but are not

**The tracking worker is pre-bundled by a Vite plugin.** MediaPipe's WASM loader
calls `importScripts()` and expects it to set `ModuleFactory` on the worker's
global scope. An ES module worker has neither, so it fails with `ModuleFactory
not set`. The tracker catches that and quietly falls back to main-thread
inference, so the failure is invisible while making everything slower. Vite's
`worker.format: 'iife'` setting only applies to `vite build`; the dev server
always emits a module worker. So `vite.config.ts` compiles `tracker.worker.ts`
into a classic script with esbuild, and rebuilds it when anything under
`src/tracking/` changes.

**`@types/node` is an explicit devDependency** even though nothing in `src/`
imports Node built-ins. `vite.config.ts` does. TypeScript looks for `@types` by
walking up the directory tree, so a stray copy in a parent folder can make `tsc`
pass on your machine and fail on a clean CI container.

---

## Security

Anything the other player sends is untrusted. They are whoever has the room
code. All of it is validated in one place, `Session.handle`, rather than at each
point of use. Names are stripped down to plain text. Numbers are coerced to
finite values inside a fixed range. Values that end up in an `innerHTML`
template are escaped there as well, so the template is safe on its own without
depending on a caller three modules away.

Room codes are six digits from `crypto.getRandomValues`. A room accepts exactly
one answer, and both blobs have a size limit. The signalling endpoint has no
authentication, which is what makes an invite link work by tapping it, so it
holds nothing sensitive and expires everything after fifteen minutes.

`/api/turn` also has no authentication and will issue TURN credentials to
anyone who asks. For a game you share with family that is a fine trade. If you
run this publicly at any scale, put that endpoint behind a check first.

---

## Deploying your own

Vercel detects it as a Vite project. `vercel.json` pins the framework, sets
cache headers for the 40MB MediaPipe runtime, rewrites `/j/*` to the app, and
pins functions to one region.

```bash
vercel deploy --prod
```

Deploy to production, not preview. Vercel's Standard Protection puts preview
URLs behind your own login, so a preview link sends your friend to a sign-in
page instead of the game.

Nothing else is required. The signalling relay uses Vercel's Runtime Cache,
which needs no account or setup. That is normally the wrong place for shared
state because each region has its own copy, but functions here are pinned to one
region so both players hit the same cache. The stored data is about a kilobyte
and gets read within seconds. If `KV_REST_API_URL` and `KV_REST_API_TOKEN`
happen to be set, it uses Redis instead without any code change.

### Optional: TURN relay

About one home network in five sits behind a NAT strict enough to block a direct
connection between two browsers. Those players cannot reach each other without a
relay. Everything else works fine without one.

1. Cloudflare dashboard, **Realtime → TURN Keys**, create a key.
2. Set the credentials. These prompt for the value, so nothing ends up in your
   shell history:

   ```bash
   vercel env add CLOUDFLARE_TURN_KEY_ID production --sensitive
   vercel env add CLOUDFLARE_TURN_API_TOKEN production --sensitive
   vercel deploy --prod
   ```

3. Check it worked: `curl -s https://your-deployment/api/turn` should report
   `"configured": true`.

The key is a long-lived secret that can issue unlimited credentials, so it stays
on the server. The browser only ever gets an ICE list that expires after an
hour. Cloudflare's free tier is far more than a few players will use.

### Optional: analytics

`@vercel/analytics` is set up in `src/main.ts`. It does nothing unless the app is
served from Vercel with Web Analytics turned on for the project. It records
anonymous page traffic and is never given anything about the camera, the hand
data, or the peer connection. Delete the `inject()` call to remove it.

---

## Developing

```bash
npm run dev          # dev server with hot reload
npm run build        # typecheck and build into dist/
npm run typecheck    # tsc --noEmit
npm run assets       # re-fetch the MediaPipe runtime and model
```

`npm run dev` serves the game but not `api/`, so the two-player lobby will report
that invites are unavailable. To work on multiplayer locally, run `vercel dev`
instead, which serves the Vite app and the API routes together.

`npm install` copies the MediaPipe WASM runtime out of `node_modules` and
downloads the 8MB gesture model into `public/` (see `scripts/fetch-assets.mjs`).
The game then loads everything from its own origin and works offline after the
first run. Both directories are generated and git-ignored.

A few things to know before changing them:

- **Spawn randomness has to stay deterministic.** Anything affecting what
  spawns draws from the seeded `Rng`. Cosmetic randomness uses `Math.random()`.
  Mixing the two breaks two-player fairness. `Game.launch()` draws all its
  random values before checking whether a fruit slot is free, because returning
  early would leave the two players' random sequences at different positions.
- **Tuning constants are at the top of `Game.ts`**: cut threshold, how long the
  blade stays "hot" after a fast swing, hit padding, starting lives.
- **`gestures.ts` still classifies open hand, fist, and pinch** even though the
  game no longer uses them. It feeds the debug overlay and is where you would
  hook in extra moves. Pose detection was removed from gameplay because it was
  the biggest single cause of the game feeling unresponsive: one frame mid-swing
  that read as the wrong shape and the swing did nothing.
- **Testing without a camera**: the mouse fallback implements `InputSource`, so
  you can drive the whole game and the multiplayer flow from a normal tab.

## Credits

Built collaboratively with [Claude](https://claude.com/claude-code) (Anthropic)
as co-developer. Claude wrote most of the implementation and did the
performance, latency and security work; direction, play-testing and the design
calls were human. `CLAUDE.md` holds the working notes for anyone continuing that
way.

Hand tracking uses [MediaPipe](https://ai.google.dev/edge/mediapipe) from Google.

## Licence

MIT, see [LICENSE](LICENSE).
