// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * This panel exists because the attention badge counts `media_files` rows while
 * the admin media browser lists `media_items`, so the badge could never agree
 * with the list it linked to. Every test here pins one of the populations that
 * divergence hid — an `extra`, and a file with no linked item at all. Assert on
 * "is it visible", not on styling: the bug was rows silently missing.
 */

import { rangeMappingProofFixture } from '$lib/schemas/__fixtures__/range-mapping-proof.fixture.js';
import { audioTailAssessmentFixture } from '../media/audio-tail-assessment.fixture.js';
import { render, screen, fireEvent, within } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach } from 'vitest';

const getFileHealth = vi.fn();
const recheckFileHealth = vi.fn();
const cancelRun = vi.fn();
const reviewFileHealth = vi.fn();
vi.mock('$lib/api/admin', () => ({
    getFileHealth: (...args: unknown[]) => getFileHealth(...args),
    recheckFileHealth,
    cancelRun,
    reviewFileHealth,
}));

const { default: FileHealthListPanel } = await import('./FileHealthListPanel.svelte');

/** The exact shape that produced "badge 2, list 0" on preprod. */
const TRAILER = {
    file_id: 'f-extra',
    file_path: '/data/movies/Cinderella (2015)/Cinderella-trailer.mkv',
    duration_seconds: 41,
    health_issues: [
        {
            type: 'truncated_video',
            detected_at: '2026-08-26T10:00:00.000Z',
            detail: 'Video decodes to ~12s but the container reports 41s',
            expected_duration: 41,
            actual_duration: 12,
        },
    ],
    media_item_id: '6c1d0d0e-0e2a-4a1b-9f1e-2b7d3f4a5c60',
    title: 'Cinderella trailer',
    media_type: 'extra',
    year: null,
};

/** Counted by the badge; listable by nothing that queries `media_items`. */
const UNLINKED = {
    file_id: 'f-orphan',
    file_path: '/data/music/Various/broken.flac',
    duration_seconds: null,
    health_issues: [{ type: 'tag_parse_corrupt', detected_at: '2026-08-26T10:00:00.000Z' }],
    media_item_id: null,
    title: null,
    media_type: null,
    year: null,
};

function resolves(files: unknown[], count = files.length) {
    getFileHealth.mockResolvedValue({ data: { files, count }, error: null });
}

beforeEach(() => {
    getFileHealth.mockReset();
    recheckFileHealth.mockReset();
    cancelRun.mockReset();
    reviewFileHealth.mockReset();
});

describe('FileHealthListPanel', () => {
    test('has a Reviewed scope and retains the raw duration observation on reviewed rows', async () => {
        getFileHealth
            .mockResolvedValueOnce({ data: { files: [], count: 1, reviewed: 1 } })
            .mockResolvedValueOnce({
                data: {
                    files: [
                        {
                            ...TRAILER,
                            classification: 'reviewed',
                            health_issues: TRAILER.health_issues.map((issue) => ({
                                ...issue,
                                reviewed: true,
                            })),
                        },
                    ],
                    count: 1,
                    reviewed: 1,
                    matching: 1,
                },
            });
        render(FileHealthListPanel);
        await fireEvent.click(await screen.findByRole('button', { name: 'Reviewed (1)' }));
        expect(await screen.findByText('Duration mismatch needs review')).toBeTruthy();
        expect(screen.getByText('Reviewed duration finding')).toBeTruthy();
        expect(getFileHealth).toHaveBeenLastCalledWith(expect.any(AbortSignal), {
            scope: 'reviewed',
            cursor: undefined,
        });
    });

    test('every linked and health-only unlinked row can recheck exactly its file', async () => {
        resolves([TRAILER, UNLINKED]);
        recheckFileHealth.mockResolvedValue({
            data: { fileId: 'f-orphan', outcome: 'warning', issues: UNLINKED.health_issues },
            error: null,
        });
        render(FileHealthListPanel);
        const buttons = await screen.findAllByRole('button', { name: /Recheck/ });
        expect(buttons).toHaveLength(2);
        await fireEvent.click(buttons[1]);
        expect(recheckFileHealth).toHaveBeenCalledWith(
            'f-orphan',
            expect.any(AbortSignal),
            expect.any(Function),
        );
    });

    test('keeps the completed result after the last warning disappears and reloads the total', async () => {
        getFileHealth
            .mockResolvedValueOnce({ data: { files: [TRAILER], count: 1 } })
            .mockResolvedValueOnce({ data: { files: [], count: 0 } });
        recheckFileHealth.mockResolvedValue({
            data: { fileId: TRAILER.file_id, outcome: 'healthy', issues: [] },
        });
        render(FileHealthListPanel);
        await fireEvent.click(await screen.findByRole('button', { name: 'Recheck' }));
        expect(
            await screen.findByText(/Recheck completed. No recorded warnings remain/),
        ).toBeTruthy();
        expect(await screen.findByText('Files with recorded warnings: 0')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Recheck' })).toBeNull();
        expect(getFileHealth).toHaveBeenCalledTimes(2);
    });

    test('pending and failed checks retain rows and never show a stale zero after reload failure', async () => {
        resolves([TRAILER]);
        let finish: (value: unknown) => void = () => {};
        recheckFileHealth.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        render(FileHealthListPanel);
        await fireEvent.click(await screen.findByRole('button', { name: 'Recheck' }));
        expect(screen.getByRole('button', { name: 'Rechecking…' }).getAttribute('aria-busy')).toBe(
            'true',
        );
        expect(screen.getAllByText('Cinderella-trailer.mkv')).toHaveLength(2);
        getFileHealth.mockResolvedValue({ error: 'Refresh failed' });
        finish({ error: 'Recheck failed' });
        expect(await screen.findByText('Recheck failed')).toBeTruthy();
        expect(await screen.findByText('Refresh failed')).toBeTruthy();
        expect(screen.queryByText('Files with recorded warnings: 0')).toBeNull();
    });

    test('lists an `extra`, which no media-browser type filter can reach', async () => {
        resolves([TRAILER]);
        render(FileHealthListPanel);

        // The filename, so the operator knows which file to re-download.
        expect(await screen.findByText('Cinderella-trailer.mkv')).toBeTruthy();
        // The recorded reason, not just the type name.
        expect(
            screen.getByText('Video decodes to ~12s but the container reports 41s'),
        ).toBeTruthy();
    });

    test('names the media type, so "trailer" is not an unattributable row', async () => {
        resolves([TRAILER]);
        render(FileHealthListPanel);

        expect(await screen.findByText(/Extra/)).toBeTruthy();
        const link = screen.getByRole('link');
        expect(link.getAttribute('href')).toContain(
            '/admin/library/media/6c1d0d0e-0e2a-4a1b-9f1e-2b7d3f4a5c60',
        );
    });

    test('shows a file with no linked item rather than dropping it', async () => {
        resolves([UNLINKED]);
        render(FileHealthListPanel);

        expect(await screen.findByText('broken.flac')).toBeTruthy();
        expect(screen.getByText('Not linked to any library item')).toBeTruthy();
        // Nothing to link to — and no link must be invented.
        expect(screen.queryByRole('link')).toBeNull();
    });

    test('states the matching page range without claiming every file is visible', async () => {
        // The endpoint returns at most 200 rows but the uncapped count; without
        // this a systemic problem reads as "here are all of them".
        resolves([TRAILER, UNLINKED], 121);
        render(FileHealthListPanel);

        expect(await screen.findByText(/Showing 1–2 of 121 matching files/)).toBeTruthy();
    });

    test('discloses the last refresh when no file has issues', async () => {
        resolves([], 0);
        const { container } = render(FileHealthListPanel);

        await vi.waitFor(() => expect(getFileHealth).toHaveBeenCalled());
        await vi.waitFor(() => expect(container.textContent?.trim()).toContain('Last refreshed:'));
    });

    test('surfaces a load failure instead of rendering an empty, reassuring panel', async () => {
        getFileHealth.mockResolvedValue({ data: null, error: 'boom' });
        render(FileHealthListPanel);

        expect(await screen.findByText('boom')).toBeTruthy();
    });
});

test('Cancel sends the accepted run, displays refusal, and waits for terminal cancellation', async () => {
    resolves([TRAILER]);
    let finish: (value: unknown) => void = () => {};
    recheckFileHealth.mockImplementation((_file, _signal, accepted) => {
        accepted('run_current');
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    cancelRun
        .mockResolvedValueOnce({ data: { accepted: false } })
        .mockResolvedValueOnce({ data: { accepted: true } });
    render(FileHealthListPanel);
    await fireEvent.click(await screen.findByRole('button', { name: 'Recheck' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancelRun).toHaveBeenCalledWith('run_current');
    expect(await screen.findByText(/Cancellation could not be confirmed/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Rechecking…' }).getAttribute('aria-busy')).toBe(
        'true',
    );
    expect(screen.queryByText(/Recheck cancelled/)).toBeNull();
    finish({ data: { fileId: TRAILER.file_id, outcome: 'cancelled', issues: [] } });
    expect(await screen.findByText(/Recheck cancelled/)).toBeTruthy();
    expect(screen.getAllByText('Cinderella-trailer.mkv').length).toBeGreaterThan(0);
    expect(getFileHealth).toHaveBeenCalledTimes(2);
});

test('keeps a refreshed duration warning with its timing and actual warning outcome', async () => {
    const row = {
        ...TRAILER,
        health_issues: [
            { type: 'video_ends_early', actual_duration: 1420, expected_duration: 1503 },
        ],
    };
    getFileHealth
        .mockResolvedValueOnce({
            data: {
                files: [
                    {
                        ...row,
                        health_issues: [
                            {
                                type: 'video_ends_early',
                                actual_duration: 1200,
                                expected_duration: 1503,
                            },
                        ],
                    },
                ],
                count: 43,
            },
            error: null,
        })
        .mockResolvedValue({ data: { files: [row], count: 43 }, error: null });
    recheckFileHealth.mockResolvedValue({
        data: {
            fileId: row.file_id,
            outcome: 'warning',
            issues: [{ type: 'video_ends_early' }],
            reason: 'warnings_remain',
        },
        error: null,
    });
    render(FileHealthListPanel);
    const reason =
        'Duration mismatch needs review: video stops at 1420s; the container reports 1503s';
    const oldReason =
        'Duration mismatch needs review: video stops at 1200s; the container reports 1503s';
    expect(await screen.findByText(oldReason)).toBeTruthy();
    expect(screen.queryByText(reason)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    expect(await screen.findByText(/warnings remain/)).toBeTruthy();
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.queryByText(oldReason)).toBeNull();
    expect(screen.getByText('Files with recorded warnings: 43')).toBeTruthy();
    expect(screen.queryByText(/could not be verified/)).toBeNull();
    expect(getFileHealth).toHaveBeenCalledTimes(2);
});

test('reconciles replacement warning rows when the refresh key changes but total stays constant', async () => {
    resolves([TRAILER]);
    const view = render(FileHealthListPanel, { refreshKey: 1 });
    await screen.findByText('Cinderella trailer');
    resolves([
        { ...TRAILER, file_id: 'replacement-warning', title: 'Fictional replacement warning' },
    ]);
    await view.rerender({ refreshKey: 2 });
    await screen.findByText('Fictional replacement warning');
    expect(screen.queryByText('Cinderella trailer')).toBeNull();
});

test('keeps observations, completeness caveats and raw details attached to their Health file row', async () => {
    resolves([
        {
            ...UNLINKED,
            file_id: 'quiet-file',
            file_path: '/fictional/quiet.mkv',
            tailAssessment: audioTailAssessmentFixture('quiet-file'),
        },
        {
            ...UNLINKED,
            file_id: 'audible-file',
            file_path: '/fictional/audible.mkv',
            tailAssessment: audioTailAssessmentFixture('audible-file', 'audible'),
        },
    ]);
    render(FileHealthListPanel);
    const quiet = (await screen.findByText('quiet.mkv')).closest('.card-bordered')! as HTMLElement;
    const audible = screen.getByText('audible.mkv').closest('.card-bordered')! as HTMLElement;
    expect(within(quiet).getByText(/All measured channels stayed at or below/)).toBeTruthy();
    expect(within(quiet).queryByText(/Audio was observed after the video ended/)).toBeNull();
    expect(within(audible).getByText(/Audio was observed after the video ended/)).toBeTruthy();
    expect(within(audible).queryByText(/All measured channels stayed at or below/)).toBeNull();
    for (const [row, id, other] of [
        [quiet, 'quiet-file', 'audible-file'],
        [audible, 'audible-file', 'quiet-file'],
    ] as const) {
        expect(within(row).getByText(/File completeness remains unverified/)).toBeTruthy();
        const summary = within(row).getByText('Measurement details');
        const details = summary.closest('details')!;
        expect(details.open).toBe(false);
        expect(details.textContent).toContain(`fixture-physical-${id}`);
        expect(details.textContent).not.toContain(`fixture-physical-${other}`);
        await fireEvent.click(summary);
        expect(details.open).toBe(true);
    }
});

test('keeps current and unproven range observations attached to their mounted Health file rows', async () => {
    const proof = rangeMappingProofFixture();
    resolves([
        {
            ...UNLINKED,
            file_id: proof.participants[0].fileId,
            file_path: proof.participants[0].path,
            health_issues: [{ type: 'range_superseded', detected_at: proof.observedAt }],
            rangeMapping: { state: 'current', proof },
        },
        {
            ...UNLINKED,
            file_id: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            file_path: '/test-media/Lantern Station S01E03E04.mkv',
            health_issues: [{ type: 'range_superseded', detected_at: proof.observedAt }],
            rangeMapping: { state: 'unproven' },
        },
    ]);
    // Keep the real child mounted: dropping its invocation or mapping prop
    // must remove these row-scoped observations and fail this test.
    render(FileHealthListPanel);
    const current = (await screen.findByText('Lantern Station S01E01E02.mkv')).closest(
        '.card-bordered',
    )! as HTMLElement;
    const unproven = screen
        .getByText('Lantern Station S01E03E04.mkv')
        .closest('.card-bordered')! as HTMLElement;

    expect(
        within(current).getByText(
            `Dedicated episode mappings observed on ${new Date(proof.observedAt).toLocaleString()}.`,
        ),
    ).toBeTruthy();
    expect(within(current).getByText(/content completeness is unverified/)).toBeTruthy();
    expect(within(current).queryByText(/mappings are unproven/)).toBeNull();
    const details = within(current).getByText('Recorded mapping details').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(proof.observedAt);
    for (const participant of proof.participants) {
        expect(details.textContent).toContain(participant.fileId);
        expect(details.textContent).toContain(participant.path);
        expect(unproven.textContent).not.toContain(participant.fileId);
    }
    expect(
        within(unproven).getByText(
            'Dedicated episode mappings are unproven. Review this recorded warning.',
        ),
    ).toBeTruthy();
    expect(within(unproven).queryByText(/Dedicated episode mappings observed on/)).toBeNull();
    expect(within(unproven).queryByText(/content completeness is unverified/)).toBeNull();
    expect(within(unproven).queryByText('Recorded mapping details')).toBeNull();
});

test('loads bounded next pages and switches to the separate information view', async () => {
    const cursor = '2026-10-25T12:00:00.000001Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    getFileHealth
        .mockResolvedValueOnce({
            data: {
                files: [TRAILER],
                count: 2,
                recorded: 2,
                actionable: 1,
                informational: 1,
                matching: 1,
                nextCursor: cursor,
            },
        })
        .mockResolvedValueOnce({
            data: {
                files: [UNLINKED],
                count: 2,
                recorded: 2,
                actionable: 1,
                informational: 1,
                matching: 1,
                nextCursor: null,
            },
        })
        .mockResolvedValue({
            data: {
                files: [TRAILER],
                count: 2,
                recorded: 2,
                actionable: 1,
                informational: 1,
                matching: 1,
                nextCursor: null,
            },
        });
    render(FileHealthListPanel);
    await screen.findByText('Cinderella-trailer.mkv');
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('broken.flac');
    expect(getFileHealth).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), {
        scope: 'actionable',
        cursor,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Mapping observations (1)' }));
    await screen.findByText('Cinderella-trailer.mkv');
    expect(getFileHealth).toHaveBeenNthCalledWith(3, expect.any(AbortSignal), {
        scope: 'informational',
        cursor: undefined,
    });
});
