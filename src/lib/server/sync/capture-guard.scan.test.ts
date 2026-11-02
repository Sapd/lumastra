// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as registry from './capture-registry.js';
import { BASE_SCHEMA_SQL } from '../database/base-schema-sql.js';

const ALLOWED: Record<string, string> = {
    'lib/server/database/base-schema-sql.ts':
        'Squashed trigger functions read the capture switch; the Various Artists seed row switches capture off, as it predates the triggers.',
    'lib/server/database/queries/sync-changes.queries.ts':
        'withSyncReset disables capture and bumps the epoch atomically.',
    'lib/server/database/queries/sort-title.queries.ts':
        'sort_title is captured but never sent to sync clients; its backfill and the follow-up key write skip capture (the title write itself stays captured).',
    'lib/server/database/migrations/_frozen/16.394.0-track-artist-credit-repair.ts':
        'Frozen copy of withSyncReset for the 16.394.0 repair: capture off and the epoch bumped in one transaction.',
};
function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(path);
        return /\.(ts|js|svelte)$/.test(path) && !/\.(test|spec)\.[^.]+$/.test(path) ? [path] : [];
    });
}

/** Quoted string literals of a SQL `ARRAY[...]`, in order, ignoring `::text` casts. */
function sqlArrayLiterals(arraySql: string): string[] {
    return [...arraySql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('sync capture guards', () => {
    it('keeps the registry equal to the capture triggers and functions in the base schema', () => {
        // The base schema is the squashed history of the capture migrations: the triggers
        // it creates are what actually record changes, so the registry must describe them.
        const rowTables = [
            ...BASE_SCHEMA_SQL.matchAll(/^CREATE TRIGGER sync_row [^\n]* ON public\.(\w+) /gm),
        ].map((m) => m[1]);
        const truncateTables = [
            ...BASE_SCHEMA_SQL.matchAll(/^CREATE TRIGGER sync_truncate [^\n]* ON public\.(\w+) /gm),
        ].map((m) => m[1]);
        expect([...rowTables, 'media_items'].sort()).toEqual(
            [...registry.SYNC_CAPTURED_TABLES].sort(),
        );
        expect([...truncateTables].sort()).toEqual([...registry.SYNC_CAPTURED_TABLES].sort());

        const updateTrigger = BASE_SCHEMA_SQL.match(
            /^CREATE TRIGGER sync_update AFTER UPDATE ON public\.media_items [^\n]*WHEN \(\(\(to_jsonb\(new\.\*\) - ARRAY\[([^\]]*)\]/m,
        );
        expect(updateTrigger).not.toBeNull();
        expect(sqlArrayLiterals(updateTrigger![1])).toEqual([...registry.SYNC_NOISE_COLUMNS]);

        const inherited = BASE_SCHEMA_SQL.match(
            /FOREACH col IN ARRAY ARRAY\[([^\]]*)\]::text\[\] LOOP/,
        );
        expect(inherited).not.toBeNull();
        expect(sqlArrayLiterals(inherited![1])).toEqual([...registry.SYNC_INHERITED_COLUMNS]);

        const kindFunction = BASE_SCHEMA_SQL.match(
            /CREATE FUNCTION public\.sync_kind\(t text\)[\s\S]*?SELECT CASE t ([^\n]*) END\n/,
        );
        expect(kindFunction).not.toBeNull();
        const kinds = Object.fromEntries(
            [...kindFunction![1].matchAll(/WHEN '(\w+)' THEN '(\w+)'/g)].map((m) => [m[1], m[2]]),
        );
        expect(kinds).toEqual(registry.SYNC_KIND_BY_MEDIA_TYPE);
    });
    it('requires an explicit exception for capture bypasses', () => {
        const bypass = new RegExp(
            `DISABLE\\s+TRIGGER|session_replication_role|lumastra\\.sync_capture|TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(?:public\\.)?["\\s]*(?:${registry.SYNC_CAPTURED_TABLES.join('|')})\\b`,
            'i',
        );
        expect(
            sourceFiles('src').filter(
                (path) =>
                    bypass.test(readFileSync(path, 'utf8')) && !ALLOWED[relative('src', path)],
            ),
        ).toEqual([]);
    });
});
