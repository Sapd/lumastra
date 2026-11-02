# Machine check

Run these on the machine Lumastra will run on and report each result to the person. The
commands are for Linux and macOS. On Windows, run them in WSL, or report what Docker
Desktop shows under Settings > Resources.

## Docker

```bash
docker --version          # 24 or newer
docker compose version    # 2.20 or newer
docker info --format '{{.ServerVersion}} {{.OSType}} {{.Architecture}}'
```

If `docker info` fails with a permission error, the user account is not in the `docker`
group. Tell the person. They either add the account to the group and log in again, or
prefix every `docker` command in the install with `sudo`.

If Docker is missing, ask before installing it. On Linux, Docker's instructions are at
https://docs.docker.com/engine/install/. On macOS and Windows, Docker Desktop includes
Compose.

## Memory

```bash
docker info --format '{{.MemTotal}}'    # bytes available to containers
```

This is the memory Docker can use. On Docker Desktop it is the VM's limit, which is
often lower than the computer's RAM. 8 GB (about 8000000000 bytes) is recommended for
the app, the background tasks, PostgreSQL and Valkey. The background tasks that scan and
analyze the library use most of it.

The example compose file sets `LUMASTRA_LOW_RAM_MODE: 'true'` on the `lumastra` service,
which caps the Node.js heap. Keep it if Docker has less than 8 GB. Below about 4 GB, warn
the person that only a small library will run. With 8 GB or more, the person can remove
that line.

## Disk

```bash
df -h "$(docker info --format '{{.DockerRootDir}}')" ~
```

The first line is where Docker keeps the database and cache volumes. It needs at least
20 GB free. Check the media folders separately with `df -h <folder>` if they are on
another disk. On Docker Desktop, the first path is inside the VM and `df` can't read it;
report the disk size shown in Docker Desktop instead.

## CPU

```bash
uname -m
grep -o -w 'sse4_2\|popcnt' /proc/cpuinfo | sort -u    # Linux on x86-64 only
```

- `x86_64`: the CPU needs x86-64-v2. The `grep` must print both `popcnt` and `sse4_2`.
  In a virtual machine, older emulated CPU models such as `qemu64` or `kvm64` can lack
  them. The fix is to set the VM's CPU model to `host-passthrough`, or to Nehalem or
  newer.
- `aarch64` or `arm64`: any 64-bit ARM CPU works. Tell the person that these features
  are not available on ARM: music BPM and mood analysis, the sound-similarity sidecar
  (the `sonic` compose profile), and Intel Quick Sync transcoding.
- 32-bit systems are not supported.

## Tools

```bash
command -v curl openssl
```

Both must print a path. `openssl` generates the secrets. Without it, use the fallback in
secrets-and-env.md.
