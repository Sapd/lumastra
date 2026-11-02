// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST /api/v1/playlists/{id}/items — public/native (Bearer) surface.
// Mounts the SAME shared def as the internal items route. OpenAPI docs live in
// the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/items/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
