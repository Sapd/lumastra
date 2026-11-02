// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface BypassCheck {
    surface: string;
    /** null means the probe could not establish either outcome. */
    gated: boolean | null;
}

/** Probe public app endpoints without the browser's login credentials. */
export async function checkProxyBypasses(
    appUrl: (path: string) => string,
    fetcher: typeof fetch = fetch,
): Promise<BypassCheck[]> {
    const probes = [
        { surface: '/api/health', path: '/api/health', public: true },
        // Health is outside /api/v1: test that bypass independently too.
        { surface: '/api/v1', path: '/api/v1/server', public: true },
        { surface: '/j', path: '/j', public: false },
        {
            surface: '/subsonic',
            path: '/subsonic/rest/ping.view?v=1.16.1&c=lumastra-setup&f=json',
            public: false,
        },
    ];
    return Promise.all(
        probes.map(async (probe): Promise<BypassCheck> => {
            try {
                const res = await fetcher(appUrl(probe.path), {
                    redirect: 'manual',
                    credentials: 'omit',
                    cache: 'no-store',
                });
                const contentType = res.headers.get('content-type') ?? '';
                if (
                    res.type === 'opaqueredirect' ||
                    (res.status >= 300 && res.status < 400) ||
                    contentType.includes('text/html') ||
                    (probe.public && (res.status === 401 || res.status === 403))
                ) {
                    return { surface: probe.surface, gated: true };
                }
                if (probe.path === '/api/health') {
                    const body: unknown = contentType.includes('application/health+json')
                        ? await res.json()
                        : null;
                    const healthy =
                        res.status === 200 &&
                        body !== null &&
                        typeof body === 'object' &&
                        'status' in body &&
                        body.status === 'pass';
                    return { surface: probe.surface, gated: healthy ? false : null };
                }
                // A missing endpoint or a proxy error cannot establish a bypass.
                const unknown = res.status === 404 || res.status >= 500;
                return { surface: probe.surface, gated: unknown ? null : false };
            } catch {
                return { surface: probe.surface, gated: null };
            }
        }),
    );
}
