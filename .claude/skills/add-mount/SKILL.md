---
name: add-mount
description: Add a host directory as a mount accessible to NanoClaw agent containers. Use when the user wants to give agents access to a local directory, mount a folder, share files with the container, or make a project/repo visible to NanoClaw. Triggers on "mount", "add directory", "share folder", "give access to", "make visible to agents".
---

# Add Mount Directory

This skill adds a host directory so NanoClaw agent containers can read (and optionally write) it. Two things need to happen:

1. The directory must be **allowed** in the mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`)
2. The directory must be **assigned** to one or more groups via `containerConfig.additionalMounts` in the database

The container will see the directory at `/workspace/extra/<basename>`.

## Workflow

### 1. Gather info

Ask the user:
- **Path**: Which directory? (accept `~` shorthand)
- **Read-write**: Should agents be able to write to it? (default: read-only for safety)
- **Groups**: Which groups should get access? (default: all groups)

### 2. Update the allowlist

The allowlist lives at `~/.config/nanoclaw/mount-allowlist.json` and is **not** mounted into containers (tamper-proof).

Read the file, then add an entry to `allowedRoots` if not already present:

```json
{ "path": "~/the/directory", "allowReadWrite": true }
```

Each entry must be an `AllowedRoot` object with `path` (string) and `allowReadWrite` (boolean). Plain strings are **not** valid — they cause a TypeError at runtime.

If the path is already in `allowedRoots`, just confirm and update `allowReadWrite` if needed.

### 3. Add to group containerConfig

The groups are stored in the SQLite database at `store/messages.db`, table `registered_groups`, column `container_config` (JSON string).

For each target group, read the current `container_config`, add the new `hostPath` entry to `additionalMounts` if not already present, and update the row:

```sql
-- Read current config
SELECT jid, container_config FROM registered_groups;

-- Update (replace <JID> and <NEW_JSON>)
UPDATE registered_groups SET container_config = '<NEW_JSON>' WHERE jid = '<JID>';
```

The `additionalMounts` array entries look like: `{"hostPath": "~/the/directory"}`

`containerPath` is optional — if omitted, the basename is used automatically and mounted at `/workspace/extra/<basename>`.

### 4. Restart

The allowlist is cached in memory at process startup, so a restart is required:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or: systemctl --user restart nanoclaw            # Linux
```

### 5. Verify

After restart, confirm the mount appears in logs or works by checking the next container run. You can also verify the allowlist and DB state:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
sqlite3 store/messages.db "SELECT jid, container_config FROM registered_groups;"
```

## Important Notes

- The allowlist uses `AllowedRoot` objects (`{ "path": "...", "allowReadWrite": bool }`), never plain strings
- `nonMainReadOnly: true` in the allowlist forces non-main groups to read-only regardless of `allowReadWrite`
- Blocked patterns (`.ssh`, `.gnupg`, `.env`, etc.) are always enforced — don't try to mount sensitive directories
- The directory must exist on the host at mount time, or the container will fail to start
