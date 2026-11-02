// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { MEDIA_ITEM_FK_CLASSIFICATION } from './never-owned-media-gc.queries.js';

// Retention removes catalog rows and their links, never physical files. Each
// physical-file FK is reviewed explicitly rather than exempting all future ones.
const FILE_REFERENCE_EXEMPTIONS: Readonly<Record<string, string>> = {
    'download_renditions.file_id':
        'Physical file remains; catalog media_item_id protects delivery.',
    'episode_chapters.file_id': 'Derived chapters of a physical file; the file is never deleted.',
    'external_subtitle_files.file_id': 'Sidecar of a physical file; the file is never deleted.',
    'media_file_items.file_id': 'File presence is checked per unit member before removing links.',
    'media_streams.file_id': 'Derived streams of a physical file; the file is never deleted.',
    'play_sessions.file_id':
        'Physical file remains; media_id separately protects playback history.',
    'transcode_failure_events.file_id':
        'Physical file remains; media_id separately protects failure history.',
    'trickplay_params.file_id':
        'Derived trickplay; physical files remain and media_item_id is classified.',
    'media_segments.file_id':
        'Derived skip segments; physical file remains and media_id is classified.',
    'manual_file_link_sets.file_id':
        'File-based restoration receipt; retention never deletes the file.',
    'file_range_mapping_proofs.file_id': 'Derived file mapping proof; physical files remain.',
};

interface ForeignKeyEdge {
    source: string;
    target: string;
}

async function unclassifiedReferences(sql: postgres.Sql, schema = 'public'): Promise<string[]> {
    // Inspect the migrated catalog, not migration text or a second list of tables.
    const edges = await sql<ForeignKeyEdge[]>`
        SELECT DISTINCT rel.relname || '.' || a.attname AS source,
               target.relname AS target
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_class target ON target.oid = c.confrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND rel.relnamespace = ${schema}::regnamespace
          AND c.confrelid IN (${`${schema}.media_items`}::regclass, ${`${schema}.media_files`}::regclass, ${`${schema}.media_file_items`}::regclass)
        ORDER BY 1, 2
    `;
    const failures: string[] = [];
    for (const edge of edges) {
        const reason =
            edge.target === 'media_items'
                ? MEDIA_ITEM_FK_CLASSIFICATION[edge.source]?.reason
                : FILE_REFERENCE_EXEMPTIONS[edge.source];
        if (!reason?.trim()) failures.push(`${edge.source} -> ${edge.target}`);
    }
    return failures;
}

afterAll(closeTestDb);

describe('retention foreign-key coverage', () => {
    it('covers or explicitly exempts every migrated FK to media items, files and links', async () => {
        expect(await unclassifiedReferences(getTestDb())).toEqual([]);
    });

    it('automatically catches newly added references to all three media tables', async () => {
        const rollback = new Error('rollback schema probe');
        try {
            await getTestDb().begin(async (tx) => {
                // Probe isolated targets so CREATE TABLE ... REFERENCES never
                // takes locks on the real media tables used by other test files.
                await tx`SET LOCAL lock_timeout = '1s'`;
                await tx`CREATE SCHEMA retention_probe`;
                await tx`CREATE TABLE retention_probe.media_items (id uuid PRIMARY KEY)`;
                await tx`CREATE TABLE retention_probe.media_files (id uuid PRIMARY KEY)`;
                await tx`CREATE TABLE retention_probe.media_file_items (
                    file_id uuid, media_item_id uuid, PRIMARY KEY (file_id, media_item_id)
                )`;
                await tx`CREATE TABLE retention_probe.retention_schema_probe (
                    media_id uuid REFERENCES retention_probe.media_items(id),
                    file_id uuid REFERENCES retention_probe.media_files(id),
                    link_file_id uuid,
                    link_media_id uuid,
                    FOREIGN KEY (link_file_id, link_media_id) REFERENCES retention_probe.media_file_items(file_id, media_item_id)
                )`;
                expect(
                    await unclassifiedReferences(tx as unknown as postgres.Sql, 'retention_probe'),
                ).toEqual([
                    'retention_schema_probe.file_id -> media_files',
                    'retention_schema_probe.link_file_id -> media_file_items',
                    'retention_schema_probe.link_media_id -> media_file_items',
                    'retention_schema_probe.media_id -> media_items',
                ]);
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });
});
