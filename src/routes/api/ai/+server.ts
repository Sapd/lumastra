// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/ai — AI service health check (database + embedding connectivity).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/ai/health.js';

export const { GET } = mount(def, { surface: 'internal' });
