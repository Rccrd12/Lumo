// Gemini Live: hands the microphone's samples to the island's page
// (src/live/audio.ts), which brings them down to 16 kHz and sends them.
// Runs on the audio thread; it only copies, about every 20 ms.

class LumoMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer);
          this.buffer = new Float32Array(1024);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("lumo-microphone", LumoMicrophone);
