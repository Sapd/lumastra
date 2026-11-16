// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { generateMigrationChecksum, type Migration } from '../migration-system';

// Web downloads: a per-user permission override (NULL = follow the server default) and the
// log of download attempts (one row per user + file|rendition + device transfer; an open row
// has ended_at IS NULL and counts its running connections in open_streams). The parallel-
// download leases do NOT live here: they are in Valkey (`dl:lease:*`, `dl:users`) with a
// process-local fallback; download_events is only the log.
const SQL = `ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_downloads boolean;
CREATE TABLE IF NOT EXISTS download_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_item_id uuid NOT NULL,
    file_id uuid,
    rendition_id uuid,
    surface text NOT NULL,
    device_key text NOT NULL,
    client_name text,
    bytes_total bigint,
    bytes_sent bigint NOT NULL DEFAULT 0,
    range_start bigint,
    started_at timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    outcome text,
    open_streams integer NOT NULL DEFAULT 0,
    CONSTRAINT download_events_surface_check CHECK (surface IN ('web', 'jellyfin', 'api')),
    CONSTRAINT download_events_outcome_check CHECK (
        outcome IS NULL OR outcome IN ('completed', 'aborted', 'denied', 'rate_limited', 'error')
    )
);
CREATE INDEX IF NOT EXISTS idx_download_events_started
    ON download_events (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_download_events_user_started
    ON download_events (user_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_download_events_open_transfer
    ON download_events (user_id, device_key, (COALESCE(file_id, rendition_id)))
    WHERE ended_at IS NULL;`;

export const migration_16_470_0: Migration = {
    version: '16.470.0',
    name: 'downloads_permission_and_log',
    description: 'Add users.allow_downloads and the download_events log table.',
    checksum: generateMigrationChecksum(SQL),
    async up(sql) {
        // Bounded wait for the users ALTER (ACCESS EXCLUSIVE); a failed boot just retries.
        await sql.unsafe(`SET LOCAL lock_timeout = '5s';\n${SQL}`);
    },
};
