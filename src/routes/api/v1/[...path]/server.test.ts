// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fallback } from './+server';

describe('/api/v1 catch-all fallback', () => {
    it('answers an unmatched path with a problem+json 404 and nothing else', async () => {
        const response = await fallback({} as Parameters<typeof fallback>[0]);
        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        expect(await response.json()).toEqual({
            code: 'not_found',
            error: 'Resource not found',
            status: 404,
        });
    });
});
