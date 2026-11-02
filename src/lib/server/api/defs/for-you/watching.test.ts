// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { def } from './watching.js';

describe('GET /api/for-you/watching age restriction', () => {
    it('returns no personalized sections for an age-restricted profile', async () => {
        const url = new URL('http://localhost/api/for-you/watching?limit=10');
        const event = {
            locals: {
                user: { userId: 'u1', username: 'child', isAgeRestricted: true },
            },
            url,
            params: {},
            request: new Request(url),
        } as unknown as RequestEvent;

        const response = (await def.handlers.GET!(event, {} as ApiContext)) as Response;

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ sections: [] });
    });
});

// The handler imports its dependencies dynamically (`await import(...)`
// inside the GET closure) rather than statically, but vi.mock still
// intercepts those — it hoists and patches the module registry regardless of
// whether the importing `import()` call is static or dynamic.
vi.mock('$lib/server/config.js', () => ({
    config: { DEFAULT_USER: 'default', METADATA_ADDITIONAL_LANGUAGES: [] },
}));
vi.mock('$lib/server/dev-user.js', () => ({ getEffectiveUser: () => 'alice' }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn(),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({ deniedGroupIds: null, ageRating: null }),
}));

describe('GET /api/for-you/watching payload shape', () => {
    it('strips chapters/audioFiles from an audiobook item but keeps authors/narrators', async () => {
        // One in-progress audiobook on prod carried 555 chapters + 555
        // audioFiles inside this same blob — the fixture below stands in for
        // that shape.
        const audiobookshelf = {
            chapters: [{ title: 'Chapter 1', start: 0 }],
            audioFiles: [{ ino: '1', filename: 'part1.mp3' }],
            authors: ['A. Author'],
            narrators: ['N. Narrator'],
        };
        vi.doMock('$lib/server/services/effective-watching.service.js', () => ({
            effectiveWatchingFor: vi.fn().mockResolvedValue({
                continueWatching: [{ id: 'ab1' }],
                nextUp: [],
            }),
        }));
        vi.doMock('$lib/server/utils/section-builder.js', () => ({
            buildWatchingSections: vi.fn().mockReturnValue([
                {
                    id: 'continue-watching',
                    title: 'Continue Watching',
                    type: 'continue-watching',
                    items: [
                        {
                            id: 'ab1',
                            title: 'An Audiobook',
                            mediaType: 'audiobook',
                            customMetadata: { audiobookshelf },
                        },
                    ],
                },
            ]),
        }));

        const url = new URL('http://localhost/api/for-you/watching?limit=10');
        const event = {
            locals: {
                user: { userId: 'u1', username: 'alice', isAgeRestricted: false },
            },
            url,
            params: {},
            request: new Request(url),
        } as unknown as RequestEvent;

        const response = (await def.handlers.GET!(event, {} as ApiContext)) as Response;
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            sections: Array<{ items: Array<{ customMetadata?: Record<string, unknown> }> }>;
        };
        const shelf = body.sections[0]?.items[0]?.customMetadata?.audiobookshelf as
            Record<string, unknown> | undefined;

        expect(shelf).toBeDefined();
        expect(shelf).not.toHaveProperty('chapters');
        expect(shelf).not.toHaveProperty('audioFiles');
        expect(shelf?.authors).toEqual(['A. Author']);
        expect(shelf?.narrators).toEqual(['N. Narrator']);
    });
});
