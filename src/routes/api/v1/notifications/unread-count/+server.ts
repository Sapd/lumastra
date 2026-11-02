// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/notifications/unread-count — fast unread badge count.
// Imports the `def` alias (defs/notifications/unread-count.ts → unreadCountDef)
// so the OpenAPI generator can discover def.docs. OpenAPI docs live in that
// def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/notifications/unread-count.js';

export const { GET } = mount(def, { surface: 'v1' });
