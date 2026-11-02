// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PUT /api/v1/plugins/internal/{id}/settings — plugin settings (tasks:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/plugins/internal/[id]/settings.ts, which delegates to
// the internal admin handlers. Stays hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/plugins/internal/[id]/settings.js';

export const { GET, PUT } = mount(def, { surface: 'v1' });
