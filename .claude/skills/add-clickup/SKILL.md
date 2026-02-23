---
name: add-clickup
description: Add ClickUp integration to NanoClaw. Lets the agent list sprint tasks, get task details, post comments, and update task statuses. Triggers on "clickup", "tasks", "sprint", or asking about backlog.
---

# Add ClickUp Integration

This skill adds ClickUp REST API support to NanoClaw. The agent can query and update tasks in the Smith.ai ClickUp workspace directly from Slack.

## What This Enables

| Action | Tool | Example trigger |
|--------|------|----------------|
| List tasks | `clickup_list_tasks` | "What tasks are in progress?" |
| Get task details | `clickup_get_task` | "Get details for PROJ-13593" |
| Add comment | `clickup_add_comment` | "Add a comment to PROJ-123: Deployed to staging" |
| Update status | `clickup_update_status` | "Move PROJ-456 to in review" |

## Phase 1: Pre-flight

### Check environment

Verify `CLICKUP_API_KEY` is available:

```bash
grep CLICKUP_API_KEY .env 2>/dev/null || echo "Not set"
```

If not set, ask the user for their ClickUp personal API token (Settings → Apps → API Token).

## Phase 2: Apply Code Changes

### 1. Add environment variables to `.env`

```bash
CLICKUP_API_KEY=pk_...
CLICKUP_TEAM_ID=<your-team-id>
```

**How to find your team ID:**
1. Open ClickUp and click any task in your workspace
2. Look at the browser URL: `https://app.clickup.com/t/<team-id>/TASK-XXX` — the number after `/t/` is your team ID
3. Alternatively: Settings → Workspaces → the numeric ID shown under your workspace name
4. Or run: `curl -s -H "Authorization: $CLICKUP_API_KEY" https://api.clickup.com/api/v2/team | python3 -m json.tool` and read the `id` field

Also add to `.env.example` (without the real value):

```bash
# ClickUp integration
CLICKUP_API_KEY=
CLICKUP_TEAM_ID=
```

### 2. Update `src/ipc.ts`

Add import after other skill imports (or after the `cron-parser` import):

```typescript
import { handleClickupIpc } from '../.claude/skills/add-clickup/host.js';
```

In the `processTaskIpc` function, add a case before the `default`:

```typescript
case 'clickup_list_tasks':
case 'clickup_get_task':
case 'clickup_add_comment':
case 'clickup_update_status': {
  const handled = await handleClickupIpc(data, sourceGroup, isMain);
  if (!handled) logger.warn({ type: data.type }, 'Unhandled ClickUp IPC type');
  break;
}
```

### 3. Update `container/agent-runner/src/ipc-mcp.ts`

Add import after `cron-parser` import:

```typescript
// @ts-ignore - Copied during Docker build from .claude/skills/add-clickup/
import { createClickUpTools } from './skills/add-clickup/agent.js';
```

Add to the tools array (alongside any other skill tools):

```typescript
    ...createClickUpTools({ groupFolder, isMain })
```

### 4. Update `container/build.sh` (if not already done)

Ensure the build context is the project root so `.claude/skills/` is accessible:

```bash
# Find:
docker build -t "${IMAGE_NAME}:${TAG}" .

# Replace with:
cd "$SCRIPT_DIR/.."
docker build -t "${IMAGE_NAME}:${TAG}" -f container/Dockerfile .
```

### 5. Update `container/Dockerfile`

Add COPY line after `COPY container/agent-runner/ ./` and before `RUN npm run build`:

```dockerfile
# Copy ClickUp skill MCP tools
COPY .claude/skills/add-clickup/agent.ts ./src/skills/add-clickup/
```

### 6. Sync secrets to container data directory

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 3: Build and Restart

```bash
npm run build
./container/build.sh

# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux:
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test from your messaging channel

In your configured channel, trigger the assistant and ask:

```
what tasks are in progress?
get details for PROJ-123
add a comment to PROJ-123: Deployed to staging ✓
```

### Test API key directly

```bash
curl -s -H "Authorization: $CLICKUP_API_KEY" \
  "https://api.clickup.com/api/v2/team/$CLICKUP_TEAM_ID/task?statuses[]=in%20progress&page=0" \
  | python3 -m json.tool | head -40
```

Expected: JSON with `tasks` array.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLICKUP_API_KEY` | — | Personal API token (required). Settings → Apps → API Token |
| `CLICKUP_TEAM_ID` | — | Your ClickUp workspace/team ID (required). See Phase 2, step 1 |

## Security Notes

- `CLICKUP_API_KEY` must stay in `.env` and `data/env/env` only — never commit it
- The skill only allows: list tasks, get task, add comment, update status
- **No task deletion, no list/space deletion** — read + limited write only
- **Stripe and billing ClickUp lists are off-limits** — PinBot has no knowledge of financial data

## File Structure

```
.claude/skills/add-clickup/
├── SKILL.md      # This file
├── agent.ts      # MCP tool definitions (runs inside container)
└── host.ts       # IPC handler + ClickUp REST API calls (runs on host)
```

## Troubleshooting

### "CLICKUP_API_KEY not set"

Check `.env` has the key and it was synced to `data/env/env`:

```bash
grep CLICKUP_API_KEY data/env/env
```

If missing, re-sync:

```bash
cp .env data/env/env
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### "HTTP 401" from ClickUp

Token is invalid or expired. Generate a new one at ClickUp Settings → Apps → API Token.

### No tasks returned

Check the statuses you're filtering. ClickUp list-level statuses may differ from workspace defaults. Try:

```bash
curl -s -H "Authorization: $CLICKUP_API_KEY" \
  "https://api.clickup.com/api/v2/team/14295188/task?page=0" \
  | python3 -c "import sys,json; tasks=json.load(sys.stdin)['tasks']; print([t['status']['status'] for t in tasks[:5]])"
```

### Tool not found in container

Verify the Docker build copied the skill:

```bash
docker run nanoclaw-agent ls /app/src/skills/add-clickup/
```

If missing, rebuild with project root as context (see Phase 2, step 4).
