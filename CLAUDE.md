# Working on Fruity

Read `README.md` for what the project is and how it fits together. This file
covers the things that will bite you, which are mostly invariants that look like
ordinary code until you break them.

## Commands

```bash
npm run dev          # dev server, http://localhost:5173
npm run build        # typecheck + build (this is the real check; run it)
npm run typecheck    # tsc --noEmit on its own
```

There is no test suite. Verification is done by driving the real app (see
below), so "it compiles" is not evidence that anything works.

## Invariants you can break without any error appearing

**Spawn randomness must stay deterministic.** Two-player matches work by both
browsers generating identical fruit from one shared seed. Anything that decides
*what* spawns, *where*, or *when* must draw from the seeded `Rng` in
`util/rng.ts`. Cosmetic randomness (particle directions, fruit spin) uses
`Math.random()` on purpose so it can never consume from the seeded stream.

In `Game.launch()` all random values are drawn *before* checking whether a fruit
slot is free. Returning early would leave the two players' streams at different
offsets and they would silently start playing different games. If you add a
spawn path, draw first, bail second.

**Physics are in viewport-heights, not pixels.** `GRAVITY_PER_H` and the launch
maths are relative to screen height so two players on different sized screens
get the same fruit in the same relative places at the same times. Introducing a
pixel constant into the trajectory maths breaks cross-device fairness.

**Spawn timing runs off the wall clock**, not accumulated frame deltas, so two
machines at different frame rates do not drift apart over a match. Do not
convert the wave scheduler back to a `-= dt` accumulator.

**Anything from the network is untrusted.** The peer is whoever holds the room
code. All inbound message fields are coerced in one place, `Session.handle`.
Add new message fields there, not at the point of use. Values that end up in an
`innerHTML` template get escaped again in `hud.ts`.

## Things that look wrong and are not

**`vite.config.ts` compiles the tracking worker separately with esbuild.**
MediaPipe's WASM loader calls `importScripts()` and needs `ModuleFactory` on the
worker global, which an ES module worker does not have. If you "simplify" this
to a normal Vite worker import, the worker throws `ModuleFactory not set`, the
tracker catches it, falls back to main-thread inference, and everything still
works while being much slower. The failure is completely silent. This cost a
long time to find once.

**`vite.config.ts` also serves `public/mediapipe` through its own middleware.**
Vite's dev server otherwise intercepts the WASM loader request and rejects it
for living in `public/`.

**`@types/node` is an explicit devDependency** even though nothing in `src/`
imports Node built-ins. `vite.config.ts` does, and TypeScript resolves `@types`
by walking up the directory tree, so removing it can pass locally and fail on a
clean checkout.

**Collision tests the drawn trail, not just the current blade.** Camera tracking
costs 55-70ms the player cannot correct for, so testing only the instantaneous
blade position makes the game feel unresponsive. `Game.bladeDistance()`
deliberately includes the recent arc. It is not redundant work.

**Pose detection exists in `gestures.ts` but does not gate gameplay.** Requiring
a specific hand shape to cut was the single biggest cause of the game feeling
broken: one frame mid-swing that read as the wrong shape and the swing did
nothing. Any hand shape cuts now. If you add gesture-dependent moves, make the
pose *select* an action rather than *enable* one, so a misread costs points
rather than making the game feel dead.

## Testing without a camera

The browser sandbox has no camera, and headless tabs often report
`document.hidden`, which stops `requestAnimationFrame`. Both are worked around
the same way:

- **Mouse mode** implements `InputSource`, so the entire game and the full
  multiplayer flow can be driven from a normal tab. Click "play with the mouse"
  on the welcome screen.
- **`window.__fruity`** is exposed in dev builds only (`{ game, tracker }`). Use
  it to step the loop by hand: `game.stop()`, replace `game.frame` with a no-op,
  then call `game.update(dt, t, hands)` and `game.render(t, hands, dt)` yourself
  with synthetic `ScreenHand` objects. This is how the determinism, collision
  and rendering behaviour were verified.
- Two browser tabs can complete a real peer-to-peer match against each other,
  which is the only way to check the multiplayer path.

Do not conclude the game works from a screenshot alone; a stray real frame can
repaint over whatever you set up.

## Tuning

Gameplay constants are at the top of `Game.ts`: cut speed threshold, how long
the blade stays "hot" after a fast swing, hit padding, starting lives, bomb
penalty. Tracking constants are at the top of `HandTracker.ts`: inference
resolution, prediction limits. Levels are a plain table in `levels.ts`.

Press `D` in game for frame time, inference cost, target vs actual sample rate,
and whether inference is running in the worker or on the main thread. If it says
`main`, the worker failed to start and that is a bug worth chasing.

## Deployment

`vercel deploy --prod`. Deploy to production, not preview: preview URLs sit
behind Vercel's login, so an invite link sends the other player to a sign-in
page.

Secrets stay server-side. `api/turn.ts` holds the Cloudflare TURN key and hands
the browser only short-lived credentials; never move that key into client code.

## Style

Comments explain *why*, not *what* the next line does. Several of the odder
decisions in this codebase are load-bearing and the comment is the only thing
stopping someone undoing them. TypeScript is strict and there are no `any`
casts; keep it that way.
