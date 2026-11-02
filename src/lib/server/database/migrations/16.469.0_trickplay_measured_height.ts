// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { generateMigrationChecksum, type Migration } from '../migration-system';

// Trickplay params used to store a 16:9 guess as the thumbnail height. 4:3 and
// scope sources then showed two half thumbnails per preview. Existing rows start
// unmeasured; trickplay-params-sync reads the real height from the sheets.
const SQL = `ALTER TABLE trickplay_params
    ADD COLUMN IF NOT EXISTS height_measured boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_trickplay_params_height_unmeasured
    ON trickplay_params (media_item_id, file_id, width) WHERE NOT height_measured;`;

export const migration_16_469_0: Migration = {
    version: '16.469.0',
    name: 'trickplay_measured_height',
    description: 'Mark trickplay params whose thumbnail height was guessed, for repair.',
    checksum: generateMigrationChecksum(SQL),
    async up(sql) {
        await sql.unsafe(SQL);
    },
};
