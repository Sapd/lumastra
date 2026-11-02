// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    compatibility: vi.fn(),
    caps: vi.fn(),
    search: vi.fn(),
    install: vi.fn(),
    review: vi.fn(),
}));
vi.mock('$lib/api/admin', () => ({
    getMediaCompatibility: mocks.compatibility,
    searchSubtitles: mocks.search,
    installSubtitle: mocks.install,
    reviewFileHealth: mocks.review,
    probeRawFile: vi.fn(),
    getMediaChapters: vi.fn(async () => ({ data: { chapters: [] } })),
    getMediaStreams: vi.fn(async () => ({ data: { streams: [] } })),
}));
vi.mock('$lib/components/player/browserCapabilities.svelte', () => ({
    ensurePathScopedCapabilities: mocks.caps,
    serializePathScopedCaps: () => '{}',
}));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ url: new URL('http://localhost/admin/library/media/movie'), data: {} }),
    };
});
import { invalidate } from '$app/navigation';
import { getMediaStreams } from '$lib/api/admin';
import FilesTab from './FilesTab.svelte';
import { audioTailAssessmentFixture } from './audio-tail-assessment.fixture.js';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
function file(id: string, label: string) {
    return {
        id,
        file_path: `/fictional/${label}.mp4`,
        file_label: label,
        part_number: id === A ? 2 : null,
        media_item_id: 'movie',
        is_default: id === A,
        duration_seconds: 150,
        container_format: 'mp4',
        health_issues: [],
    };
}
function manifest(id: string) {
    return {
        fileId: id,
        width: 320,
        height: 180,
        tileColumns: 2,
        tileRows: 1,
        intervalMs: 10000,
        thumbnailCount: 2,
        sheets: [{ index: 0, startMs: 0, endMs: 20000, href: `/sheet-${id}` }],
    };
}
function response(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200 });
}
beforeEach(() => {
    vi.stubGlobal(
        'EventSource',
        class extends EventTarget {
            onopen: (() => void) | null = null;
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            close(): void {}
        },
    );
    mocks.caps.mockResolvedValue(null);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
        (blob) => `blob:${blob instanceof Blob ? blob.size : 0}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.compatibility.mockReset();
    mocks.caps.mockReset();
    mocks.review.mockReset();
});
it('shows the selected physical version preview when the old manifest resolves late', async () => {
    let finishA: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('/files?'))
            return Promise.resolve(
                response({ files: [file(A, 'Version A'), file(B, 'Version B')] }),
            );
        if (url.includes('/manifest'))
            return url.includes(A)
                ? new Promise((resolve) => {
                      finishA = resolve;
                  })
                : Promise.resolve(response(manifest(B)));
        if (url === `/sheet-${B}`)
            return Promise.resolve(new Response(new Blob(['selected-version-b'])));
        return Promise.resolve(new Response('', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await waitFor(() => expect(finishA).toBeTypeOf('function'));
    expect(screen.getByText('Part 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-read file details' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Version B', pressed: false }));
    await waitFor(() => expect(view.container.querySelector('[style*="blob:18"]')).toBeTruthy());
    finishA?.(response(manifest(A)));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.container.querySelector('[style*="blob:18"]')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `/sheet-${A}`)).toBe(false);
});
it('rejects stale compatibility errors across A to B to A selection', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({ files: [file(A, 'Version A'), file(B, 'Version B')] })
                : new Response('', { status: 404 }),
        ),
    );
    let failOld: ((reason: Error) => void) | undefined;
    mocks.compatibility
        .mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    failOld = reject;
                }),
        )
        .mockResolvedValue({ error: 'Current compatibility outcome' });
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByRole('button', { name: 'Version A', pressed: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Check Compatibility' }));
    await waitFor(() => expect(failOld).toBeTypeOf('function'));
    await fireEvent.click(screen.getByRole('button', { name: 'Version B', pressed: false }));
    await fireEvent.click(screen.getByRole('button', { name: 'Version A', pressed: false }));
    await fireEvent.click(screen.getByRole('button', { name: 'Check Compatibility' }));
    expect(await screen.findByText('Current compatibility outcome')).toBeTruthy();
    failOld?.(new Error('Old request'));
    await Promise.resolve();
    expect(screen.getByText('Current compatibility outcome')).toBeTruthy();
});

it('physical file cards adopt their own batched languages without mixing alternate versions', async () => {
    const summary = (id: string, language: string) => ({
        fileId: id,
        probed: true,
        isMissing: false,
        audio: [{ language, isDefault: true, isForced: false, source: 'embedded' }],
        subtitles: [],
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          { ...file(A, 'Japanese cut'), language_summary: summary(A, 'jpn') },
                          { ...file(B, 'English cut'), language_summary: summary(B, 'eng') },
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    const view = render(FilesTab, { mediaId: 'episode', mediaType: 'episode' });
    await screen.findByRole('button', { name: 'Japanese cut', pressed: true });
    const a = view.container.querySelector(`[data-file-id="${A}"]`)! as HTMLElement;
    const b = view.container.querySelector(`[data-file-id="${B}"]`)! as HTMLElement;
    expect(within(a).getByLabelText('Language details').textContent).toContain('Audio: Japanese');
    expect(within(a).getByLabelText('Language details').textContent).not.toContain('English');
    expect(within(b).getByLabelText('Language details').textContent).toContain('Audio: English');
    expect(within(b).getByLabelText('Language details').textContent).toContain(
        'Subtitles: None found',
    );
});

it('offers one duration review entry per affected physical file and opens its preview', async () => {
    mocks.review.mockResolvedValue({
        data: {
            action: 'preview',
            preview: {
                fileId: A,
                fileName: 'Version A.mp4',
                filePath: `/fictional/Version A.mp4`,
                snapshot: 'a'.repeat(64),
                eligible: false,
                blockedReason: 'needs-recheck',
                findings: [],
                history: [],
            },
        },
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          {
                              ...file(A, 'Version A'),
                              health_issues: [
                                  {
                                      type: 'duration_mismatch',
                                      detected_at: '2026-10-25T12:00:00Z',
                                  },
                              ],
                          },
                          file(B, 'Healthy'),
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    expect(
        await screen.findAllByRole('button', { name: 'Review duration difference' }),
    ).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Review duration difference' }));
    expect(await screen.findAllByText('/fictional/Version A.mp4')).toHaveLength(2);
    expect(mocks.review).toHaveBeenCalledWith({ action: 'preview', fileId: A });
});

it('successful sidecar installation refreshes the same file summary and invalidates Overview data', async () => {
    let installed = false;
    vi.mocked(getMediaStreams).mockResolvedValue({
        data: {
            streams: [
                {
                    id: 'audio',
                    stream_type: 'audio',
                    stream_index: 0,
                    codec: 'aac',
                    language: 'jpn',
                    is_default: true,
                    is_forced: false,
                },
            ],
        },
    } as Awaited<ReturnType<typeof getMediaStreams>>);
    mocks.search.mockResolvedValue({
        data: {
            providers: 1,
            candidates: [
                {
                    id: 'sidecar',
                    providerId: 'fiction',
                    language: 'fra',
                    format: 'ass',
                    releaseName: 'French sidecar',
                },
            ],
        },
    });
    mocks.install.mockImplementation(async () => {
        installed = true;
        return { data: { language: 'fra' } };
    });
    vi.mocked(invalidate).mockClear();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          {
                              ...file(A, 'Selected cut'),
                              language_summary: {
                                  fileId: A,
                                  probed: true,
                                  isMissing: false,
                                  audio: [],
                                  subtitles: installed
                                      ? [
                                            {
                                                language: 'fra',
                                                isDefault: null,
                                                isForced: true,
                                                source: 'sidecar',
                                            },
                                        ]
                                      : [],
                              },
                          },
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    render(FilesTab, { mediaId: 'episode', mediaType: 'episode' });
    await screen.findByRole('button', { name: 'Selected cut', pressed: true });
    expect(screen.getByLabelText('Language details').textContent).toContain(
        'Subtitles: None found',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Find subtitles' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    await waitFor(() =>
        expect(screen.getByLabelText('Language details').textContent).toContain(
            'Subtitles: French',
        ),
    );
    expect(invalidate).toHaveBeenCalledWith('media:runs');
});

it('refreshes selected source evidence on focus without changing its canonical UUID', async () => {
    let replacement = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/files?')
            ? response({
                  files: [
                      {
                          ...file(A, replacement ? 'Verified replacement' : 'Pending source'),
                          duration_seconds: replacement ? 150 : null,
                      },
                  ],
              })
            : new Response('', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByText('Pending source');
    replacement = true;
    await fireEvent(window, new Event('focus'));
    await screen.findByText('Verified replacement');
    expect(screen.queryByText('Pending source')).toBeNull();
});

it('reloads selected streams and chapters on focus when source fields and UUID are unchanged', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({ files: [file(A, 'Unchanged source')] })
                : new Response('', { status: 404 }),
        ),
    );
    const { getMediaChapters } = await import('$lib/api/admin');
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByText('Unchanged source');
    await waitFor(() => expect(getMediaStreams).toHaveBeenCalled());
    vi.mocked(getMediaStreams).mockClear();
    vi.mocked(getMediaChapters).mockClear();
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(getMediaStreams).toHaveBeenCalledTimes(2));
    expect(getMediaChapters).toHaveBeenCalledWith('movie', A);
});

it('clears former-source technical evidence and keeps a persistent stale label when replacement reads fail', async () => {
    let replacement = false;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          {
                              ...file(A, 'Same canonical file'),
                              file_hash_head: replacement ? 'replacement' : 'original',
                          },
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    const { getMediaChapters } = await import('$lib/api/admin');
    vi.mocked(getMediaChapters).mockResolvedValue({
        data: {
            chapters: [
                {
                    chapter_index: 0,
                    id: 1,
                    file_id: A,
                    media_item_id: 'movie',
                    chapter_name: 'Fictional old chapter',
                    source: 'ffprobe',
                    fetched_at: '2026-10-24T10:00:00Z',
                    startMs: 0,
                    endMs: 150000,
                },
            ],
        },
    } as Awaited<ReturnType<typeof getMediaChapters>>);
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByText('Fictional old chapter');
    vi.mocked(getMediaChapters).mockResolvedValue({
        error: 'fictional source read failed',
    } as Awaited<ReturnType<typeof getMediaChapters>>);
    vi.mocked(getMediaStreams).mockResolvedValue({
        error: 'fictional source read failed',
    } as Awaited<ReturnType<typeof getMediaStreams>>);
    replacement = true;
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByText('Fictional old chapter')).toBeNull());
    await waitFor(() =>
        expect(document.querySelectorAll('[role="status"]').length).toBeGreaterThan(0),
    );
});

it('retains compatibility results and in-flight checks across unchanged focus refreshes without duplicate technical loads', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/files?')
            ? response({ files: [file(A, 'Unchanged source')] })
            : new Response('', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    let finish!: (value: unknown) => void;
    mocks.compatibility.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByRole('button', { name: 'Unchanged source', pressed: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Check Compatibility' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const before = vi.mocked(getMediaStreams).mock.calls.length;
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(getMediaStreams).toHaveBeenCalledTimes(before + 1));
    finish({
        data: {
            files: [
                {
                    file_id: A,
                    file_path: '/fictional/compatibility-result.mp4',
                    label: null,
                    media_info: {
                        video_codec: 'h264',
                        audio_codecs: ['aac'],
                        container: 'mp4',
                        hdr: 'sdr',
                    },
                    browsers: [],
                },
            ],
        },
    });
    await screen.findByText('compatibility-result.mp4');
    await fireEvent(window, new Event('focus'));
    await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/files?')).length).toBe(
            3,
        ),
    );
    expect(screen.getByText('compatibility-result.mp4')).toBeTruthy();
});

it('discards late compatibility for replaced content under the same selected UUID', async () => {
    let replacement = false;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          {
                              ...file(A, 'Same UUID'),
                              file_hash_head: replacement ? 'new-bytes' : 'old-bytes',
                          },
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    let finish!: (value: unknown) => void;
    mocks.compatibility
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        )
        .mockResolvedValue({ error: 'Replacement compatibility outcome' });
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByRole('button', { name: 'Same UUID', pressed: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Check Compatibility' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    replacement = true;
    await fireEvent(window, new Event('focus'));
    await screen.findByRole('button', { name: 'Check Compatibility' });
    await fireEvent.click(screen.getByRole('button', { name: 'Check Compatibility' }));
    await screen.findByText('Replacement compatibility outcome');
    finish({ error: 'Old content compatibility outcome' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Old content compatibility outcome')).toBeNull();
    expect(screen.getByText('Replacement compatibility outcome')).toBeTruthy();
});

it('renders each physical file’s own audio observation, caveat and expandable evidence', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          {
                              ...file(A, 'Silent fixture'),
                              tailAssessment: audioTailAssessmentFixture(A),
                          },
                          {
                              ...file(B, 'Audible fixture'),
                              tailAssessment: audioTailAssessmentFixture(B, 'audible'),
                          },
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    const view = render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByRole('button', { name: 'Silent fixture', pressed: true });
    const a = view.container.querySelector(`[data-file-id="${A}"]`)! as HTMLElement;
    const b = view.container.querySelector(`[data-file-id="${B}"]`)! as HTMLElement;
    expect(within(a).getByText(/All measured channels stayed at or below/)).toBeTruthy();
    expect(within(a).queryByText(/Audio was observed after the video ended/)).toBeNull();
    expect(within(b).getByText(/Audio was observed after the video ended/)).toBeTruthy();
    expect(within(b).queryByText(/All measured channels stayed at or below/)).toBeNull();
    for (const [card, id, other] of [
        [a, A, B],
        [b, B, A],
    ] as const) {
        expect(within(card).getByText(/File completeness remains unverified/)).toBeTruthy();
        const details = within(card).getByText('Measurement details').closest('details')!;
        expect(details.open).toBe(false);
        expect(details.textContent).toContain(`fixture-physical-${id}`);
        expect(details.textContent).not.toContain(`fixture-physical-${other}`);
        await fireEvent.click(within(card).getByText('Measurement details'));
        expect(details.open).toBe(true);
    }
});

it('labels the global physical-file count rather than the current episode context count', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL): Promise<Response> =>
            Promise.resolve(
                String(input).includes('/files?')
                    ? response({ files: [{ ...file(A, 'Shared file'), linked_media_count: 3 }] })
                    : new Response('', { status: 404 }),
            ),
        ),
    );
    render(FilesTab, { mediaId: 'movie', mediaType: 'episode' });
    expect(await screen.findByText('Linked media items across the library: 3')).toBeTruthy();
    expect(screen.queryByText('1 linked media item')).toBeNull();
});

it('renders current mapping as information while mixed and unknown file warnings remain actionable', async () => {
    const current = {
        ...file(A, 'Current Mapping'),
        health_classification: 'informational',
        health_issues: [{ type: 'range_superseded', detected_at: '2026-10-25T00:00:00Z' }],
    };
    const mixed = {
        ...file(B, 'Mixed Warning'),
        health_classification: 'actionable',
        health_issues: [
            { type: 'range_superseded', detected_at: '2026-10-25T00:00:00Z' },
            { type: 'truncated_video', detected_at: '2026-10-25T00:00:00Z' },
        ],
    };
    const unknown = {
        ...file('00000000-0000-4000-8000-000000000003', 'Unknown Warning'),
        health_classification: 'actionable',
        health_issues: [{ type: 'unknown_recorded_evidence', detected_at: '2026-10-25T00:00:00Z' }],
    };
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({ files: [current, mixed, unknown] })
                : new Response('', { status: 404 }),
        ),
    );
    const view = render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByText('Current Mapping');
    expect(
        screen.getByText('Current recorded episode mapping; file content remains unverified.'),
    ).toBeTruthy();
    expect(screen.getByText('Unknown recorded warning')).toBeTruthy();
    expect(view.container.textContent).toContain('Duration mismatch needs review');
    expect(view.container.textContent).toContain('Recorded episode-file mapping');
    expect(view.container.textContent).not.toContain('Covered by single-episode files');
    const informationCard = screen
        .getByText('Current recorded episode mapping; file content remains unverified.')
        .closest('article');
    expect(informationCard?.textContent).not.toContain('Recorded episode-file mapping');
});

it.each(['series', 'season'])(
    'names %s descendant files and shows each combined-file episode window',
    async (kind) => {
        const base = {
            file_label: null,
            edition: null,
            part_number: null,
            duration_seconds: 5400,
            container_format: 'matroska,webm',
            health_issues: [],
        };
        const rows = [
            {
                ...base,
                id: A,
                file_path: '/fictional/combined.1080p.mkv',
                media_item_id: 'episode-1',
                is_default: true,
                file_sort_order: 0,
                start_offset_ms: 0,
                end_offset_ms: 2722000,
                season_number: 1,
                episode_number: 1,
                media_title: 'Pilot',
            },
            {
                ...base,
                id: A,
                file_path: '/fictional/combined.1080p.mkv',
                media_item_id: 'episode-2',
                is_default: false,
                file_sort_order: 1,
                start_offset_ms: 2722000,
                end_offset_ms: 5400000,
                season_number: 1,
                episode_number: 2,
                media_title: 'Second',
            },
            {
                ...base,
                id: B,
                file_path: '/fictional/single.mkv',
                media_item_id: 'episode-3',
                is_default: true,
                file_sort_order: 0,
                start_offset_ms: null,
                end_offset_ms: null,
                season_number: 1,
                episode_number: 3,
                media_title: 'Third',
            },
        ];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) =>
                String(input).includes('/files?')
                    ? response({ files: rows })
                    : new Response('', { status: 404 }),
            ),
        );
        const view = render(FilesTab, {
            mediaId: kind,
            mediaType: kind,
            isSeries: kind === 'series',
        });
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/files?children=true')),
        );
        const cards = within(await screen.findByTestId('physical-file-cards'));
        expect(cards.getAllByText('Matroska (MKV)')).toHaveLength(2);
        await cards.findByRole('button', { name: 'combined.1080p.mkv' });
        expect(
            screen.getAllByRole('button', { name: 'combined.1080p.mkv' }).length,
        ).toBeGreaterThan(1);
        expect(screen.queryByRole('button', { name: '1080p' })).toBeNull();
        expect(cards.getByRole('button', { name: 'single.mkv' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Version \d+$/ })).toBeNull();
        const combined = view.container.querySelector(`[data-file-id="${A}"]`)! as HTMLElement;
        expect(
            within(combined).getByText('· 0:00–45:22 · Used for playback · Playback order: 1'),
        ).toBeTruthy();
        expect(
            within(combined).getByText('· 45:22–1:30:00 · Other copy · Playback order: 2'),
        ).toBeTruthy();
        expect(combined.textContent).not.toContain('· — ·');
        const single = view.container.querySelector(`[data-file-id="${B}"]`)! as HTMLElement;
        expect(within(single).getByText('· Used for playback')).toBeTruthy();
        expect(single.textContent).not.toContain('Order:');
    },
);

it('names alternate movie releases by filename and edition rather than an ordinal version', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes('/files?')
                ? response({
                      files: [
                          { ...file(A, 'Cinema cut'), file_label: null, part_number: null },
                          {
                              ...file(B, 'Extended cut'),
                              file_label: null,
                              edition: 'Extended edition',
                          },
                      ],
                  })
                : new Response('', { status: 404 }),
        ),
    );
    render(FilesTab, { mediaId: 'movie', mediaType: 'movie' });
    await screen.findByTestId('physical-file-cards');
    const cards = within(screen.getByTestId('physical-file-cards'));
    expect(cards.getByRole('button', { name: 'Cinema cut.mp4' })).toBeTruthy();
    expect(cards.getByRole('button', { name: 'Extended edition' })).toBeTruthy();
    expect(cards.queryByRole('button', { name: /^Version/ })).toBeNull();
});
