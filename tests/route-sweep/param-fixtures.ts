// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRequestContext } from '@playwright/test';

import { LIBRARY_TYPE_TEMPLATES } from '../../src/lib/shared/library-type-templates.js';

export type FixtureKind = 'required' | 'optional';

export interface ParamFixture {
    kind: FixtureKind;
    valid: string | null;
    nonexistent: string | null;
}

export type ParamFixtureInventory = Record<string, Record<string, ParamFixture>>;
export interface ResolvedParamFixtures {
    routes: Record<string, Record<string, ParamFixture>>;
    libraryTypes: string[];
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
export const VALID_SYMPTOMS = [
    'why-transcode',
    'wrong-match',
    'proxy',
    'user-cannot-see',
    'slow',
    'new-files',
    'stuck',
    'where-is-it',
    'missing-episodes',
    'seek-previews',
];

/**
 * Resolve the null slots emitted by the inventory against the running target.
 * A missing collection is a useful empty-install result, while a transport or
 * malformed-response failure must remain fatal so the sweep cannot go green
 * without knowing whether fixture discovery worked.
 */
export async function resolveParamFixtures(
    request: APIRequestContext,
    inventory: ParamFixtureInventory,
): Promise<ResolvedParamFixtures> {
    const [playlists, albums, artists, stations, libraryTypes] = await Promise.all([
        listIds(request, '/api/playlists'),
        listIds(request, '/api/music/albums'),
        listIds(request, '/api/music/artists'),
        listIds(request, '/api/music/radio'),
        Promise.resolve(listLibraryTypes()),
    ]);

    const slots = Object.fromEntries(
        Object.entries(inventory).map(([routeId, params]) => [
            routeId,
            Object.fromEntries(
                Object.entries(params).map(([param, fixture]) => [
                    param,
                    {
                        ...fixture,
                        valid: resolveValidValue(routeId, param, {
                            playlists,
                            albums,
                            artists,
                            stations,
                            libraryTypes,
                        }),
                        nonexistent: fixture.nonexistent ?? nonexistentValue(param),
                    },
                ]),
            ),
        ]),
    ) as Record<string, Record<string, ParamFixture>>;
    return { routes: slots, libraryTypes };
}

interface ListedValues {
    playlists: string[];
    albums: string[];
    artists: string[];
    stations: string[];
    libraryTypes: string[];
}

/**
 * Discovery notes: endpoints that could not supply a valid value, and why.
 *
 * Read by the Tier A spec so an unresolved slot is REPORTED rather than
 * silently dropped. Not an error channel — the absence of a value is a normal
 * result, and a sweep that cannot say which slots were unresolved is hiding
 * the most interesting thing about an empty install.
 */
const discoveryNotes: string[] = [];

export function discoveryDiagnostics(): readonly string[] {
    return discoveryNotes;
}

async function listIds(request: APIRequestContext, path: string): Promise<string[]> {
    const response = await request.get(path);
    if (!response.ok()) {
        // NOT fatal. On the fresh-install target — the environment this whole
        // sweep exists for — most collections are legitimately empty or absent,
        // so an HTTP failure here is the expected case, not a broken harness.
        // Throwing took all 158 Tier A tests down over one 404 and would have
        // made the tier permanently useless on a clean install.
        //
        // A transport error still propagates: failing to ask at all is
        // different from asking and being told there is nothing.
        discoveryNotes.push(`GET ${path} -> HTTP ${response.status()} (slot unresolved)`);
        return [];
    }
    return extractIds(await response.json());
}

/**
 * `/library/[libraryType]` takes a LIBRARY TYPE TEMPLATE key, not a media type.
 *
 * This slot was previously filled from `/api/browse/libraries`, which reports
 * `mediaType` values — `movie`, `series`. Those are the wrong vocabulary
 * entirely: `+page.server.ts` resolves the param through
 * `getLibraryTypeTemplate()` and answers `error(404, 'Unknown library type')`
 * for anything that is not a template key, so every run tested a guaranteed
 * 404 and called it a route failure.
 *
 * The vocabulary is a static, compiled-in enum rather than instance data, so it
 * is read from the app's own source — the same reasoning that lets the
 * `symptom` slot come from the inventory's static sibling routes. Reading it
 * here rather than copying the values keeps the sweep correct when a template
 * is added.
 */
function listLibraryTypes(): string[] {
    return Object.keys(LIBRARY_TYPE_TEMPLATES);
}

function extractIds(value: unknown): string[] {
    const ids: string[] = [];
    collectObjects(value, (object) => {
        const id = object.id;
        if ((typeof id === 'string' || typeof id === 'number') && String(id).length > 0) {
            ids.push(String(id));
        }
    });
    return [...new Set(ids)];
}

function collectObjects(value: unknown, visit: (value: Record<string, unknown>) => void): void {
    if (Array.isArray(value)) {
        for (const item of value) collectObjects(item, visit);
        return;
    }
    if (!isRecord(value)) return;
    visit(value);
    for (const child of Object.values(value)) collectObjects(child, visit);
}

function resolveValidValue(routeId: string, param: string, values: ListedValues): string | null {
    if (param === 'symptom') return VALID_SYMPTOMS[0] ?? null;
    if (param === 'libraryType') return values.libraryTypes[0] ?? null;
    if (param === 'id' && routeId.endsWith('/playlists/[id]')) return values.playlists[0] ?? null;
    if (param === 'id' && routeId.endsWith('/music/albums/[id]')) return values.albums[0] ?? null;
    if (param === 'id' && routeId.endsWith('/music/artists/[id]')) return values.artists[0] ?? null;
    if (param === 'id' && routeId.endsWith('/music/radio/[id]')) return values.stations[0] ?? null;
    return null;
}

function nonexistentValue(param: string): string {
    if (['id', 'seriesId', 'featureId', 'taskId', 'userId', 'itemId'].includes(param)) {
        return MISSING_UUID;
    }
    if (param === 'page') return '999999';
    if (param === 'code') return 'ROUTE-SWEEP-MISSING';
    if (param === 'libraryType') return 'route-sweep-missing-library';
    if (param === 'symptom') return 'route-sweep-missing-symptom';
    return 'route-sweep-missing';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
