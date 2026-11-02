// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/notifications — paginated notification inbox (browser/forward-auth surface)
//
// Definition: $lib/server/api/defs/notifications/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/notifications/index.js';

export const { GET } = mount(def, { surface: 'internal' });
