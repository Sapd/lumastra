// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/ai/available-genres — genres with sufficient content for AI recommendations.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/ai/available-genres.js';

export const { GET } = mount(def, { surface: 'internal' });
