// Runs in the audio thread: hands microphone samples to the page in chunks,
// stamped with the audio-clock time at the end of each chunk, together with
// what the app sent to the speaker over the same time (input 1), so the
// front end can tell the orchestra from the player.
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.ref = new Float32Array(512);
    this.n = 0;
  }

  process(inputs) {
    const mic = inputs[0] && inputs[0][0];
    if (mic) {
      const ref = inputs[1] && inputs[1][0];
      this.buf.set(mic, this.n);
      if (ref) this.ref.set(ref, this.n); else this.ref.fill(0, this.n, this.n + mic.length);
      this.n += mic.length;
      if (this.n + 128 > this.buf.length) {
        this.port.postMessage({ data: this.buf.slice(0, this.n), ref: this.ref.slice(0, this.n),
                                t: currentTime + mic.length / sampleRate });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("mic-tap", MicTap);
