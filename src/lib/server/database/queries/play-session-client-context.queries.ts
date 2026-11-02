// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

const CONTEXT_KEY = '__lumastra_client_context';

/** Display-only context from the client; never infer identity or authorization from it. */
export function sessionCarPlayContext(payload: unknown): boolean | undefined {
    if (!payload || typeof payload !== 'object' || !(CONTEXT_KEY in payload)) return undefined;
    const context: unknown = Reflect.get(payload, CONTEXT_KEY);
    if (!context || typeof context !== 'object' || !('carPlay' in context)) return undefined;
    const carPlay: unknown = context.carPlay;
    return typeof carPlay === 'boolean' ? carPlay : undefined;
}

/** Match an accepted report's sequence so an older concurrent report cannot restore old context. */
export async function recordSessionCarPlayContext(
    sql: postgres.Sql,
    sessionId: string,
    eventSeq: number,
    carPlay: boolean,
): Promise<void> {
    await sql`UPDATE play_sessions
        SET external_payload = jsonb_set(COALESCE(external_payload, '{}'::jsonb),
            ARRAY[${CONTEXT_KEY}], ${sql.json({ carPlay, eventSeq })})
        WHERE id = ${sessionId}::uuid AND status IN ('ACTIVE', 'PAUSED')
          AND last_event_seq = ${eventSeq}
          AND COALESCE(external_payload #> ARRAY[${CONTEXT_KEY}, 'eventSeq'], '-1'::jsonb)
              < to_jsonb(${eventSeq}::bigint)`;
}
