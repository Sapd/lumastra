// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { overallHealthVerdict, type OverallHealthInputs } from './health-verdict.js';

const ok: OverallHealthInputs = {
    attention: 'healthy',
    components: ['pass', 'pass'],
    taskSystem: 'healthy',
    incomplete: false,
};

describe('overallHealthVerdict', () => {
    it('all clear is healthy', () => {
        expect(overallHealthVerdict(ok)).toBe('healthy');
    });

    it('a failing component is critical even when attention says healthy', () => {
        expect(overallHealthVerdict({ ...ok, components: ['fail', 'pass'] })).toBe('critical');
    });

    it('an unhealthy task system is critical', () => {
        expect(overallHealthVerdict({ ...ok, taskSystem: 'unhealthy' })).toBe('critical');
    });

    it('incomplete data never hides a known problem', () => {
        expect(overallHealthVerdict({ ...ok, attention: 'degraded', incomplete: true })).toBe(
            'degraded',
        );
        expect(
            overallHealthVerdict({
                ...ok,
                components: ['fail'],
                incomplete: true,
                taskSystem: null,
            }),
        ).toBe('critical');
    });

    it('incomplete data turns healthy into unknown', () => {
        expect(overallHealthVerdict({ ...ok, incomplete: true })).toBe('unknown');
        expect(overallHealthVerdict({ ...ok, taskSystem: null })).toBe('unknown');
        expect(overallHealthVerdict({ ...ok, attention: 'unknown' })).toBe('unknown');
        expect(overallHealthVerdict({ ...ok, components: [] })).toBe('unknown');
        expect(overallHealthVerdict({ ...ok, components: ['pass', undefined] })).toBe('unknown');
    });

    it('warnings are degraded', () => {
        expect(overallHealthVerdict({ ...ok, components: ['warn'] })).toBe('degraded');
        expect(overallHealthVerdict({ ...ok, taskSystem: 'degraded' })).toBe('degraded');
    });
});
