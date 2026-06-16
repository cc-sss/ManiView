// ======================================================
// STRUCTURE DU FICHIER
// ======================================================
// AppConfig + Helpers
// CycleEngine 
// AudioService
// BarRenderer — rendu visuel de la barre et des labels
// CountdownController — gestion de l’overlay de compte à rebours
// UIController — gestion du DOM, des boutons et des champs de saisie
// App — orchestrateur principal
//   - Initialisation
//   - Handlers d’inputs
//   - Actions principales
//   - Boucle d’animation
// Point d’entrée - Lancement de l'application
// ======================================================

"use strict"; //force js à exécuter le code avec des règles strictes

// ======================================================
// AppConfig + Helpers
// ======================================================

// Paramètres de réglage de l'application (AppConfig)

const AppConfig = Object.freeze({
  MARKER_PCT:        70,
  START3_PCT:        25,
  SCHED_INTERVAL_MS: 25,
  LOOKAHEAD_SEC:     0.15,
  MIN_SAFETY_SEC:    0.01,
  NOISE_DURATION_SEC: 3,
  BEEP_FREQ_HZ:      440,
  APNEA_MIN_SEC:     10,
  APNEA_MAX_SEC:     30,
  EXP_MIN_SEC:       0,
  EXP_MAX_SEC:       10 * 60,
  NUDGE_MIN_SEC:     0.1,
  NUDGE_MAX_SEC:     0.4,
  NUDGE_DEFAULT_SEC: 0.2,
  APNEA_DEFAULT_SEC: 30.0,
  EXP_DEFAULT_SEC:   4.5,
  AUDIO_START_OFFSET_SEC: 0.02,
});

// Helpers : Fonctions utiles, utilisées autre part dans le code

const Helpers = Object.freeze({

  clampNumber(v, min, max) {
    const n = Number(String(v).replace(",", "."));
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  },

  formatSec(ms) {
    return (ms / 1000).toFixed(3);
  },

  mod(a, n) {
    return ((a % n) + n) % n;
  },

});

// ===================================================================================================
// CycleEngine — moteur logique du cycle ventilatoire ("Ou doit se trouver la barre de progression ?")
// ===================================================================================================

class CycleEngine {

  // Les valeurs Thaut/Tbas

  constructor() {

    // Valeurs par défaut
    this._apneaMs      = AppConfig.APNEA_DEFAULT_SEC * 1000;
    this._expMs        = AppConfig.EXP_DEFAULT_SEC * 1000;

    // Valeurs utilisées pour le cycle en cours
    this._activeApnea  = this._apneaMs;
    this._activeExp    = this._expMs;

    // Valeurs en attente pour le cycle suivant (--> lorsque l'utilisateur change Thaut/Tbas pendant que le cycle tourne)
    this._pendingApnea = null; // Nouvelle durée d’apnée en attente
    this._pendingExp   = null; // Nouvelle durée d'expi en attente
    this._hasPending   = false; // Indique s’il y a au moins un changement en attente

    // Décalage temporel crée par le nudge 
    this._phaseOffsetMs = 0;

    // Compteur de cycle - permet surtout d'éviter que les sons soient planifiés plusieurs fois dans le même cycle 
    this._cycleIndex    = 0;

  }

  // Les "getters"  - permettent aux autres parties du programme de lire ces valeurs proprement, 
  // sans accéder directement à la variable interne ni contourner la logique prévue pour modifier les durées

  get apneaMs()      { return this._apneaMs; }
  get expMs()        { return this._expMs; }
  get activeApneaMs(){ return this._activeApnea; }
  get activeExpMs()  { return this._activeExp; }
  get cycleDurationMs() { return this._activeApnea + this._activeExp; }
  get phaseOffsetMs()   { return this._phaseOffsetMs; }
  get cycleIndex()      { return this._cycleIndex; }

  // Les "setters" - modifient la durée de Thaut et Tbas en fonction de ce qui est encodé par l'utilisateur
  // N.B. ms = nouvelle apnée en ms; isRunning = indique si l'application est en train de tourner ou non

  // Modifie le temps d'apnée assistée (Thaut) 
  setApnea(ms, isRunning) {
    const value = Helpers.clampNumber(ms, AppConfig.APNEA_MIN_SEC * 1000, AppConfig.APNEA_MAX_SEC * 1000);
    if (isRunning) { // Si l'application tourne
      this._pendingApnea = value; // La valeur est une valeur à appliquer au cycle suivant
      this._hasPending   = true; // Il y'a un changement en attente
    } else { // Si l'application ne tourne pas
      this._apneaMs     = value;
      this._activeApnea = value;
    }
  }

  // Modifie le temps d'expi (Tbas) 
  setExp(ms, isRunning) {
    const value = Helpers.clampNumber(ms, AppConfig.EXP_MIN_SEC * 1000, AppConfig.EXP_MAX_SEC * 1000);
    if (isRunning) { // Si l'application tourne
      this._pendingExp = value;
      this._hasPending = true;
    } else { // Si l'application ne tourne pas
      this._expMs     = value; // Valeur est appliquée directement
      this._activeExp = value;
    }
  }

  // Fonction qui calcule où on est dans le cycle

  computePhaseMs(nowPerf, cycleStartPerf) {
    return (nowPerf - cycleStartPerf) + this._phaseOffsetMs;
  }

  // Fonction qui applique le nudge (décalage temporel)

  nudge(deltaMs) {
    this._phaseOffsetMs += deltaMs;
  }

  // Fonction qui remet le décalage apporté par le nudge à zéro

  resetPhaseOffset() {
    this._phaseOffsetMs = 0;
  }

  // Fonction qui transforme une position temporelle dans le cycle (en ms) en pourcentage de remplissage de la barre
  // N.B. phaseMs = position actuelle dans le cycle, en ms

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

  // Fonctions appelées à chaque "rollover", càd, à chaque nouveau cycle
  
  onCycleRollover() {
    this._cycleIndex++; //Augmente le compteur

    if (this._hasPending) { //Applique les changements mis en attente
      if (this._pendingApnea !== null) this._apneaMs = this._pendingApnea;
      if (this._pendingExp   !== null) this._expMs   = this._pendingExp;
      this._pendingApnea = null;
      this._pendingExp   = null;
      this._hasPending   = false;
    }

    this._activeApnea = this._apneaMs; //Met à jour les valeurs du nouveau cycle
    this._activeExp   = this._expMs;
  }

  // Mise à zéro complet (après réinitialisation du cycle)

  reset() {
    this._phaseOffsetMs = 0;
    this._cycleIndex    = 0;
    this._pendingApnea  = null;
    this._pendingExp    = null;
    this._hasPending    = false;
    this._activeApnea   = this._apneaMs;
    this._activeExp     = this._expMs;
  }

}

// ======================================================
// AudioService — classe qui gère la dimension auditive 
// ======================================================

class AudioService {
  
  // Variables audio

  constructor() {

    this._ctx         = null; // Contexte audio --> créer ou pas l'audio
    this._masterGain  = null; // Volume oui ou non
    this._noiseBuf    = null; // Bruit blanc (son à l'insufflation)

    this._schedTimer  = null; // Minuteur du scheduler (vérifie si un son doit être joué)
    this._cycleStartAudioTime = 0;

    this._lastPlannedTingleTime = -Infinity;
    this._lastPlanned = { beep3Cycle: -1, beep2Cycle: -1, beep1Cycle: -1 };
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

  // Les "getters" audio

  get isRunning() { // Est ce que l'audio fonctionne?
    return this._ctx && this._ctx.state === "running";
  }

  get currentTime() { // Renvoie le temps actuel de l’horloge audio
    return this._ctx ? this._ctx.currentTime : 0;
  }

  get cycleStartAudioTime() { // Renvoie le moment audio où le cycle a commencé
    return this._cycleStartAudioTime;
  }

  // Fonction qui calcule la phase actuelle selon l’horloge audio

  getPhaseMs(engine) {
    const raw = (this._ctx.currentTime - this._cycleStartAudioTime) * 1000;
    return Helpers.mod(Math.max(0, raw), engine.cycleDurationMs);
  }

  // Synchronisation de l'horloge audio avec avec l'horloge de la barre de progression

  // Avec le démarrage
  syncOnStart(isResume, pausedPhaseMs) {
    if (isResume) {
      this._cycleStartAudioTime = this._ctx.currentTime - (pausedPhaseMs / 1000);
    } else {
      this._cycleStartAudioTime = this._ctx.currentTime + AppConfig.AUDIO_START_OFFSET_SEC;
    }
  }

  // Avec le cycle suivant
  advanceCycleStart(cycleDurationMs) {
    this._cycleStartAudioTime += cycleDurationMs / 1000;
  }

  // Pour tenir compte des décalages temporels induits par le nudge 
  nudge(deltaMs) {
    this._cycleStartAudioTime -= deltaMs / 1000;
  }

  // Éviter les sons incohérents après un nudge
  recomputePlannedAfterNudge(engine) {
    const phaseMs = Helpers.mod(
      (this._ctx.currentTime - this._cycleStartAudioTime) * 1000,
      engine.cycleDurationMs
    );

    this._lastPlannedTingleTime = -Infinity;

    if (engine.activeApneaMs >= 3000) {
      const ci = engine.cycleIndex;
      this._lastPlanned.beep3Cycle = (phaseMs >= engine.activeApneaMs - 3000) ? ci : -1;
      this._lastPlanned.beep2Cycle = (phaseMs >= engine.activeApneaMs - 2000) ? ci : -1;
      this._lastPlanned.beep1Cycle = (phaseMs >= engine.activeApneaMs - 1000) ? ci : -1;
    }
  }

  // Volume

  unmute() {
    if (!this.isRunning || !this._masterGain) return;
    this._masterGain.gain.cancelScheduledValues(this._ctx.currentTime);
    this._masterGain.gain.setValueAtTime(1, this._ctx.currentTime);
  }

  mute() {
    if (!this.isRunning || !this._masterGain) return;
    this._masterGain.gain.setValueAtTime(0, this._ctx.currentTime);
  }

  // Génération des sons

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

  // Scheduler audio
  // N.B. Toutes les 25 ms, le js regarde 150ms dans le futur et si il voit que un son doit bientôt arriver, il le programme à l'avance

  startScheduler(engine, beepEnabledFn) {
    this.stopScheduler();
    this._schedTimer = setInterval(
      () => this.schedulerTick(engine, beepEnabledFn()),
      AppConfig.SCHED_INTERVAL_MS
    );
  }

  stopScheduler() { // Quand l'application est arrêté ou réinitialisé - arrête le scheduler
    if (this._schedTimer) {
      clearInterval(this._schedTimer);
      this._schedTimer = null;
    }
  }

  resetPlanned() { // Quand l'application est arrêté ou réinitialisé - efface la mémoire des sons déjà programmés
    this._lastPlanned = { beep3Cycle: -1, beep2Cycle: -1, beep1Cycle: -1 };
    this._lastPlannedTingleTime = -Infinity;
  }

  markPastCountdownBeeps(engine, phaseMs) {
    const ci = engine.cycleIndex;
    const ap = engine.activeApneaMs;

    if (phaseMs >= ap - 3000) this._lastPlanned.beep3Cycle = ci;
    if (phaseMs >= ap - 2000) this._lastPlanned.beep2Cycle = ci;
    if (phaseMs >= ap - 1000) this._lastPlanned.beep1Cycle = ci;
  }

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

    // Bips de décompte
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

}

// ===========================================================================================
// BarRenderer — classe qui gère le rendu visuel de la barre de progrssion et des pictogrammes
// ===========================================================================================

class BarRenderer {

  // Variables

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

  // Fonction qui met à jour les positions des repères selon le CycleEngine
   
  // Place des repères fixes
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

  // Met a jour la barre pendant que le temps avance
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
    this.expSecInput = document.getElementById("expSec");
    this.tbasUpBtn   = document.getElementById("tbasUpBtn");
    this.tbasDownBtn = document.getElementById("tbasDownBtn");
    this.beepEnabled    = document.getElementById("beepEnabled");
    this.nudgeSecSelect = document.getElementById("nudgeSec");

    // Pavé numérique Tbas
    this.tbasKeypadOverlay = document.getElementById("tbasKeypadOverlay");
    this.tbasKeypadDisplay = document.getElementById("tbasKeypadDisplay");
    this.tbasCancelBtn     = document.getElementById("tbasCancelBtn");
    this.tbasOkBtn         = document.getElementById("tbasOkBtn");

    this._tbasDraftValue = "";

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
    this.nudgeMs = AppConfig.NUDGE_DEFAULT_SEC * 1000;
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
    this.startBtn.disabled     = false;
    this.stopBtn.disabled      = true;
    this.resetBtn.disabled     = false;
    this.nudgeBackBtn.disabled = true;
    this.nudgeFwdBtn.disabled  = true;
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
    this.nudgeBackBtn.disabled = true;
    this.nudgeFwdBtn.disabled  = true;
  }

  readApneaMs() {
    const sec = Helpers.clampNumber(
      this.apneaSecInput.value,
      AppConfig.APNEA_MIN_SEC,
      AppConfig.APNEA_MAX_SEC
    );

    this.apneaSecInput.value = sec.toFixed(1);
    return sec * 1000;
  }

  readExpSecAsMs() {
    const sec = Helpers.clampNumber(
      this.expSecInput.textContent,
      AppConfig.EXP_MIN_SEC,
      AppConfig.EXP_MAX_SEC
    );

    this.setExpDisplay(sec);
    return sec * 1000;
  }

  formatTbasDisplay(sec) {
    return sec.toFixed(1).replace(".", ",");
  }

  setExpDisplay(sec) {
    this.expSecInput.textContent = this.formatTbasDisplay(sec);
  }

  openTbasKeypad() {
    this._tbasDraftValue = this.expSecInput.textContent.trim();
    this.tbasKeypadDisplay.textContent = this._tbasDraftValue;
    this.tbasKeypadOverlay.hidden = false;
  }

  closeTbasKeypad() {
    this.tbasKeypadOverlay.hidden = true;
  }

  handleTbasKey(key) {
    if (key === "backspace") {
      this._tbasDraftValue = this._tbasDraftValue.slice(0, -1);
    } 
    
    else if (key === ",") {
      if (!this._tbasDraftValue.includes(",") && this._tbasDraftValue.length > 0) {
        this._tbasDraftValue += ",";
      }
    } 
    
    else {
      const hasComma = this._tbasDraftValue.includes(",");
      const decimals = hasComma ? this._tbasDraftValue.split(",")[1] : "";

      // Maximum 1 chiffre après la virgule
      if (hasComma && decimals.length >= 1) return;

      // Maximum 3 chiffres avant la virgule
      const beforeComma = this._tbasDraftValue.split(",")[0];
      if (!hasComma && beforeComma.length >= 3) return;

      this._tbasDraftValue += key;
    }

    this.tbasKeypadDisplay.textContent = this._tbasDraftValue || "0";
  }

  confirmTbasKeypad() {
    const sec = Helpers.clampNumber(
      this._tbasDraftValue,
      AppConfig.EXP_MIN_SEC,
      AppConfig.EXP_MAX_SEC
    );

    this.setExpDisplay(sec);
    this.closeTbasKeypad();

    return sec * 1000;
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
    this.expSecInput.addEventListener("click", () => {
    this.openTbasKeypad();
  });

    this.tbasUpBtn.addEventListener("click", () => {
    handlers.onExpAdjust(+0.1);
  });

  this.tbasDownBtn.addEventListener("click", () => {
    handlers.onExpAdjust(-0.1);
  });

  this.tbasKeypadOverlay.addEventListener("click", (event) => {
    if (event.target === this.tbasKeypadOverlay) {
      this.closeTbasKeypad();
    }
  });

  this.tbasCancelBtn.addEventListener("click", () => {
    this.closeTbasKeypad();
  });

  this.tbasOkBtn.addEventListener("click", () => {
    this.confirmTbasKeypad();
    handlers.onExpChange();
  });

  this.tbasKeypadOverlay.querySelectorAll("[data-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      this.handleTbasKey(btn.dataset.key);
    });
  });

    if (this.nudgeSecSelect) {
      this.nudgeMs = Helpers.clampNumber(
        this.nudgeSecSelect.value,
        AppConfig.NUDGE_MIN_SEC,
        AppConfig.NUDGE_MAX_SEC
      ) * 1000;

      this.nudgeSecSelect.addEventListener("change", () => {
        this.nudgeMs = Helpers.clampNumber(
          this.nudgeSecSelect.value,
          AppConfig.NUDGE_MIN_SEC,
          AppConfig.NUDGE_MAX_SEC
        ) * 1000;
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

    this._running       = false;
    this._rafId         = null;
    this._cycleStartPerf = 0;

    this._isPaused      = false;
    this._pausedPhaseMs = 0;

  }

  // Initialisation

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
      onExpAdjust:   (deltaSec) => this._adjustExpSec(deltaSec),
    });

    this._ui.setResetState();
    this._ui.setExpDisplay(AppConfig.EXP_DEFAULT_SEC);
    this._countdown.hide();
    this._bar.updateMarkers(this._engine);
    this._bar.render(0, this._engine);
    this._ui.setPhaseText("Stopped");

  }

  // Handlers d'inputs

  _onApneaChange() {
    const ms = this._ui.readApneaMs();
    const deferChange = this._running || this._isPaused;

    this._engine.setApnea(ms, deferChange);

    if (!deferChange) {
      this._bar.updateMarkers(this._engine);
    }
  }

  _onExpChange() {
    const ms = this._ui.readExpSecAsMs();
    const deferChange = this._running || this._isPaused;

    this._engine.setExp(ms, deferChange);

    if (!deferChange) {
      this._bar.updateMarkers(this._engine);
    }
  }

  _adjustExpSec(deltaSec) {
    const currentMs = this._ui.readExpSecAsMs();
    const currentSec = currentMs / 1000;

    const newSec = Helpers.clampNumber(
      currentSec + deltaSec,
      AppConfig.EXP_MIN_SEC,
      AppConfig.EXP_MAX_SEC
    );

    this._ui.setExpDisplay(newSec);

    const deferChange = this._running || this._isPaused;
    this._engine.setExp(newSec * 1000, deferChange);

    if (!deferChange) {
      this._bar.updateMarkers(this._engine);
    }
  }

  // Actions principales

  async _start() {
    
    // Lecture des paramètres courants
    if (!this._isPaused) {
      this._engine.setApnea(this._ui.readApneaMs(), false);
      this._engine.setExp(this._ui.readExpSecAsMs(), false);
      this._bar.updateMarkers(this._engine);
    }

    this._running = true;
    this._ui.setRunningState();
    this._countdown.hide();

    const audioOk = await this._audio.ensure();
    const nowP    = performance.now();

    if (audioOk) {
      this._audio.unmute();
      this._audio.syncOnStart(this._isPaused, this._pausedPhaseMs);
    }

    if (this._isPaused) {
      this._cycleStartPerf = nowP - this._pausedPhaseMs + this._engine.phaseOffsetMs;

      if (audioOk) {
        this._audio.markPastCountdownBeeps(this._engine, this._pausedPhaseMs);
      }

      this._isPaused = false;
    } else {
      // Démarrage frais
      this._engine.reset();
      this._cycleStartPerf = nowP;
      this._audio.resetPlanned();
    }

    if (audioOk) {
      this._audio.startScheduler(
        this._engine,
        () => this._ui.isBeepEnabled()
      );

      this._audio.schedulerTick(this._engine, this._ui.isBeepEnabled());
    }

    this._loop();

  }

  _stop() {
    if (!this._running) return;

    const nowP = performance.now();
    this._pausedPhaseMs = Helpers.clampNumber(
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

    this._engine.setApnea(this._ui.readApneaMs(), false);
    this._engine.setExp(this._ui.readExpSecAsMs(), false);
    this._engine.reset();

    this._countdown.hide();
    this._bar.updateMarkers(this._engine);
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
    if (!this._running) return;

    this._engine.nudge(deltaMs);

    if (this._audio.isRunning) {
      this._audio.nudge(deltaMs);
      this._audio.recomputePlannedAfterNudge(this._engine);
      this._audio.schedulerTick(this._engine, this._ui.isBeepEnabled());
    }
  }

  // Boucle d'animation

  _loop() {
    if (!this._running) return;

    const nowP = performance.now();
    let phaseVis = this._engine.computePhaseMs(nowP, this._cycleStartPerf);

    // Gestion du compte à rebours via l'horloge audio (plus précise)
    if (this._audio.isRunning) {
      const phaseCd = this._audio.getPhaseMs(this._engine);
      this._countdown.update(phaseCd, this._engine);
    } else {
      this._countdown.update(phaseVis, this._engine);
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
// Lancement de l'application (Point d’entrée)
// ======================================================

const app = new App();
app.init();
