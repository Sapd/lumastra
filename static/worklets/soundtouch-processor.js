/* global AudioWorkletProcessor, registerProcessor */
/**
 * SoundTouch WSOLA AudioWorklet Processor
 *
 * Implements Waveform Similarity Overlap-Add (WSOLA) for pitch-preserving
 * time-stretching. Used when BPM gap > 8% where native playbackRate
 * would cause audible pitch shift.
 *
 * Original, independently written implementation of the WSOLA technique.
 * Named after the SoundTouch library that popularized it (and mirrors its
 * documented default window parameters), but derived from neither its (LGPL)
 * code nor soundtouchjs.
 *
 * Communication via MessagePort:
 *   { type: 'setTempo', tempo: number }  — set time-stretch ratio (1.0 = normal)
 */

// WSOLA parameters
const SEQUENCE_MS = 40; // Analysis window size in ms
const SEEKWINDOW_MS = 15; // Seek window size in ms
const OVERLAP_MS = 8; // Overlap length in ms

class SoundTouchProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.tempo = 1.0;
        this.inputBuffer = [];
        this.outputBuffer = [];
        this.sampleRate = 44100; // Updated from context
        this.sequenceSamples = 0;
        this.seekWindowSamples = 0;
        this.overlapSamples = 0;
        this.inputPos = 0;
        this.outputPos = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === 'setTempo') {
                this.tempo = event.data.tempo;
            } else if (event.data.type === 'setSampleRate') {
                this.sampleRate = event.data.sampleRate;
                this._updateParameters();
            }
        };

        this._updateParameters();
    }

    _updateParameters() {
        this.sequenceSamples = Math.floor((SEQUENCE_MS * this.sampleRate) / 1000);
        this.seekWindowSamples = Math.floor((SEEKWINDOW_MS * this.sampleRate) / 1000);
        this.overlapSamples = Math.floor((OVERLAP_MS * this.sampleRate) / 1000);
    }

    /**
     * Find the best overlap position using cross-correlation.
     */
    _seekBestOverlapPosition(refPos) {
        let bestCorr = -1;
        let bestOffset = 0;

        for (let i = 0; i < this.seekWindowSamples; i++) {
            let corr = 0;
            for (let j = 0; j < this.overlapSamples; j++) {
                const refIdx = refPos + j;
                const testIdx = refPos + i + j;
                if (refIdx < this.inputBuffer.length && testIdx < this.inputBuffer.length) {
                    corr += this.inputBuffer[refIdx] * this.inputBuffer[testIdx];
                }
            }
            if (corr > bestCorr) {
                bestCorr = corr;
                bestOffset = i;
            }
        }

        return bestOffset;
    }

    /**
     * Apply overlap-add blending between two segments.
     */
    _overlapAdd(output, outputOffset, input1Offset, input2Offset) {
        for (let i = 0; i < this.overlapSamples; i++) {
            const fadeOut = 1.0 - i / this.overlapSamples;
            const fadeIn = i / this.overlapSamples;

            const s1 =
                input1Offset + i < this.inputBuffer.length ? this.inputBuffer[input1Offset + i] : 0;
            const s2 =
                input2Offset + i < this.inputBuffer.length ? this.inputBuffer[input2Offset + i] : 0;

            if (outputOffset + i < output.length) {
                output[outputOffset + i] = s1 * fadeOut + s2 * fadeIn;
            }
        }
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0] || !output || !output[0]) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];

        // Passthrough when tempo is ~1.0
        if (Math.abs(this.tempo - 1.0) < 0.01) {
            outputChannel.set(inputChannel);
            // Copy to other channels if present
            for (let ch = 1; ch < output.length; ch++) {
                output[ch].set(input[ch] || inputChannel);
            }
            return true;
        }

        // Accumulate input samples
        for (let i = 0; i < inputChannel.length; i++) {
            this.inputBuffer.push(inputChannel[i]);
        }

        // Process WSOLA
        const nominalSkip = this.tempo * this.sequenceSamples;
        let outputIdx = 0;

        while (
            outputIdx < outputChannel.length &&
            this.inputPos + this.sequenceSamples + this.seekWindowSamples < this.inputBuffer.length
        ) {
            // Find best overlap position
            const bestOffset = this._seekBestOverlapPosition(this.inputPos);
            const matchPos = this.inputPos + bestOffset;

            // Copy sequence to output with overlap
            const copyLen = Math.min(
                this.sequenceSamples - this.overlapSamples,
                outputChannel.length - outputIdx,
            );

            for (let i = 0; i < copyLen; i++) {
                if (matchPos + this.overlapSamples + i < this.inputBuffer.length) {
                    outputChannel[outputIdx + i] =
                        this.inputBuffer[matchPos + this.overlapSamples + i];
                }
            }

            outputIdx += copyLen;
            this.inputPos += Math.floor(nominalSkip);
        }

        // Fill remaining output with silence
        for (let i = outputIdx; i < outputChannel.length; i++) {
            outputChannel[i] = 0;
        }

        // Copy to other channels
        for (let ch = 1; ch < output.length; ch++) {
            output[ch].set(outputChannel);
        }

        // Trim consumed input buffer
        if (this.inputPos > this.sequenceSamples * 4) {
            const trimTo = this.inputPos - this.sequenceSamples;
            this.inputBuffer = this.inputBuffer.slice(trimTo);
            this.inputPos -= trimTo;
        }

        return true;
    }
}

registerProcessor('soundtouch-processor', SoundTouchProcessor);
