# Hello World — external plugin example

A minimal drop-in plugin that demonstrates the new SDK plugin shape. It
implements `ProviderDefinition` (metadata provider) and returns
hardcoded search/detail results so the loader and admin UI have something
real to surface.

## How drop-in plugins work

The host walks every directory under `$PLUGINS_EXTERNAL_DIR` (default
`/app/plugins`) at boot. Each plugin directory must contain either:

- An `index.js` (default entry point), OR
- A `package.json` with a `main` field pointing at the entry file

The default export must be a plain object matching one of the eight SDK
contract shapes — `defineTask` / `defineProvider` / `defineTrickplayProvider`
/ `defineWatchSync` / `defineFeature` / `defineIntegration` /
`defineMediaSource` / `defineExternalService`. The loader detects which
contract is implemented by inspecting the export's shape and registers the
plugin against the task registry.

Plugins are detected by **export shape**, not by SDK function calls. A
default-exported plain object whose keys match a contract is all the host
needs. Do **not** runtime-import from `@sapd/lumastra-plugin-sdk` (e.g.
`import { defineProvider } from '@sapd/lumastra-plugin-sdk'`) — the host doesn't
ship the SDK as resolvable JS to plugin processes, and a runtime import
will throw `ERR_MODULE_NOT_FOUND` at plugin load. Types only: JSDoc
`@type` for JavaScript, `import type` for TypeScript. The loader handles
shape detection.

## JavaScript authors

Install `@sapd/lumastra-plugin-sdk` as a dev dependency and annotate the default
export with a JSDoc `@type` so VS Code gives you autocomplete + type
errors:

```js
/** @type {import('@sapd/lumastra-plugin-sdk').ProviderDefinition} */
const myProvider = {
    id: 'my-provider',
    name: 'My Provider',
    version: '1.0.0',
    capabilities: { http: true },
    async isConfigured(ctx) {
        /* … */
    },
    async search(ctx, params) {
        /* … */
    },
    async detail(ctx, externalId) {
        /* … */
    },
};
export default myProvider;
```

## TypeScript authors

Write your plugin in `.ts` using **type-only imports**, then compile to
`.js` before drop-in. `import type` is erased by the TypeScript compiler,
so the output JavaScript contains zero references to `@sapd/lumastra-plugin-sdk`
— only the plain object literal the host loader detects by shape.

```ts
import type { ProviderDefinition } from '@sapd/lumastra-plugin-sdk';

const myProvider: ProviderDefinition = {
    id: 'my-provider',
    name: 'My Provider',
    version: '1.0.0',
    capabilities: { http: true },
    async isConfigured(ctx) {
        /* … */
    },
    async search(ctx, params) {
        /* … */
    },
    async detail(ctx, externalId) {
        /* … */
    },
};
export default myProvider;
```

Compile with `tsc`:

```bash
npx tsc --module esnext --target es2022 \
    --moduleResolution bundler \
    src/index.ts --outDir .
```

`esbuild`, `tsup`, and `swc` all honor `import type` erasure too — pick
whichever you already use. No `--external` flag is needed because there's
nothing left to externalize.

> **Don't use runtime value imports** (`import { defineProvider } from
'@sapd/lumastra-plugin-sdk'`) — the host doesn't ship the SDK as resolvable
> JS at runtime, so the plugin will fail to load with
> `ERR_MODULE_NOT_FOUND`. The contract is the export's shape, not a
> function call.

## Optional companion exports

Alongside the default export, a plugin can also export:

- `normalizer` — a `NormalizerModule` that controls how provider-specific
  search/detail results are normalized into the host's catalog shape
- `encoder` — an `EncodeFn` that controls how provider-specific external
  IDs are encoded into the unified `provider:id` format

The loader wires both automatically. Authors who prefer module-level side
effects can call `registerProviderNormalizer` / `registerProviderEncoder`
directly inside their module instead.

## Capabilities

`capabilities: { http?, cache?, database? }` declares which host resources
the plugin needs. The host builds the `PluginContext` you receive at
`isConfigured` / `search` / `detail` / etc. accordingly — only declared
capabilities have non-undefined fields.

## Feature routes and authorization

If your plugin exposes `routes` (`FeatureDefinition.routes`, see the
`example-feature-plugin` companion), the host only enforces that SOME user
is authenticated before calling your handler — a request with no user gets
a 401 and never reaches you. There is no host-enforced `access` gate on a
route the way there is on `FeaturePage.access`. Anything finer than "some
user is logged in" — admin-only, a specific group, ownership of the
resource being touched — is the plugin author's own job: check `ctx.user`
(e.g. `ctx.user?.isAdmin`) inside every handler that mutates state or
returns sensitive data, and return a 404 (not a 403) for a denied caller so
the response doesn't confirm the route even exists.
