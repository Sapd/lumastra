// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /api/admin/media/{id}/files` selected `mf.file_size_bytes` raw.
 *
 * That column is `bigint`, and the pool in `connection.ts` registers a bigint
 * (OID 20) parser returning `Number(x)` — so the value went on the wire as a
 * JSON number. But `MediaFilesResponseSchema` declares it
 * `z.string().nullable()`, and that schema is what the v1 twin
 * (`defs/media/[id]/files-admin.ts`) publishes as this body's OpenAPI contract:
 * the generated Swift decoder expects `String?` and the generated
 * `schema.d.ts` says `string | null`.
 *
 * Unlike the `premiere_date`/`startTicks` arm of this class, the handler does
 * NOT `.parse()` its own body, so the mismatch never became a 500 — it became a
 * silent contract violation that `mount()`'s response audit logs on every
 * request, and that `MediaFileInfoModal.svelte` was already carrying a
 * `typeof f.file_size_bytes === 'number' ? String(...)` workaround for.
 *
 * The suite drives the REAL handler through a `sql` mock that decides the
 * column's JS type from whether THAT call's own template text carries the cast,
 * i.e. it simulates postgres.js's behaviour for the query as written. Deleting
 * `::text` from the production SQL changes what the mock hands back, so the
 * test fails on a revert rather than on a stale fixture.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const { def, FilesResponseSchema } = await import('./files.js');
const { MediaFilesResponseSchema } = await import('$lib/schemas/api-media-responses');

/** A file row as postgres.js would hand it back for the query as written. */
function driverShapedSql() {
    return vi.fn().mockImplementation((strings: TemplateStringsArray | string) => {
        // postgres.js identifiers are fragments, not query executions.
        if (typeof strings === 'string') return Promise.resolve([]);
        const text = strings.join('');
        if (text.includes('COUNT(*)::int AS linked_media_count'))
            return Promise.resolve([
                { file_id: '22222222-2222-4222-8222-222222222222', linked_media_count: 3 },
            ]);
        if (text.includes('FROM media_streams') || text.includes('FROM external_subtitle_files'))
            return Promise.resolve([]);
        if (text.includes(' AS probed') && text.includes('FROM media_files'))
            return Promise.resolve([
                {
                    id: '22222222-2222-4222-8222-222222222222',
                    probed: true,
                    is_missing: false,
                    original_language: null,
                },
            ]);
        return Promise.resolve([
            {
                id: '22222222-2222-4222-8222-222222222222',
                file_path: '/data/tv/show/s01e01.mkv',
                edition: null,
                part_number: null,
                library_group_id: null,
                created_at: '2026-01-01T00:00:00.000Z',
                media_item_id: '11111111-1111-4111-8111-111111111111',
                // 8.6 GB — comfortably past 2^32, so a revert cannot be
                // mistaken for something an int column would explain.
                file_size_bytes: text.includes('file_size_bytes::text') ? '8589934592' : 8589934592,
                duration_seconds: 2700,
                container_format: 'matroska,webm',
                file_mtime: '2026-01-01T00:00:00.000Z',
                file_hash_head: 'deadbeef',
                probed_at: '2026-01-01T00:00:00.000Z',
                health_issues: null,
                health_classification: 'none',
                is_default: true,
                file_sort_order: 0,
                file_label: null,
            },
        ]);
    });
}

function makeEvent(): RequestEvent {
    return {
        locals: { resolvedIds: { internalId: '11111111-1111-4111-8111-111111111111' } },
        params: { id: '11111111-1111-4111-8111-111111111111' },
        url: new URL('http://localhost/api/admin/media/item-1/files'),
    } as unknown as RequestEvent;
}

const ctxFor = (children: boolean) =>
    ({ input: { query: children ? { children: 'true' } : {} } }) as never;

describe.each([
    ['base rows', false],
    ['?children=true rows', true],
])('admin files list — file_size_bytes contract (%s)', (_label, children) => {
    it('emits a string file_size_bytes that satisfies the published schema', async () => {
        mockGetDb.mockReturnValue(driverShapedSql());

        const res = await def.handlers.GET!(makeEvent(), ctxFor(children));

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        // The real gate: the body the handler actually produced, run through the
        // schema the OpenAPI spec (and the Swift decoder) are generated from.
        expect(() => MediaFilesResponseSchema.parse(body)).not.toThrow();
        const parsed = MediaFilesResponseSchema.parse(body);
        expect(parsed.files[0].file_size_bytes).toBe('8589934592');
        expect(parsed.files[0].language_summary).toMatchObject({ probed: true, isMissing: false });
        expect(FilesResponseSchema.parse(body).files[0].linked_media_count).toBe(3);
    });

    it('emits SQL that casts file_size_bytes', async () => {
        const sql = driverShapedSql();
        mockGetDb.mockReturnValue(sql);

        await def.handlers.GET!(makeEvent(), ctxFor(children));

        const text = sql.mock.calls
            .map(([parts]) =>
                typeof parts === 'string' ? parts : (parts as TemplateStringsArray).join(''),
            )
            .join('\n');
        expect(text).toContain('file_size_bytes::text');
    });
});

describe('admin files list — the failure mode a missing cast reproduces', () => {
    it('rejects a numeric file_size_bytes against the published schema', () => {
        const withNumericSize = {
            files: [
                {
                    id: '22222222-2222-4222-8222-222222222222',
                    file_path: '/data/tv/show/s01e01.mkv',
                    edition: null,
                    part_number: null,
                    library_group_id: null,
                    created_at: '2026-01-01T00:00:00.000Z',
                    media_item_id: '11111111-1111-4111-8111-111111111111',
                    file_size_bytes: 8589934592 as unknown as string,
                    duration_seconds: 2700,
                    container_format: 'matroska,webm',
                    file_mtime: '2026-01-01T00:00:00.000Z',
                    file_hash_head: 'deadbeef',
                    probed_at: '2026-01-01T00:00:00.000Z',
                    health_issues: null,
                    is_default: true,
                    file_sort_order: 0,
                    file_label: null,
                },
            ],
        };
        expect(() => MediaFilesResponseSchema.parse(withNumericSize)).toThrow();
    });
});
