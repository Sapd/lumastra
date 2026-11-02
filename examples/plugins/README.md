<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: Apache-2.0
-->

# Sample plugins

Working drop-in plugins, one per contract shape. Copy a directory into
`$PLUGINS_EXTERNAL_DIR`, restart, and it loads.

Every one of these is loaded through the real loader by
`src/lib/server/plugins/runtime/sample-plugins.test.ts`, so if the host's rules
and these examples ever drift apart, that test fails rather than an author
discovering it. Both directions have already bitten: `defineTask` used to accept
a task the registry then rejected, and a feature without routes is refused at
load — neither was obvious from the docs alone.

| Directory                   | Contract                  | What it shows                                                    |
| --------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `sample-task/`              | `defineTask`              | Scheduled work. Note `processingVersion` — it is required        |
| `sample-feature/`           | `defineFeature`           | HTTP routes. **At least one route is mandatory**                 |
| `sample-external-service/`  | `defineExternalService`   | Settings only. Declares NO contract method, deliberately         |
| `sample-subtitle-provider/` | `defineSubtitleProvider`  | search + download; the host does the ranking                     |
| `sample-integration/`       | `defineIntegration`       | Host events out, webhook in — with no declared secret field      |
| `sample-lyrics-ts/`         | `defineLyricsProvider`    | **TypeScript, no build step**                                    |
| `sample-bundle/`            | aggregate                 | Several contracts in one plugin: namespace + anchor rules        |
| `sample-provider/`          | `defineProvider`          | Metadata search + detail lookups                                 |
| `sample-trickplay/`         | `defineTrickplayProvider` | Scrubbing-preview tiles                                          |
| `sample-watch-sync/`        | `defineWatchSync`         | Bidirectional watch state; push/pull tasks are synthesized       |
| `sample-media-source/`      | aggregate                 | A media source plus its own namespaced scan task                 |
| `sample-auth-provider/`     | `defineAuthProvider`      | Verifies a login and returns claims — the host mints the session |

## Things these examples exist to make concrete

**The SDK is a dev-time dependency.** Never `import` it at runtime — the host
loads plugins with it marked external, so a runtime import fails with
`ERR_MODULE_NOT_FOUND` on your first line. Use `@type` JSDoc (as the `.js`
samples do) or `import type` (as the `.ts` one does).

**TypeScript needs no build step.** `sample-lyrics-ts/` ships `index.ts` and
nothing else. The loader resolves `package.json#main`, then `index.js`, then
`index.ts`, and the host runs Node 24, which strips types on import.

Strip-only is a real limit: `enum`, `namespace`, parameter properties and
decorators throw at import with _"not supported in strip-only mode"_, because
they need code generated rather than removed. Use const objects and union types,
or compile and ship `index.js`.

`index.js` is resolved **first**. If you ship a build alongside your source, the
build runs — that is the artifact your signature and tree digest cover.

**An aggregate has two rules**, both enforced at load. _Namespace_: every
contract id must be the plugin name or start with `<name>-`. _Anchor_: exactly
one contract must be named after the plugin itself, because that id is how the
host answers "is this loaded?". Validation is all-or-nothing — one invalid
contract registers none of them, since there is no unload and a half-registered
bundle would be unrecoverable.

**A webhook integration gets its secret from the host.** `sample-integration/`
declares `capabilities.webhook` and no `webhookSecret` field on purpose: the
host injects that field so an operator can set the secret. The endpoint 404s
until they do.

Full authoring guide: <https://lumastra.org/developers/plugins/>

## Publishing these as a signed repository

A repository is one JSON index plus the signed manifests and payloads it points
at. There is no server component and no registration: anything that can serve
static files can host one.

```bash
node scripts/build-plugin-repo.mjs \
    --src examples/plugins --out /tmp/repo \
    --base-url https://plugins.example.com \
    --key ~/.secrets/lumastra-official-2026.pem \
    --key-id lumastra-official-2026
```

That signs every directory here and lays the output out as:

```
index.json
<name>/<version>/manifest.json      # the exact bytes that were signed
<name>/<version>/manifest.json.sig
<name>/<version>/index.js           # or bundle.tar.gz for a multi-file plugin
```

Serve that directory, then add `https://plugins.example.com/index.json` on
**Admin → Extensions**. The catalog is an autofill for the verified install
form — it carries the same `(manifestUrl, signature)` pair an operator would
otherwise paste, so every entry is re-verified from signed bytes before
anything is installed and a repository grants no trust of its own.

Two things that bite:

- **`--base-url` is signed.** `bundleUrl` lives inside the manifest bytes, so
  moving a repository to a different origin means re-signing every manifest.
  Pick the final hostname before publishing.
- **Serve `manifest.json` byte-for-byte.** Any re-indentation or re-minification
  by a CDN or a build step invalidates the signature. The signature is over the
  exact bytes, which is the point of it.

Each plugin's `plugin.json` supplies what gets signed alongside the code:
`kind` (or `kinds` for an aggregate), `publisher`, `description`, `license`,
`sourceUrl`, and optionally `capabilities` and `minAppVersion`. Those are inside
the signature because an operator's install decision reads them — a catalog that
could substitute `description` or `capabilities` could present a watch-sync with
database access as a harmless theme.
