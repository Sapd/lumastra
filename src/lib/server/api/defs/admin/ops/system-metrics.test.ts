// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GeForce NVENC session cap is a driver limit (3 → 5 at release 530 → 8 at 550), not a
 * model one. An RTX 3090 on driver 617 ran five transcodes while the panel claimed 3.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cpuUsageBetween, getMaxNvencSessions, sumCpuTimes } from './system-metrics.js';

describe('getMaxNvencSessions', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('current drivers allow 8 sessions on consumer cards of any generation', () => {
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '617.14')).toBe(8);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 4090', '580.82.07')).toBe(8);
        expect(getMaxNvencSessions('NVIDIA GeForce GTX 1080', '550.40.07')).toBe(8);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 2070', '551.23')).toBe(8);
    });

    it('older drivers keep their historical caps', () => {
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '546.65')).toBe(5);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '530.41.03')).toBe(5);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '525.147.05')).toBe(3);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '529.19')).toBe(3);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '549.99')).toBe(5);
    });

    it('an unknown driver is assumed current', () => {
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3060')).toBe(8);
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3060', 'garbage')).toBe(8);
        expect(getMaxNvencSessions('')).toBe(8);
    });

    it('the GTX 1630 stays at 3 even on current drivers', () => {
        expect(getMaxNvencSessions('NVIDIA GeForce GTX 1630', '580.82.07')).toBe(3);
    });

    it('data-center and workstation cards are uncapped', () => {
        expect(getMaxNvencSessions('NVIDIA RTX A4000', '580.82.07')).toBe(0);
        expect(getMaxNvencSessions('Tesla T4', '535.104.05')).toBe(0);
        expect(getMaxNvencSessions('Quadro P2000', '470.256.02')).toBe(0);
        expect(getMaxNvencSessions('NVIDIA L40S', '550.54.15')).toBe(0);
        expect(getMaxNvencSessions('NVIDIA L4', '550.54.15')).toBe(0);
        expect(getMaxNvencSessions('NVIDIA A10G', '550.54.15')).toBe(0);
        expect(getMaxNvencSessions('NVIDIA RTX 6000 Ada Generation', '580.82.07')).toBe(0);
        expect(getMaxNvencSessions('NVIDIA RTX PRO 6000 Blackwell', '580.82.07')).toBe(0);
    });

    it('consumer names never match the data-center patterns', () => {
        for (const name of [
            'NVIDIA GeForce RTX 3060 Ti',
            'NVIDIA GeForce RTX 4070 SUPER',
            'NVIDIA GeForce RTX 5090',
        ]) {
            expect(getMaxNvencSessions(name, '580.82.07')).toBe(8);
        }
    });

    it('NVENC_MAX_SESSIONS overrides the estimate', () => {
        vi.stubEnv('NVENC_MAX_SESSIONS', '12');
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '617.14')).toBe(12);
        vi.stubEnv('NVENC_MAX_SESSIONS', '0');
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '617.14')).toBe(0);
        vi.stubEnv('NVENC_MAX_SESSIONS', '-1');
        expect(getMaxNvencSessions('NVIDIA GeForce RTX 3090', '617.14')).toBe(0);
    });
});

describe('cpuUsageBetween', () => {
    const times = (user: number, sys: number, idle: number) => ({
        times: { user, nice: 0, sys, idle, irq: 0 },
    });

    it('reports the load between samples, not the average since boot', () => {
        // A week mostly idle, then a fully busy second.
        const prev = sumCpuTimes([times(1_000, 1_000, 98_000)]);
        const cur = sumCpuTimes([times(1_900, 1_100, 98_000)]);
        expect(cpuUsageBetween(prev, cur)).toEqual({ user: 90, system: 10, idle: 0, total: 100 });
        // The cumulative reading would have said 3 %.
        expect(cpuUsageBetween(null, cur).total).toBe(3);
    });

    it('falls back to the cumulative figure when no time has passed', () => {
        const cur = sumCpuTimes([times(10, 10, 80)]);
        expect(cpuUsageBetween(cur, cur)).toEqual({ user: 10, system: 10, idle: 80, total: 20 });
    });

    it('no data is zero, not NaN', () => {
        expect(cpuUsageBetween(null, sumCpuTimes([]))).toEqual({
            user: 0,
            system: 0,
            idle: 0,
            total: 0,
        });
    });
});
