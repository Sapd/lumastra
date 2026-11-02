# Security Policy

We take the security of Lumastra seriously. Thank you for helping keep the project
and its users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or
pull requests.**

Instead, report them privately via one of:

- **GitHub (preferred):** [Report a vulnerability](https://github.com/Sapd/lumastra/security/advisories/new)
  on the repository's **Security** tab. The report stays private between you and the
  maintainer, and the fix and advisory can be prepared there together.
- **Email:** <git@sapd.eu>, use a subject line starting with `SECURITY:`

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version / commit, and your environment
- Any suggested remediation

## What to expect

- We aim to **acknowledge** your report within a few business days.
- We will investigate, keep you updated on progress, and work on a fix.
- We follow **coordinated disclosure**: please give us a reasonable window to release a fix
  before any public disclosure. We're happy to credit you in the release notes unless you
  prefer to remain anonymous.

## Supported versions

Security fixes land on `main` and ship in the next `:stable` image and tagged release. There
are no backported releases for older tags: run a current `:stable`, and if you pin a version,
plan to move to the next one when a fix is announced.

Security notices appear in two places: the
[GitHub Security Advisories](https://github.com/Sapd/lumastra/security/advisories) for this
repository, and the [release notes](https://github.com/Sapd/lumastra/releases), where a security
release is marked `Security: yes`. Lumastra checks the releases once a day and shows a security
release to admins as a red notice until it is installed (Admin → Settings → General →
Diagnostics turns the check off). Anything an operator must act on is also posted in the
Announcements discussion category.

## Scope

Lumastra is self-hosted. Most deployments place the app behind a reverse proxy that
provides **forward authentication** (Authentik, Authelia, etc.); see
[`README.md`](../README.md) and the
[authentication guide](https://lumastra.org/guides/authentication/) for the trust model
(including `FORWARD_AUTH_ENABLED` and `TRUSTED_PROXY_IPS`). Reports about authentication bypass, identity
header trust, token handling, SSRF, injection, or data exposure are especially welcome.

Note that some components (the Jellyfin-compatible `/j` API and the AI assistant) are
proprietary and source-available. They are in scope for security reports just like the rest
of the codebase.

## Out of scope

- Vulnerabilities in third-party dependencies that are already publicly known and have an
  upstream fix (please update your dependencies first).
- Issues that require a misconfigured deployment contrary to the documented setup (e.g.
  exposing the app directly without forward auth in production).
