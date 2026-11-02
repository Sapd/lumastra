// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseWorkerMode, resolveTaskProcessRole } from './task-role.js';

describe('task process roles', () => {
    it('defaults a direct server launch to web with no task consumers', () => {
        expect(resolveTaskProcessRole(parseWorkerMode(undefined), false)).toBe('web');
    });
    it('permits consumers only on the explicitly dedicated worker', () => {
        expect(resolveTaskProcessRole(parseWorkerMode('enabled'), true)).toBe('worker');
        expect(() => resolveTaskProcessRole('enabled', false)).toThrow('Combined web/task');
        expect(() => resolveTaskProcessRole('disabled', true)).toThrow('Combined web/task');
        expect(() => resolveTaskProcessRole('enabled', false)).toThrow(
            'upgrading-to-the-dedicated-worker-and-two-valkeys',
        );
    });
    it.each(['auto', 'combined', 'legacy', 'typo', ''])(
        'rejects obsolete/invalid WORKER_MODE=%s',
        (mode) => {
            expect(() => parseWorkerMode(mode)).toThrow('unsupported');
        },
    );
});
