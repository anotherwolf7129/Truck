import { Game } from './Game.js';
import { TRAILERS, DEFAULT_TRAILER, getTrailer } from './physics/Trailers.js';
import './ui/style.css';

const canvas = document.getElementById('view');
const hudRoot = document.getElementById('hud-root');
const loading = document.getElementById('loading');
const startScreen = document.getElementById('start-screen');
const startButton = document.getElementById('start-button');
const picker = document.getElementById('trailer-picker');

/**
 * The yard: one card per trailer, and picking one rebuilds the combination.
 *
 * Swapping trailers is not a cosmetic choice -- it changes the number of rigid
 * bodies, the number of axles, the length of the whole thing and how many
 * engines are pushing it -- so choosing here rather than mid-move is deliberate.
 */
function buildPicker(game, selected) {
  picker.innerHTML = TRAILERS.map((t) => `
    <button class="trailer-card${t.id === selected ? ' selected' : ''}" data-id="${t.id}">
      <b>${t.name}</b>
      <span class="trailer-summary">${t.summary}</span>
      <span class="trailer-blurb">${t.blurb}</span>
    </button>
  `).join('');

  for (const card of picker.querySelectorAll('.trailer-card')) {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      game.setTrailer(id);
      for (const other of picker.querySelectorAll('.trailer-card')) {
        other.classList.toggle('selected', other === card);
      }
      const url = new URL(window.location);
      url.searchParams.set('trailer', id);
      window.history.replaceState({}, '', url);
    });
  }
}

async function boot() {
  const requested = new URLSearchParams(window.location.search).get('trailer');
  const trailer = getTrailer(requested ?? DEFAULT_TRAILER).id;

  let game;
  try {
    game = new Game(canvas, hudRoot, { trailer });
  } catch (err) {
    loading.innerHTML = `<div class="fatal"><h2>Failed to start</h2><pre>${
      String(err && err.stack ? err.stack : err)
    }</pre></div>`;
    throw err;
  }

  loading.style.display = 'none';
  startScreen.classList.add('visible');
  buildPicker(game, trailer);

  const begin = () => {
    startScreen.classList.remove('visible');
    // This click (or Enter) is the user gesture the browser requires before it
    // will hand over a running AudioContext, so the sound is built here rather
    // than alongside the rest of the game.
    game.attachAudio();
    game.start();
    canvas.focus();
  };
  startButton.addEventListener('click', begin);
  window.addEventListener('keydown', function once(e) {
    if (e.code === 'Enter') {
      window.removeEventListener('keydown', once);
      begin();
    }
  });

  // Expose for debugging from the console.
  window.game = game;
}

boot();
