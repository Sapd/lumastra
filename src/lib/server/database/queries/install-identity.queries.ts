// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Install Identity Query Module
 *
 * Reads the per-DEPLOYMENT install UUID from the one-row `license_install`
 * table (migration 16.48.0; the name is historical, the table stays so a
 * rollback still boots). The UUID is shown on /admin/system/instance and is the
 * only identifier sent to lumastra.org, when the push relay token is requested.
 *
 * The UUID is allocated once by the migration's seed INSERT and shared across
 * all replicas. `getInstallUuid` defensively re-seeds (idempotently) if the row
 * is somehow missing, so it always returns a stable value.
 */

import type postgres from 'postgres';

interface InstallRow {
    install_uuid: string;
    created_at: Date;
}

/**
 * Get the stable per-deployment install UUID, seeding the singleton row if it
 * is somehow absent (idempotent / race-safe via ON CONFLICT).
 */
export async function getInstallUuid(sql: postgres.Sql): Promise<string> {
    const rows = await sql<InstallRow[]>`
        SELECT install_uuid, created_at FROM license_install WHERE singleton = true
    `;
    if (rows[0]?.install_uuid) {
        return rows[0].install_uuid;
    }
    // Defensive seed — should only happen if the migration row was removed.
    const seeded = await sql<InstallRow[]>`
        INSERT INTO license_install (singleton)
        VALUES (true)
        ON CONFLICT (singleton) DO NOTHING
        RETURNING install_uuid, created_at
    `;
    if (seeded[0]?.install_uuid) {
        return seeded[0].install_uuid;
    }
    // Lost the race to a concurrent seeder — read the now-present row.
    const after = await sql<InstallRow[]>`
        SELECT install_uuid, created_at FROM license_install WHERE singleton = true
    `;
    if (!after[0]?.install_uuid) {
        throw new Error('license_install row missing after seed');
    }
    return after[0].install_uuid;
}
