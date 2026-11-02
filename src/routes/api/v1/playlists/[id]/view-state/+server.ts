// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PUT /api/v1/playlists/{id}/view-state — public/native (Bearer) surface.
// Mounts the SAME shared def as the internal view-state route. OpenAPI docs live
// in the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/view-state.js';

export const { PUT } = mount(def, { surface: 'v1' });
