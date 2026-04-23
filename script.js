"use strict";

// ======================================================
// AppConfig — Constantes de configuration globales
// ======================================================

const AppConfig = Object.freeze({
  MARKER_PCT:        70,
  START3_PCT:        25,
  SCHED_INTERVAL_MS: 25,
  LOOKAHEAD_SEC:     0.15,
  MIN_SAFETY_SEC:    0.01,
  NOISE_DURATION_SEC: 3,
  BEEP_FREQ_HZ:      440,
  APNEA_MIN_SEC:     1,
  APNEA_MAX_SEC:     1800,
  EXP_MIN_MS:        0,
  EXP_MAX_MS:        10 * 60_000,
  NUDGE_MIN_MS:      125,
  NUDGE_MAX_MS:      500,
  NUDGE_DEFAULT_MS:  250,
  APNEA_DEFAULT_SEC: 30,
  EXP_DEFAULT_MS:    4500,
  AUDIO_START_OFFSET_SEC: 0.02,
});


// ======================================================
// Helpers — fonctions utilitaires pures
// ======================================================

const Helpers = Object.freeze({
  clampInt(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  },

  formatSec(ms) {
    return (ms / 1000).toFixed(3);
  },

  mod(a, n) {
    return ((a % n) + n) % n;
  },
});


// ======================================================
// CycleEngine — logique du cycle (phases, timings, nudge)
// ======================================================

class CycleEngine {
  constructor() {
    this._apneaMs      = AppConfig.APNEA_DEFAULT_SEC * 1000;
    this._expMs        = AppConfig.EXP_DEFAULT_MS;
    this._activeApnea  = this._apneaMs;
    this._activeExp    = this._expMs;

    this._pendingApnea = null;
    this._pendingExp   = null;
    this._hasPending   = false;

    this._phaseOffsetMs = 0;
    this._cycleIndex    = 0;
  }

  // --- Getters publics ---

  get apneaMs()      { return this._apneaMs; }
  get expMs()        { return this._expMs; }
  get activeApneaMs(){ return this._activeApnea; }
  get activeExpMs()  { return this._activeExp; }
  get cycleDurationMs() { return this._activeApnea + this._activeExp; }
  get phaseOffsetMs()   { return this._phaseOffsetMs; }
  get cycleIndex()      { return this._cycleIndex; }

  // --- Setters avec gestion des changements en cours ---

  setApnea(ms, isRunning) {
    const value = Helpers.clampInt(ms, AppConfig.APNEA_MIN_SEC * 1000, AppConfig.APNEA_MAX_SEC * 1000);
    if (isRunning) {
      this._pendingApnea = value;
      this._hasPending   = true;
    } else {
      this._apneaMs     = value;
      this._activeApnea = value;
    }
  }

  setExp(ms, isRunning) {
    const value = Helpers.clampInt(ms, AppConfig.EXP_MIN_MS, AppConfig.EXP_MAX_MS);
    if (isRunning) {
      this._pendingExp = value;
      this._hasPending = true;
    } else {
      this._expMs     = value;
      this._activeExp = value;
    }
  }

  // --- Calcul de la phase visuelle ---

  computePhaseMs(nowPerf, cycleStartPerf) {
    return (nowPerf - cycleStartPerf) + this._phaseOffsetMs;
  }

  // --- Nudge (décalage de phase) ---

  nudge(deltaMs) {
    this._phaseOffsetMs += deltaMs;
  }

  resetPhaseOffset() {
    this._phaseOffsetMs = 0;
  }

  // --- Gestion du cycle (appelé à chaque rollover) ---

  onCycleRollover() {
    this._cycleIndex++;

    if (this._hasPending) {
      if (this._pendingApnea !== null) this._apneaMs = this._pendingApnea;
      if (this._pendingExp   !== null) this._expMs   = this._pendingExp;
      this._pendingApnea = null;
      this._pendingExp   = null;
      this._hasPending   = false;
    }

    this._activeApnea = this._apneaMs;
    this._activeExp   = this._expMs;
  }

  // --- Reset complet ---

  reset() {
    this._phaseOffsetMs = 0;
    this._cycleIndex    = 0;
    this._pendingApnea  = null;
    this._pendingExp    = null;
    this._hasPending    = false;
    this._activeApnea   = this._apneaMs;
    this._activeExp     = this._expMs;
  }

  incrementCycleIndex() {
    this._cycleIndex++;
  }

  // --- Mapping phase (ms) → pourcentage barre ---

  phaseToPct(phaseMs) {
    const P_sortie = AppConfig.MARKER_PCT / 100;
    const P_3s     = AppConfig.START3_PCT / 100;

    const apnea  = Math.max(1, this._activeApnea);
    const exhale = Math.max(1, this._activeExp);
    const t3     = Math.min(3000, apnea);

    if (phaseMs <= t3) {
      return (phaseMs / t3) * (P_3s * 100);
    }
    if (phaseMs <= apnea) {
      const tA2 = apnea - t3;
      const pA2 = (P_sortie - P_3s) * 100;
      return (P_3s * 100) + ((phaseMs - t3) / Math.max(1, tA2)) * pA2;
    }
    const tB = Math.min(phaseMs - apnea, exhale);
    return (P_sortie * 100) + (tB / exhale) * ((1 - P_sortie) * 100);
  }
}


// ======================================================
// AudioService — Web Audio API, scheduler lookahead
// ======================================================

class AudioService {
  constructor() {
    this._ctx         = null;
    this._masterGain  = null;
    this._noiseBuf    = null;

    // Synchronisation temps perf ↔ temps audio
    this._startAudioPerf = 0;
    this._startAudioTime = 0;

    // Scheduler
    this._schedTimer  = null;
    this._cycleStartAudioTime = 0;

    // Anti-doublon
    this._lastPlannedTingleTime = -Infinity;
    this._lastPlanned = { tingleCycle: -1, beep3Cycle: -1, beep2Cycle: -1, beep1Cycle: -1 };
  }

  // --- Initialisation / reprise du contexte audio ---

  async ensure() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._ctx.state !== "running") {
      try { await this._ctx.resume(); } catch (_) {}
    }
    if (this._ctx.state === "running" && !this._masterGain) {
      this._masterGain = this._ctx.createGain();
      this._masterGain.gain.setValueAtTime(1, this._ctx.currentTime);
      this._masterGain.connect(this._ctx.destination);
    }
    return this._ctx.state === "running";
  }

  get isRunning() {
    return this._ctx && this._ctx.state === "running";
  }

  get currentTime() {
    return this._ctx ? this._ctx.currentTime : 0;
  }

  get cycleStartAudioTime() {
    return this._cycleStartAudioTime;
  }

  // --- Synchronisation avec le moteur de cycle ---

  syncOnStart(nowPerf, isResume, pausedPhaseMs) {
    this._startAudioPerf = nowPerf;
    this._startAudioTime = this._ctx.currentTime;

    if (isResume) {
      this._cycleStartAudioTime = this._ctx.currentTime - (pausedPhaseMs / 1000);
    } else {
      this._cycleStartAudioTime = this._ctx.currentTime + AppConfig.AUDIO_START_OFFSET_SEC;
    }
  }

  advanceCycleStart(cycleDurationMs) {
    this._cycleStartAudioTime += cycleDurationMs / 1000;
  }

  // --- Nudge (décalage audio synchronisé) ---

  nudge(deltaMs) {
    this._cycleStartAudioTime -= deltaMs / 1000;
  }

  // --- Gestion du gain ---

  unmute() {
    if (!this.isRunning || !this._masterGain) return;
    this._masterGain.gain.cancelScheduledValues(this._ctx.currentTime);
    this._masterGain.gain.setValueAtTime(1, this._ctx.currentTime);
  }

  mute() {
    if (!this.isRunning || !this._masterGain) return;
    this._masterGain.gain.setValueAtTime(0, this._ctx.currentTime);
  }

  // --- Buffer de bruit blanc (lazy) ---

  _getNoiseBuffer() {
    if (this._noiseBuf) return this._noiseBuf;
    const sr  = this._ctx.sampleRate;
    const len = Math.floor(AppConfig.NOISE_DURATION_SEC * sr);
    const buf = this._ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  // --- Sons ---

  _playSoftBeepAt(t) {
    if (!this.isRunning || !this._masterGain) return;
    const osc  = this._ctx.createOscillator();
    const gain = this._ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(AppConfig.BEEP_FREQ_HZ, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(1, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

    osc.connect(gain);
    gain.connect(this._masterGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  _playCycleStartTingleAt(tStartAudio, durationSec) {
    if (!this.isRunning || !this._masterGain) return;
    const nowA = this._ctx.currentTime;
    const t0 = Math.max(nowA + AppConfig.MIN_SAFETY_SEC, tStartAudio);
    const t1 = t0 + Math.max(0.05, durationSec);

    const src  = this._ctx.createBufferSource();
    src.buffer = this._getNoiseBuffer();
    src.loop   = false;

    const band = this._ctx.createBiquadFilter();
    band.type  = "bandpass";
    band.Q.setValueAtTime(10, t0);
    band.frequency.setValueAtTime(600, t0);
    band.frequency.exponentialRampToValueAtTime(3800, t1);

    const gain = this._ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.50, t0 + Math.min(0.7, durationSec * 0.6));
    gain.gain.linearRampToValueAtTime(0.0001, t1);

    const lfo     = this._ctx.createOscillator();
    const lfoGain = this._ctx.createGain();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(28, t0);
    lfoGain.gain.setValueAtTime(0.025, t0);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    src.connect(band);
    band.connect(gain);
    gain.connect(this._masterGain);

    src.start(t0);
    src.stop(t1);
    lfo.start(t0);
    lfo.stop(t1 + 0.02);
  }

  // --- Scheduler lookahead ---

  resetPlanned() {
    this._lastPlanned = { tingleCycle: -1, beep3Cycle: -1, beep2Cycle: -1, beep1Cycle: -1 };
    this._lastPlannedTingleTime = -Infinity;
  }

  resetPlannedTingle() {
    this._lastPlannedTingleTime = -Infinity;
  }

  /**
   * @param {CycleEngine} engine
   * @param {boolean} beepEnabled
   */
  schedulerTick(engine, beepEnabled) {
    if (!this.isRunning) return;
    if (!beepEnabled) return;

    const nowA    = this._ctx.currentTime;
    const horizon = nowA + AppConfig.LOOKAHEAD_SEC;
    const durSec  = Math.max(0.001, engine.cycleDurationMs / 1000);

    // Tingle de début de cycle
    let tTingle = this._cycleStartAudioTime;
    while (tTingle < nowA - 0.002) tTingle += durSec;

    if (tTingle <= horizon && Math.abs(tTingle - this._lastPlannedTingleTime) > 1e-4) {
      this._playCycleStartTingleAt(tTingle - 0.03, Math.min(3, durSec));
      this._lastPlannedTingleTime = tTingle;
    }

    // Beeps de décompte (3, 2, 1 s avant fin d'apnée)
    if (engine.activeApneaMs >= 3000) {
      const t3 = this._cycleStartAudioTime + (engine.activeApneaMs - 3000) / 1000;
      const t2 = this._cycleStartAudioTime + (engine.activeApneaMs - 2000) / 1000;
      const t1 = this._cycleStartAudioTime + (engine.activeApneaMs - 1000) / 1000;
      const ci = engine.cycleIndex;

      if (ci !== this._lastPlanned.beep3Cycle && t3 >= nowA - 0.002 && t3 <= horizon) {
        this._playSoftBeepAt(t3);
        this._lastPlanned.beep3Cycle = ci;
      }
      if (ci !== this._lastPlanned.beep2Cycle && t2 >= nowA - 0.002 && t2 <= horizon) {
        this._playSoftBeepAt(t2);
        this._lastPlanned.beep2Cycle = ci;
      }
      if (ci !== this._lastPlanned.beep1Cycle && t1 >= nowA - 0.002 && t1 <= horizon) {
        this._playSoftBeepAt(t1);
        this._lastPlanned.beep1Cycle = ci;
      }
    }
  }

  startScheduler(engine, beepEnabledFn) {
    this.stopScheduler();
    this._schedTimer = setInterval(
      () => this.schedulerTick(engine, beepEnabledFn()),
      AppConfig.SCHED_INTERVAL_MS
    );
  }

  stopScheduler() {
    if (this._schedTimer) {
      clearInterval(this._schedTimer);
      this._schedTimer = null;
    }
  }

  // --- Helpers pour la resynchronisation après nudge ---

  recomputePlannedAfterNudge(engine) {
    const phaseMs = Helpers.mod(
      (this._ctx.currentTime - this._cycleStartAudioTime) * 1000,
      engine.cycleDurationMs
    );

    this._lastPlannedTingleTime = -Infinity;

    if (phaseMs > 50) this._lastPlanned.tingleCycle = engine.cycleIndex;
    else              this._lastPlanned.tingleCycle = -1;

    if (engine.activeApneaMs >= 3000) {
      const ci = engine.cycleIndex;
      this._lastPlanned.beep3Cycle = (phaseMs >= engine.activeApneaMs - 3000) ? ci : -1;
      this._lastPlanned.beep2Cycle = (phaseMs >= engine.activeApneaMs - 2000) ? ci : -1;
      this._lastPlanned.beep1Cycle = (phaseMs >= engine.activeApneaMs - 1000) ? ci : -1;
    }
  }

  getPhaseMs(engine) {
    const raw = (this._ctx.currentTime - this._cycleStartAudioTime) * 1000;
    return Helpers.mod(Math.max(0, raw), engine.cycleDurationMs);
  }
}


// ======================================================
// BarRenderer — rendu visuel de la barre et des labels
// ======================================================

class BarRenderer {
  constructor() {
    this._fillEl          = document.getElementById("fill");
    this._markerEl        = document.getElementById("marker30");
    this._marker3El       = document.getElementById("marker3");
    this._marker0El       = document.getElementById("marker0");
    this._sortieLabelEl   = document.getElementById("sortieLabel");
    this._startLabelEl    = document.getElementById("startLabel");
    this._arriveeLabelEl  = document.getElementById("arriveeLabel");
    this._inspiStartLabel = document.getElementById("inspiStartLabel");
    this._cycleTextEl     = document.getElementById("cycleText");
    this._tTextEl         = document.getElementById("tText");
  }

  /**
   * Met à jour les positions des repères selon le moteur de cycle.
   * @param {CycleEngine} engine
   */
  updateMarkers(engine) {
    const pct3 = engine.phaseToPct(3000);

    if (this._marker0El)       this._marker0El.style.left       = "0%";
    if (this._inspiStartLabel) this._inspiStartLabel.style.left = "0%";

    if (this._markerEl)      this._markerEl.style.left      = `${AppConfig.MARKER_PCT}%`;
    if (this._sortieLabelEl) this._sortieLabelEl.style.left  = `${AppConfig.MARKER_PCT}%`;

    if (this._marker3El)    this._marker3El.style.left    = `${pct3}%`;
    if (this._startLabelEl) this._startLabelEl.style.left = `${pct3}%`;

    if (this._arriveeLabelEl) this._arriveeLabelEl.style.left = "100%";

    this._cycleTextEl.textContent = `Cycle = ${Helpers.formatSec(engine.cycleDurationMs)} s`;
  }

  /**
   * Rend la barre à une position de phase donnée.
   * @param {number} phaseMs
   * @param {CycleEngine} engine
   */
  render(phaseMs, engine) {
    const widthPct = engine.phaseToPct(phaseMs);
    this._fillEl.style.width      = `${widthPct.toFixed(6)}%`;
    this._tTextEl.textContent     = `t = ${Helpers.formatSec(phaseMs)} s`;
    this._cycleTextEl.textContent = `Cycle = ${Helpers.formatSec(engine.cycleDurationMs)} s`;
  }
}


// ======================================================
// CountdownController — overlay compte à rebours
// ======================================================

class CountdownController {
  constructor() {
    this._el    = document.getElementById("countdown");
    this._numEl = document.getElementById("countNum");
  }

  update(phaseMs, engine) {
    const inSortie = phaseMs >= engine.activeApneaMs - 3000
                  && phaseMs < engine.activeApneaMs;

    if (!inSortie) { this.hide(); return; }

    const sec = Math.ceil((engine.activeApneaMs - phaseMs) / 1000);
    this._show(sec);
  }

  _show(sec) {
    this._el.hidden       = false;
    this._numEl.textContent = String(sec);
  }

  hide() {
    this._el.hidden = true;
  }
}


// ======================================================
// UIController — gestion du DOM, boutons, inputs
// ======================================================

class UIController {
  constructor() {
    // Inputs
    this.apneaSecInput  = document.getElementById("apneaSec");
    this.expMsInput     = document.getElementById("expMs");
    this.beepEnabled    = document.getElementById("beepEnabled");
    this.nudgeMsSelect  = document.getElementById("nudgeMs");

    // Boutons
    this.startBtn       = document.getElementById("startBtn");
    this.stopBtn        = document.getElementById("stopBtn");
    this.resetBtn       = document.getElementById("resetBtn");
    this.jumpSortieBtn  = document.getElementById("jumpSortieBtn");
    this.nudgeBackBtn   = document.getElementById("nudgeBack");
    this.nudgeFwdBtn    = document.getElementById("nudgeFwd");
    this.uiToggleBtn    = document.getElementById("uiToggle");

    // Readout
    this._phaseTextEl   = document.getElementById("phaseText");

    // Valeur nudge
    this.nudgeMs = AppConfig.NUDGE_DEFAULT_MS;
  }

  setPhaseText(text) {
    this._phaseTextEl.textContent = text;
  }

  setRunningState() {
    this.startBtn.disabled    = true;
    this.stopBtn.disabled     = false;
    this.resetBtn.disabled    = false;
    this.nudgeBackBtn.disabled = false;
    this.nudgeFwdBtn.disabled  = false;
  }

  setStoppedState() {
    this.startBtn.disabled    = false;
    this.stopBtn.disabled     = true;
  }

  setResetState() {
    this.startBtn.disabled     = false;
    this.stopBtn.disabled      = true;
    this.resetBtn.disabled     = true;
    this.nudgeBackBtn.disabled = true;
    this.nudgeFwdBtn.disabled  = true;
  }

  setJumpSortieState() {
    this.startBtn.disabled     = false;
    this.stopBtn.disabled      = true;
    this.resetBtn.disabled     = false;
    this.nudgeBackBtn.disabled = false;
    this.nudgeFwdBtn.disabled  = false;
  }

  readApneaMs() {
    const sec = Helpers.clampInt(this.apneaSecInput.value, AppConfig.APNEA_MIN_SEC, AppConfig.APNEA_MAX_SEC);
    this.apneaSecInput.value = String(sec);
    return sec * 1000;
  }

  readExpMs() {
    return Helpers.clampInt(this.expMsInput.value, AppConfig.EXP_MIN_MS, AppConfig.EXP_MAX_MS);
  }

  isBeepEnabled() {
    return this.beepEnabled.checked;
  }

  toggleCompactUI() {
    if (document.body.classList.contains("patientMode")) {
      document.body.classList.remove("patientMode");
    } else {
      document.body.classList.toggle("compactUI");
    }
  }

  /**
   * Branche tous les event listeners, les callbacks sont fournis par App.
   * @param {object} handlers
   */
  bindEvents(handlers) {
    this.startBtn.addEventListener("click",      handlers.onStart);
    this.stopBtn.addEventListener("click",       handlers.onStop);
    this.resetBtn.addEventListener("click",      handlers.onReset);
    this.jumpSortieBtn.addEventListener("click", handlers.onJumpSortie);
    this.nudgeBackBtn.addEventListener("click",  handlers.onNudgeBack);
    this.nudgeFwdBtn.addEventListener("click",   handlers.onNudgeFwd);
    this.uiToggleBtn.addEventListener("click",   handlers.onUIToggle);

    this.apneaSecInput.addEventListener("input", handlers.onApneaChange);
    this.expMsInput.addEventListener("input",    handlers.onExpChange);

    if (this.nudgeMsSelect) {
      this.nudgeMs = Helpers.clampInt(
        this.nudgeMsSelect.value,
        AppConfig.NUDGE_MIN_MS,
        AppConfig.NUDGE_MAX_MS
      );
      this.nudgeMsSelect.addEventListener("change", () => {
        this.nudgeMs = Helpers.clampInt(
          this.nudgeMsSelect.value,
          AppConfig.NUDGE_MIN_MS,
          AppConfig.NUDGE_MAX_MS
        );
      });
    }
  }
}


// ======================================================
// App — orchestrateur principal
// ======================================================

class App {
  constructor() {
    this._engine    = new CycleEngine();
    this._audio     = new AudioService();
    this._bar       = new BarRenderer();
    this._countdown = new CountdownController();
    this._ui        = new UIController();

    // État de la boucle d'animation
    this._running       = false;
    this._rafId         = null;
    this._cycleStartPerf = 0;

    // État pause
    this._isPaused      = false;
    this._pausedPhaseMs = 0;
  }

  // ======================================================
  // Initialisation
  // ======================================================

  init() {
    this._ui.bindEvents({
      onStart:       () => this._start(),
      onStop:        () => this._stop(),
      onReset:       () => this._reset(),
      onJumpSortie:  () => this._jumpToSortie(),
      onNudgeBack:   () => this._nudge(-this._ui.nudgeMs),
      onNudgeFwd:    () => this._nudge(+this._ui.nudgeMs),
      onUIToggle:    () => this._ui.toggleCompactUI(),
      onApneaChange: () => this._onApneaChange(),
      onExpChange:   () => this._onExpChange(),
    });

    // Initialisation de l'affichage
    this._ui.setResetState();
    this._countdown.hide();
    this._bar.updateMarkers(this._engine);
    this._bar.render(0, this._engine);
    this._ui.setPhaseText("Stopped");
  }

  // ======================================================
  // Handlers d'inputs
  // ======================================================

  _onApneaChange() {
    const ms = this._ui.readApneaMs();
    this._engine.setApnea(ms, this._running);
    if (!this._running) {
      this._bar.updateMarkers(this._engine);
    }
  }

  _onExpChange() {
    const ms = this._ui.readExpMs();
    this._engine.setExp(ms, this._running);
    if (!this._running) {
      this._bar.updateMarkers(this._engine);
    }
  }

  // ======================================================
  // Actions principales
  // ======================================================

  async _start() {
    // Lecture des paramètres courants
    this._engine.setApnea(this._ui.readApneaMs(), false);
    this._engine.setExp(this._ui.readExpMs(), false);
    this._bar.updateMarkers(this._engine);

    this._running = true;
    this._ui.setRunningState();
    this._countdown.hide();

    const audioOk = await this._audio.ensure();
    const nowP    = performance.now();

    if (audioOk) {
      this._audio.unmute();
      this._audio.syncOnStart(nowP, this._isPaused, this._pausedPhaseMs);
    }

    if (this._isPaused) {
      // Reprise depuis la position de pause
      this._cycleStartPerf = nowP - this._pausedPhaseMs + this._engine.phaseOffsetMs;

      if (audioOk) {
        // Les beeps déjà passés sont marqués comme planifiés
        const pm = this._pausedPhaseMs;
        const ap = this._engine.apneaMs;
        if (pm >= ap - 3000) this._audio._lastPlanned.beep3Cycle = this._engine.cycleIndex;
        if (pm >= ap - 2000) this._audio._lastPlanned.beep2Cycle = this._engine.cycleIndex;
        if (pm >= ap - 1000) this._audio._lastPlanned.beep1Cycle = this._engine.cycleIndex;
      }

      this._isPaused = false;
    } else {
      // Démarrage frais
      this._engine.reset();
      this._cycleStartPerf = nowP;
      this._audio.resetPlanned();
    }

    this._audio.startScheduler(
      this._engine,
      () => this._ui.isBeepEnabled()
    );
    this._audio.schedulerTick(this._engine, this._ui.isBeepEnabled());
    this._loop();
  }

  _stop() {
    if (!this._running) return;

    const nowP = performance.now();
    this._pausedPhaseMs = Helpers.clampInt(
      this._engine.computePhaseMs(nowP, this._cycleStartPerf),
      0,
      this._engine.cycleDurationMs
    );
    this._isPaused = true;
    this._running  = false;

    this._ui.setStoppedState();
    this._cancelLoop();
    this._audio.stopScheduler();
    this._audio.mute();

    this._bar.render(this._pausedPhaseMs, this._engine);
    this._countdown.hide();
    this._ui.setPhaseText("Stopped");
  }

  _reset() {
    this._running = false;
    this._cancelLoop();
    this._audio.stopScheduler();
    this._audio.mute();

    this._isPaused      = false;
    this._pausedPhaseMs = 0;
    this._engine.resetPhaseOffset();

    this._countdown.hide();
    this._bar.render(0, this._engine);
    this._ui.setPhaseText("Stopped");
    this._ui.setResetState();
  }

  _jumpToSortie() {
    this._running = false;
    this._cancelLoop();
    this._audio.stopScheduler();
    this._audio.mute();

    this._pausedPhaseMs = this._engine.apneaMs;
    this._isPaused      = true;

    this._engine.resetPhaseOffset();
    this._cycleStartPerf = performance.now() - this._pausedPhaseMs;

    this._countdown.hide();
    this._bar.render(this._pausedPhaseMs, this._engine);
    this._ui.setPhaseText("Stopped");
    this._ui.setJumpSortieState();
  }

  _nudge(deltaMs) {
    this._engine.nudge(deltaMs);

    if (this._audio.isRunning && this._running) {
      this._audio.nudge(deltaMs);
      this._audio.recomputePlannedAfterNudge(this._engine);
      this._audio.schedulerTick(this._engine, this._ui.isBeepEnabled());
    }
  }

  // ======================================================
  // Boucle d'animation
  // ======================================================

  _loop() {
    if (!this._running) return;

    const nowP = performance.now();
    let phaseVis = this._engine.computePhaseMs(nowP, this._cycleStartPerf);

    // Gestion du compte à rebours via l'horloge audio (plus précise)
    if (this._audio.isRunning) {
      const phaseCd = this._audio.getPhaseMs(this._engine);
      this._countdown.update(phaseCd, this._engine);
    } else {
      this._countdown.hide();
    }

    // Rollover(s) de cycle
    while (phaseVis >= this._engine.cycleDurationMs) {
      phaseVis -= this._engine.cycleDurationMs;
      this._cycleStartPerf += this._engine.cycleDurationMs;

      if (this._audio.isRunning) {
        this._audio.advanceCycleStart(this._engine.cycleDurationMs);
      }

      this._engine.onCycleRollover();
      this._bar.updateMarkers(this._engine);
      this._audio.resetPlanned();
    }

    this._bar.render(phaseVis, this._engine);
    this._ui.setPhaseText("Running");

    this._rafId = requestAnimationFrame(() => this._loop());
  }

  _cancelLoop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}


// ======================================================
// Point d'entrée
// ======================================================

const app = new App();
app.init();
