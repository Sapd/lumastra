// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/ai/force-suggestions — admin debug: force-generate suggestions for calling user.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/ai/force-suggestions.js';

export const { GET } = mount(def, { surface: 'internal' });
