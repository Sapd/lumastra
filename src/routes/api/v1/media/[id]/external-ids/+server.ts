// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PUT/DELETE /api/v1/media/{id}/external-ids — external provider IDs (media:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/media/[id]/external-ids.ts, which delegates to the
// internal admin handlers. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/external-ids.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'v1' });
