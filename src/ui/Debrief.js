/**
 * End-of-move debrief.
 *
 * Deliberately styled as a permit sign-off rather than a score screen: the
 * interesting question after a heavy haul job is not how many points you got,
 * it is which of the things that could have gone wrong nearly did.
 */

const OUTCOME_TITLE = {
  delivered: 'Load delivered',
  rolled: 'Load lost',
};

const MARK = { pass: '✓', warn: '!', fail: '✕' };

export class Debrief {
  constructor(root) {
    this.root = document.createElement('div');
    this.root.id = 'debrief';
    root.appendChild(this.root);
    this.onRestart = null;
  }

  hide() {
    this.root.classList.remove('visible');
    this.root.innerHTML = '';
    document.getElementById('hud')?.classList.remove('behind-debrief');
  }

  /**
   * @param scorecard  a finished Scorecard
   * @param route      the route, for the destination name
   * @param rig        the combination, for the permit it was moved under
   */
  show(scorecard, route, rig = null) {
    const title = OUTCOME_TITLE[scorecard.outcome] ?? 'Move ended';
    const lines = scorecard.lines
      .map((l) => `
        <div class="debrief-row ${l.verdict}">
          <span class="mark">${MARK[l.verdict]}</span>
          <span class="dl-label">${l.label}</span>
          <span class="dl-value">${l.value}</span>
          <span class="dl-note">${l.note}</span>
        </div>`)
      .join('');

    const miles = scorecard.distanceMi.toFixed(2);
    const minutes = scorecard.minutes.toFixed(0);
    const avg = scorecard.minutes > 0
      ? (scorecard.distanceMi / (scorecard.minutes / 60)).toFixed(1)
      : '0.0';

    this.root.innerHTML = /* html */`
      <div class="start-card debrief-card ${scorecard.grade}">
        <div class="sub">Permit ${rig?.spec?.permitNo ?? ''} &mdash; ${rig?.spec?.name ?? ''}
          &mdash; ${route.destination.name}</div>
        <h1>${title}</h1>
        <p class="debrief-verdict">${scorecard.verdictText}</p>

        <div class="debrief-summary">
          <div><span>Distance</span><b>${miles} mi</b></div>
          <div><span>On the road</span><b>${minutes} min</b></div>
          <div><span>Average</span><b>${avg} mph</b></div>
        </div>

        <div class="debrief-rows">${lines}</div>

        <button id="debrief-restart">Run it again</button>
      </div>
    `;

    this.root.querySelector('#debrief-restart').addEventListener('click', () => {
      this.hide();
      this.onRestart?.();
    });

    // The instrument panel is not part of the debrief -- the move is over.
    document.getElementById('hud')?.classList.add('behind-debrief');
    this.root.classList.add('visible');
  }
}
