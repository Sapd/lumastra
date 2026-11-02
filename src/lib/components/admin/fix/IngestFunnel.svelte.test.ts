// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The funnel's green line is a claim that every file reached the library. It
 * needs files to have been measured, and a failed load must not look like a
 * clean one. Entry links go to the media detail route, not the list.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('$lib/api/client.js', () => api);

import IngestFunnel from './IngestFunnel.svelte';

const SEGMENT = {
    mediaType: 'movie',
    present: 10,
    probed: 10,
    linked: 10,
    identified: 10,
    visible: 10,
};

function funnel(over: Record<string, unknown> = {}): unknown {
    return {
        missingFiles: 0,
        orphanFiles: 0,
        removedEntryFiles: 0,
        segments: [SEGMENT],
        findings: [],
        ...over,
    };
}

beforeEach(() => api.apiGet.mockReset());
afterEach(() => cleanup());

describe('IngestFunnel', () => {
    it('a measured library with nothing lost says so', async () => {
        api.apiGet.mockResolvedValue({ data: funnel(), error: null });
        render(IngestFunnel);
        await screen.findByText(m.admin_fix_funnel_clean());
    });

    it('a library with no files is not "nothing is being lost"', async () => {
        api.apiGet.mockResolvedValue({ data: funnel({ segments: [] }), error: null });
        render(IngestFunnel);
        await screen.findByText(m.admin_fix_funnel_no_files());
        expect(screen.queryByText(m.admin_fix_funnel_clean())).toBeNull();
    });

    it('a failed first load is reported, quietly', async () => {
        api.apiGet.mockResolvedValue({ data: null, error: 'boom' });
        render(IngestFunnel);
        await screen.findByText(m.admin_fix_funnel_failed());
    });

    it('a failed refresh marks the old numbers as possibly stale', async () => {
        api.apiGet.mockResolvedValueOnce({ data: funnel(), error: null });
        render(IngestFunnel);
        await screen.findByText(m.admin_fix_funnel_clean());
        api.apiGet.mockResolvedValueOnce({ data: null, error: 'boom' });
        await fireEvent.click(screen.getByRole('button', { name: m.admin_fix_funnel_refresh() }));
        await screen.findByText(m.admin_fix_funnel_stale());
    });

    it('"Open entry" links to the media detail page', async () => {
        api.apiGet.mockImplementation(async (url: unknown) =>
            String(url).includes('/samples')
                ? {
                      data: {
                          samples: [
                              {
                                  fileId: 'f1',
                                  filePath: '/m/a.mkv',
                                  mediaItemId: 'item-1',
                                  title: 'A',
                                  mediaType: 'movie',
                                  showTitle: null,
                                  seasonNumber: null,
                                  episodeNumber: null,
                                  issueType: null,
                                  issueDetail: null,
                              },
                          ],
                          truncated: false,
                      },
                      error: null,
                  }
                : { data: funnel({ missingFiles: 1 }), error: null },
        );
        render(IngestFunnel);
        await fireEvent.click(
            await screen.findByRole('button', { name: m.admin_fix_funnel_show() }),
        );
        const link = await screen.findByRole('link', { name: m.admin_fix_funnel_open_entry() });
        expect(link.getAttribute('href')).toMatch(/\/admin\/library\/media\/item-1$/);
    });

    it('files of a removed entry are reported apart from never-linked files', async () => {
        api.apiGet.mockResolvedValue({
            data: funnel({ orphanFiles: 2, removedEntryFiles: 5 }),
            error: null,
        });
        render(IngestFunnel);
        await screen.findByText(m.admin_fix_funnel_removed_entry({ count: 5 }));
        expect(screen.getByText(m.admin_fix_funnel_orphans({ count: 2 }))).toBeTruthy();
        expect(screen.queryByText(m.admin_fix_funnel_clean())).toBeNull();
    });
});
