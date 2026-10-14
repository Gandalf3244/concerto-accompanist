// Follower + orchestra clock (port of accomp/clock.py and accomp/engine.py).
//
// The soloist leads while they are playing; during orchestra-only passages the
// orchestra leads, and the follower is slaved to the orchestra so it expects
// the soloist's next entrance at the orchestra's tempo.
import { bisectLeft } from "./score.js";
import { Follower } from "./follower.js";
import { AudioFollower } from "./audiofollower.js";

const SOLO_ACTIVE_BEATS = 1.5; // soloist counts as playing within this many beats of a piano note
// Many passages sound alike, so the follower can briefly believe the player is
// somewhere else. The orchestra moves far (more than jumpBeats) only once the
// follower has stayed there: CONFIRM new matches over CONFIRM_S seconds, at a
// key spot (flexible bar, or no tempo plan) the KEY_ values.
const CONFIRM = 6, CONFIRM_S = 3.0, KEY_CONFIRM = 3, KEY_CONFIRM_S = 1.0;
// how far from the orchestra (beats) the follower expects the player, in a steady bar / at a key spot
const GUIDE_SIGMA = 1.5, KEY_GUIDE_SIGMA = 3.0;

// The conductor (with a tempo plan). As a conductor accompanies a concerto:
// it keeps listening to the soloist's tempo (the follower's readings over
// their last bar, as a pace against the plan's tempo for the same notes, so a
// bar the music stretches doesn't read as slow) and beats time at that tempo,
// the way the recording shapes it. The tempo changes only on a beat, never
// inside one (the rhythm stays even), and by a limited step: in a fast
// section at most 2.5% a beat, in a slow one 4%; at a rit., rubato or a change
// of section, and in the first bar of every section (where it takes the
// soloist's tempo afresh), it follows closely. A gentle extra correction
// closes a gap in position; playing faster while clearly behind (or slower
// while clearly ahead) is catching up after a slip and doesn't change the tempo.
const PACE_RANGE = [0.6, 1.3];  // the player's pace (their tempo / the plan's) is believed within this (practising slowly is fine)
const ENTRY_BEATS = 4;          // a section's first beats the soloist plays: follow closely, take their tempo
// per decision (unit: every bar or every beat): window = beats of notes the tempo is measured over
// (the median of the follower's readings), gain = how far the pace moves
// toward what is heard, step = most it moves, deadband = smaller differences are ignored, confirm = a
// change must be heard twice in a row,
// settle = beats to close a gap in position, correct = most that adds
const FAST = { unit: "beat", window: 4, gain: 0.7, step: 0.025, deadband: 0.01, confirm: false, settle: 3, correct: 0.04, posDeadband: 0.1 };
const SLOW = { unit: "beat", window: 2, gain: 0.8, step: 0.04, deadband: 0.01, confirm: false, settle: 2, correct: 0.06, posDeadband: 0 };
const FLEX = { unit: "beat", window: 2, gain: 1.0, step: 0.12, deadband: 0, confirm: false, settle: 1.5, correct: 0.12, posDeadband: 0 };
const BIG_CHANGE = 0.08, BIG_STEP = 0.10; // a change of pace this big may move this much per decision
const CATCH_UP = (globalThis.conductorTune?.catchUp ?? 0.5);        // beats behind (ahead) at which faster (slower) playing is catching up after a slip, not a new tempo
const PLAN_JUMP = 4.0;       // beats apart before the jump rule applies

// The orchestra's own clock: follows the soloist smoothly instead of jumping.
export class AccompClock {
  constructor(beat, bpm, tau = 0.6, maxAdjust = 0.35, jumpBeats = 1.5) {
    this.beat = beat;
    this.rate = bpm / 60.0; // beats per second
    this.t = null;
    this.tau = tau;
    this.maxAdjust = maxAdjust;
    this.jumpBeats = jumpBeats;
  }

  advance(t) {
    if (this.t !== null) this.beat += this.rate * (t - this.t);
    this.t = t;
    return this.beat;
  }

  // Move toward the follower's position/tempo; call often (e.g. every 5 ms).
  // tau / maxAdjust / jumpBeats may be given per call (a steadier orchestra).
  steer(t, targetBeat, targetRate, tau = this.tau, maxAdjust = this.maxAdjust, jumpBeats = this.jumpBeats) {
    this.advance(t);
    const err = targetBeat - this.beat;
    if (Math.abs(err) > jumpBeats) {
      this.beat = targetBeat;
      this.rate = targetRate;
      return;
    }
    let adj = err / tau / Math.max(targetRate, 1e-6); // fraction of tempo
    adj = Math.max(-maxAdjust, Math.min(maxAdjust, adj));
    this.rate = targetRate * (1.0 + adj);
  }

  // No soloist to follow: keep going at the current (or given) tempo.
  freeRun(t, rate = null) {
    this.advance(t);
    if (rate !== null) this.rate += 0.1 * (rate - this.rate);
  }
}

export class Engine {
  // audio: follow microphone onsets (onAudio) instead of MIDI notes (onNote)
  constructor(score, startBeat = 0.0, tempoScale = 1.0, audio = false) {
    this.score = score;
    this.tempoScale = tempoScale;
    const bpm = score.nominalBpm(startBeat) * tempoScale;
    this.follower = new (audio ? AudioFollower : Follower)(score, startBeat, bpm);
    this.clock = new AccompClock(startBeat, bpm);
    this.pianoBeats = score.chords.map(c => c.beat);
    this.orch = score.orchestra;
    this.orchBeats = this.orch.map(n => n.beat);
    this.nextOrch = bisectLeft(this.orchBeats, startBeat);
    this.started = false;
    this.sections = score.orchestraSections();
    // sections where the orchestra keeps the soloist's last tempo instead of its own
    this.keepTempo = new Set();
    this.plan = null; // tempo plan (setPlan): the orchestra keeps steady between its key spots
    this.skipped = 0; // orchestra notes passed over after a jump (for tests)
    this.away = null;  // the follower far from the orchestra: {err, n, seen, t0}
    // the follower is told where the orchestra is
    this.follower.guide = t => this.started && this.clock.t !== null
      ? { beat: this.clock.beat + this.clock.rate * (t - this.clock.t), sigma: this.keySpot() ? KEY_GUIDE_SIGMA : GUIDE_SIGMA }
      : null;
  }

  // a key spot: where the orchestra gives way to the soloist (rit., rubato, a
  // new section; in a slow section also where the recording stretches), or no plan
  keySpot() {
    if (!this.plan) return true;
    const h = this.planAt(this.clock.beat);
    return h.flex >= 2 || (h.flex === 1 && !h.fast);
  }

  // The follower is far from the orchestra: move there only once it has
  // stayed there (true if the clock jumped); until then keep the course.
  farOff(t, target, rate) {
    const f = this.follower, key = this.keySpot(), err = target - this.clock.beat;
    if (!this.away || Math.abs(err - this.away.err) > 1.0) this.away = { err, n: 0, seen: f.lastTime, t0: t };
    else if (f.lastTime !== this.away.seen) { this.away.n++; this.away.seen = f.lastTime; this.away.err = err; }
    if (this.away.n >= (key ? KEY_CONFIRM : CONFIRM) && t - this.away.t0 >= (key ? KEY_CONFIRM_S : CONFIRM_S)) {
      this.clock.beat = target;
      this.clock.rate = rate;
      this.away = null;
      this.nextOrch = bisectLeft(this.orchBeats, target - 1e-6); // play on from there (also after a jump back)
      return true;
    }
    this.clock.freeRun(t);
    return false;
  }

  // Without a plan: steer the clock toward the follower (AccompClock.steer),
  // moving far only by the jump rule.
  follow(t, target, rate) {
    this.clock.advance(t);
    if (Math.abs(target - this.clock.beat) <= this.clock.jumpBeats) {
      this.away = null;
      this.clock.steer(t, target, rate);
    } else {
      this.farOff(t, target, rate);
    }
  }

  // A tempo plan (tools/tempo_plan.py): per bar [bar, bpm, flex, section],
  // flex 0 steady, 1 the recording strays, 2 a change of section, 3 a tempo
  // word; sections [first bar, end bar, bpm, fast].
  setPlan(bars, sections = null) {
    this.plan = { bars, sections };
    // section: the plan section we are in; rate: its tempo (beats/s) as taken
    // from the player; entry: beats left of listening; next: the beat at which
    // the tempo is next decided
    // section: the plan section we are in, from beat secStart; pace: the
    // player's tempo / the plan's as the orchestra takes it; hist: the
    // player's recent notes [beat, time]; next: the beat at which the tempo is next decided
    this.cond = { section: null, secStart: 0, pace: null, entry: 0, hist: [], samples: [], seen: null, next: null, errSum: 0, errN: 0 };
    // the limits (tests may override them: globalThis.conductorTune = {FAST: {...}, ...})
    const tune = globalThis.conductorTune || {};
    this.tune = { FAST: { ...FAST, ...tune.FAST }, SLOW: { ...SLOW, ...tune.SLOW }, FLEX: { ...FLEX, ...tune.FLEX } };
    // the tempo the orchestra takes in each bar (at pace 1): the plan's, which
    // is the section's tempo except where the recording stretches or presses
    // on (as a conductor who knows the piece shapes those bars with the
    // soloist instead of reacting late). cum: plan time at each bar line (planTime)
    this.plan.use = (globalThis.conductorTune?.sectionTempo)
      ? bars.map((b, i) => { const h = this.planAt(4 * i); return h.fast && h.flex < 3 ? h.secBpm : h.bpm; })
      : bars.map(b => b[1]);
    this.plan.cum = [0];
    for (const u of this.plan.use) this.plan.cum.push(this.plan.cum[this.plan.cum.length - 1] + 4 * 60 / u);
  }

  planAt(beat) {
    const bars = this.plan.bars;
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor(beat / 4)));
    const b = bars[i], sec = this.plan.sections && b[3] !== undefined ? this.plan.sections[b[3]] : null;
    return { bpm: b[1], flex: +b[2] || 0, bar: i, sec: sec ? b[3] : -1,
             secBpm: sec ? sec[2] : b[1], fast: sec ? !!sec[3] : b[1] >= 100 };
  }

  // index of the orchestra-only section containing beat, or -1
  sectionAt(beat) {
    return this.sections.findIndex(([a, b]) => a <= beat && beat < b);
  }

  soloistActive(beat) {
    const i = bisectLeft(this.pianoBeats, beat - SOLO_ACTIVE_BEATS);
    return i < this.pianoBeats.length && this.pianoBeats[i] <= beat + SOLO_ACTIVE_BEATS;
  }

  start(t) {
    this.started = true;
    this.clock.t = t;
    this.follower.anchor = [this.clock.beat, t];
  }

  onNote(pitch, t) { return this.onInput(t, () => this.follower.onNote(pitch, t)); }

  // a microphone onset: sal(p) = share of the new sound at pitch p (AudioFrontEnd)
  onAudio(sal, t) { return this.onInput(t, () => this.follower.onOnset(sal, t)); }

  onInput(t, feed) {
    const first = !this.started;
    if (first) this.start(t);
    const b = feed();
    if (first && b !== null) {
      // the soloist starts the piece: the orchestra starts where they are
      this.clock.beat = b;
      this.clock.t = t;
      this.nextOrch = bisectLeft(this.orchBeats, b - 1e-6);
    }
    return b;
  }

  // seconds from the start to beat b at the plan's tempos
  planTime(b) {
    const bars = this.plan.bars, i = Math.max(0, Math.min(bars.length - 1, Math.floor(b / 4)));
    return this.plan.cum[i] + (b - 4 * i) * 60 / this.plan.use[i];
  }

  // the player's pace (their tempo / the plan's) over their notes from beat
  // `from` on: how fast their time runs against the plan's time for the same
  // notes, the median over pairs of notes 1-2 beats apart (local tempos: a
  // stumble, after which the player carries on, touches only the few pairs
  // around it, where a real change of tempo shows in all of them)
  paceOver(from) {
    const p = this.cond.hist.filter(x => x[0] >= from);
    if (p.length < 3 || p[p.length - 1][0] - p[0][0] < 2) return null;
    const slopes = [];
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      const db = p[j][0] - p[i][0];
      if (db > 2) break;
      if (db >= 1 && p[j][1] > p[i][1]) slopes.push((this.planTime(p[j][0]) - this.planTime(p[i][0])) / (p[j][1] - p[i][1]));
    }
    if (slopes.length < 3) return null;
    slopes.sort((a, b) => a - b);
    return Math.max(PACE_RANGE[0], Math.min(PACE_RANGE[1], slopes[slopes.length >> 1]));
  }

  // The conductor (see the top of this file); called while the soloist plays.
  conduct(t) {
    const f = this.follower, C = this.cond, c = this.clock;
    c.advance(t);
    const pos = f.position(t), err = pos - c.beat;
    if (Math.abs(err) > PLAN_JUMP) {
      if (this.farOff(t, pos, 1.0 / f.spb)) { C.next = null; C.hist = []; }
      return;
    }
    this.away = null;
    // the player's notes (a jump back or a relocation restarts the record)
    if (f.lastTime !== null && f.lastTime !== C.seen) {
      C.seen = f.lastTime;
      const last = C.hist[C.hist.length - 1];
      if (last && f.lastBeat < last[0]) C.hist = [];
      C.hist.push([f.lastBeat, f.lastTime]);
      // the follower's tempo just now, as a pace against the plan's tempo there
      const bi = Math.max(0, Math.min(this.plan.use.length - 1, Math.floor(f.lastBeat / 4)));
      C.samples.push([f.lastBeat, 60 / f.spb / this.plan.use[bi]]);
      while (C.samples.length && C.samples[0][0] < f.lastBeat - 8) C.samples.shift();
      while (C.hist.length > 48 || (C.hist.length && C.hist[0][0] < f.lastBeat - 16)) C.hist.shift();
    }
    C.errSum += err; C.errN++; // the gap, averaged until the next decision
    if (C.next !== null && c.beat < C.next - 1e-9) return; // the beat goes on at the tempo set
    const h = this.planAt(c.beat);
    if (h.sec !== C.section) { C.section = h.sec; C.secStart = Math.floor(c.beat / 4) * 4; C.entry = ENTRY_BEATS; C.heardN = 0; }
    const entry = C.entry > 0;
    const { FAST, SLOW, FLEX } = this.tune;
    const P = entry || this.keySpot() ? FLEX : h.fast ? FAST : SLOW;
    const clamp = (x, m) => Math.max(-m, Math.min(m, x));
    // the player's pace: over the notes of this section when it has just begun, else the window
    // the player's pace since the last decision: the median of the follower's
    // tempo readings over it (one bar in a fast section, a beat in a slow one)
    let heard = null;
    const recent = C.samples.filter(x => x[0] >= c.beat - P.window).map(x => x[1]);
    if (recent.length >= 2) {
      recent.sort((a, b) => a - b);
      heard = Math.max(PACE_RANGE[0], Math.min(PACE_RANGE[1], recent[recent.length >> 1]));
    }
    if (entry) heard = this.paceOver(C.secStart) ?? heard; // a section's first notes: its own notes only
    const gap = C.errSum / C.errN;
    C.errSum = 0; C.errN = 0;
    if (entry) {
      // listening at a section's start: take the player's tempo as heard, and
      // keep listening until it has been heard twice (or for twice as long)
      if (heard !== null) { C.pace = heard; C.heardN++; }
      C.entry -= 1;
      if (C.entry <= 0 && C.heardN < 2 && c.beat - C.secStart < 2 * ENTRY_BEATS + 4) C.entry = 1;
    }
    if (C.pace === null) C.pace = heard ?? 1.0;
    else if (!entry && heard !== null && Math.abs(heard / C.pace - 1) > P.deadband) {
      // a real change of tempo moves the player away from the orchestra in
      // the same direction; playing faster while behind (or slower while
      // ahead) is catching up after a slip, and the tempo stays
      // a change heard twice in a row, that is (outside the key spots, where it follows at once)
      const d = heard / C.pace - 1, sure = !P.confirm || Math.sign(d) === C.lastSign;
      C.lastSign = Math.sign(d);
      // a big difference, heard twice, is taken up quickly (the player has really changed tempo)
      const step = Math.abs(d) > BIG_CHANGE ? Math.max(P.step, BIG_STEP) : P.step;
      if (sure && !(d > 0 && gap < -CATCH_UP) && !(d < 0 && gap > CATCH_UP)) C.pace *= 1 + clamp(P.gain * d, step);
    } else C.lastSign = 0;
    const corr = Math.abs(gap) > P.posDeadband ? clamp(gap / P.settle, P.correct) : 0;
    c.rate = this.plan.use[h.bar] / 60 * C.pace * (1 + corr);
    C.next = P.unit === "bar" ? Math.floor(c.beat / 4 + 1e-9) * 4 + 4 : Math.floor(c.beat + 1e-9) + 1;
    this.onDecide?.({ t, beat: c.beat, section: h.sec, pace: C.pace, heard, bpm: c.rate * 60, kind: P === FAST ? "fast" : P === SLOW ? "slow" : "flex" });
  }

  // Advance to time t; return orchestra notes due, each with the time it is
  // due at. ahead > 0 also returns the notes due within the next `ahead`
  // seconds at the current tempo (so they can be scheduled precisely).
  tick(t, ahead = 0.0) {
    if (!this.started) return [];
    const f = this.follower;
    if (this.soloistActive(this.clock.beat) && f.lastTime !== null) {
      if (!this.plan) this.follow(t, f.position(t), 1.0 / f.spb);
      else this.conduct(t);
    } else {
      // the orchestra plays alone: its own tempo in an orchestra-only
      // passage, the soloist's last tempo in a short rest
      const s = this.sectionAt(this.clock.beat);
      const own = (s >= 0 && !this.keepTempo.has(s)) || f.lastTime === null;
      this.clock.freeRun(t, own ? this.score.nominalBpm(this.clock.beat) * this.tempoScale / 60.0 : null);
      // the soloist will come back in with the orchestra
      f.anchor = [this.clock.beat, t];
      f.timed = true;
      f.spb = 1.0 / this.clock.rate;
      if (f.lastBeat < this.clock.beat - 2) {
        f.lastBeat = this.clock.beat - 0.5;
        f.lastIdx = bisectLeft(this.pianoBeats, f.lastBeat) - 1;
      }
    }
    const due = [];
    const horizon = this.clock.beat + ahead * this.clock.rate;
    while (this.nextOrch < this.orch.length && this.orchBeats[this.nextOrch] <= horizon) {
      const n = this.orch[this.nextOrch];
      // after a jump, skip the backlog instead of firing it all at once
      if (n.beat >= this.clock.beat - 0.3) {
        due.push({ note: n, time: t + Math.max(0, n.beat - this.clock.beat) / Math.max(this.clock.rate, 1e-3) });
      } else this.skipped++;
      this.nextOrch += 1;
    }
    return due;
  }
}
