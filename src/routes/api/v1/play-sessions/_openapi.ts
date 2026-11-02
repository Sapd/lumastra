// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { def as startDef } from '$lib/server/api/defs/play-sessions/index.js';
import { def as listDef } from '$lib/server/api/defs/play-sessions/list.js';

export const route: RouteMetadata = { ...startDef.docs, ...listDef.docs };
