// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/notifications/{id}/read — mark one notification as read
//
// Definition: $lib/server/api/defs/notifications/[id]/read/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/notifications/[id]/read/index.js';

export const { POST } = mount(def, { surface: 'v1' });
