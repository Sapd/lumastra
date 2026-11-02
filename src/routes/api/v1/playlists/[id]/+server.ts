// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Public API for single playlist - JWT authenticated
// Mounts the SAME shared def as the internal route, but on the v1 surface.
// It used to re-export the internal route's handlers, which meant this v1
// endpoint executed with ctx.surface === 'internal' and emitted /api/... URLs
// from an /api/v1 path. Mount the def directly so the surface matches the
// prefix the route file physically defines.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playlists/[id]/index.js';

export const { GET, PATCH, DELETE } = mount(def, { surface: 'v1' });
