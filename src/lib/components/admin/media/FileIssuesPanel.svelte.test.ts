// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The point of this panel is that the RECORDED REASON is visible, not just a
 * type name. "Video ends early" alone tells an admin nothing about which file
 * to re-download; the ffmpeg detail — including its byte offset — is the
 * actionable part, so these tests assert on that text rather than on labels.
 */

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import FileIssuesPanel from './FileIssuesPanel.svelte';

const ITEM_ID = '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0';

const CLOUD_HARBOR = {
    fileId: 'f1',
    filePath: '/data/movies/Cloud Harbor (2024)/Cloud Harbor - Bluray-1080p.mkv',
    mediaItemId: ITEM_ID,
    mediaTitle: 'Cloud Harbor',
    seasonNumber: null,
    episodeNumber: null,
    issues: [
        {
            type: 'video_ends_early',
            detail: 'Video decodes to ~5040s but the container reports 7168s — 2128s past the last frame ffmpeg could produce',
            expected_duration: 7168,
            actual_duration: 5040,
        },
    ],
};

describe('FileIssuesPanel', () => {
    test('renders nothing when the item has no file issues', () => {
        const { container } = render(FileIssuesPanel, { mediaId: ITEM_ID, files: [] });
        expect(container.querySelector('section')).toBeNull();
    });

    test('shows the verbatim reason, not just the issue type', () => {
        render(FileIssuesPanel, { mediaId: ITEM_ID, files: [CLOUD_HARBOR] });

        expect(screen.getByText('Duration mismatch needs review')).toBeTruthy();
        expect(screen.getByText(/2128s past the last frame ffmpeg could produce/)).toBeTruthy();
    });

    test('shows the filename so a multi-version item is unambiguous', () => {
        render(FileIssuesPanel, { mediaId: ITEM_ID, files: [CLOUD_HARBOR] });

        // Basename only — the full library path is noise in this context.
        expect(screen.getByText('Cloud Harbor - Bluray-1080p.mkv')).toBeTruthy();
        expect(screen.queryByText(/^\/data\/movies/)).toBeNull();
    });

    test('keeps the byte offset of an unreadable container', () => {
        render(FileIssuesPanel, {
            mediaId: ITEM_ID,
            files: [
                {
                    ...CLOUD_HARBOR,
                    issues: [
                        {
                            type: 'container_unreadable',
                            detail: '0x00 at pos 8193 (0x2001) invalid as first byte of an EBML number',
                        },
                    ],
                },
            ],
        });

        expect(screen.getByText('Could not decode media')).toBeTruthy();
        expect(screen.getByText(/pos 8193/)).toBeTruthy();
        expect(screen.getByText(/H.266\/VVC/)).toBeTruthy();
    });

    test('links a descendant file back to the episode that owns it', () => {
        // On a series, issues live on the EPISODE's file — naming the episode
        // and linking to it is the difference between actionable and not.
        render(FileIssuesPanel, {
            mediaId: ITEM_ID,
            files: [
                {
                    fileId: 'f2',
                    filePath: '/data/series/Show/Season 01/Show - S01E08.mkv',
                    mediaItemId: 'episode-uuid',
                    mediaTitle: 'The Reckoning',
                    seasonNumber: 1,
                    episodeNumber: 8,
                    issues: [
                        { type: 'video_decode_gaps', detail: '12 sample points produced no frame' },
                    ],
                },
            ],
        });

        const link = screen.getByRole('link', { name: /S01E08 · The Reckoning/ });
        expect(link.getAttribute('href')).toContain('episode-uuid');
    });

    test('does not label the item’s own file with a scope link', () => {
        render(FileIssuesPanel, { mediaId: ITEM_ID, files: [CLOUD_HARBOR] });
        expect(screen.queryByRole('link', { name: /Cloud Harbor$/ })).toBeNull();
    });

    test('falls back to a composed reason for probe issues that carry no detail', () => {
        // truncated_video predates the `detail` field entirely.
        render(FileIssuesPanel, {
            mediaId: ITEM_ID,
            files: [
                {
                    ...CLOUD_HARBOR,
                    issues: [
                        { type: 'truncated_video', expected_duration: 7168, actual_duration: 5040 },
                    ],
                },
            ],
        });

        expect(screen.getByText('Duration mismatch needs review')).toBeTruthy();
        expect(screen.getByText(/5040/)).toBeTruthy();
    });

    test('shows a readable fallback for an unknown issue', () => {
        // The old if/else chains ended in an `else` naming duration_mismatch,
        // so any newly-added type rendered as confidently wrong.
        render(FileIssuesPanel, {
            mediaId: ITEM_ID,
            files: [{ ...CLOUD_HARBOR, issues: [{ type: 'some_future_issue', detail: 'why' }] }],
        });

        expect(screen.getByText('File check needs attention')).toBeTruthy();
        expect(screen.queryByText('Duration Mismatch')).toBeNull();
    });
});

test('uses accepted disposition beside another actionable issue, without repeating its old imperative', () => {
    render(FileIssuesPanel, {
        mediaId: ITEM_ID,
        files: [
            {
                ...CLOUD_HARBOR,
                issues: [
                    {
                        type: 'video_ends_early',
                        reviewed: true,
                        detail: 'Needs review: inspect the ending now',
                    },
                    { type: 'video_decode_gaps', detail: 'New decoder evidence' },
                ],
            },
        ],
    });
    expect(screen.getByText(/duration difference was accepted/)).toBeTruthy();
    expect(screen.queryByText('Needs review: inspect the ending now')).toBeNull();
    expect(screen.getByText('New decoder evidence')).toBeTruthy();
});
