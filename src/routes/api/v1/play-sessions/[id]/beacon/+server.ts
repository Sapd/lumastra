// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/play-sessions/{id}/beacon — public/native (Bearer token) surface.
// Mounts the SAME shared def as the internal /api/play-sessions/[id]/beacon
// route. OpenAPI docs live in the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/play-sessions/[id]/beacon.js';

export const { POST } = mount(def, { surface: 'v1' });
