import { Game } from './Game.js';
import './ui/style.css';

const canvas = document.getElementById('view');
const hudRoot = document.getElementById('hud-root');
const loading = document.getElementById('loading');
const startScreen = document.getElementById('start-screen');
const startButton = document.getElementById('start-button');

async function boot() {
  let game;
  try {
    game = new Game(canvas, hudRoot);
  } catch (err) {
    loading.innerHTML = `<div class="fatal"><h2>Failed to start</h2><pre>${
      String(err && err.stack ? err.stack : err)
    }</pre></div>`;
    throw err;
  }

  loading.style.display = 'none';
  startScreen.classList.add('visible');

  const begin = () => {
    startScreen.classList.remove('visible');
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
