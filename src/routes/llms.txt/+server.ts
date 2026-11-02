// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /llms.txt - LLM-friendly API documentation
// Following the emerging convention for machine-readable docs

import type { RequestHandler } from './$types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isDeviceAuthEnabled } from '$lib/server/oauth';

let markdownDoc: string | null = null;

function loadMarkdown(): string {
    if (!markdownDoc) {
        try {
            const devPath = join(process.cwd(), 'docs/api/API.md');
            markdownDoc = readFileSync(devPath, 'utf-8');
        } catch {
            markdownDoc = '# API Documentation\n\nPublic API documentation not available.';
        }
    }
    return markdownDoc;
}

export const GET: RequestHandler = async () => {
    // Only serve docs if public API is enabled
    if (!isDeviceAuthEnabled()) {
        return new Response('# API Not Available\n\nPublic API is disabled on this instance.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }

    return new Response(loadMarkdown(), {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
        },
    });
};
