/* The microphone, sample by sample, for the voice assistant: hands 16 kHz mono frames to the page, where the
   speech detector and Whisper take them. Runs on the audio thread. */
class MorfisCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(320); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('morfis-capture', MorfisCapture);
