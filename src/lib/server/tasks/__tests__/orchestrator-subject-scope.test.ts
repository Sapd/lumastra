// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { RunSchema } from '@sapd/lumastra-plugin-sdk';

describe('run scope subject fields', () => {
    it('RunSchema accepts and preserves subjectType/subjectId', () => {
        const parsed = RunSchema.parse({
            id: 'r1',
            taskId: 't',
            label: 'l',
            state: 'pending',
            input: {},
            scope: { subjectType: 'mediaItem', subjectId: 'media-1' },
            trigger: { kind: 'manual' },
            startedAt: '2026-08-18T10:00:00.000Z',
            stages: [],
            actor: { type: 'user' },
        });
        expect(parsed.scope?.subjectType).toBe('mediaItem');
        expect(parsed.scope?.subjectId).toBe('media-1');
    });

    it('rejects an unknown subjectType', () => {
        const res = RunSchema.safeParse({
            id: 'r1',
            taskId: 't',
            label: 'l',
            state: 'pending',
            input: {},
            scope: { subjectType: 'nonsense', subjectId: 'x' },
            trigger: { kind: 'manual' },
            startedAt: '2026-08-18T10:00:00.000Z',
            stages: [],
            actor: { type: 'user' },
        });
        expect(res.success).toBe(false);
    });
});
