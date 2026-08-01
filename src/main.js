import { Game } from './Game.js';
import { TRAILER_CONFIGS, loadSplit } from './physics/Trailers.js';
import './ui/style.css';

const canvas = document.getElementById('view');
const hudRoot = document.getElementById('hud-root');
const loading = document.getElementById('loading');
const startScreen = document.getElementById('start-screen');
const startButton = document.getElementById('start-button');
const picker = document.getElementById('trailer-picker');

const TRACTOR_AND_JEEP = 14500;
let selected = TRAILER_CONFIGS[0].id;

/** Builds the rig chooser on the start screen. */
function buildPicker() {
  picker.innerHTML = TRAILER_CONFIGS.map((c) => {
    const split = loadSplit(c);
    const grossLb = Math.round((TRACTOR_AND_JEEP + split.mass) * 2.20462);
    const lengthFt = Math.round((c.gooseneckZ - c.axleZ[c.axleZ.length - 1] + 10.9) * 3.28084);
    const heightFt = ((0.55 + c.cargo.size.y) * 3.28084).toFixed(1);
    return `
      <button class="trailer-option${c.id === selected ? ' selected' : ''}" data-id="${c.id}">
        <span class="t-name">${c.name}</span>
        <span class="t-cargo">${c.cargo.name}</span>
        <span class="t-stats">${grossLb.toLocaleString()} lb &middot; ${lengthFt} ft &middot; ${heightFt} ft high &middot; ${c.axleZ.length} trailer axles</span>
        <span class="t-blurb">${c.blurb}</span>
      </button>`;
  }).join('');

  picker.querySelectorAll('.trailer-option').forEach((el) => {
    el.addEventListener('click', () => {
      selected = el.dataset.id;
      picker.querySelectorAll('.trailer-option').forEach((o) => o.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

async function boot() {
  buildPicker();
  loading.style.display = 'none';
  startScreen.classList.add('visible');

  let started = false;
  const begin = () => {
    if (started) return;
    started = true;

    let game;
    try {
      game = new Game(canvas, hudRoot, { trailer: selected });
    } catch (err) {
      loading.style.display = 'flex';
      loading.innerHTML = `<div class="fatal"><h2>Failed to start</h2><pre>${
        String(err && err.stack ? err.stack : err)
      }</pre></div>`;
      throw err;
    }

    startScreen.classList.remove('visible');
    game.start();
    canvas.focus();
    // Exposed for the console: game.jumpTo(metres, mph) moves the whole convoy.
    window.game = game;
  };

  startButton.addEventListener('click', begin);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') begin();
  });
}

boot();
