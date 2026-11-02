# Lumastra skills for Claude Code

Agent skills that help an AI assistant install and run a Lumastra server.

| Skill                   | Use it for                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| `lumastra-install`      | A new install with Docker Compose, including the reverse proxy and HTTPS   |
| `lumastra-troubleshoot` | An install that misbehaves: health checks, proxy, secrets, sign-in, limits |

## Install

In Claude Code:

```text
/plugin marketplace add Sapd/lumastra
/plugin install lumastra-skills@lumastra
```

Then ask for what you want, for example "install Lumastra on this server" or "my
Lumastra login keeps failing". Claude loads the matching skill automatically. You can also
call one directly with `/lumastra-skills:lumastra-install` or
`/lumastra-skills:lumastra-troubleshoot`.

Other assistants can read the same instructions as plain Markdown. Start with
`skills/lumastra-install/SKILL.md` or `skills/lumastra-troubleshoot/SKILL.md`. For
installing, https://lumastra.org/install.md has the same flow in one file.

Lumastra's server plugin loader ignores this folder: it has no plugin entry point.
