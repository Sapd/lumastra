// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PUT/DELETE /api/v1/media/{id}/rating — public/native (Bearer token) surface.
// Mounts the SAME shared def as the internal /api/media/[id]/rating route, so
// both surfaces run identical auth/validation/handler logic. The OpenAPI docs
// for this surface live in the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-rating.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'v1' });
