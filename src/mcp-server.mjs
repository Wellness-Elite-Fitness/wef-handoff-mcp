#!/usr/bin/env node
/**
 * WEF Handoff MCP — direct Claude-to-Claude communication channel.
 *
 * Each user runs this as a local stdio MCP process. It exposes 4 tools to Claude:
 *   - handoff_send(to, subject, body, urgency?)  → send a message to teammate
 *   - handoff_inbox(unread_only?, since?, limit?) → list messages addressed to me
 *   - handoff_read(message_id)                    → read a specific message
 *   - handoff_ack(message_id)                     → mark a message read
 *
 * The MCP talks to a shared Vercel-hosted backend over HTTPS with a per-user bearer token.
 * Storage is Vercel KV (Redis), keyed by recipient + message id.
 *
 * Env vars (set in ~/.claude/mcp.json per user):
 *   WEF_HANDOFF_BACKEND   default: https://wef-handoff.vercel.app
 *   WEF_HANDOFF_TOKEN     required — your bearer token (each user's differs)
 *   WEF_HANDOFF_USER      required — "imani" | "teresa" | "kori"
 *
 * 2026-05-26 — first cut. Pair channel (imani <-> teresa).
 * 2026-05-27 — added kori (WEF manager, Team seat). Now a 3-party channel.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BACKEND = process.env.WEF_HANDOFF_BACKEND || 'https://wef-handoff.vercel.app';
const TOKEN = process.env.WEF_HANDOFF_TOKEN;
const USER = process.env.WEF_HANDOFF_USER;

if (!TOKEN || !USER) {
  console.error('FATAL: WEF_HANDOFF_TOKEN and WEF_HANDOFF_USER env vars required.');
  console.error('Configure them in ~/.claude/mcp.json under the "wef-handoff" server "env" block.');
  process.exit(1);
}

async function api(action, payload = {}) {
  const r = await fetch(`${BACKEND}/api/handoff`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${TOKEN}`,
      'x-wef-user': USER,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await r.json().catch(() => ({ error: 'invalid json from backend' }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const server = new Server(
  { name: 'wef-handoff', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'handoff_send',
      description: 'Send a direct message to your WEF teammate. Use when you have output, a question, or a decision request that the other person\'s Claude should pick up on their next session. Messages are persistent and auditable.',
      inputSchema: {
        type: 'object',
        required: ['to', 'subject', 'body'],
        properties: {
          to: { type: 'string', enum: ['imani', 'teresa', 'kori'], description: 'Recipient — "imani", "teresa", or "kori"' },
          subject: { type: 'string', description: 'One-line subject, ≤120 chars' },
          body: { type: 'string', description: 'Message body in markdown. Be specific; the recipient\'s Claude will summarize this on their next session.' },
          urgency: { type: 'string', enum: ['fyi', 'normal', 'urgent'], description: 'How soon the recipient should see this. "urgent" surfaces immediately on their next session start.' },
          ref: { type: 'string', description: 'Optional reference — commit SHA, file path, URL, or topic slug for cross-linking' },
        },
      },
    },
    {
      name: 'handoff_inbox',
      description: 'List messages addressed to you. By default returns unread messages from the last 7 days. Call this on every Claude Code session start to see what your teammate sent.',
      inputSchema: {
        type: 'object',
        properties: {
          unread_only: { type: 'boolean', description: 'If true (default), only return unread messages' },
          since: { type: 'string', description: 'ISO date — only return messages newer than this' },
          limit: { type: 'number', description: 'Max messages to return (default 20)' },
        },
      },
    },
    {
      name: 'handoff_read',
      description: 'Read a specific message by ID. Returns full body + metadata. Use after handoff_inbox to drill into a message.',
      inputSchema: {
        type: 'object',
        required: ['message_id'],
        properties: {
          message_id: { type: 'string', description: 'Message ID from handoff_inbox' },
        },
      },
    },
    {
      name: 'handoff_ack',
      description: 'Mark a message as read. Removes it from default inbox view. Call after the recipient (you, via the user) has actually seen / acted on the message.',
      inputSchema: {
        type: 'object',
        required: ['message_id'],
        properties: {
          message_id: { type: 'string' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'handoff_send') {
      const r = await api('send', { to: args.to, subject: args.subject, body: args.body, urgency: args.urgency || 'normal', ref: args.ref });
      return { content: [{ type: 'text', text: `✓ Sent to ${args.to}. Message ID: ${r.id}. They'll see it on their next handoff_inbox call.` }] };
    }
    if (name === 'handoff_inbox') {
      const r = await api('inbox', { unread_only: args.unread_only !== false, since: args.since, limit: args.limit || 20 });
      if (!r.messages?.length) return { content: [{ type: 'text', text: 'Inbox empty.' }] };
      const lines = r.messages.map(m =>
        `  [${m.read ? 'read  ' : 'UNREAD'}] ${m.id}  ${m.from}→${m.to}  ${m.urgency}  ${m.created_at}\n    ${m.subject}`
      );
      return { content: [{ type: 'text', text: `${r.messages.length} message(s):\n\n${lines.join('\n')}\n\nUse handoff_read(message_id) to view body.` }] };
    }
    if (name === 'handoff_read') {
      const r = await api('read', { message_id: args.message_id });
      const m = r.message;
      return { content: [{ type: 'text', text: `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nUrgency: ${m.urgency}\nSent: ${m.created_at}\nRef: ${m.ref || '(none)'}\nRead: ${m.read ? 'yes' : 'no'}\n\n${m.body}` }] };
    }
    if (name === 'handoff_ack') {
      await api('ack', { message_id: args.message_id });
      return { content: [{ type: 'text', text: `✓ Marked ${args.message_id} as read.` }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e.message || e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
