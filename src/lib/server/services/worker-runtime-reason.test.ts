// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { workerUnavailableReasons } from './worker-runtime-reason.js';

describe('workerUnavailableReasons', () => {
    it('treats a node without runtime state (older build) as available', () => {
        expect(workerUnavailableReasons(undefined)).toEqual([]);
        expect(workerUnavailableReasons({})).toEqual([]);
    });
    it('a healthy runtime has no reasons', () => {
        expect(
            workerUnavailableReasons({
                upgradeState: 'idle',
                consumers: { running: 6, paused: 0 },
                lease: { held: true },
            }),
        ).toEqual([]);
    });
    it('names each reason', () => {
        expect(
            workerUnavailableReasons({
                upgradeState: 'prepared',
                consumers: { running: 0, paused: 0 },
                lease: { held: false },
            }),
        ).toEqual(['upgrade_prepared', 'consumers_stopped', 'singleton_lease_not_held']);
        expect(workerUnavailableReasons({ consumers: { running: 0, paused: 3 } })).toEqual([
            'consumers_paused',
        ]);
    });
    it('some consumers running keeps the worker available even if others are paused', () => {
        expect(workerUnavailableReasons({ consumers: { running: 2, paused: 1 } })).toEqual([]);
    });
    it('a postponed upgrade leaves the worker available', () => {
        expect(workerUnavailableReasons({ upgradeState: 'postponed' })).toEqual([]);
    });
});
