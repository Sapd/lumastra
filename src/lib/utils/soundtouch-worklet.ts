// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SoundTouch AudioWorklet wrapper.
 *
 * Provides pitch-preserving time-stretch for audio using WSOLA algorithm
 * running in an AudioWorklet thread. Used when BPM gap between tracks
 * exceeds ±8% where native playbackRate would cause audible pitch shift.
 *
 * Usage:
 *   const node = await createTimeStretchNode(audioContext, 1.05);
 *   source.connect(node).connect(gainNode);
 *   node.setTempo(1.0); // normalize later
 *   node.dispose();
 */

let workletRegistered = false;

export interface TimeStretchNode {
    /** The underlying AudioWorkletNode. Connect to audio graph. */
    node: AudioWorkletNode;

    /** Set the time-stretch tempo ratio (1.0 = normal speed). */
    setTempo(ratio: number): void;

    /** Disconnect and clean up. */
    dispose(): void;
}

/**
 * Create a time-stretch AudioWorkletNode.
 *
 * Registers the worklet processor on first call (cached for subsequent calls).
 *
 * @param audioContext - The AudioContext to use
 * @param tempoRatio - Initial tempo ratio (1.0 = normal, >1 = faster, <1 = slower)
 */
export async function createTimeStretchNode(
    audioContext: AudioContext,
    tempoRatio: number = 1.0,
): Promise<TimeStretchNode> {
    if (!workletRegistered) {
        await audioContext.audioWorklet.addModule('/worklets/soundtouch-processor.js');
        workletRegistered = true;
    }

    const workletNode = new AudioWorkletNode(audioContext, 'soundtouch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
    });

    // Send initial configuration
    workletNode.port.postMessage({
        type: 'setSampleRate',
        sampleRate: audioContext.sampleRate,
    });

    workletNode.port.postMessage({
        type: 'setTempo',
        tempo: tempoRatio,
    });

    return {
        node: workletNode,

        setTempo(ratio: number): void {
            workletNode.port.postMessage({
                type: 'setTempo',
                tempo: ratio,
            });
        },

        dispose(): void {
            workletNode.disconnect();
            workletNode.port.close();
        },
    };
}
