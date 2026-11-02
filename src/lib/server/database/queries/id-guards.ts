// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `playback_incident_events.media_id` is only populated when the client's
 * IncidentReporter happened to have a mediaId at report time — several
 * report paths (notably the unload beacon) fire with it unset (prod
 * 2026-08-18: every incident tied to a mid-session "session expired" 410
 * had `media_id IS NULL`, showing as "Media: Unknown" in the admin UI even
 * though the play_sessions row for the same play_session_id knew exactly
 * what was playing). `play_session_id` is stored as free-text (can be an
 * empty string on the no-session unload path — see incident-reporter.ts),
 * so joining it against play_sessions.id needs a guarded cast. A plain
 * `col ~ pattern AND col::uuid = ...` is NOT safe here — Postgres does not
 * guarantee left-to-right short-circuit evaluation of AND subexpressions in
 * a JOIN's ON clause, and the integration test below caught exactly that:
 * a non-UUID play_session_id ("test-list-session-0") still threw "invalid
 * input syntax for type uuid" even with the regex guard ANDed in front of
 * the cast. A CASE expression's WHEN/THEN order IS guaranteed, so the cast
 * only ever runs after the regex has matched.
 *
 * Shared across every query module that joins a free-text play_session_id
 * against a `uuid` column (playback-incident-events, delivery-windows,
 * client-diagnostics, …) — one pattern, one rationale, so a fix to one
 * cannot drift from the others.
 */
export const PLAY_SESSION_ID_UUID_PATTERN =
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
