// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/requests/quota — user request quota (token surface)
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/quota.js';

export const { GET } = mount(def, { surface: 'v1' });
