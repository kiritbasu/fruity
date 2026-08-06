import './style.css';
import { inject } from '@vercel/analytics';
import { HandTracker } from './tracking/HandTracker';
import { PointerInput } from './tracking/PointerInput';
import { Game } from './game/Game';
import { Hud } from './game/hud';
import { Lobby } from './net/lobby';
import { codeFromUrl } from './net/rooms';
import { errorText } from './util/html';
import type { InputSource } from './tracking/types';

/*
 * Vercel Web Analytics. Anonymous page-level traffic only — it is never told
 * anything about the camera, the hand data or the peer connection, and it
 * no-ops entirely when the app is served anywhere other than Vercel.
 */
inject({ mode: import.meta.env.PROD ? 'production' : 'development' });

const canvas = document.getElementById('game') as HTMLCanvasElement;
const camWrap = document.getElementById('camWrap') as HTMLElement;

const tracker = new HandTracker(1);
camWrap.append(tracker.video);

let game: Game | null = null;
let lobby: Lobby | null = null;
let usingPointer = false;

const hud = new Hud({
  onRestart: () => {
    // Leaving a match has to tear down the versus HUD and the peer connection,
    // or a solo run inherits the opponent panel and match clock.
    hud.setVersusChrome(false);
    lobby?.close();
    if (game) game.start();
    else if (usingPointer) void startPointerMode();
    else void boot();
  },
  onResume: () => game?.resumeFromPause(),
  onRematch: () => lobby?.rematch(),
});

function welcome() {
  hud.showRaw(`
    <h1><span class="melon">\u{1F349}</span> Fruity</h1>
    <p>Wave your hand at the camera to swing a sword. Slice the fruit,
    miss the bombs.</p>
    <div class="moves">
      <div class="move" data-a="slice">
        <div class="emoji">\u{1F5E1}\uFE0F</div>
        <div><b>Swing to slice</b><small>The sword follows your hand. Swipe through the fruit to cut it in half.</small></div>
      </div>
      <div class="move" data-a="bomb">
        <div class="emoji">\u{1F4A3}</div>
        <div><b>Miss the bombs</b><small>Bombs flash red. Hit one and you lose a life.</small></div>
      </div>
    </div>
    <button class="primary" data-action="begin">Play solo</button>
    <button class="ghost" data-action="versus">Play with a friend</button>
    <div class="foot">
      You'll need a webcam. The camera is only used to see your hand.<br />
      No webcam? <a href="#" data-action="pointer" class="link">play with the mouse</a><br />
      <kbd>D</kbd> stats \u00b7 <kbd>M</kbd> sound \u00b7 <kbd>P</kbd> pause
    </div>
  `);

  hud.panelEl.querySelector('[data-action="begin"]')?.addEventListener('click', () => {
    openLobbyAfterBoot = false;
    void boot();
  });
  hud.panelEl.querySelector('[data-action="versus"]')?.addEventListener('click', () => {
    openLobbyAfterBoot = true;
    void boot();
  });
  hud.panelEl.querySelector('[data-action="pointer"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    void startPointerMode();
  });
}

function launchGame(source: InputSource) {
  if (!game) {
    game = new Game(canvas, source, hud);
    hud.onSoundToggle((on) => {
      if (game) game.sfx.enabled = on;
    });
  }
  game.sfx.resume();
  if (!lobby) {
    lobby = new Lobby(
      game,
      hud,
      () => tracker.cameraStream,
      () => {
        hud.setVersusChrome(false);
        lobby?.close();
        game?.start();
      },
    );
  }
  hud.showHud(game.best);
  hud.setLives(game.lives);
  hud.setScore(0, 0);
  return game;
}

/** Camera-free fallback: same game, driven by mouse buttons. */
async function startPointerMode() {
  usingPointer = true;
  const pointer = new PointerInput(document.body);
  launchGame(pointer);
  hud.setInputMode('pointer');
  hud.showRaw(`
    <div class="kicker">Mouse mode</div>
    <h2>No camera needed</h2>
    <div class="moves">
      <div class="move" data-a="slice"><div class="emoji">🖱️</div>
        <div><b>Swing to slice</b><small>The sword follows your mouse. Swipe through the fruit. No clicking.</small></div></div>
      <div class="move" data-a="bomb"><div class="emoji">💣</div>
        <div><b>Miss the bombs</b><small>Bombs flash red. Hit one and you lose a life.</small></div></div>
    </div>
    <button class="primary" data-action="go">Start playing</button>
  `);
  await new Promise<void>((resolve) => {
    hud.panelEl.querySelector('[data-action="go"]')?.addEventListener('click', () => resolve());
  });
  hud.hideOverlay();
  if (joinCode) {
    const code = joinCode;
    joinCode = null;
    await lobby!.joinWithCode(code);
  } else if (openLobbyAfterBoot) {
    game!.suspend();
    lobby!.show();
  } else {
    game!.start();
  }
}

async function boot() {
  hud.showLoading('Starting your camera…');
  try {
    // Audio must be unlocked from the click that got us here.
    const startPromise = tracker.start();
    hud.showLoading('Getting things ready…');
    await startPromise;
  } catch (err) {
    const msg = errorText(err);
    hud.showError(
      'Could not start the camera',
      /denied|Permission|NotAllowed/i.test(msg)
        ? 'Camera access was blocked. Allow it for this site in your browser settings, then try again.'
        : msg,
    );
    hud.panelEl.querySelector('[data-action="pointer"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      void startPointerMode();
    });
    return;
  }

  usingPointer = false;
  launchGame(tracker);
  hud.setInputMode('camera');
  await calibrate();
  if (joinCode) {
    const code = joinCode;
    joinCode = null;
    await lobby!.joinWithCode(code);
  } else if (openLobbyAfterBoot) {
    game!.suspend();
    lobby!.show();
  } else {
    game!.start();
  }
}

/**
 * A short "can we see your hand?" check before the first round. There is only
 * one gesture now, so this exists purely to confirm tracking works on this
 * machine and in this lighting before fruit starts falling.
 */
function calibrate(): Promise<void> {
  return new Promise((resolve) => {
    let raf = 0;
    let seenSince = 0;
    let lastState = '';

    const finish = () => {
      cancelAnimationFrame(raf);
      hud.hideOverlay();
      resolve();
    };

    const render = (seen: boolean, held: number) => {
      const key = `${seen}|${held > 600}`;
      if (key === lastState) return;
      lastState = key;
      hud.showRaw(`
        <div class="kicker">Warm-up</div>
        <h2>${seen ? 'Got you' : 'Raise your hand'}</h2>
        <p>Hold your hand up where the camera can see it.</p>
        <div class="moves">
          <div class="move ${seen ? 'active done' : ''}" data-a="slice">
            <div class="emoji">${seen ? '\u{1F5E1}\uFE0F' : '\u{1F44B}'}</div>
            <div><b>${seen ? 'Got it' : 'Looking for your hand\u2026'}</b><small>${
              seen
                ? 'Now swing it like a sword.'
                : 'Keep your whole hand in view. Good light helps.'
            }</small></div>
            <div class="check">${seen ? '\u2705' : '\u2B1C\uFE0F'}</div>
          </div>
        </div>
        <button class="primary" data-action="go">${seen ? 'Start playing' : 'Start anyway'}</button>
      `);
      hud.panelEl.querySelector('[data-action="go"]')?.addEventListener('click', finish);
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const hands = tracker.getHands(now, window.innerWidth, window.innerHeight);
      const seen = hands.length > 0;
      hud.setHandPresent(seen);
      if (seen) {
        if (!seenSince) seenSince = now;
      } else {
        seenSince = 0;
      }
      const held = seenSince ? now - seenSince : 0;
      render(seen, held);
      // Once tracking has been solid for a moment, get out of the way.
      if (held > 1400) finish();
    };

    loop();
  });
}

/** Set when the player chose two-player from the welcome screen. */
let openLobbyAfterBoot = false;
/** Set when the app was opened from an invite link. */
let joinCode: string | null = null;

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  switch (e.key.toLowerCase()) {
    case 'd':
      if (game) game.showDebug = !game.showDebug;
      break;
    case 'm':
      hud.toggleSound();
      break;
    case 'p':
      if (!game) break;
      if (game.phase === 'playing') game.pause();
      else game.resumeFromPause();
      break;
    case 'r':
      hud.setVersusChrome(false);
      lobby?.close();
      game?.start();
      break;
    case '2':
      if (game && lobby) {
        game.suspend();
        hud.setVersusChrome(false);
        lobby.show();
      }
      break;
    case 'v':
      // Toggle sending our own camera mid-match; no renegotiation needed.
      lobby?.toggleVideo();
      break;
  }
});

if (import.meta.env.DEV) {
  // Dev-only handle so the game can be stepped and inspected from the console.
  Object.defineProperty(window, '__fruity', {
    value: {
      get game() {
        return game;
      },
      tracker,
      startPointerMode,
    },
  });
}

/**
 * Someone arriving from an invite link gets a single button and nothing else to
 * read. The tap is not optional — browsers only grant camera access from a user
 * gesture — but it is the only thing they have to do.
 */
function invited(code: string) {
  joinCode = code;
  openLobbyAfterBoot = true;
  hud.showRaw(`
    <h1><span class="melon">\u{1F349}</span> Fruity</h1>
    <div class="kicker">You've been invited</div>
    <h2>Game ${code}</h2>
    <p>Tap to join. Wave your hand at the camera to swing a sword and slice
    the fruit. Highest score wins.</p>
    <button class="primary wide big" data-action="join">Join the game</button>
    <div class="foot">
      The camera is only used to see your hand.<br />
      No webcam? <a href="#" data-action="pointer" class="link">use the mouse instead</a>
    </div>
  `);
  hud.panelEl.querySelector('[data-action="join"]')?.addEventListener('click', () => {
    void boot();
  });
  hud.panelEl.querySelector('[data-action="pointer"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    void startPointerMode();
  });
}

const invitedTo = codeFromUrl();
if (invitedTo) invited(invitedTo);
else welcome();
