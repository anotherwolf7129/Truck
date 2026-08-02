/**
 * Instrument panel and escort radio.
 *
 * The gauges here are the ones that actually matter on a permit move: air
 * pressure, brake temperature, per-axle weights, and the two warnings that end
 * the job -- rollover and jackknife. Speed is almost an afterthought.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.root.innerHTML = TEMPLATE;

    this.el = {
      speed: root.querySelector('#speed'),
      speedUnit: root.querySelector('#speed-unit'),
      gear: root.querySelector('#gear'),
      rpmBar: root.querySelector('#rpm-bar'),
      rpmText: root.querySelector('#rpm-text'),
      psi: root.querySelector('#psi'),
      psiBar: root.querySelector('#psi-bar'),
      brakeTemp: root.querySelector('#brake-temp'),
      brakeTempBar: root.querySelector('#brake-temp-bar'),
      advisory: root.querySelector('#advisory'),
      limit: root.querySelector('#limit'),
      signal: root.querySelector('#signal'),
      distance: root.querySelector('#distance'),
      grade: root.querySelector('#grade'),
      rollover: root.querySelector('#rollover-fill'),
      jackknife: root.querySelector('#jackknife-fill'),
      radio: root.querySelector('#radio-log'),
      axles: root.querySelector('#axle-table'),
      warnings: root.querySelector('#warnings'),
      permit: root.querySelector('#permit'),
      convoy: root.querySelector('#convoy-list'),
      indicators: root.querySelector('#indicators'),
      clock: root.querySelector('#clock'),
      paused: root.querySelector('#paused'),
    };

    this._lastRadioCount = 0;
    this._warningState = new Map();
  }

  /** Formats a newton load as pounds with thousands separators. */
  static lb(n) {
    return Math.round(n * 0.2248089431).toLocaleString();
  }

  update(game) {
    const rig = game.rig;
    const t = rig.telemetry;

    // --- Primary gauges -----------------------------------------------------
    const mph = Math.abs(t.speedMph);
    this.el.speed.textContent = mph < 0.5 ? '0' : mph.toFixed(0);
    this.el.gear.textContent = rig.powertrain.gearLabel;

    const rpmFraction = Math.max(0, Math.min(1, (t.rpm - 500) / (rig.powertrain.maxRpm - 500)));
    this.el.rpmBar.style.width = `${rpmFraction * 100}%`;
    this.el.rpmBar.classList.toggle('redline', t.rpm > 1950);
    this.el.rpmText.textContent = `${Math.round(t.rpm)}`;

    // --- Air system ---------------------------------------------------------
    this.el.psi.textContent = `${Math.round(t.psi)}`;
    this.el.psiBar.style.width = `${Math.max(0, Math.min(1, t.psi / 130)) * 100}%`;
    this.el.psiBar.className = 'bar-fill';
    if (t.psi < 60) this.el.psiBar.classList.add('critical');
    else if (t.psi < 85) this.el.psiBar.classList.add('warn');

    // --- Brake temperature --------------------------------------------------
    const temp = t.brakeTempC;
    this.el.brakeTemp.textContent = `${Math.round(temp)}°C`;
    const tempFrac = Math.max(0, Math.min(1, (temp - 20) / 480));
    this.el.brakeTempBar.style.width = `${tempFrac * 100}%`;
    this.el.brakeTempBar.className = 'bar-fill';
    if (temp > 380) this.el.brakeTempBar.classList.add('critical');
    else if (temp > 240) this.el.brakeTempBar.classList.add('warn');

    // --- Risk meters --------------------------------------------------------
    this.setMeter(this.el.rollover, t.rollover);
    this.setMeter(this.el.jackknife, t.jackknife);

    // --- Route --------------------------------------------------------------
    const remaining = Math.max(0, game.route.destination.s - game.convoyS);
    this.el.distance.textContent = `${(remaining / 1609.34).toFixed(2)} mi`;
    this.el.advisory.textContent = `${Math.round(game.advisoryMph)}`;
    this.el.limit.textContent = `${Math.round(game.speedLimitMph ?? game.route.speedLimitAt(game.convoyS))}`;
    const grade = game.route.gradeAt(game.convoyS) * 100;
    this.el.grade.textContent = `${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%`;
    this.el.grade.className = grade < -4 ? 'value warn' : 'value';

    // The next light. Green because a unit has it reads differently from green
    // because it happens to be green, so the two are labelled differently.
    const sig = game.nextSignal;
    if (!sig) {
      this.el.signal.textContent = '—';
      this.el.signal.className = 'value';
    } else {
      const distance = sig.distance > 950
        ? `${(sig.distance / 1609.34).toFixed(1)} mi`
        : `${Math.round(sig.distance)} m`;
      this.el.signal.textContent = sig.held
        ? `held · ${distance}`
        : `${sig.phase} · ${distance}`;
      this.el.signal.className = sig.held
        ? 'value ok'
        : sig.phase === 'green' ? 'value' : 'value critical';
    }

    this.el.clock.textContent = formatClock(game.clockHour);

    // --- Axle weights -------------------------------------------------------
    // Damped the way an onboard air-gauge scale is. The instantaneous
    // suspension load swings by thousands of pounds over every joint in the
    // pavement; nobody reads a scale that twitches.
    const groups = rig.axleWeights();
    this._axleSmooth ??= groups.map((g) => g.lb);
    this.el.axles.innerHTML = groups
      .map((g, i) => {
        this._axleSmooth[i] += (g.lb - this._axleSmooth[i]) * 0.06;
        return `<div class="axle-row"><span>${g.label}</span>` +
          `<span>${Math.round(this._axleSmooth[i]).toLocaleString()} lb</span></div>`;
      })
      .join('');

    // --- Convoy -------------------------------------------------------------
    this.el.convoy.innerHTML = game.convoy.vehicles
      .map((v) => {
        const gap = Math.round(v.s - game.convoyS);
        const label = game.convoy.unitName(v);
        const state = v.state === 'blocking'
          ? (v.assignment?.signalised
            ? `light at ${v.assignment.name}`
            : `holding ${v.assignment?.name ?? ''}`)
          : v.state === 'advance' ? `running ahead`
          : v.state === 'rejoin' ? 'catching up' : 'on station';
        return `<div class="convoy-row"><span class="cv-name">${label}</span>` +
          `<span class="cv-state">${state}</span>` +
          `<span class="cv-gap">${gap > 0 ? '+' : ''}${gap} m</span></div>`;
      })
      .join('');

    // --- Indicator lamps ----------------------------------------------------
    const lamps = [
      ['PARK', rig.air.parkingBrake, 'critical'],
      ['LOW AIR', rig.air.lowPressureWarning, 'critical'],
      ['JAKE', rig.powertrain.engineBrakeStage > 0, 'ok'],
      ['DIFF', rig.diffLock, 'ok'],
      ['AUTO', game.autoShift, 'ok'],
      ['R-STEER', Math.abs(rig.trailerSteerAngle) > 0.02, 'ok'],
      ['MUTE', game.audio.muted, 'critical'],
    ];
    this.el.indicators.innerHTML = lamps
      .map(([name, on, kind]) => `<span class="lamp ${on ? kind : 'off'}">${name}</span>`)
      .join('');

    this.updateWarnings(game);
    this.updateRadio(game.convoy.radio);
  }

  /** The pause overlay is driven directly, since update() stops while paused. */
  setPaused(paused) {
    this.el.paused.classList.toggle('visible', paused);
  }

  setMeter(el, value) {
    const pct = Math.max(0, Math.min(1, value)) * 100;
    el.style.width = `${pct}%`;
    el.className = 'meter-fill';
    if (value > 0.8) el.classList.add('critical');
    else if (value > 0.55) el.classList.add('warn');
  }

  /** Big centre-screen warnings, only for things that will end the move. */
  updateWarnings(game) {
    const rig = game.rig;
    const active = [];

    if (rig.telemetry.rollover > 0.78) active.push(['ROLLOVER RISK', 'Slow down and unwind the wheel']);
    if (rig.telemetry.jackknife > 0.7) active.push(['JACKKNIFE', 'Ease off the brakes, straighten the tractor']);
    if (rig.telemetry.brakeTempC > 400) active.push(['BRAKES OVERHEATING', 'Gear down and use the compression brake']);
    if (rig.air.lowPressureWarning) active.push(['LOW AIR PRESSURE', 'Stop while you still can']);
    if (game.clearanceAlarm) active.push(['LOW CLEARANCE AHEAD', game.clearanceAlarm]);
    if (game.offRoute) active.push(['OFF THE PERMITTED ROUTE', 'Get back on the surveyed corridor']);

    this.el.warnings.innerHTML = active
      .map(([title, sub]) => `<div class="warning"><b>${title}</b><span>${sub}</span></div>`)
      .join('');
  }

  updateRadio(radio) {
    // Against `total` rather than `messages.length`: the buffer stops growing
    // once it is full, so comparing the length silently freezes the panel for
    // the rest of the move.
    if (radio.total === this._lastRadioCount) return;
    this._lastRadioCount = radio.total;
    this.el.radio.innerHTML = radio
      .recent(7)
      .map((m) => `<div class="radio-line ${m.priority}"><b>${m.from}:</b> ${m.text}</div>`)
      .join('');
    this.el.radio.scrollTop = this.el.radio.scrollHeight;
  }

  setPermit(rig, route) {
    const cargo = rig.cargo;
    const widthFt = cargo.size.x * 3.28084;
    const heightM = rig.loadHeight ?? 0;
    this.el.permit.innerHTML = `
      <div class="permit-row"><span>Load</span><span>${cargo.name}</span></div>
      <div class="permit-row"><span>Gross</span><span>${Math.round(rig.grossWeightLb).toLocaleString()} lb</span></div>
      <div class="permit-row"><span>Width</span><span>${widthFt.toFixed(1)} ft</span></div>
      <div class="permit-row"><span>Height</span><span>${(heightM * 3.28084).toFixed(2)} ft (${heightM.toFixed(2)} m)</span></div>
      <div class="permit-row"><span>Length</span><span>87 ft combination</span></div>
      <div class="permit-row"><span>Route</span><span>${route.staging.name} &rarr; ${route.destination.name}</span></div>
    `;
  }
}

function formatClock(hour) {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

const TEMPLATE = /* html */`
<div id="hud">
  <div class="panel top-left">
    <div class="panel-title">Permit 24-0881-OS</div>
    <div id="permit"></div>
  </div>

  <div class="panel top-right">
    <div class="panel-title">Convoy <span id="clock" class="muted"></span></div>
    <div id="convoy-list"></div>
    <div class="panel-title" style="margin-top:10px">Axle weights</div>
    <div id="axle-table"></div>
  </div>

  <div id="warnings"></div>

  <div id="paused"><div class="paused-card">Paused<span>Esc to carry on</span></div></div>

  <div class="panel bottom-left" id="radio-panel">
    <div class="panel-title">Escort radio</div>
    <div id="radio-log"></div>
  </div>

  <div class="cluster">
    <div class="cluster-main">
      <div class="readout">
        <div id="speed">0</div>
        <div id="speed-unit">mph</div>
      </div>
      <div class="gearbox">
        <div class="label">gear</div>
        <div id="gear">N</div>
      </div>
      <div class="advisory-box">
        <div class="label">advisory</div>
        <div id="advisory">45</div>
      </div>
      <div class="limit-sign">
        <div class="label">Speed<br>Limit</div>
        <div id="limit">45</div>
      </div>
    </div>

    <div class="cluster-bars">
      <div class="gauge">
        <div class="gauge-label">RPM <span id="rpm-text" class="muted"></span></div>
        <div class="bar"><div id="rpm-bar" class="bar-fill"></div></div>
      </div>
      <div class="gauge">
        <div class="gauge-label">Air <span id="psi" class="muted"></span> psi</div>
        <div class="bar"><div id="psi-bar" class="bar-fill"></div></div>
      </div>
      <div class="gauge">
        <div class="gauge-label">Brakes <span id="brake-temp" class="muted"></span></div>
        <div class="bar"><div id="brake-temp-bar" class="bar-fill"></div></div>
      </div>
    </div>

    <div class="cluster-risk">
      <div class="risk">
        <div class="risk-label">Rollover</div>
        <div class="meter"><div id="rollover-fill" class="meter-fill"></div></div>
      </div>
      <div class="risk">
        <div class="risk-label">Jackknife</div>
        <div class="meter"><div id="jackknife-fill" class="meter-fill"></div></div>
      </div>
      <div class="risk">
        <div class="risk-label">To go</div>
        <div class="value" id="distance">0.0 mi</div>
      </div>
      <div class="risk">
        <div class="risk-label">Grade</div>
        <div class="value" id="grade">0.0%</div>
      </div>
      <div class="risk">
        <div class="risk-label">Next signal</div>
        <div class="value" id="signal">—</div>
      </div>
    </div>

    <div id="indicators"></div>
  </div>
</div>
`;
