// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET    /api/notifications/{id} — read one notification (browser/forward-auth surface)
// DELETE /api/notifications/{id} — delete a notification
//
// Definition: $lib/server/api/defs/notifications/[id]/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/notifications/[id]/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
