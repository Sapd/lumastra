// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { generateMigrationChecksum, type Migration } from '../migration-system';

// A ZIP archive download (a season or a series) has neither a file nor a rendition id, so it
// cannot be told apart from a refused single-file attempt that never resolved a file. `kind`
// says it explicitly. Every archive request is its own attempt (its own row, never joined or
// re-opened like a resumable single file).
//
// The open-transfer unique index of 16.470.0 is NOT touched: code of 16.470.0 (mixed-version
// rollout, rollback) names it in `ON CONFLICT (user_id, device_key, (COALESCE(file_id,
// rendition_id))) WHERE ended_at IS NULL`, which must keep inferring it. Archive rows keep NULL
// file and rendition ids, so their COALESCE key is NULL and they never collide with it.
const SQL = `ALTER TABLE download_events ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file';
ALTER TABLE download_events DROP CONSTRAINT IF EXISTS download_events_kind_check;
ALTER TABLE download_events
    ADD CONSTRAINT download_events_kind_check CHECK (kind IN ('file', 'archive'));`;

export const migration_16_471_0: Migration = {
    version: '16.471.0',
    name: 'download_events_archive_kind',
    description: 'Add download_events.kind (file | archive); the open-transfer index is unchanged.',
    checksum: generateMigrationChecksum(SQL),
    async up(sql) {
        await sql.unsafe(`SET LOCAL lock_timeout = '5s';\n${SQL}`);
    },
};
