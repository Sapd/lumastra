// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));

describe('match snippet HTML boundary', () => {
    beforeEach(() => {
        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
    });
    afterEach(cleanup);

    it.each([
        '<mark><script>alert("xss")</script></mark>',
        '<mark><img src=x onerror="alert(1)"></mark>',
        '<mark onclick="alert(1)">unsafe marker</mark>',
        '&lt;img src=x onerror=alert(1)&gt;',
    ])('renders hostile matched text as text: %s', (snippet) => {
        const item: UniversalMediaItem = {
            id: 'snippet-test',
            externalIds: { internal: 'snippet-test' },
            mediaType: 'movie',
            title: 'Snippet test',
            image: '',
            isAvailable: false,
            canRequest: false,
            matchSource: 'overview',
            matchSnippet: 'Matched text',
            highlightedMatchSnippet: snippet,
        };
        const { container } = render(UniversalMediaCard, { item, variant: 'list' });
        const paragraph = container.querySelector('p.italic');
        expect(paragraph).not.toBeNull();
        expect(paragraph?.querySelector('script, img, [onclick], [onerror]')).toBeNull();
        expect(paragraph?.textContent).toContain(snippet.replace(/<\/?mark>/g, ''));
    });

    it('retains only the fixed highlight markup', () => {
        const item: UniversalMediaItem = {
            id: 'snippet-test',
            externalIds: { internal: 'snippet-test' },
            mediaType: 'movie',
            title: 'Snippet test',
            image: '',
            isAvailable: false,
            canRequest: false,
            matchSource: 'overview',
            matchSnippet: 'A match & text',
            highlightedMatchSnippet: 'A <mark>match & text</mark>',
        };
        const { container } = render(UniversalMediaCard, { item, variant: 'list' });
        expect(container.querySelector('p.italic mark')?.textContent).toBe('match & text');
    });
});
