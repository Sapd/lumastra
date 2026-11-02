// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/DELETE /api/v1/users/{id}/identities — federated identity admin (users:admin)
//
// Hand-mounted delegate def (Phase 3). Definition + OpenAPI docs live in
// $lib/server/api/defs/users/[id]/identities.ts, which resolves the UUID to a
// username before delegating to the internal admin handlers. Stays
// hand-written (not generator-owned) → v1-only.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/[id]/identities.js';

export const { GET, DELETE } = mount(def, { surface: 'v1' });
