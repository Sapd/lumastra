// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/ai/generate-suggestions/[userId] — admin: generate suggestions for a specific user.
// Rate limiting is applied inside the def handler (after auth, preserving original ordering).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/ai/generate-suggestions.js';

export const { POST } = mount(def, { surface: 'internal' });
