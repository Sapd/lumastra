// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/notifications — paginated notification inbox
//
// Definition: $lib/server/api/defs/notifications/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/notifications/index.js';

export const { GET } = mount(def, { surface: 'v1' });
