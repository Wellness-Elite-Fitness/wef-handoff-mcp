#!/usr/bin/env node
/**
 * WEF Handoff Auto-Responder — Imani's Claude answers Teresa + Kori autonomously
 * when Imani is away from the terminal.
 *
 * How "away" is detected: a message is only auto-answered once it has sat UNREAD
 * for longer than STALE_MINUTES (5). If Imani is actively working he picks it up and
 * acks it first; if it's still unread after the window, he's away and the bot steps in.
 * Poll cadence (Task Scheduler) is matched to 5 min so the window is meaningful.
 *
 * Engine: headless `claude -p` in the wef-web-2026 repo with READ-ONLY tools. This
 * gives Teresa/Kori Imani's fully-loaded Claude (repo access + global/project
 * CLAUDE.md = brand canon, pricing canon, banned terms, partner trust ladder,
 * no-PHI) — but it physically cannot edit, commit, deploy, send, or spend. Anything
 * that needs an action is answered with the analysis + "Imani must execute X".
 *
 * Company parameters are gently enforced: the responder guides Teresa/Kori toward
 * the right path, cites the canon, and escalates changes to Imani rather than
 * refusing coldly.
 *
 * Usage:
 *   node auto-responder.mjs --dry-run     # show what it WOULD answer, send nothing
 *   node auto-responder.mjs               # live: answer + send + ack
 *
 * Wire to Task Scheduler every ~15-20 min on Imani's machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BACKEND = 'https://wef-handoff.vercel.app';
const ASKERS = ['teresa', 'kori'];
const STALE_MINUTES = 5;             // proxy for "Imani is away from the terminal"
const MODEL = 'claude-sonnet-4-6';   // cost-discipline default; capable for Q&A
const ALLOWED_TOOLS = 'Read,Grep,Glob,WebFetch,WebSearch';
const REPO = 'C:/Users/lower/OneDrive/Documents/Coding Projects/wef-web-2026';
const ADD_DIRS = [
  'C:/Users/lower/OneDrive/Documents/Coding Projects/wef-agency',
  'C:/Users/lower/OneDrive/Documents/Coding Projects/WEF-kiosk',
];
const LOG_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'logs');
const DRY = process.argv.includes('--dry-run');

// ─── Imani's bearer token (single source of truth: his ~/.claude.json) ──────
function imaniToken() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const env = cfg.mcpServers?.['wef-handoff']?.env;
  if (env?.WEF_HANDOFF_USER !== 'imani' || !env?.WEF_HANDOFF_TOKEN) {
    throw new Error('Could not read imani wef-handoff token from ~/.claude.json');
  }
  return env.WEF_HANDOFF_TOKEN;
}

async function api(token, action, payload = {}) {
  const r = await fetch(`${BACKEND}/api/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-wef-user': 'imani' },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await r.json().catch(() => ({ error: 'bad json' }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const ROLE = { teresa: 'Ariva & Co partner (read-only access stage per the trust ladder)', kori: 'WEF manager' };

function buildPrompt(msg) {
  const who = msg.from;
  return [
    `You are Imani's Claude Code, answering an async message on Imani's behalf while Imani is away from the terminal.`,
    `The sender is ${who} — ${ROLE[who] || 'WEF teammate'}. They cannot see your tools or your repo; they only get your final written reply.`,
    ``,
    `THEIR MESSAGE:`,
    `Subject: ${msg.subject}`,
    `Body:\n${msg.body}`,
    ``,
    `HOW TO ANSWER:`,
    `- Answer fully, accurately, and concisely using the WEF codebase + your knowledge. This is the real value: they get Imani's fully-loaded Claude.`,
    `- You are READ-ONLY. You cannot edit, commit, deploy, send, or commit capital. If the answer requires any such action, give the complete analysis + the exact steps, then state plainly: "This needs Imani to execute — flagged for him." Do NOT pretend you did it.`,
    `- GENTLY ENFORCE Imani's company parameters (they are in your loaded CLAUDE.md): the Five-Token brand lock, the pricing canon, the banned terms (never "medical-grade"/"physician-led"/urgency tactics), the no-PHI rule, name-only references to Imani, and the partner trust ladder. If ${who} is heading somewhere off-parameter, don't refuse coldly — guide them: cite the canon, explain the why in one line, and point to the compliant path. If it's a change to brand/pricing/main/strategy, note it's Imani's call and you've flagged it.`,
    `- Never expose secrets, tokens, or credentials.`,
    `- Keep WEF voice: clear, calm, premium. No hype.`,
    `- End with exactly this line on its own: "— Auto-answered by Imani's Claude while Imani was away. Flag if you need Imani directly."`,
  ].join('\n');
}

function runClaude(prompt) {
  const args = ['-p', prompt, '--model', MODEL, '--allowedTools', ALLOWED_TOOLS];
  for (const d of ADD_DIRS) args.push('--add-dir', d);
  return execFileSync('claude', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 240000 }).trim();
}

function log(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const f = path.join(LOG_DIR, `auto-responder-${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
const token = imaniToken();
const { messages = [] } = await api(token, 'inbox', { unread_only: true, limit: 50 });
const now = Date.now();
const cutoff = STALE_MINUTES * 60 * 1000;

const targets = messages.filter(
  (m) => ASKERS.includes(m.from) && now - new Date(m.created_at).getTime() >= cutoff
);

console.log(`[auto-responder] ${DRY ? 'DRY-RUN · ' : ''}inbox=${messages.length} eligible=${targets.length} (from teresa/kori, unread >${STALE_MINUTES}m)`);

for (const msg of targets) {
  const ageMin = Math.round((now - new Date(msg.created_at).getTime()) / 60000);
  console.log(`\n→ ${msg.from} (${ageMin}m old): ${msg.subject}`);
  let answer;
  try {
    answer = runClaude(buildPrompt(msg));
  } catch (e) {
    console.error(`  ✗ claude run failed: ${e.message}`);
    log({ event: 'answer_failed', id: msg.id, from: msg.from, error: e.message });
    continue;
  }
  if (DRY) {
    console.log(`  [would reply]\n${answer.split('\n').map((l) => '    ' + l).join('\n')}`);
    log({ event: 'dry_run_answer', id: msg.id, from: msg.from, subject: msg.subject, answer_preview: answer.slice(0, 400) });
    continue;
  }
  await api(token, 'send', { to: msg.from, subject: `Re: ${msg.subject}`.slice(0, 200), body: answer, urgency: 'normal', ref: msg.id });
  await api(token, 'ack', { message_id: msg.id });
  console.log(`  ✓ replied + acked`);
  log({ event: 'answered', id: msg.id, from: msg.from, subject: msg.subject, answer_len: answer.length });
}

console.log(`\n[auto-responder] done.${DRY ? ' (dry-run — nothing sent)' : ''}`);
