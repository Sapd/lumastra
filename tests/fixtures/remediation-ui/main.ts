// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from 'svelte';
import Harness from './Harness.svelte';
import './style.css';

const sourceId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const oldEpisode = '00000000-0000-4000-8000-000000000003';
const newEpisode = '00000000-0000-4000-8000-000000000004';
const fileId = '00000000-0000-4000-8000-000000000005';
const view = new URL(location.href).searchParams.get('view');
const movie = view === 'movie' || view === 'movie-failure';
const targetFileless = movie || view === 'series-fileless';
let merged = false;
let identityFailedOnce = false;
let moved = false;
let writes = 0;
const retryStates = ['automatic-poison', 'automatic-poison', 'failed', 'operator-skip'];
const watch = { sourceSeries: 12000, canonicalSeries: 0, oldEpisode: 42000 };
const nativeFetch = window.fetch;
function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
const status = document.createElement('p');
status.style.cssText =
    'position:fixed;bottom:12px;left:12px;color:white;z-index:9999;background:#171717;padding:12px';
status.textContent = 'Controlled fixture · 0 writes · no production connection';
document.body.append(status);
window.fetch = async (input, init) => {
    const path =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!path.startsWith('/api/')) return nativeFetch(input, init);
    if (path.includes('/tasks/lumastra-intro-analyzer/failures'))
        return response({
            items: [
                {
                    id: 'f1',
                    itemId: oldEpisode,
                    title: 'Intro timeout episode',
                    reason: 'Analysis timed out; automatic poison exclusion',
                    occurredAt: new Date().toISOString(),
                    failureCount: 5,
                },
                {
                    id: 'f2',
                    itemId: newEpisode,
                    title: 'Interrupted episode',
                    reason: 'Aborted during shutdown; automatic poison exclusion',
                    occurredAt: new Date().toISOString(),
                    failureCount: 5,
                },
                {
                    id: 'f3',
                    itemId: fileId,
                    title: 'Unsupported VVC movie',
                    reason: 'Unsupported codec VVC',
                    occurredAt: new Date().toISOString(),
                    failureCount: 1,
                },
            ],
            page: { limit: 50, hasMore: false, total: 3 },
        });
    if (path.endsWith('/pipeline/retry-stage')) {
        const count = retryStates.filter(
            (state) => state === 'automatic-poison' || state === 'failed',
        ).length;
        retryStates.forEach((state, i) => {
            if (state === 'automatic-poison' || state === 'failed') retryStates[i] = 'pending';
        });
        status.textContent = `Controlled fixture · restored ${count} · operator skip unchanged · historical failures retained`;
        return response({ count });
    }
    if (path.includes('/provider-search'))
        return response({
            query: 'Magic Repo Man',
            results: [
                {
                    provider: 'tmdb',
                    externalId: '12345',
                    title: 'Magic Repo Man (Canonical)',
                    year: 2020,
                    type: movie ? 'movie' : 'series',
                },
            ],
        });
    if (path.endsWith('/match') && merged) {
        if (view === 'movie-failure' && !identityFailedOnce) {
            identityFailedOnce = true;
            return response({ error: 'Fixture identity service temporarily unavailable' }, 503);
        }
        writes++;
        status.textContent = `Controlled fixture · ${writes} writes · selected provider ID applied to movie keeper`;
        return response({ mediaItemId: sourceId });
    }
    if (path.endsWith('/match'))
        return response(
            { error: 'Already linked', conflictMediaId: targetId, fileMediaId: sourceId },
            409,
        );
    if (path.includes('/files?'))
        return response({
            files: path.includes(sourceId)
                ? moved
                    ? []
                    : [{ id: fileId, file_path: '/fixture/Magic Repo Man S01E01.mkv' }]
                : [
                      ...(targetFileless
                          ? []
                          : [{ id: 'existing', file_path: '/fixture/canonical-existing.mkv' }]),
                      ...(moved
                          ? [{ id: fileId, file_path: '/fixture/Magic Repo Man S01E01.mkv' }]
                          : []),
                  ],
        });
    if (path.includes('/media/search'))
        return response({
            results: [{ id: targetId, title: 'Magic Repo Man (Canonical)', year: 2020 }],
        });
    if (path.endsWith('/episodes')) {
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            if (
                !path.includes(targetId) ||
                body.episodes?.length !== 1 ||
                body.episodes[0].mediaItemId !== newEpisode
            )
                return response({ error: 'Choose the canonical episode before saving.' }, 422);
            moved = true;
            writes++;
        }
        const target = path.includes(targetId);
        status.textContent = `Controlled fixture · ${writes} writes · ${moved ? 'file reassigned' : 'draft only'} · no production connection`;
        return response({
            file: {
                id: fileId,
                filePath: '/fixture/Magic Repo Man S01E01.mkv',
                durationMs: 1200000,
                manual: moved,
            },
            chapters: [],
            links: [
                {
                    mediaItemId: moved ? newEpisode : oldEpisode,
                    seasonNumber: 1,
                    episodeNumber: 1,
                    title: moved ? 'Canonical episode' : 'Wrong-series episode',
                    isDefault: true,
                    sortOrder: 0,
                    startMs: null,
                    endMs: null,
                    offsetSource: moved ? 'manual' : null,
                },
            ],
            episodes: [
                {
                    id: target ? newEpisode : oldEpisode,
                    seasonNumber: 1,
                    episodeNumber: 1,
                    title: target ? 'Canonical episode' : 'Wrong-series episode',
                    runtimeMs: 1200000,
                },
            ],
        });
    }
    if (path.endsWith('/merge') && movie) {
        const body = JSON.parse(String(init?.body));
        if (body.keepId !== sourceId || body.mergeId !== targetId)
            return response({ error: 'Movie must remain the file-bearing keeper' }, 409);
        merged = true;
        writes++;
        status.textContent = `Controlled fixture · ${writes} write · entries merged · selected identity update pending`;
        return response({
            keepId: sourceId,
            mergeId: targetId,
            seasonsReparented: 0,
            itemsDeleted: 1,
        });
    }
    if (path.endsWith('/merge')) {
        const body = JSON.parse(String(init?.body));
        if (!moved || body.keepId !== targetId || body.mergeId !== sourceId)
            return response(
                { error: 'Both rows still have files, or the file-bearing keeper is wrong.' },
                409,
            );
        writes++;
        watch.canonicalSeries = watch.sourceSeries;
        watch.sourceSeries = 0;
        status.textContent = `Controlled fixture · ${writes} writes · canonical entry retained · file preserved · episode resume ${watch.oldEpisode} · canonical resume ${watch.canonicalSeries}`;
        return response({
            keepId: targetId,
            mergeId: sourceId,
            seasonsReparented: 0,
            itemsDeleted: 1,
        });
    }
    return response({ error: 'Fixture endpoint not provided' }, 404);
};
mount(Harness, { target: document.getElementById('app')!, props: { sourceId } });
