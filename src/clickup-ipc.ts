/**
 * ClickUp Integration IPC Handler (host side)
 *
 * Handles clickup_* IPC messages from container agents and proxies
 * them to the ClickUp REST API v2. Result files are written back into
 * the group's IPC directory so the container agent can pick them up.
 */

import fs from 'fs';
import https from 'https';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface ClickUpResult {
  success: boolean;
  message: string;
  data?: unknown;
}

function getCredentials(): { apiKey: string | null; teamId: string | null } {
  const env = readEnvFile(['CLICKUP_API_KEY', 'CLICKUP_TEAM_ID']);
  return { apiKey: env.CLICKUP_API_KEY ?? null, teamId: env.CLICKUP_TEAM_ID ?? null };
}

function clickupRequest(method: string, apiPath: string, body?: object): Promise<ClickUpResult> {
  const { apiKey } = getCredentials();
  if (!apiKey) {
    return Promise.resolve({ success: false, message: 'CLICKUP_API_KEY not set in .env' });
  }

  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.clickup.com',
      path: `/api/v2${apiPath}`,
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
            resolve({ success: false, message: (parsed as { err?: string; error?: string }).err ?? (parsed as { err?: string; error?: string }).error ?? `HTTP ${res.statusCode}`, data: parsed });
          } else {
            resolve({ success: true, message: 'OK', data: parsed });
          }
        } catch {
          resolve({ success: false, message: `Failed to parse response: ${data.slice(0, 200)}` });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, message: (err as Error).message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function handleListTasks(data: Record<string, unknown>): Promise<ClickUpResult> {
  const { teamId } = getCredentials();
  if (!teamId) return { success: false, message: 'CLICKUP_TEAM_ID not set in .env' };
  const statuses = (data.statuses as string[]) ?? ['to do', 'in progress', 'in review'];
  const assigneeId = data.assignee_id as string | undefined;
  const page = (data.page as number) ?? 0;

  const params = new URLSearchParams({ page: String(page) });
  for (const s of statuses) params.append('statuses[]', s);
  if (assigneeId) params.append('assignees[]', assigneeId);

  const result = await clickupRequest('GET', `/team/${teamId}/task?${params.toString()}`);
  if (!result.success) return result;

  const tasks = ((result.data as { tasks?: unknown[] })?.tasks ?? []) as Array<Record<string, unknown>>;
  const summary = tasks.map((t) => ({
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

  const isCustomId = /^[A-Z]+-\d+$/.test(taskId);
  const { teamId } = getCredentials();
  if (!teamId) return { success: false, message: 'CLICKUP_TEAM_ID not set in .env' };
  const apiPath = isCustomId
    ? `/task/${taskId}?custom_task_ids=true&team_id=${teamId}`
    : `/task/${taskId}`;

  const result = await clickupRequest('GET', apiPath);
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

export async function handleClickupIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
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

  if (requestId) {
    const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'clickup_results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result, null, 2));
  }

  logger.debug({ type, requestId, success: result.success }, 'ClickUp IPC handled');
  return true;
}
