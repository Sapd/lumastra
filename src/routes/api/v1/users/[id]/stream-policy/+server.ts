// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/PUT /api/v1/users/{id}/stream-policy — effective stream policy admin (users:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/users/[id]/stream-policy.ts, which resolves the UUID
// to a username before delegating to the internal admin handlers. Stays
// hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id]/stream-policy.js';

export const { GET, PUT } = mount(def, { surface: 'v1' });
