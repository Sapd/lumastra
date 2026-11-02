// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST /api/v1/plugins/internal/{id} — plugin status + trigger (tasks:admin / tasks:run)
// GET WAS tasks:read — moved 2026-09-18 fix-plan-4 Task 2, Shape C ruling's
// five-endpoint sweep (see defs/plugins/internal/[id]/index.ts).
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/plugins/internal/[id]/index.ts, which delegates to the
// internal admin handlers. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/plugins/internal/[id]/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
