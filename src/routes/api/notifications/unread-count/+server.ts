// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/notifications/unread-count — fast unread badge count (browser/forward-auth surface)
//
// Definition: $lib/server/api/defs/notifications/index.ts (unreadCountDef)

import { mount } from '$lib/server/api/mount.js';
import { unreadCountDef } from '$lib/server/api/defs/notifications/index.js';

export const { GET } = mount(unreadCountDef, { surface: 'internal' });
