// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PlaybackInfo hands out sidecar URLs in the client's SubtitleProfile format
// (Stream.ass for JASSUB, Stream.pgssub for jellyfin-web's PGS renderer). The
// route must ask the resolver for that format instead of always WebVTT.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const { mockResolveSubtitle } = vi.hoisted(() => ({ mockResolveSubtitle: vi.fn() }));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/subtitle-resolver.service', () => ({
    resolveSubtitle: mockResolveSubtitle,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
    userNeedsMediaAccessCheck: vi.fn().mockResolvedValue(false),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { GET } from './+server';

const ITEM_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const FILE_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

async function callGet(streamFile: string): Promise<Response> {
    const url = new URL(
        `https://example.test/j/Videos/${ITEM_ID}/${FILE_ID}/Subtitles/3/0/${streamFile}`,
    );
    const event = {
        params: {
            itemId: ITEM_ID,
            mediaSourceId: FILE_ID,
            subtitleIndex: '3',
            segmentIndex: '0',
            streamFile,
        },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u', username: 'aleks' } },
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('/j Subtitles Stream.{ext}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveSubtitle.mockResolvedValue({ content: 'x', contentType: 'text/plain' });
    });

    it.each([
        ['Stream.vtt', 'vtt'],
        ['Stream.srt', 'srt'],
        ['Stream.ass', 'ass'],
        ['Stream.pgssub', 'pgssub'],
        ['Stream.js', 'vtt'],
    ])('%s asks the resolver for %s', async (streamFile, format) => {
        const res = await callGet(streamFile);
        expect(res.status).toBe(200);
        expect(mockResolveSubtitle).toHaveBeenCalledWith(expect.anything(), ITEM_ID, 3, {
            fileId: FILE_ID,
            format,
        });
    });
});
