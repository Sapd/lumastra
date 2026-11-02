// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { STAGE_STATUSES, isCoveredStatus, type StageStatus } from './pipeline.js';

describe('STAGE_STATUSES', () => {
    it('contains exactly the eight status values', () => {
        expect(STAGE_STATUSES).toEqual([
            'pending',
            'running',
            'completed',
            'failed_transient',
            'failed_permanent',
            'skipped_permanent',
            'skipped_transient',
            'obsolete',
        ]);
    });
});

describe('isCoveredStatus', () => {
    it('classifies completed and skipped_permanent as covered', () => {
        expect(isCoveredStatus('completed')).toBe(true);
        expect(isCoveredStatus('skipped_permanent')).toBe(true);
    });

    it('classifies every other status as not covered', () => {
        const notCovered: StageStatus[] = [
            'pending',
            'running',
            'failed_transient',
            'failed_permanent',
            'skipped_transient',
            'obsolete',
        ];
        for (const s of notCovered) expect(isCoveredStatus(s)).toBe(false);
    });
});
