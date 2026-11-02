// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/users/{id}/password — admin-set a user's native password (users:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/users/[id]/password.ts, which resolves the UUID to a
// username before delegating to the internal admin handler. Stays
// hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id]/password.js';

export const { POST } = mount(def, { surface: 'v1' });
