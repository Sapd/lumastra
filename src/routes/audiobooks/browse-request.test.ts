// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { LatestRequest, requestLibrary, type LibraryScope } from './browse-request';
import { apiGet } from '$lib/api/client';

vi.mock('$lib/api/client', () => ({ apiGet: vi.fn() }));

describe('audiobook library requests', () => {
    it('keeps every selected filter on pages beyond sixty and passes cancellation', () => {
        const scope: LibraryScope = {
            group: 'shelf',
            language: 'de',
            author: 'Author',
            narrator: 'Narrator',
            series: 'Series',
            letter: 'A',
            sort: 'series_sequence',
        };
        const signal = new AbortController().signal;
        requestLibrary(scope, 60, 60, signal, 'book');
        expect(apiGet).toHaveBeenCalledWith('/api/audiobooks', expect.anything(), {
            signal,
            params: {
                libraryGroupId: 'shelf',
                lang: 'de',
                authorId: 'Author',
                narratorId: 'Narrator',
                seriesId: 'Series',
                letter: 'A',
                sort: 'series',
                order: 'asc',
                collapse: undefined,
                q: 'book',
                offset: 60,
                limit: 60,
            },
        });
    });

    it('invalidates immediately when cleared, before the next debounced request starts', () => {
        const requests = new LatestRequest();
        const old = requests.start();
        requests.cancel();
        expect(old.signal.aborted).toBe(true);
        expect(old.current()).toBe(false);
        const next = requests.start();
        expect(next.current()).toBe(true);
        expect(old.current()).toBe(false);
        const newest = requests.start();
        expect(next.signal.aborted).toBe(true);
        expect(newest.current()).toBe(true);
    });
});
