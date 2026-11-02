// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/series/{id} — public/native (Bearer token) surface.
// Mounts the SAME shared def as the internal /api/series/[id] route. Every URL
// the def emits is derived from `ctx.surface`, so this mount yields /api/v1/...
// links and images while the internal mount yields /api/... . The OpenAPI docs
// for this surface live in the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/series-id.js';

export const { GET } = mount(def, { surface: 'v1' });
