// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST/DELETE /api/v1/recommendations/dismiss — public/native surface. Mounts
// a delegate def that forwards to the untouched internal /api/recommendations/
// dismiss mounted handler (Option B), preserving its exact runtime auth/response
// behaviour. OpenAPI docs (POST only) live in the def's `docs` field (the retired
// _openapi.ts). See src/lib/server/api/defs/recommendations/dismiss.ts.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/recommendations/dismiss.js';

export const { GET, POST, DELETE } = mount(def, { surface: 'v1' });
