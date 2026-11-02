// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import AudioTailDiagnosis from './AudioTailDiagnosis.svelte';
import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';
afterEach(cleanup);
const assessment: AudioTailAssessment = {
    version: 1,
    measuredAt: '2026-10-24T12:00:00Z',
    method: 'ffmpeg-astats-frames-v1',
    thresholdDbfs: -60,
    completeness: 'unverified',
    scope: 'partial',
    observation: 'unknown',
    inventorySignature: 'fixture-inventory',
    inventory: [{ codec_type: 'audio', index: 1 }],
    source: {
        generation: 'fixture-generation',
        physical: 'fixture-physical',
        streams: 'fixture-streams',
    },
    limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
    reasons: ['tail_duration_cap'],
    requested: { start: 20, end: 250 },
    streams: [],
};
it('shows limits, measurement date and unverified completeness with expandable raw details', () => {
    render(AudioTailDiagnosis, { assessment });
    expect(screen.getByText(/completeness remains unverified/i)).toBeTruthy();
    expect(screen.getByText(/Measurements are limited or inconclusive/i)).toBeTruthy();
    expect(screen.getByText(/20.000–250.000/)).toBeTruthy();
    const details = screen.getByText('Measurement details').closest('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('tail_duration_cap');
    expect(details?.textContent).toContain('fixture-physical');
});
it('presents near-silence as an observation while retaining the completeness caveat', () => {
    render(AudioTailDiagnosis, {
        assessment: { ...assessment, scope: 'measured', observation: 'near_silent' },
    });
    expect(screen.getByText(/at or below −60 dBFS/i)).toBeTruthy();
    expect(screen.getByText(/Silence does not resolve existing warnings/i)).toBeTruthy();
});
it('counts a proven no-tail stream while still showing dated and unverified evidence', () => {
    render(AudioTailDiagnosis, {
        assessment: {
            ...assessment,
            scope: 'measured',
            observation: 'near_silent',
            inventory: [
                { codec_type: 'audio', index: 1 },
                { codec_type: 'audio', index: 2 },
            ],
            streams: [
                {
                    index: 1,
                    requested: { start: 20, end: 20 },
                    packetEof: true,
                    packetEnd: 20,
                    noPostVideoPackets: true,
                    samples: 0,
                    coverageSeconds: 0,
                    continuous: true,
                    channels: [],
                    reasons: [],
                },
                {
                    index: 2,
                    requested: { start: 20, end: 250 },
                    packetEof: true,
                    packetEnd: 250,
                    samples: 48000,
                    coverageSeconds: 1,
                    continuous: true,
                    channels: [{ channel: 1, peakDbfs: -300, rmsDbfs: -300, digitalZero: true }],
                    reasons: [],
                },
            ],
        },
    });
    expect(screen.getByText(/2 of 2 audio streams measured/i)).toBeTruthy();
    expect(screen.getByText(/completeness remains unverified/i)).toBeTruthy();
    expect(screen.getByText(/observations apply to the recorded source/i)).toBeTruthy();
});

it('keeps one action sentence visible and the completeness explanation in a closed disclosure', () => {
    render(AudioTailDiagnosis, { assessment });
    expect(
        screen.getByText('Check the ending before deciding whether to keep this warning.'),
    ).toBeTruthy();
    const disclosure = screen.getByText('What this check can tell you').closest('details');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('completeness remains unverified');
});
