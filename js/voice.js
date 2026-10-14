// How the app plays one orchestra note: which sound, how loud, how shaped.
// The app and the offline renderer (tests/web/render.html) both play notes
// through here, so a rendered clip is exactly what the app plays.

export const BOWED = ["violins1", "violins2", "violas", "celli", "basses"];

// the sample set for a note: pizzicato and tremolo strings have their own
export function soundFor(sampler, part, note) {
  if (BOWED.includes(part.set)) {
    if (note.pizz && sampler.sets[part.set + "_pizz"]) return part.set + "_pizz";
    if (note.tremolo >= 3) return "tremolo";
  }
  return part.set;
}

// how much louder or softer than written the orchestra plays here, from the
// recording (data.gain: dB per beat; tools/expression.py), at `shaping` %
export function phrasingGain(data, beat, shaping) {
  const g = data.gain;
  if (!g) return 1;
  const i = Math.max(0, Math.min(g.length - 1, Math.floor(beat))), j = Math.min(g.length - 1, i + 1), f = beat - Math.floor(beat);
  return 10 ** (((1 - f) * g[i] + f * g[j]) * shaping / 100 / 20);
}

// play `note` (a Score orchestra note) at context time `when` for `seconds`.
// opts: phrasing, balance (on/off), shaping (% of both), as in the app's settings
export function playNote(sampler, data, note, when, seconds, { phrasing = true, balance = true, shaping = 75 } = {}) {
  const part = data.parts[note.partIdx];
  const vel = Math.max(20, Math.min(127, note.velocity + part.vel - 75));
  // balance: the lead lifted, accompaniment shaded, sections at their power (tools/balance.py)
  const bal = balance ? 10 ** (note.balance * shaping / 100 / 20) : 1;
  const phr = phrasing ? phrasingGain(data, note.beat, shaping) : 1;
  return sampler.play(soundFor(sampler, part, note), part.drum ?? note.pitch, vel, when, seconds, phr * bal,
                      note.legato ? "legato" : note.stacc ? "stacc" : null);
}
