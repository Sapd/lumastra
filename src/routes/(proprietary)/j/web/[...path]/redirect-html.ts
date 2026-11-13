// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// The page /j/web/* serves. It reads the jellyfin-web hash route the client
// built (the server never sees the fragment) and sends the browser to the
// matching Lumastra page:
//
//   #!/details?id=<uuid>…          → <base>/watch/<uuid>
//   #/quickconnect?code=<6 digits> → <base>/settings/connections?connect=jellyfin&code=<code>
//     (Moonfin's sign-in QR on Jellyfin ≥ 10.9; the modal opens with the code
//      filled in and the person still taps Approve)
//   anything else                  → <base>/
//
// Kept in a sibling module (a `+server.ts` may only export handlers) so the
// script can be run under test.

/** JSON for an inline <script>: `<` escaped so a value can't close the tag. */
function scriptJson(value: string): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildDeeplinkRedirectHtml(basePath: string): string {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Redirecting…</title>
<meta name="robots" content="noindex"></head>
<body><script>
(function () {
    var base = ${scriptJson(basePath)};
    var h = location.hash || '';
    var qc = h.match(/^#!?\\/quickconnect(?:\\?|$)/i) && h.match(/[?&]code=(\\d{6})(?:&|$)/);
    if (qc) {
        location.replace(base + '/settings/connections?connect=jellyfin&code=' + qc[1]);
        return;
    }
    // Match either dashed UUID (36) or dashless Jellyfin form (32) as id=...
    var m = h.match(/[?&]id=([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})/);
    location.replace(m ? base + '/watch/' + m[1] : base + '/');
})();
</script>Redirecting…</body></html>`;
}
