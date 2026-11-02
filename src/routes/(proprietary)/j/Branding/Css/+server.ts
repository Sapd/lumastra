// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Branding/Css — see brandingCssResponse.

import type { RequestHandler } from './$types';
import { brandingCssResponse } from '$lib/server/proprietary/jellyfin-compat/serializers/system';

export const GET: RequestHandler = () => brandingCssResponse();
