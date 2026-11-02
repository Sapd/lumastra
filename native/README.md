<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Native components

Each component has an independent Cargo manifest and committed lockfile. The
shared compiler version is pinned in `rust-toolchain.toml`. Native build tooling
requires that exact toolchain and fails on missing components or lockfiles.

From the application directory:

```sh
node scripts/native.mjs check watcher
node scripts/native.mjs build watcher
node scripts/native.mjs test-release watcher
node scripts/native.mjs licenses watcher
node scripts/native.mjs smoke watcher
```

`check` runs formatting, strict Clippy and actual Rust tests. `test-release`
runs the component tests with the optimized profile. `build` copies the
release executable reported by Cargo into `build/`; it does not guess a target
output path. `licenses` writes resolved dependency metadata and available license
texts into `build/native-licenses/`. The inventory explicitly includes development
and other-target dependencies and lists packages without collected notice files;
it is not a claim that every package is linked or every notice is complete. `smoke` runs only the executable's version
command and does not establish behavioral conformance.

Supported components are `watcher`, `livetv-proxy` and `task-queue`. Their own READMEs
and conformance suites describe implementation status. The task queue client is
being qualified independently and has no production ownership selector. Its test
binary is available through the validation image, not the application image.

The application image packages the Rust watcher beside the dedicated lean
TypeScript task host in the same worker container. Exactly one worker runs
unchanged TypeScript tasks/plugins and supervises one credential-free Rust watcher
child. The web role serves requests and submits work. Combined web/task execution
and the legacy task-host selector are removed. BullMQ and the persistent
noeviction task/shared-coordination Valkey plus separate evictable cache remain.
Task control ownership stays in TypeScript. Rust is the only file watcher, including
local development. `npm run build:watcher` builds `build/lumastra-watcher`;
`npm run dev:worker` runs that build automatically.

The native Live TV proxy supports explicit operational `--serve` startup and is
qualified independently from the task host. TypeScript remains its default and
rollback runtime. Candidate evidence includes actual media on Linux AMD64/native
ARM, Apple TV and Chrome; an unexplained initial iOS freeze and the ongoing
isolated proxy soak remain open. These results do not establish universal
production, mixed-workload or GPU qualification.

`native/Dockerfile` is a validation image, not a deployment entrypoint. It builds
for its target architecture against GNU libc and executes a non-root Ubuntu
version smoke. Native CI additionally runs cross-language conformance on Linux
AMD64 and ARM64. A configured workflow is not evidence of a passed run. Container
execution, resource measurements, recovery/rollback tests and component-specific
soaks remain required before activation; `--version` alone cannot satisfy them.
