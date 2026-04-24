# wBOB bridge — systemd user units

Five user-level units that replace the tmux-session workflow:

| Unit | What |
|------|------|
| `wbob-backend.service`   | Fastify API on `PORT` (default `13013`) + all backend executors |
| `wbob-watcher1.service`  | Watcher signer 1 (`WATCHER_PRIVATE_KEY=$WATCHER_1_KEY`) |
| `wbob-watcher2.service`  | Watcher signer 2 (`$WATCHER_2_KEY`) |
| `wbob-watcher3.service`  | Watcher signer 3 (`$WATCHER_3_KEY`) |
| `wbob-portal.service`    | Next.js portal dev-mode on `:8888` |

## First-time install

```bash
# 1. Copy into user-systemd dir
mkdir -p ~/.config/systemd/user
cp ops/systemd/wbob-*.service ~/.config/systemd/user/

# 2. Enable lingering so services run without a login session (once per user)
sudo loginctl enable-linger "$(whoami)"

# 3. Reload + enable + start
systemctl --user daemon-reload
systemctl --user enable --now wbob-backend wbob-watcher1 wbob-watcher2 wbob-watcher3 wbob-portal
```

The units reference:
- `/home/btcbob/claude/wBOB/.env` (backend + watchers)
- `/home/btcbob/claude/wBOB/portal/.env` (portal)

Both gitignored; see `.env.example` and `portal/.env.example` for the required keys.

## Daily driving

```bash
# Status of everything
systemctl --user list-units 'wbob-*'

# Live-tail a service (replaces `tmux attach -t backend`)
journalctl --user -u wbob-backend -f

# All wbob services at once
journalctl --user -u 'wbob-*' -f

# Restart one
systemctl --user restart wbob-backend

# History
journalctl --user -u wbob-backend --since "1 hour ago"
```

## Per-machine customization

The `WorkingDirectory=` paths are hardcoded to `/home/btcbob/claude/wBOB/...`. For a
different operator / machine, edit the five unit files before `daemon-reload`.
Portal service uses `--port 8888 --hostname 0.0.0.0` — adjust if that conflicts.
