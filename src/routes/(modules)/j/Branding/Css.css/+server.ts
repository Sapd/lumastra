// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Branding/Css.css — see brandingCssResponse.

import type { RequestHandler } from './$types';
import { brandingCssResponse } from '$lib/server/jellyfin-compat/serializers/system';

export const GET: RequestHandler = () => brandingCssResponse();
