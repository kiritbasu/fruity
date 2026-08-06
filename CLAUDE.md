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

`npm run dev` does not serve `api/`, so the two-player lobby fails with "invites
are unavailable". Use `vercel dev` when working on multiplayer; it runs the Vite
server and the API routes together.

There is no test suite. Verification is done by driving the real app (see
below), so "it compiles" is not evidence that anything works.

## Invariants you can break without any error appearing

**Spawn randomness must stay deterministic.** Two-player matches work by both
browsers generating identical fruit from one shared seed, and a cut identifies
its fruit by a number derived from spawn order, so a desync would not just
change what people see, it would make cuts land on the wrong fruit. Anything that decides
*what* spawns, *where*, or *when* must draw from the seeded `Rng` in
`util/rng.ts`. Cosmetic randomness (particle directions, fruit spin) uses
`Math.random()` on purpose so it can never consume from the seeded stream.

In `Game.launch()` all random values are drawn *before* checking whether a fruit
slot is free. Returning early would leave the two players' streams at different
offsets and they would silently start playing different games. If you add a
spawn path, draw first, bail second.

For the same reason `spawnWave()` applies `VERSUS_WAVE_BONUS` *after* rolling
the wave size rather than passing a bigger range into the roll. The stream then
advances by the same amount whatever the mode, and since both peers are always
in the same mode as each other they stay aligned. Folding the multiplier into
the `rng.int()` call looks identical and is not.

`MAX_FRUIT` has to stay above the busiest level's peak. Measured worst case is
40 (last level, two players, nothing cut for twenty seconds) against a pool of
56. An exhausted pool drops spawns silently — no error, no log, and the two
players' boards quietly stop matching.

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

**Anything toggled with `.hidden` needs its own `[hidden]` rule if its CSS sets
`display`.** The user-agent's `[hidden] { display: none }` loses to any author
rule with a `display`, so `el.hidden = true` sets the attribute and nothing
happens. This shipped twice: the "show your hand" nag appeared once and never
left, and `#hud` sat on top of the welcome screen. Both are `display: flex` /
`display: grid` rules. There is a runtime check for it in the review notes —
set `hidden` on every such element and assert the computed `display` is `none`.

**`Sfx.enabled` is a setter, not a field.** Every one-shot checks it when it
fires, so muting just stops new sounds starting. The blender motor is a
sustained voice that is already playing by then, so the setter stops it
explicitly. Turning `enabled` back into a plain boolean means pressing `M`
during the end-of-game blend leaves the motor running until the stage changes.

**The sword advances in exactly one place outside play.** `swordFor()` stores
this frame's segment as next frame's "previous", so calling it twice in a frame
leaves `prev` equal to `current` and any velocity derived from the pair reads as
zero. The non-playing branch at the bottom of `Game.update()` is that one place;
put per-phase hand behaviour inside it rather than in a phase handler that also
walks `hands`.

**ICE candidates are trickled, not gathered up front.** An earlier version
froze every candidate into the invite before showing it, which made invites slow
and left the host's candidates to go stale while the invite waited. `api/room.ts`
carries candidate lists both ways; each side rewrites its own list as it grows,
so there is one writer per key and no append races.

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
penalty, the two-player wave multiplier, and the fruit and chunk pool sizes.
Tracking constants are at the top of `HandTracker.ts`: inference resolution,
prediction limits. Levels are a plain table in `levels.ts` — difficulty is meant
to come from wave size and bombs, with `tempo` shortening hang time as the real
dial, because hang time is what decides whether a player can reach the fruit.

One balance note worth knowing: a bomb clears every fruit in the air, and waves
are much bigger than they used to be. In two-player that is now a large swing,
because the board only clears for whoever hit it (which is deliberate) while the
other player keeps cutting. If bombs start feeling unfair, that is where to look
— either the blast radius or `bombChance` in the later levels.

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
