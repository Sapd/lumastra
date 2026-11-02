// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readStageBody } from './stage-body.js';

const req = (body?: string): Request => new Request('http://localhost/x', { method: 'POST', body });

describe('readStageBody', () => {
    it('treats no body and an empty object as "every stage"', async () => {
        expect(await readStageBody(req())).toEqual({ ok: true, stageId: undefined });
        expect(await readStageBody(req('{}'))).toEqual({ ok: true, stageId: undefined });
    });

    it('returns the named stage', async () => {
        expect(await readStageBody(req('{"stageId":"trickplay"}'))).toEqual({
            ok: true,
            stageId: 'trickplay',
        });
    });

    it.each(['not json', '[]', '{"stage_id":"trickplay"}', '{"stageId":""}', '{"stageId":5}'])(
        'rejects %s instead of falling back to every stage',
        async (body) => {
            const result = await readStageBody(req(body));
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.response.status).toBe(422);
        },
    );
});
