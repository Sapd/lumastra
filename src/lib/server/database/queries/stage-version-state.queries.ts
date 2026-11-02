// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export async function getObservedVersion(
    sql: postgres.Sql,
    stageId: string,
): Promise<number | null> {
    const rows = await sql<{ observed_version: number }[]>`
        SELECT observed_version FROM stage_version_state
         WHERE stage_id = ${stageId}
         LIMIT 1
    `;
    return rows[0]?.observed_version ?? null;
}

export async function setObservedVersion(
    sql: postgres.Sql,
    stageId: string,
    version: number,
): Promise<void> {
    await sql`
        INSERT INTO stage_version_state (stage_id, observed_version)
        VALUES (${stageId}, ${version})
        ON CONFLICT (stage_id) DO UPDATE
          SET observed_version = EXCLUDED.observed_version,
              updated_at = now()
    `;
}

export async function allObservedVersions(
    sql: postgres.Sql,
): Promise<{ stage_id: string; observed_version: number }[]> {
    return await sql<{ stage_id: string; observed_version: number }[]>`
        SELECT stage_id, observed_version FROM stage_version_state
    `;
}
