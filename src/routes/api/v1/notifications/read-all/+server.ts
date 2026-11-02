// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/notifications/read-all — mark all unread notifications as read.
// Imports the `def` alias (defs/notifications/read-all.ts → readAllDef) so the
// OpenAPI generator can discover def.docs. OpenAPI docs live in that def's
// `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/notifications/read-all.js';

export const { POST } = mount(def, { surface: 'v1' });
