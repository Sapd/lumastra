// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';

export interface PatUsageBatch {
    tokenHash: string;
    uses: number;
    usedAt: Date;
    clientIp: string | null;
}

/** Add every observed use, keeping the latest timestamp/IP across replicas. */
export async function recordPatUsage(sql: postgres.Sql, batch: PatUsageBatch): Promise<void> {
    await sql`
        UPDATE personal_access_tokens
        SET last_used_at = GREATEST(last_used_at, ${batch.usedAt}),
            last_used_ip = CASE WHEN last_used_at IS NULL OR last_used_at <= ${batch.usedAt}
                THEN ${batch.clientIp} ELSE last_used_ip END,
            usage_count = usage_count + ${batch.uses}
        WHERE token_hash = ${batch.tokenHash}
    `;
}
