// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import IngestMap from './IngestMap.svelte';
import type { MapResponse } from './ingest-map.types.js';
import { currentStationIndex, formatTrainHeadline, LINES } from './ingest-map.constants.js';
import type { StageStatus, FileHealthIssueType } from '$lib/types/pipeline.js';

// ── Mock EventSource ──────────────────────────────────────────────────────────

class MockEventSource {
    listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
    closed = false;
    addEventListener(type: string, listener: (ev: { data: string }) => void): void {
        (this.listeners[type] ??= []).push(listener);
    }
    fire(type: string, data: unknown): void {
        for (const l of this.listeners[type] ?? []) {
            l({ data: typeof data === 'string' ? data : JSON.stringify(data) });
        }
    }
    close(): void {
        this.closed = true;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stage(stage_id: string, status: StageStatus = 'completed') {
    return {
        stage_id,
        status,
        processing_version: 1,
        attempt: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
    };
}

function item(
    id: string,
    title: string,
    media_type: string,
    stages: ReturnType<typeof stage>[] = [],
) {
    return {
        media_item_id: id,
        media_type,
        title,
        created_at: new Date().toISOString(),
        stages,
    };
}

function emptyInitial(): MapResponse {
    return {
        items: [],
        window: {
            since: new Date().toISOString(),
            until: new Date().toISOString(),
        },
        total: 0,
    };
}

// happy-dom does not implement the Web Animations API (`Element.prototype.animate`),
// which Svelte 5 uses to drive `in:`/`out:` transitions. Without it, the train's
// `out:fade` outro throws ("element.animate is not a function") and the outgoing
// node is never removed from the DOM — so a delete event leaves the train visible.
// Install a minimal Animation stub that finishes on the next microtask so outros
// complete and the node is torn down, matching real-browser behaviour.
function installAnimatePolyfill(): void {
    if (typeof Element === 'undefined' || typeof Element.prototype.animate === 'function') {
        return;
    }
    Element.prototype.animate = function animate(): Animation {
        let onfinish: ((this: Animation, ev: Event) => unknown) | null = null;
        let oncancel: ((this: Animation, ev: Event) => unknown) | null = null;
        const finished = Promise.resolve();
        const anim = {
            get finished(): Promise<unknown> {
                return finished;
            },
            get onfinish(): typeof onfinish {
                return onfinish;
            },
            set onfinish(fn: typeof onfinish) {
                onfinish = fn;
                if (fn) {
                    // Fire on a microtask so the outro completes and Svelte removes the node.
                    queueMicrotask(() =>
                        fn.call(anim as unknown as Animation, new Event('finish')),
                    );
                }
            },
            get oncancel(): typeof oncancel {
                return oncancel;
            },
            set oncancel(fn: typeof oncancel) {
                oncancel = fn;
            },
            currentTime: 0,
            startTime: 0,
            playState: 'finished' as AnimationPlayState,
            playbackRate: 1,
            effect: null,
            play(): void {},
            pause(): void {},
            cancel(): void {},
            finish(): void {},
            commitStyles(): void {},
            reverse(): void {},
            addEventListener(): void {},
            removeEventListener(): void {},
        };
        return anim as unknown as Animation;
    } as typeof Element.prototype.animate;
}

beforeEach(() => {
    installAnimatePolyfill();
    // Stub fetch so window-change refetches don't blow up.
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(emptyInitial()),
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('IngestMap', () => {
    test('renders one section per metro line with the correct labels', () => {
        const initial: MapResponse = {
            items: [],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 0,
        };
        const factory = (): MockEventSource => new MockEventSource();
        render(IngestMap, { initial, eventSourceFactory: factory });

        for (const line of LINES) {
            // Each line header is rendered as an h3.
            const heading = screen.getByRole('heading', {
                level: 3,
                name: line.label,
            });
            expect(heading).toBeTruthy();
        }
    });

    test('groups items by media_type onto the correct line', () => {
        const initial: MapResponse = {
            items: [
                item('m1', 'A Movie', 'movie', [stage('media-probe-a', 'completed')]),
                item('s1', 'A Series', 'tv', [stage('media-probe-a', 'completed')]),
                item('t1', 'A Track', 'track', [stage('media-probe-a', 'completed')]),
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 3,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        // Three trains, one per line.
        const trains = container.querySelectorAll('g.train');
        expect(trains.length).toBe(3);

        // Each train carries its title in the visible <text> inside the pill.
        const titles = Array.from(trains).map((t) => t.querySelector('text')?.textContent?.trim());
        expect(titles).toContain('A Movie');
        expect(titles).toContain('A Series');
        expect(titles).toContain('A Track');
    });

    test('currentStationIndex helper places running items at running station', () => {
        const movieStations = LINES[0].stations;
        // Movie with media-probe completed and tmdb running.
        const stages = [
            stage('media-probe-a', 'completed'),
            stage('tmdb-metadata-sync', 'running'),
        ];
        const result = currentStationIndex(movieStations, stages);
        expect(result.mode).toBe('running');
        expect(result.index).toBe(1);
    });

    test('currentStationIndex helper marks done when all complete', () => {
        const stations = LINES[2].stations; // music
        const stages = stations.map((s) => stage(s, 'completed'));
        const result = currentStationIndex(stations, stages);
        expect(result.mode).toBe('done');
        expect(result.index).toBe(stations.length - 1);
    });

    test('formatTrainHeadline prefixes a season with its series title', () => {
        const headline = formatTrainHeadline({
            media_type: 'season',
            title: 'Season 1',
            series_title: 'Haus des Geldes',
            season_number: 1,
            episode_number: null,
        });
        expect(headline).toBe('Haus des Geldes · Season 1');
    });

    test('formatTrainHeadline falls back to the bare title when a season has no series_title', () => {
        const headline = formatTrainHeadline({
            media_type: 'season',
            title: 'Specials',
            series_title: null,
            season_number: 0,
            episode_number: null,
        });
        expect(headline).toBe('Specials');
    });

    test('table-view toggle switches to accessible table', async () => {
        const initial: MapResponse = {
            items: [item('m1', 'A Movie', 'movie', [stage('media-probe-a', 'completed')])],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 1,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        // Map view default: no <table> visible.
        expect(container.querySelector('table')).toBeNull();

        // Click "Table" button.
        const tableBtn = screen.getByRole('button', { name: 'Table' });
        await fireEvent.click(tableBtn);

        // Table now rendered with row for our movie.
        const table = container.querySelector('table');
        expect(table).not.toBeNull();
        expect(screen.getByText('A Movie')).toBeTruthy();
    });

    test('keeps global health and diagnostic links visible while map and table filters change', async () => {
        const initial: MapResponse = {
            ...emptyInitial(),
            items: [
                item('movie', 'Mëtallica Movie', 'movie', [stage('media-probe-a', 'running')]),
                item('track', 'Metallica Track', 'track', [stage('media-probe-a', 'pending')]),
                item('series', 'Another Series', 'tv', [stage('media-probe-a', 'pending')]),
            ],
            pipelineSummary: {
                inFlight: 39,
                running: 12,
                failedLastHour: 8,
                deadLetterItems: 3,
                degradedItems: 2,
                oldestPendingAgeSec: 3600,
                reidentifyItems: 1,
            },
        };
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: () => new MockEventSource(),
        });
        const health = screen.getByRole('region', { name: 'Pipeline health' });
        expect(within(health).getByText('39')).toBeTruthy();
        expect(within(health).getByText(/Global totals/)).toBeTruthy();
        expect(
            within(health)
                .getByRole('link', { name: /Failed in the last hour/ })
                .getAttribute('href'),
        ).toBe('#error-groups');
        expect(
            within(health)
                .getByRole('link', { name: /stopped retrying/ })
                .getAttribute('href'),
        ).toBe('#dead-letter');
        expect(
            within(health)
                .getByRole('link', { name: /Struggling/ })
                .getAttribute('href'),
        ).toBe('#stuck-items');
        expect(
            within(health)
                .getByRole('link', { name: /needs re-identify/ })
                .getAttribute('href'),
        ).toContain('/admin/library/fix-matches?view=broken');

        await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter items by title' }), {
            target: { value: 'metallica' },
        });
        await waitFor(() => expect(container.querySelectorAll('g.train').length).toBe(2));
        expect(screen.getByRole('status').textContent).toContain('2 of 3 loaded items');
        await fireEvent.click(screen.getByRole('button', { name: 'Music' }));
        await waitFor(() => expect(container.querySelectorAll('g.train').length).toBe(1));
        await fireEvent.click(screen.getByRole('button', { name: 'Table' }));
        const table = screen.getByRole('table');
        expect(within(table).getByText('Metallica Track')).toBeTruthy();
        expect(within(table).queryByText('Mëtallica Movie')).toBeNull();
        expect(within(health).getByText('39')).toBeTruthy();
        for (const anchor of ['stuck-items', 'dead-letter', 'error-groups']) {
            expect(container.querySelector(`#${anchor}`)).not.toBeNull();
        }

        await fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
        expect(within(table).getByText('Mëtallica Movie')).toBeTruthy();
        expect(within(table).getByText('Another Series')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Map' }));
        expect(container.querySelectorAll('g.train').length).toBe(3);
        expect(screen.getByRole('region', { name: 'Pipeline health' })).toBe(health);
    });

    test('advances the loaded window scope after success with and without media filters', async () => {
        let finishMap!: (response: Response) => void;
        const mapResponse = new Promise<Response>((resolve) => {
            finishMap = resolve;
        });
        vi.mocked(fetch).mockImplementation((input) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.includes('/ingest/map?')) return mapResponse;
            if (url.includes('/scan-issues')) {
                return Promise.resolve(Response.json({ issues: [], total: 0, truncated: false }));
            }
            if (url.includes('/stage-activity')) {
                return Promise.resolve(Response.json({ stages: [] }));
            }
            return Promise.resolve(
                Response.json({
                    summary: {
                        inFlight: 0,
                        running: 0,
                        failedLastHour: 0,
                        deadLetterItems: 0,
                        degradedItems: 0,
                        oldestPendingAgeSec: null,
                    },
                    stuckItems: [],
                    deadLetter: [],
                    errorGroups: [],
                }),
            );
        });
        render(IngestMap, {
            initial: emptyInitial(),
            eventSourceFactory: () => new MockEventSource(),
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Movies' }));
        await fireEvent.change(screen.getByRole('combobox', { name: 'Time window' }), {
            target: { value: '1h' },
        });
        expect(screen.getByRole('status').textContent).toContain('in the last 24 hours');
        finishMap(
            Response.json({
                items: [
                    item('window-movie', 'Recent Movie', 'movie'),
                    item('window-track', 'Recent Track', 'track'),
                ],
                window: emptyInitial().window,
                page: { limit: 500, hasMore: false },
            }),
        );
        await waitFor(() => {
            expect(screen.getByRole('status').textContent).toContain(
                '1 of 2 loaded items with activity in the last hour',
            );
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
        expect(screen.getByRole('status').textContent).toContain(
            '2 items with activity in the last hour',
        );
        expect(screen.getByRole('status').textContent).not.toContain('in the last 24 hours');
    });

    test('keeps the loaded window scope when loading another window fails', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('offline'));
        render(IngestMap, {
            initial: emptyInitial(),
            eventSourceFactory: () => new MockEventSource(),
        });
        await fireEvent.change(screen.getByRole('combobox', { name: 'Time window' }), {
            target: { value: '1h' },
        });
        await waitFor(() => expect(screen.getByText(/offline/)).toBeTruthy());
        expect(screen.getByRole('status').textContent).toContain('in the last 24 hours');
        expect(screen.getByRole('status').textContent).not.toContain('in the last hour');
    });

    test('labels completed window items as loaded items rather than in-flight work', () => {
        const initial: MapResponse = {
            ...emptyInitial(),
            items: [
                item(
                    'done',
                    'Finished Movie',
                    'movie',
                    LINES[0].stations.map((id) => stage(id)),
                ),
            ],
        };
        render(IngestMap, { initial, eventSourceFactory: () => new MockEventSource() });
        expect(screen.getByText('Loaded items: 1')).toBeTruthy();
        expect(screen.getByText(/Window items include completed work/)).toBeTruthy();
        expect(screen.queryByText(/in flight/i)).toBeNull();
    });

    test('renders zero health calmly and omits an absent summary without inventing counts', async () => {
        const { unmount } = render(IngestMap, {
            initial: {
                ...emptyInitial(),
                pipelineSummary: {
                    inFlight: 0,
                    running: 0,
                    failedLastHour: 0,
                    deadLetterItems: 0,
                    degradedItems: 0,
                    oldestPendingAgeSec: null,
                },
            },
            eventSourceFactory: () => new MockEventSource(),
        });
        const health = screen.getByRole('region', { name: 'Pipeline health' });
        expect(within(health).getAllByText('0')).toHaveLength(5);
        expect(within(health).queryByText('longest wait')).toBeNull();
        expect(within(health).queryByText('needs re-identify')).toBeNull();
        expect(health.querySelector('[class*="border-amber-"], [class*="border-red-"]')).toBeNull();
        await unmount();
        render(IngestMap, {
            initial: { ...emptyInitial(), pipelineSummary: null },
            eventSourceFactory: () => new MockEventSource(),
        });
        expect(screen.queryByRole('region', { name: 'Pipeline health' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Table' })).toBeTruthy();
    });

    test('SSE stage-state-changed event updates a train', async () => {
        let mockEs: MockEventSource | null = null;
        const factory = (): MockEventSource => {
            mockEs = new MockEventSource();
            return mockEs;
        };
        const initial: MapResponse = {
            items: [
                item('m1', 'A Movie', 'movie', [
                    stage('media-probe-a', 'completed'),
                    stage('tmdb-metadata-sync', 'pending'),
                ]),
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 1,
        };
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        // Initially train is "waiting" at tmdb-metadata-sync (index 1).
        const trainsBefore = container.querySelectorAll('g.train');
        expect(trainsBefore.length).toBe(1);
        // It should not have the pulse class on its rect.
        const rectBefore = trainsBefore[0].querySelector('rect');
        expect(rectBefore?.classList.contains('train-pulse')).toBe(false);

        // Fire SSE: tmdb-metadata-sync → running.
        expect(mockEs).not.toBeNull();
        mockEs!.fire('stage-state-changed', {
            mediaItemId: 'm1',
            stageId: 'tmdb-metadata-sync',
            newStatus: 'running',
            processingVersion: 1,
            timestamp: new Date().toISOString(),
            kind: 'transition',
        });

        // After event, the train's rect should now carry the pulse class.
        await waitFor(() => {
            const rectAfter = container.querySelector('g.train rect');
            expect(rectAfter?.classList.contains('train-pulse')).toBe(true);
        });
    });

    test('failed stages park the train above the line in red', () => {
        const initial: MapResponse = {
            items: [
                item('m1', 'Broken Movie', 'movie', [
                    stage('media-probe-a', 'completed'),
                    stage('tmdb-metadata-sync', 'failed_permanent'),
                ]),
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 1,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        const train = container.querySelector('g.train rect');
        expect(train?.classList.contains('fill-red-600')).toBe(true);
    });

    test('waiting and running trains use visually distinct fill colors', () => {
        const initial: MapResponse = {
            items: [
                item('m1', 'Waiting Movie', 'movie', [
                    stage('media-probe-a', 'completed'),
                    stage('tmdb-metadata-sync', 'pending'),
                ]),
                item('m2', 'Running Movie', 'movie', [
                    stage('media-probe-a', 'completed'),
                    stage('tmdb-metadata-sync', 'running'),
                ]),
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 2,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, { initial, eventSourceFactory: factory });

        const trains = Array.from(container.querySelectorAll('g.train'));
        const waitingTrain = trains.find((g) => g.textContent?.includes('Waiting Movie'));
        const runningTrain = trains.find((g) => g.textContent?.includes('Running Movie'));
        expect(waitingTrain).toBeDefined();
        expect(runningTrain).toBeDefined();

        expect(waitingTrain!.querySelector('rect')!.classList.contains('fill-sky-800/50')).toBe(
            true,
        );
        expect(runningTrain!.querySelector('rect')!.classList.contains('fill-sky-500')).toBe(true);
    });

    test('failed_transient trains render amber (will auto-retry); failed_permanent stays red', () => {
        const initial: MapResponse = {
            items: [
                item('m1', 'Retrying Movie', 'movie', [
                    stage('media-probe-a', 'completed'),
                    stage('tmdb-metadata-sync', 'failed_transient'),
                ]),
                item('m2', 'Dead Movie', 'movie', [
                    stage('media-probe-a', 'completed'),
                    stage('tmdb-metadata-sync', 'failed_permanent'),
                ]),
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 2,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, { initial, eventSourceFactory: factory });

        const trains = Array.from(container.querySelectorAll('g.train'));
        const retryingTrain = trains.find((g) => g.textContent?.includes('Retrying Movie'));
        const deadTrain = trains.find((g) => g.textContent?.includes('Dead Movie'));
        expect(retryingTrain).toBeDefined();
        expect(deadTrain).toBeDefined();

        expect(retryingTrain!.querySelector('rect')!.classList.contains('fill-amber-600')).toBe(
            true,
        );
        expect(deadTrain!.querySelector('rect')!.classList.contains('fill-red-600')).toBe(true);
    });

    test('done trains use the shared emerald color regardless of line', () => {
        const stations = LINES[0].stations; // movie
        const stages = stations.map((s) => stage(s, 'completed'));
        const initial: MapResponse = {
            items: [item('m1', 'Finished Movie', 'movie', stages)],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 1,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, { initial, eventSourceFactory: factory });

        const train = container.querySelector('g.train rect');
        expect(train).not.toBeNull();
        // Previously a finished movie rendered 'fill-sky-700/60' (the line's
        // own darkened hue); now it matches CoverageGrid's "completed" color
        // and the "Completed last hour" ticker's emerald chips for the same
        // item.
        expect(train!.classList.contains('fill-emerald-700/60')).toBe(true);
        expect(train!.classList.contains('fill-sky-700/60')).toBe(false);
    });

    test('running station indicator uses amber, not emerald (avoids collision with the Music line color)', () => {
        const initial: MapResponse = {
            items: [item('m1', 'A Movie', 'movie', [stage('media-probe-a', 'pending')])],
            stageActivity: [
                {
                    stage_id: 'media-probe-a',
                    last_completed_at: null,
                    completed_5m: 0,
                    running: 1,
                    failed_1h: 0,
                },
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 1,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, { initial, eventSourceFactory: factory });

        // First station on the Movies line is 'media-probe-a'.
        const circle = container.querySelector('g.station circle');
        expect(circle).not.toBeNull();
        expect(circle!.classList.contains('fill-amber-500/30')).toBe(true);
        expect(circle!.classList.contains('stroke-amber-400')).toBe(true);
        expect(circle!.classList.contains('fill-emerald-500/30')).toBe(false);
    });

    test('SSE delete event removes the matching item from the map', async () => {
        let mockEs: MockEventSource | null = null;
        const factory = (): MockEventSource => {
            mockEs = new MockEventSource();
            return mockEs;
        };
        const initial: MapResponse = {
            items: [
                item('m1', 'A Movie', 'movie', [stage('media-probe-a', 'completed')]),
                item('m2', 'Another Movie', 'movie', [stage('media-probe-a', 'pending')]),
            ],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 2,
        };
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        // Two trains initially.
        expect(container.querySelectorAll('g.train').length).toBe(2);

        // Fire delete event for m1.
        expect(mockEs).not.toBeNull();
        mockEs!.fire('stage-state-changed', {
            mediaItemId: 'm1',
            stageId: '*',
            newStatus: 'pending',
            processingVersion: 0,
            timestamp: new Date().toISOString(),
            kind: 'delete',
        });

        // Only one train should remain.
        await waitFor(() => {
            expect(container.querySelectorAll('g.train').length).toBe(1);
        });
        // The remaining train should be for m2.
        const remainingTrain = container.querySelector('g.train text');
        expect(remainingTrain?.textContent?.trim()).toBe('Another Movie');
    });

    test('SSE delete event for unknown item is a no-op', async () => {
        let mockEs: MockEventSource | null = null;
        const factory = (): MockEventSource => {
            mockEs = new MockEventSource();
            return mockEs;
        };
        const initial: MapResponse = {
            items: [item('m1', 'A Movie', 'movie', [stage('media-probe-a', 'completed')])],
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: 1,
        };
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        expect(container.querySelectorAll('g.train').length).toBe(1);

        mockEs!.fire('stage-state-changed', {
            mediaItemId: 'does-not-exist',
            stageId: '*',
            newStatus: 'pending',
            processingVersion: 0,
            timestamp: new Date().toISOString(),
            kind: 'delete',
        });

        // Still one train — no change.
        await waitFor(() => {
            expect(container.querySelectorAll('g.train').length).toBe(1);
        });
    });

    test('aggregates trains beyond max into +N more pill', () => {
        const many = Array.from({ length: 8 }).map((_, i) =>
            item(`t-${i}`, `Track ${i}`, 'track', [
                stage('media-probe-a', 'completed'),
                stage('music-analysis', 'pending'),
            ]),
        );
        const initial: MapResponse = {
            items: many,
            window: {
                since: new Date().toISOString(),
                until: new Date().toISOString(),
            },
            total: many.length,
        };
        const factory = (): MockEventSource => new MockEventSource();
        const { container } = render(IngestMap, {
            initial,
            eventSourceFactory: factory,
        });

        // 8 items, 4 visible + overflow marker.
        const trains = container.querySelectorAll('g.train');
        expect(trains.length).toBe(4);
        const overflow = container.querySelector('g.overflow-marker');
        expect(overflow).not.toBeNull();
        expect(overflow?.textContent ?? '').toContain('+ 4 more');
    });

    test('renders a legend explaining line colors, running indicator, and failure states', () => {
        const factory = (): MockEventSource => new MockEventSource();
        render(IngestMap, { initial: emptyInitial(), eventSourceFactory: factory });

        expect(screen.getByText('movie line')).toBeTruthy();
        expect(screen.getByText('series line')).toBeTruthy();
        expect(screen.getByText('music line')).toBeTruthy();
        expect(screen.getByText('waiting / queued (dimmed)')).toBeTruthy();
        expect(screen.getByText('running now')).toBeTruthy();
        expect(screen.getByText('failed — will retry')).toBeTruthy();
        expect(screen.getByText('failed — stopped retrying')).toBeTruthy();
        const details = screen.getByText('Line colors and station details').closest('details');
        expect(details).not.toBeNull();
        expect(details?.open).toBe(false);
        expect(screen.getByText(/Hover or tab to any station or train for details/)).toBeTruthy();
    });

    // F2 (fix plan 6, Task 7 fix round 1): the "Scan issues" panel used to
    // hard-code its own three-type primary-issue chain and a duplicate
    // type→text mapping. Both new types must render a real label here too,
    // via the same fileHealthIssueLabel() every other surface uses.
    describe('Scan issues panel — new health-issue types (F2)', () => {
        test.each([
            ['unsafe_filename', 'Unsafe filename'],
            ['playlist_container_rejected', 'Playlist container rejected'],
            // Control: the pre-existing type still renders correctly.
            ['filename_not_utf8', 'Filename not UTF-8'],
        ])('%s renders as %j, not the raw type or "unknown"', (type, expectedLabel) => {
            const initial: MapResponse = {
                ...emptyInitial(),
                scanIssues: [
                    {
                        file_path: `/data/movies/${type}.mkv`,
                        library_group_id: null,
                        issues: [
                            {
                                type: type as FileHealthIssueType,
                                detected_at: new Date().toISOString(),
                                attempt_count: 1,
                            },
                        ],
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    },
                ],
            };
            const factory = (): MockEventSource => new MockEventSource();
            render(IngestMap, { initial, eventSourceFactory: factory });

            expect(screen.getByText(expectedLabel)).toBeTruthy();
            expect(screen.queryByText('unknown')).toBeNull();
            expect(screen.queryByText(type)).toBeNull();
        });
    });
});
