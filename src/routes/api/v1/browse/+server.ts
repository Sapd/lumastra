// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/browse — public/native (Bearer token) surface for the browse
// endpoint. Mounts the SAME shared def as the internal /api/browse route, so
// both surfaces run identical auth/validation/handler logic. The OpenAPI docs
// for this surface live in the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/browse/index.js';

export const { GET } = mount(def, { surface: 'v1' });
