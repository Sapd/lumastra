// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/media/{id}/viewers — public/native (Bearer token) surface. Mounts
// the SAME shared def as the internal /api/media/[id]/viewers route, so both
// surfaces run identical auth/validation/handler logic (incl. the FEATURE_SOCIAL
// gate inside the handler). The OpenAPI docs for this surface live in the def's
// `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/media-id-viewers.js';

export const { GET } = mount(def, { surface: 'v1' });
