// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/artists/{id} — public/native (Bearer token) surface. Mounts a
// delegate def that calls the shared handler (src/lib/server/api/handlers/music-artist-detail.handler.ts)
// with {surface:'v1', fullAudioFeatures:true}, deliberately returning full Essentia
// audio features in track payloads. The internal surface calls the same handler with
// different options. OpenAPI docs live in the def's `docs` field. See
// src/lib/server/api/defs/music/artists/[id].ts for rationale.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/artists/[id].js';

export const { GET } = mount(def, { surface: 'v1' });
