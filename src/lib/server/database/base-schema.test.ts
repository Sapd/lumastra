// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Seam test: the base migration must execute the ownership-GUARDED schema. The guard itself is
 * covered in base-schema-extension-comments*.test.ts; this pins that baseSchemaUp applies it (a
 * non-superuser role on pre-created extensions failed the first migration without it).
 */
import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { BASE_SCHEMA_MIGRATION } from './base-schema.js';
import { BASE_SCHEMA_SQL } from './base-schema-sql.js';
import { generateMigrationChecksum } from './migration-system.js';

describe('BASE_SCHEMA_MIGRATION', () => {
    it('runs the schema with COMMENT ON EXTENSION wrapped in the ownership guard', async () => {
        const unsafe = vi.fn().mockResolvedValue([]);
        await BASE_SCHEMA_MIGRATION.up({ unsafe } as unknown as postgres.TransactionSql);

        expect(unsafe).toHaveBeenCalledTimes(1);
        const executed = String(unsafe.mock.calls[0]?.[0]);
        expect(executed).not.toMatch(/^COMMENT ON EXTENSION /m);
        expect(executed.match(/^DO \$lumastra_ext_comment\$$/gm)).toHaveLength(4);
        expect(executed).not.toContain('__EMBEDDING_DIM__');
    });

    it('keeps the checksum of the unmodified snapshot (deployed databases see no change)', () => {
        expect(BASE_SCHEMA_MIGRATION.checksum).toBe(generateMigrationChecksum(BASE_SCHEMA_SQL));
    });
});
