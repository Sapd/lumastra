// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET  /api/v1/webhooks — list hooks ({items,page})
// POST /api/v1/webhooks — create hook; returns 201 + resource + Location

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/webhooks/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
