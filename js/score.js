// Score model for the accompanist (port of accomp/score.py).
// Positions are in beats (quarter notes) from the start of the movement.

export const BAR = 4.0; // the first movement is in 4/4 throughout

export function bisectLeft(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

export function bisectRight(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1; }
  return lo;
}

export class Score {
  // data: web/data/score.json; tempoMap: [[beat, bpm], ...] (defaults to the score's)
  constructor(data, tempoMap = null) {
    this.nMeasures = data.measures;
    this.parts = data.parts;
    this.chords = data.chords.map(([beat, ps]) => ({ beat, pitches: new Set(ps), matched: new Set() }));
    this.orchestra = data.orch.map(([beat, dur, pitch, part, velocity, tremolo]) =>
      ({ beat, dur, pitch, part: data.parts[part].id, partIdx: part, velocity, tremolo }));
    this.tempoMap = tempoMap || data.tempo;
  }

  nominalBpm(beat) {
    let bpm = this.tempoMap[0][1];
    for (const [b, t] of this.tempoMap) if (b <= beat) bpm = t;
    return bpm;
  }

  // Orchestra-only passages: [start, end] beats between piano chords at least
  // minBeats apart. Their tempo is set by the player (or the score); shorter
  // rests keep the soloist's tempo.
  orchestraSections(minBeats = 8.0) {
    const out = [];
    let prev = 0.0;
    for (const b of [...this.chords.map(c => c.beat), this.nMeasures * BAR]) {
      if (b - prev >= minBeats) out.push([prev, b]);
      prev = b;
    }
    return out;
  }

  beatOfMeasure(m) { return (m - 1) * BAR; }

  reset() { for (const c of this.chords) c.matched = new Set(); }
}
