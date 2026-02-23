/**
 * ClickUp Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'clickup_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 30000): Promise<{ success: boolean; message: string; data?: unknown }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'ClickUp request timed out (30s)' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

/**
 * Create ClickUp integration MCP tools
 */
export function createClickUpTools(_ctx: SkillToolsContext) {
  return [
    tool(
      'clickup_list_tasks',
      `List tasks from the ClickUp workspace. Returns tasks filtered by status and optionally by assignee.

Use this to answer questions like:
- "What tasks are in progress?"
- "Show me all tasks assigned to me"
- "What's in the current sprint?"

Default statuses: to do, in progress, in review.`,
      {
        statuses: z
          .array(z.string())
          .optional()
          .describe('List of statuses to filter by (default: ["to do", "in progress", "in review"])'),
        assignee_id: z.string().optional().describe('ClickUp user ID to filter by assignee'),
        page: z.number().optional().describe('Page number for pagination (default: 0)'),
      },
      async (args: { statuses?: string[]; assignee_id?: string; page?: number }) => {
        const requestId = `clist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'clickup_list_tasks',
          requestId,
          ...args,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        if (!result.success) {
          return { content: [{ type: 'text', text: `ClickUp error: ${result.message}` }], isError: true };
        }

        const tasks = result.data as Array<{ id: string; name: string; status: string; assignees: string[] }>;
        if (!tasks.length) {
          return { content: [{ type: 'text', text: 'No tasks found matching the filters.' }] };
        }

        const lines = tasks.map((t) => `- [${t.id}] ${t.name} (${t.status})${t.assignees?.length ? ` — ${t.assignees.join(', ')}` : ''}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      },
    ),

    tool(
      'clickup_get_task',
      `Get full details for a specific ClickUp task by its ID.

Accepts both custom IDs (e.g. PROJ-13593) and internal ClickUp IDs.
Returns task name, status, description, assignees, and URL.`,
      {
        task_id: z.string().describe('Task ID in custom format (e.g. PROJ-13593) or internal ClickUp ID'),
      },
      async (args: { task_id: string }) => {
        const requestId = `cget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'clickup_get_task',
          requestId,
          task_id: args.task_id,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        if (!result.success) {
          return { content: [{ type: 'text', text: `ClickUp error: ${result.message}` }], isError: true };
        }

        const t = result.data as { id: string; name: string; status: string; description: string; assignees: string[]; url: string };
        const text = [
          `**[${t.id}] ${t.name}**`,
          `Status: ${t.status}`,
          `Assignees: ${t.assignees?.join(', ') || 'none'}`,
          `URL: ${t.url}`,
          t.description ? `\nDescription:\n${t.description.slice(0, 500)}${t.description.length > 500 ? '…' : ''}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        return { content: [{ type: 'text', text }] };
      },
    ),

    tool(
      'clickup_add_comment',
      `Add a comment to a ClickUp task.

Use this to post status updates, deployment notes, or any other information to a task.`,
      {
        task_id: z.string().describe('Task ID in custom format (e.g. PROJ-13593) or internal ClickUp ID'),
        comment_text: z.string().min(1).describe('The comment text to post'),
      },
      async (args: { task_id: string; comment_text: string }) => {
        const requestId = `ccomment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'clickup_add_comment',
          requestId,
          task_id: args.task_id,
          comment_text: args.comment_text,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        if (!result.success) {
          return { content: [{ type: 'text', text: `ClickUp error: ${result.message}` }], isError: true };
        }

        return { content: [{ type: 'text', text: `Comment added to ${args.task_id}.` }] };
      },
    ),

    tool(
      'clickup_update_status',
      `Update the status of a ClickUp task.

Common statuses: "to do", "in progress", "in review", "done".`,
      {
        task_id: z.string().describe('Task ID in custom format (e.g. PROJ-13593) or internal ClickUp ID'),
        status: z.string().describe('New status (e.g. "in progress", "in review", "done")'),
      },
      async (args: { task_id: string; status: string }) => {
        const requestId = `cstatus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        writeIpcFile(TASKS_DIR, {
          type: 'clickup_update_status',
          requestId,
          task_id: args.task_id,
          status: args.status,
          timestamp: new Date().toISOString(),
        });

        const result = await waitForResult(requestId);
        if (!result.success) {
          return { content: [{ type: 'text', text: `ClickUp error: ${result.message}` }], isError: true };
        }

        return { content: [{ type: 'text', text: `${args.task_id} status updated to "${args.status}".` }] };
      },
    ),
  ];
}
