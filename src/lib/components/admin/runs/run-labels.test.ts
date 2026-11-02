// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import {
    formatLogTime,
    resumeLabel,
    serverLabel,
    shortenUuids,
    stopReasonLabel,
    triggerLabel,
} from './run-labels.js';

describe('run labels', () => {
    it('words the trigger instead of printing its kind', () => {
        expect(triggerLabel({ kind: 'scheduled' })).toBe(m.admin_run_trigger_scheduled());
        expect(triggerLabel({ kind: 'manual', by: 'testuser' })).toBe(
            m.admin_run_trigger_manual_by({ who: 'testuser' }),
        );
    });

    it('labels a run resumed after a restart, and only that', () => {
        expect(
            resumeLabel({
                kind: 'manual',
                by: 'testuser',
                resume: { rootRunId: 'run_a', previousRunId: 'run_b', count: 2, max: 3 },
            }),
        ).toBe(m.admin_run_resumed_badge({ count: '2', max: '3' }));
        expect(resumeLabel({ kind: 'manual', by: 'testuser' })).toBeNull();
    });

    it('reads a stopReason, and says nothing when there is none', () => {
        expect(stopReasonLabel({ stopReason: 'drained' })).toBe(m.admin_run_stop_drained());
        expect(stopReasonLabel({ itemsProcessed: 3 })).toBeNull();
        expect(stopReasonLabel(null)).toBeNull();
    });

    it('explains preview source continuation only from an explicit budget outcome and summary', () => {
        const summary = {
            count: 663,
            unit: 'frames' as const,
            continuation: { kind: 'source-check' as const, remainingSources: 1 },
        };
        expect(stopReasonLabel({ stopReason: 'budget' }, summary)).toBe(
            m.admin_run_source_check_later({ count: '1' }),
        );
        expect(stopReasonLabel(undefined, summary)).toBe(
            m.admin_run_source_check_later({ count: '1' }),
        );
        expect(stopReasonLabel({ itemsProcessed: 663 })).toBeNull();
        expect(stopReasonLabel({ stopReason: 'budget' })).toBe(m.admin_run_stop_budget());
    });

    it('shortens UUIDs in log text', () => {
        expect(
            shortenUuids('blackframe abstained for 4accc520-925a-4445-a172-3f54284366b2: x'),
        ).toBe('blackframe abstained for 4accc520…: x');
    });

    it('prints log times locally, with the date only when not today', () => {
        const now = new Date(2026, 8, 27, 12, 0, 0);
        const today = new Date(2026, 8, 27, 9, 5, 7).toISOString();
        const earlier = new Date(2026, 8, 25, 9, 5, 7).toISOString();
        expect(formatLogTime(today, now)).not.toContain('T');
        expect(formatLogTime(today, now)).not.toContain(',');
        expect(formatLogTime(earlier, now)).toContain(',');
    });

    it('labels an auto-named server by its suffix, like the Servers box', () => {
        expect(serverLabel('e0440fdcb81e-201f00')).toBe('#201f00');
        expect(serverLabel('web-1')).toBe('web-1');
    });
});
