// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Internal origin URL only; callers must check media access before delivery. */
export async function getRadioStreamUrl(
    sql: postgres.Sql,
    stationId: string,
): Promise<string | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Origin lookup only; callers checkMediaAccess before delivery (documented in docs/dev/eslint-exceptions.md).
    const [row] = await sql<{ stream_url: string | null }[]>`
        SELECT custom_metadata ->> 'stream_url' AS stream_url FROM media_items
        WHERE id = ${stationId}::uuid AND media_type = 'radio' AND status = 'active'
        LIMIT 1
    `;
    return row?.stream_url ?? null;
}
