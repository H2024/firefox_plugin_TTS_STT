/* Captures mono Float32 frames at the AudioContext's sample rate (16 kHz) and
   ships them to the panel. Also reports a rolling RMS level for the meter. */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "active") this.active = !!e.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const rms = Math.sqrt(sum / channel.length);

    if (this.active) {
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage({ type: "audio", data: copy, rms }, [copy.buffer]);
    } else {
      this.port.postMessage({ type: "level", rms });
    }
    return true;
  }
}

registerProcessor("moonshine-recorder", RecorderProcessor);
