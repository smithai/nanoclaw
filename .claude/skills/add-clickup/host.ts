/**
 * ClickUp Integration IPC Handler
 *
 * Handles all clickup_* IPC messages from container agents.
 * Makes HTTP calls to the ClickUp REST API v2 on behalf of the agent.
 */

import https from 'https';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

interface ClickUpResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function getApiKey(): string | null {
  return process.env.CLICKUP_API_KEY ?? null;
}

function getTeamId(): string {
  const teamId = process.env.CLICKUP_TEAM_ID;
  if (!teamId) throw new Error('CLICKUP_TEAM_ID not set. See .claude/skills/add-clickup/SKILL.md for setup instructions.');
  return teamId;
}

function clickupRequest(method: string, path: string, body?: object): Promise<ClickUpResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return Promise.resolve({ success: false, message: 'CLICKUP_API_KEY not set in environment' });
  }

  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.clickup.com',
      path: `/api/v2${path}`,
      method,
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ success: false, message: parsed.err ?? parsed.error ?? `HTTP ${res.statusCode}`, data: parsed });
          } else {
            resolve({ success: true, message: 'OK', data: parsed });
          }
        } catch {
          resolve({ success: false, message: `Failed to parse response: ${data.slice(0, 200)}` });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, message: err.message }));

    if (payload) req.write(payload);
    req.end();
  });
}

// ────────────────────────────────────────────────
// IPC handlers
// ────────────────────────────────────────────────

async function handleListTasks(data: Record<string, unknown>): Promise<ClickUpResult> {
  const teamId = getTeamId();
  const statuses: string[] = (data.statuses as string[]) ?? ['to do', 'in progress', 'in review'];
  const assigneeId = data.assignee_id as string | undefined;
  const page = (data.page as number) ?? 0;

  const params = new URLSearchParams({ page: String(page) });
  for (const s of statuses) params.append('statuses[]', s);
  if (assigneeId) params.append('assignees[]', assigneeId);

  const result = await clickupRequest('GET', `/team/${teamId}/task?${params.toString()}`);
  if (!result.success) return result;

  const tasks = (result.data as { tasks?: unknown[] })?.tasks ?? [];
  const summary = (tasks as Array<Record<string, unknown>>).map((t) => ({
    id: t.custom_id ?? t.id,
    name: t.name,
    status: (t.status as Record<string, unknown>)?.status,
    assignees: (t.assignees as Array<Record<string, unknown>>)?.map((a) => a.username),
  }));

  return { success: true, message: `Found ${summary.length} tasks`, data: summary };
}

async function handleGetTask(data: Record<string, unknown>): Promise<ClickUpResult> {
  const taskId = data.task_id as string;
  if (!taskId) return { success: false, message: 'task_id is required' };

  // Support both custom IDs (PROJ-123) and internal IDs
  const isCustomId = /^[A-Z]+-\d+$/.test(taskId);
  const teamId = getTeamId();
  const path = isCustomId
    ? `/task/${taskId}?custom_task_ids=true&team_id=${teamId}`
    : `/task/${taskId}`;

  const result = await clickupRequest('GET', path);
  if (!result.success) return result;

  const t = result.data as Record<string, unknown>;
  return {
    success: true,
    message: 'OK',
    data: {
      id: t.custom_id ?? t.id,
      name: t.name,
      status: (t.status as Record<string, unknown>)?.status,
      description: t.text_content,
      assignees: (t.assignees as Array<Record<string, unknown>>)?.map((a) => a.username),
      url: t.url,
    },
  };
}

async function handleAddComment(data: Record<string, unknown>): Promise<ClickUpResult> {
  const taskId = data.task_id as string;
  const commentText = data.comment_text as string;
  if (!taskId || !commentText) return { success: false, message: 'task_id and comment_text are required' };

  return clickupRequest('POST', `/task/${taskId}/comment`, {
    comment_text: commentText,
    notify_all: false,
  });
}

async function handleUpdateStatus(data: Record<string, unknown>): Promise<ClickUpResult> {
  const taskId = data.task_id as string;
  const status = data.status as string;
  if (!taskId || !status) return { success: false, message: 'task_id and status are required' };

  return clickupRequest('PUT', `/task/${taskId}`, { status });
}

// ────────────────────────────────────────────────
// Entry point — called from src/ipc.ts
// ────────────────────────────────────────────────

export async function handleClickupIpc(
  data: Record<string, unknown>,
  _sourceGroup: string,
  _isMain: boolean,
): Promise<boolean> {
  const type = data.type as string;
  if (!type?.startsWith('clickup_')) return false;

  const requestId = data.requestId as string;
  let result: ClickUpResult;

  logger.debug({ type, requestId }, 'ClickUp IPC received');

  try {
    switch (type) {
      case 'clickup_list_tasks':
        result = await handleListTasks(data);
        break;
      case 'clickup_get_task':
        result = await handleGetTask(data);
        break;
      case 'clickup_add_comment':
        result = await handleAddComment(data);
        break;
      case 'clickup_update_status':
        result = await handleUpdateStatus(data);
        break;
      default:
        return false;
    }
  } catch (err) {
    result = { success: false, message: String(err) };
  }

  // Write result file for the agent to pick up
  if (requestId) {
    const fs = await import('fs');
    const path = await import('path');
    const { DATA_DIR } = await import('./config.js');
    const resultsDir = path.join(DATA_DIR, 'ipc', _sourceGroup, 'clickup_results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result, null, 2));
  }

  logger.debug({ type, requestId, success: result.success }, 'ClickUp IPC handled');
  return true;
}
