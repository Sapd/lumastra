// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/tracks/{id} — public/native (Bearer token) surface. Mounts a
// delegate def that forwards to the untouched internal /api/music/tracks/[id]
// handler (Option B), preserving its exact runtime auth/response behaviour. The
// OpenAPI docs for this surface live in the def's `docs` field (the retired
// _openapi.ts). See src/lib/server/api/defs/music/tracks/[id].ts for rationale.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks/[id].js';

export const { GET } = mount(def, { surface: 'v1' });
