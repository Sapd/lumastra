// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/playlists/{id}/playback-context — public/native surface. Mounts
// the SAME shared def as the internal route. OpenAPI docs live in the def's
// `docs` field.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/playback-context.js';

export const { GET } = mount(def, { surface: 'v1' });
