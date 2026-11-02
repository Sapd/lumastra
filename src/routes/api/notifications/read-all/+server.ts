// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/notifications/read-all — mark all unread notifications as read (browser/forward-auth surface)
//
// Definition: $lib/server/api/defs/notifications/index.ts (readAllDef)

import { mount } from '$lib/server/api/mount.js';
import { readAllDef } from '$lib/server/api/defs/notifications/index.js';

export const { POST } = mount(readAllDef, { surface: 'internal' });
