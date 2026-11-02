// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/plugins/internal/{id}/run — trigger a plugin run (tasks:run)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/plugins/internal/[id]/run.ts, which delegates to the
// internal admin handler. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/plugins/internal/[id]/run.js';

export const { POST } = mount(def, { surface: 'v1' });
