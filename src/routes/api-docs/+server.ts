// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api-docs - Serve API documentation
// Returns OpenAPI spec in YAML or JSON format, or Swagger UI HTML
// Only available to signed-in users when device auth (public API) is enabled

import type { RequestHandler } from './$types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isDeviceAuthEnabled } from '$lib/server/oauth';

// Cache the spec file content
let publicApiSpec: string | null = null;
let markdownDoc: string | null = null;

/**
 * MUST read `api-v1.yaml`, never `openapi.yaml`. This route is reachable by
 * signed-in users once FEATURE_DEVICE_AUTH is on — `openapi.yaml` is the "Combined"
 * spec (its own `info.description`: "Do not use for documentation") that
 * additionally carries every `visibility: 'internal'` admin route
 * (`openapi-admin-internal-visibility` lint rule enforces that those stay
 * OUT of `api-v1.yaml` specifically so it's safe to publish here). Loading
 * the combined file previously leaked internal/admin endpoint shapes to an
 * unauthenticated caller.
 */
function loadSpec(): string {
    if (!publicApiSpec) {
        try {
            // Try to load from docs folder (development)
            const devPath = join(process.cwd(), 'docs/api/api-v1.yaml');
            publicApiSpec = readFileSync(devPath, 'utf-8');
        } catch {
            // Fallback: return a minimal spec
            publicApiSpec = `
openapi: 3.1.0
info:
  title: Lumastra API
  version: 1.0.0
  description: The OpenAPI spec artifact is unavailable. Contact the instance administrator.
paths: {}
`;
        }
    }
    return publicApiSpec;
}

function loadMarkdown(): string {
    if (!markdownDoc) {
        try {
            const devPath = join(process.cwd(), 'docs/api/API.md');
            markdownDoc = readFileSync(devPath, 'utf-8');
        } catch {
            markdownDoc = '# API Documentation\n\nSee /api-docs?format=yaml for the OpenAPI spec.';
        }
    }
    return markdownDoc;
}

// Swagger UI comes from unpkg, pinned to an exact version with SRI hashes. The app-wide CSP
// (hooks.server.ts) only allows same-origin scripts and styles, so this page sends its own
// full policy — mergeRouteCsp() keeps a route-owned CSP verbatim. When bumping the version,
// recompute both hashes: `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
const SWAGGER_UI_BASE = 'https://unpkg.com/swagger-ui-dist@5.33.0';
const SWAGGER_UI_CSS_SRI =
    'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW';
const SWAGGER_UI_JS_SRI = 'sha384-YDALVcy8kj8yltLBVi1vBiBAUqdxvus673gM8XKwiy6aDUJFXivF/KCufekjYbVf';
const SWAGGER_UI_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

export const GET: RequestHandler = async ({ url }) => {
    // Only serve docs if public API is enabled
    if (!isDeviceAuthEnabled()) {
        return new Response('API documentation not available. Public API is disabled.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
        });
    }

    const format = url.searchParams.get('format');

    // Return raw markdown for LLMs
    if (format === 'md' || format === 'markdown') {
        return new Response(loadMarkdown(), {
            headers: {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Cache-Control': 'private, max-age=3600',
            },
        });
    }

    // Return raw YAML
    if (format === 'yaml') {
        return new Response(loadSpec(), {
            headers: {
                'Content-Type': 'text/yaml; charset=utf-8',
                'Cache-Control': 'private, max-age=3600',
            },
        });
    }

    // Return raw JSON
    if (format === 'json') {
        // Convert YAML to JSON (simple approach - just for the response)
        const yaml = await import('yaml');
        // maxAliasCount: -1 disables yaml's anchor/alias resource-exhaustion
        // guard, which exists for untrusted input — this file is our own
        // generated build artifact, and its legitimate anchor count (shared
        // component schemas referenced across 258 paths) already exceeds the
        // library's default limit (100), throwing on every request.
        const spec: unknown = yaml.parse(loadSpec(), { maxAliasCount: -1 });
        return new Response(JSON.stringify(spec, null, 2), {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'private, max-age=3600',
            },
        });
    }

    // Default: Return Swagger UI HTML
    const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lumastra API Documentation</title>
  <link rel="stylesheet" type="text/css" href="${SWAGGER_UI_BASE}/swagger-ui.css" integrity="${SWAGGER_UI_CSS_SRI}" crossorigin="anonymous">
  <style>
    body { margin: 0; padding: 0; }
    .swagger-ui .topbar { display: none; }
    .info-container { padding: 20px; background: #1a1a2e; }
    .info-container h2 { color: #fff; margin: 0 0 10px 0; }
    .info-container p { color: #aaa; margin: 0; }
    .info-container a { color: #61affe; }
  </style>
</head>
<body>
  <div class="info-container">
    <h2>Lumastra API</h2>
    <p>
      <a href="/api-docs?format=yaml">OpenAPI YAML</a> |
      <a href="/api-docs?format=json">OpenAPI JSON</a> |
      <a href="/api-docs?format=md">Markdown (LLM-friendly)</a>
    </p>
  </div>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI_BASE}/swagger-ui-bundle.js" integrity="${SWAGGER_UI_JS_SRI}" crossorigin="anonymous"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: '/api-docs?format=json',
        dom_id: '#swagger-ui',
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout",
        deepLinking: true,
        defaultModelsExpandDepth: 0,
        docExpansion: 'list'
      });
    };
  </script>
</body>
</html>`;

    return new Response(swaggerHtml, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'private, max-age=3600',
            'Content-Security-Policy': SWAGGER_UI_CSP,
        },
    });
};
