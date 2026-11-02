// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/users/{id}/refresh-watch-state — reset watch-sync pull cursor (users:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/users/[id]/refresh-watch-state.ts, which resolves the
// UUID to a username before delegating to the internal admin handler. Stays
// hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id]/refresh-watch-state.js';

export const { POST } = mount(def, { surface: 'v1' });
