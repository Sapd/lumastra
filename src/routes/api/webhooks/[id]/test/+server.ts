// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/webhooks/{id}/test — send synthetic event to hook URL
//
// Internal (cookie/forward-auth) mirror of /api/v1/webhooks/{id}/test.

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/webhooks/[id]/test.js';

export const { POST } = mount(def, { surface: 'internal' });
