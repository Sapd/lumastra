// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PATCH /api/v1/media/{id}/metadata — custom metadata JSONB (media:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/media/[id]/metadata-admin.ts (named `metadata-admin` —
// NOT `metadata` — to avoid colliding with the unrelated, already-generator-
// mounted lock-status def at defs/media/[id]/metadata.ts; see that file's
// docstring), which delegates to the internal admin handlers. Stays
// hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/metadata-admin.js';

export const { GET, PATCH } = mount(def, { surface: 'v1' });
