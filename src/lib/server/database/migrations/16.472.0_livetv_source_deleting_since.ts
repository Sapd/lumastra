// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { generateMigrationChecksum, type Migration } from '../migration-system';

const SQL = 'ALTER TABLE livetv_sources ADD COLUMN IF NOT EXISTS deleting_since timestamptz;';

export const migration_16_472_0: Migration = {
    version: '16.472.0',
    name: 'livetv_source_deleting_since',
    description: 'Track Live TV sources queued for background deletion.',
    checksum: generateMigrationChecksum(SQL),
    async up(sql): Promise<void> {
        await sql.unsafe(`SET LOCAL lock_timeout = '5s';\n${SQL}`);
    },
};
