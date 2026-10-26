class PcmCaptureWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._offset++] = channelData[i];
      if (this._offset >= this._buffer.length) {
        let sumSq = 0;
        for (let j = 0; j < this._buffer.length; j += 4) {
          sumSq += this._buffer[j] * this._buffer[j];
        }
        const rms = Math.sqrt(sumSq / (this._buffer.length / 4));
        const chunk = this._buffer.slice(0);
        this.port.postMessage(
          {
            samples: chunk,
            rms,
            sampleRate,
          },
          [chunk.buffer]
        );
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture-worklet', PcmCaptureWorkletProcessor);
