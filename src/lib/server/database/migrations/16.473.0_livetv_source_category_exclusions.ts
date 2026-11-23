// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { generateMigrationChecksum, type Migration } from '../migration-system';

const SQL = `
    CREATE TABLE livetv_source_category_exclusions (
        source_id uuid NOT NULL REFERENCES livetv_sources(id) ON DELETE CASCADE,
        category_name text NOT NULL,
        PRIMARY KEY (source_id, category_name)
    );

    CREATE TABLE livetv_source_feed_exclusions (
        source_id uuid NOT NULL REFERENCES livetv_sources(id) ON DELETE CASCADE,
        feed_key text NOT NULL,
        PRIMARY KEY (source_id, feed_key)
    );

    ALTER TABLE livetv_channels ADD COLUMN playlist_category_key text;
`;

export const migration_16_473_0: Migration = {
    version: '16.473.0',
    name: 'livetv_source_category_exclusions',
    description: 'Remember removed playlist groups and feeds by source.',
    checksum: generateMigrationChecksum(SQL),
    async up(sql): Promise<void> {
        await sql.unsafe(`SET LOCAL lock_timeout = '5s';\n${SQL}`);
    },
};
