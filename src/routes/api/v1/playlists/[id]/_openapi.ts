// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI metadata for /api/v1/playlists/{id}.
 *
 * The route file used to re-export the INTERNAL route's handlers, which meant it
 * ran with ctx.surface === 'internal' and emitted /api/... URLs from an /api/v1
 * path. It now mounts the shared def on the v1 surface directly — but the spec
 * generator resolved this route's metadata by following that re-export to the
 * internal route's colocated `_openapi.ts`, so mounting directly would have
 * silently dropped the path from the published spec.
 *
 * Re-exported rather than duplicated: both surfaces mount the SAME def, so the
 * documented request/response contract is by construction identical.
 */
export * from '../../../playlists/[id]/_openapi.js';
