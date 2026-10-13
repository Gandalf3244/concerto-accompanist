// Real-time score follower (port of accomp/follower.py; keep the two in step).
//
// Keeps an estimate of where the soloist is (score beat) and how fast they are
// going. Each incoming note is matched to the most plausible not-yet-played
// note of the piano part near the expected position; wrong and extra notes are
// ignored, skipped notes are allowed, and after a run of unmatched notes the
// follower searches more widely to relocate itself.
import { bisectLeft, bisectRight } from "./score.js";

const CHORD_SPREAD = 0.07; // s; notes of one chord are rarely further apart than this
const LOOKAHEAD = 6.0;     // beats searched ahead of the last match
const LOST_AFTER = 6;      // unmatched notes in a row before a wide search

function pushMax(arr, x, maxlen) { arr.push(x); if (arr.length > maxlen) arr.shift(); }

export class Follower {
  constructor(score, startBeat = 0.0, bpm = null) {
    this.score = score;
    this.chords = score.chords;
    this.beats = this.chords.map(c => c.beat);
    score.reset();
    this.lastIdx = bisectLeft(this.beats, startBeat) - 1;
    this.lastBeat = startBeat;
    this.lastTime = null;
    this.spb = 60.0 / (bpm || score.nominalBpm(startBeat));
    this.obs = [];       // (beat, time) of chord onsets, at most 8
    this.unmatched = 0;
    this.recent = [];    // recent (pitch, time) for relocation, at most 8
    this.anchor = [startBeat, null];
    this.tentative = new Map(); // chord idx -> time of its single matched note
    this.lastTempoBeat = startBeat;
    this.lastZ = 0.0;
    this.lastSkipped = false;
    this.pendingSkipped = 0;
    this.timed = false; // the orchestra is playing: the soloist's first note has a time to fit
  }

  // ------------------------------------------------------------ queries
  position(t) {
    const [b0, t0] = this.anchor;
    if (t0 === null) return b0;
    return b0 + (t - t0) / this.spb;
  }

  // Pitches the soloist may play next (for the microphone front end).
  expectedPitches(t, ahead = 1.5, maxChords = 8, groupS = 0.06) {
    const pos = this.anchor[1] !== null ? this.position(t) : this.lastBeat;
    const lo = Math.max(0, this.lastIdx);
    const hi = bisectRight(this.beats, Math.max(pos, this.lastBeat) + ahead);
    const out = [];
    let prevBeat = null;
    for (let i = lo; i < Math.min(hi, lo + maxChords); i++) {
      const c = this.chords[i];
      const rest = new Set([...c.pitches].filter(p => !c.matched.has(p)));
      if (!rest.size) continue;
      // chords closer than a microphone can separate count as one group
      if (out.length && prevBeat !== null && (c.beat - prevBeat) * this.spb < groupS) {
        for (const p of rest) out[out.length - 1].add(p);
      } else {
        out.push(rest);
      }
      prevBeat = c.beat;
    }
    return out;
  }

  tempoBpm() { return 60.0 / this.spb; }

  // ------------------------------------------------------------ input
  // Feed one note-on. Returns the matched chord beat or null.
  onNote(pitch, t) {
    pushMax(this.recent, [pitch, t], 8);
    // another (possibly late) note of the chord we just matched: accept it
    // until about halfway to the next chord
    if (this.lastTime !== null && this.lastIdx >= 0) {
      const c = this.chords[this.lastIdx];
      const nxt = this.lastIdx + 1 < this.chords.length ? this.chords[this.lastIdx + 1].beat : c.beat + 1;
      const window = Math.max(CHORD_SPREAD, 0.5 * (nxt - c.beat) * this.spb);
      if (t - this.lastTime < window && c.pitches.has(pitch) && !c.matched.has(pitch)) {
        c.matched.add(pitch);
        return c.beat;
      }
    }
    if (this.lastTime === null && !this.obs.length && !this.timed) {
      // first note: no timing yet, take the first upcoming chord with this pitch
      const lo = bisectLeft(this.beats, this.lastBeat - 0.01);
      const hi = bisectRight(this.beats, this.lastBeat + 8);
      let first = null;
      for (let i = lo; i < hi; i++) if (this.chords[i].pitches.has(pitch)) { first = i; break; }
      if (first !== null) {
        const c = this.chords[first];
        c.matched.add(pitch);
        this.lastIdx = first; this.lastBeat = c.beat; this.lastTime = t;
        this.anchor = [c.beat, t];
        pushMax(this.obs, [c.beat, t], 8);
        return c.beat;
      }
    }
    const idx = this.bestMatch(pitch, t, LOOKAHEAD);
    if (idx === null) {
      this.unmatched += 1;
      if (this.unmatched >= LOST_AFTER) this.relocate();
      return null;
    }
    this.accept(idx, pitch, t);
    return this.chords[idx].beat;
  }

  bestMatch(pitch, t, window, loBeat = null, maxZ = 2.5) {
    const expected = this.anchor[1] !== null ? this.position(t) : this.lastBeat;
    let lo = bisectLeft(this.beats, (loBeat !== null ? loBeat : this.lastBeat) - 0.01);
    lo = Math.max(0, Math.min(lo, this.lastIdx - 2)); // a weakly matched recent chord may be revisited
    const hi = bisectRight(this.beats, this.lastBeat + window);
    let best = null, bestCost = 1e9;
    for (let i = lo; i < hi; i++) {
      const c = this.chords[i];
      if (!c.pitches.has(pitch) || c.matched.has(pitch)) continue;
      // chords between the last match and this one that we would skip
      let skipped = 0;
      for (let j = Math.max(this.lastIdx + 1, lo); j < i; j++) if (!this.chords[j].matched.size) skipped++;
      const dt = Math.abs(c.beat - expected) * this.spb; // seconds off the expected time
      // timing uncertainty grows with distance from the last confirmed note
      let sigma = 0.05 + 0.12 * Math.abs(c.beat - this.lastBeat) * this.spb;
      if (i < this.lastIdx && this.lastSkipped) sigma = Math.max(sigma, 0.15); // the last match skipped ahead: it may be the wrong one
      const z = dt / sigma;
      if (z > maxZ) continue;
      let cost = z + 0.6 * skipped;
      if (i <= this.lastIdx && c.matched.size >= 0.5 * c.pitches.size) cost += 1.5; // going back to a chord that was clearly played is unusual
      if (cost > maxZ) continue;
      if (cost < bestCost) {
        best = i; bestCost = cost;
        this.lastZ = z;
        this.pendingSkipped = skipped;
      }
    }
    return best;
  }

  accept(idx, pitch, t) {
    const c = this.chords[idx];
    c.matched.add(pitch);
    this.unmatched = 0;
    // one note of a multi-note chord could be a stray: wait for a second one
    if (c.pitches.size >= 2 && c.matched.size === 1) {
      this.tentative.set(idx, t);
      return;
    }
    const first = this.tentative.has(idx) ? this.tentative.get(idx) : null;
    this.tentative.delete(idx);
    if (first !== null && t - first < 0.08) t = first;
    const skipped = this.pendingSkipped;
    if (idx > this.lastIdx) {
      this.lastSkipped = skipped > 0;
      if (this.lastZ < 1.2) {
        pushMax(this.obs, [c.beat, t], 8);
        this.updateTempo();
      }
      this.lastIdx = idx; this.lastBeat = c.beat; this.lastTime = t;
      this.anchor = [c.beat, t];
    } else if (idx < this.lastIdx) {
      // we had jumped ahead on a stray note: step back, and free the notes
      // we wrongly used up in the chords we had jumped to
      for (let j = idx + 1; j <= this.lastIdx; j++) {
        this.chords[j].matched.clear();
        this.tentative.delete(j);
      }
      this.lastSkipped = false;
      while (this.obs.length && this.obs[this.obs.length - 1][0] > c.beat) this.obs.pop();
      pushMax(this.obs, [c.beat, t], 8);
      this.lastIdx = idx; this.lastBeat = c.beat; this.lastTime = t;
      this.anchor = [c.beat, t];
    }
  }

  // Robust (Theil-Sen) slope of time vs beat over recent chord onsets.
  updateTempo() {
    const pts = this.obs;
    if (pts.length < 4 || pts[pts.length - 1][0] - pts[0][0] < 1.5) return;
    const slopes = [];
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const db = pts[b][0] - pts[a][0];
        if (db >= 0.5) slopes.push((pts[b][1] - pts[a][1]) / db);
      }
    }
    if (!slopes.length) return;
    slopes.sort((x, y) => x - y);
    let spb = slopes[slopes.length >> 1];
    const last = pts[pts.length - 1][0];
    const nominal = 60.0 / this.score.nominalBpm(last);
    spb = Math.min(Math.max(spb, 0.5 * nominal), 2.0 * nominal);
    // tempo changes are gradual: at most ~8% per beat of music
    const db = Math.max(0.05, last - this.lastTempoBeat);
    this.lastTempoBeat = last;
    const lim = 1.0 + 0.08 * Math.min(db, 2.0);
    const target = 0.7 * this.spb + 0.3 * spb;
    this.spb = Math.min(Math.max(target, this.spb / lim), this.spb * lim);
  }

  // Lost: look for the recent notes as a sequence anywhere nearby.
  relocate() {
    const pitches = this.recent.map(r => r[0]);
    const tLast = this.recent[this.recent.length - 1][1];
    const expected = this.anchor[1] !== null ? this.position(tLast) : this.lastBeat;
    let best = null, bestScore = -1e9;
    const lo = bisectLeft(this.beats, this.lastBeat - 16);
    const hi = bisectRight(this.beats, this.lastBeat + 32);
    const n = this.chords.length;
    for (let i = lo; i < hi; i++) {
      let j = i, k = 0, hits = 0;
      while (k < pitches.length && j < n && j < i + 2 * pitches.length) {
        if (this.chords[j].pitches.has(pitches[k])) { hits++; k++; }
        j++;
      }
      // repeated phrases are common: prefer the copy nearest where we expect to be
      const score = hits - 0.08 * Math.abs(this.chords[Math.min(j - 1, n - 1)].beat - expected);
      if (hits >= 0.7 * pitches.length && score > bestScore) { best = j - 1; bestScore = score; }
    }
    if (best !== null) {
      const c = this.chords[best];
      this.lastIdx = best; this.lastBeat = c.beat; this.lastTime = tLast;
      this.anchor = [c.beat, tLast];
      this.obs = [[c.beat, tLast]];
      this.unmatched = 0;
    }
  }
}
