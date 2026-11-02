// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The boundary analyser, against signals whose answer is known by construction.
 *
 * The harness's whole value is that it can distinguish a perfect join from a
 * clipped head — a distinction the previous, gap-only version could not make.
 * An instrument that has never been shown to produce the RIGHT number on a
 * synthetic input with a KNOWN answer is not evidence of anything, and this
 * project has already shipped one measurement (4a's "0 ms everywhere") that was
 * true and yet said nothing about the question people took it to answer.
 *
 * So: build the exact waveform each control is supposed to produce, and check
 * the analyser reports what it should — including that the gap column and the
 * loss column do not leak into each other.
 */

import { describe, expect, it } from 'vitest';
import { analyseBoundary, CHIRP_BASE_HZ, CHIRP_RATE_HZ_PER_S, TONE_A_HZ } from './analysis.mjs';

const RATE = 44_100;

/**
 * Build one boundary recording.
 *
 * @param toneSeconds     length of the constant-tone A section
 * @param gapSeconds      silence between the sections
 * @param entrySeconds    how far into the chirp B is when it becomes audible
 * @param chirpSeconds    length of the audible B section
 */
function synthesise(
    toneSeconds: number,
    gapSeconds: number,
    entrySeconds: number,
    chirpSeconds: number,
): Float32Array {
    const total = Math.round((toneSeconds + gapSeconds + chirpSeconds) * RATE);
    const out = new Float32Array(total);

    let i = 0;
    for (let n = 0; n < Math.round(toneSeconds * RATE); n++, i++) {
        out[i] = 0.5 * Math.sin(2 * Math.PI * TONE_A_HZ * (n / RATE));
    }
    i += Math.round(gapSeconds * RATE);

    // Phase of a linear chirp f(t) = BASE + RATE·t is 2π(BASE·t + RATE·t²/2).
    // Integrating the frequency rather than plugging f into sin() matters: the
    // naive form sweeps at twice the intended rate, which would make every
    // content-loss figure exactly half of the truth.
    const phase = (t: number): number =>
        2 * Math.PI * (CHIRP_BASE_HZ * t + (CHIRP_RATE_HZ_PER_S * t * t) / 2);
    for (let n = 0; n < Math.round(chirpSeconds * RATE) && i < total; n++, i++) {
        out[i] = 0.5 * Math.sin(phase(entrySeconds + n / RATE));
    }
    return out;
}

describe('gapless boundary analysis', () => {
    it('reads a perfect join as no gap and no loss', () => {
        const result = analyseBoundary(synthesise(1.0, 0, 0, 1.0), RATE);
        expect(result.joinMs).toBeCloseTo(1000, -2);
        expect(result.gapMs).toBeLessThan(15);
        expect(result.contentLostMs).toBeGreaterThan(-15);
        expect(result.contentLostMs).toBeLessThan(15);
        expect(result.fitR2).toBeGreaterThan(0.99);
    });

    it('reads the forced-gap control as a gap and NOT as loss', () => {
        const result = analyseBoundary(synthesise(1.0, 0.2, 0, 1.0), RATE);
        expect(result.gapMs).toBeGreaterThan(180);
        expect(result.gapMs).toBeLessThan(220);
        expect(Math.abs(result.contentLostMs!)).toBeLessThan(20);
    });

    it('reads the forced-clip control as loss and NOT as a gap', () => {
        const result = analyseBoundary(synthesise(1.0, 0, 0.2, 1.0), RATE);
        expect(result.gapMs).toBeLessThan(15);
        expect(result.contentLostMs).toBeGreaterThan(180);
        expect(result.contentLostMs).toBeLessThan(220);
    });

    it('separates a gap and a clip that happen together', () => {
        // The case a single number could never express, and the reason the two
        // columns are computed independently.
        const result = analyseBoundary(synthesise(1.0, 0.1, 0.15, 1.0), RATE);
        expect(result.gapMs).toBeGreaterThan(80);
        expect(result.gapMs).toBeLessThan(130);
        expect(result.contentLostMs).toBeGreaterThan(125);
        expect(result.contentLostMs).toBeLessThan(180);
    });

    it('resolves the shipped 150 ms lead distinctly from zero', () => {
        const perfect = analyseBoundary(synthesise(1.0, 0, 0, 1.0), RATE);
        const lead150 = analyseBoundary(synthesise(1.0, 0, 0.15, 1.0), RATE);
        expect(lead150.contentLostMs! - perfect.contentLostMs!).toBeGreaterThan(120);
    });

    it('recovers the chirp rate, so a wrong playback rate is visible', () => {
        const result = analyseBoundary(synthesise(1.0, 0, 0, 1.5), RATE);
        expect(result.chirpSlopeHzPerS).toBeGreaterThan(CHIRP_RATE_HZ_PER_S * 0.95);
        expect(result.chirpSlopeHzPerS).toBeLessThan(CHIRP_RATE_HZ_PER_S * 1.05);
    });

    it('reports silence rather than inventing a join', () => {
        const result = analyseBoundary(new Float32Array(RATE), RATE);
        expect(result.silent).toBe(true);
        expect(result.joinMs).toBeNull();
        expect(result.usable).toBe(false);
    });

    /**
     * A capture that never reached file B must not read as a perfect join.
     *
     * `gapMs: 0` is the best possible result, so returning it for a FAILED
     * measurement is the one way this harness could actively mislead — and it
     * did, before the `usable` flag existed.
     */
    it('refuses a reading when file B never sounded', () => {
        const toneOnly = synthesise(2.0, 0, 0, 0);
        const result = analyseBoundary(toneOnly, RATE);
        expect(result.usable).toBe(false);
        expect(result.joinMs).toBeNull();
        expect(result.gapMs).toBeNull();
        expect(result.contentLostMs).toBeNull();
    });

    it('marks a real boundary usable', () => {
        expect(analyseBoundary(synthesise(1.0, 0, 0.15, 1.0), RATE).usable).toBe(true);
    });
});
