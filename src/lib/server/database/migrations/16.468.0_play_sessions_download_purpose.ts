// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Migration } from '../migration-system.js';

/**
 * Let `play_sessions.purpose` say 'download'.
 *
 * An audiobook DOWNLOAD (the Apple Watch fetches files in a background URLSession for
 * hours or days) needs a row that authorises its byte requests but is not a stream: it
 * must not count toward the concurrent-stream limit, appear in Active Sessions or the
 * "listening now" feeds, or be reaped by the heartbeat rules, because it sends no
 * reports. Until now that was only a key inside `external_payload`; the column is what
 * every "who is playing" read already filters on (`purpose = 'play'`), so a real value
 * excludes the row everywhere at once.
 *
 * play_sessions is large, so the CHECK is added `NOT VALID` (no scan) under a bounded
 * `lock_timeout` and validated afterwards in its own statement: VALIDATE CONSTRAINT only
 * takes SHARE UPDATE EXCLUSIVE, so readers and writers keep working during the scan. Both
 * steps run in nonTransactionalUp, otherwise the migration transaction would keep the
 * ACCESS EXCLUSIVE lock of the ALTER for the whole validation. Both are idempotent, so a
 * failed boot simply retries.
 */
export const migration_16_468_0: Migration = {
    version: '16.468.0',
    name: 'play_sessions_download_purpose',
    description:
        "Allow purpose = 'download' on play_sessions so offline-download sessions are a real kind, not a payload key.",
    checksum: 'play-sessions-download-purpose-v1',
    async nonTransactionalUp(sql) {
        await sql.begin(async (tx) => {
            await tx`SET LOCAL lock_timeout = '5s'`;
            await tx.unsafe(`
                ALTER TABLE play_sessions DROP CONSTRAINT IF EXISTS play_sessions_purpose_check;
                ALTER TABLE play_sessions
                    ADD CONSTRAINT play_sessions_purpose_check
                    CHECK (purpose = ANY (ARRAY['play'::text, 'prefetch'::text, 'download'::text]))
                    NOT VALID;
            `);
        });
        await sql.unsafe(
            'ALTER TABLE play_sessions VALIDATE CONSTRAINT play_sessions_purpose_check',
        );
    },
    async up() {
        // Schema work happens in nonTransactionalUp above.
    },
};
