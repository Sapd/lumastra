// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const extract = vi.hoisted(() =>
    vi.fn(async () => ({ extracted: true, filePath: '/new-thumb.jpg' })),
);
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/video-frame-extractor.service.js', () => ({
    extractPosterForItem: extract,
}));
import { def } from './extract.js';

describe('explicit admin frame extraction', () => {
    it('forces extraction and selection even when the compatibility force flag is false', async () => {
        const id = '781cf231-79ed-448e-b4b9-5adc65b70229';
        const event = {
            params: { id },
            locals: { user: { username: 'admin' } },
        } as unknown as RequestEvent;
        const handler = def.handlers.POST!;
        const ctx = {
            input: { body: { artworkType: 'thumb', force: false } },
        } as unknown as Parameters<typeof handler>[1];
        const response = await handler(event, ctx);
        expect(response.status).toBe(200);
        expect(extract).toHaveBeenCalledWith(expect.anything(), {
            mediaItemId: id,
            artworkType: 'thumb',
            force: true,
            selectAsAdmin: true,
        });
    });
});
