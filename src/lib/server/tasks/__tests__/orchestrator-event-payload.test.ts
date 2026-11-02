// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { RunEventSchema, type Run } from '@sapd/lumastra-plugin-sdk';
import { toRunEvent } from '../run-event.js';

describe('orchestrator run.started payload', () => {
    it('carries the full scope including subjectId, not a hand-written subset', () => {
        const data = toRunEvent({
            id: 'run-9',
            taskId: 'series-sync',
            label: 'Series sync',
            state: 'pending',
            input: { mediaItemId: 'x' },
            // subjectType/subjectId are added to the SDK scope object by the
            // subject-correlation task; the cast keeps this fixture — which is
            // the whole point of the assertion below — compiling until then.
            scope: {
                libraryGroupId: 'lg-1',
                userId: 'u-1',
                subjectType: 'mediaItem',
                subjectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            } as Run['scope'],
            trigger: { kind: 'manual' },
            startedAt: '2026-08-18T10:00:00.000Z',
            stages: [],
            actor: { type: 'user' },
        });

        expect(RunEventSchema.safeParse(data).success).toBe(true);
        expect(data.scope).toEqual({
            libraryGroupId: 'lg-1',
            userId: 'u-1',
            subjectType: 'mediaItem',
            subjectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        });
        expect(data.state).toBe('pending');
    });
});
