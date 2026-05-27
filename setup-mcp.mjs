#!/usr/bin/env node
/**
 * Turnkey installer for the WEF Handoff MCP — one command, no manual JSON editing.
 *
 * What it does:
 *   1. Resolves the absolute path to this repo's src/mcp-server.mjs
 *   2. Reads the bearer token (from --token, WEF_HANDOFF_TOKEN env, or a local
 *      .<user>-token.local file dropped next to this script)
 *   3. Registers the "wef-handoff" MCP server in Claude Code at user scope —
 *      first via the official `claude mcp add-json` CLI, falling back to a
 *      direct merge into ~/.claude.json if the CLI isn't on PATH.
 *   4. Backs up the existing config before any write.
 *
 * Usage (from inside the cloned repo, after `npm install`):
 *   node setup-mcp.mjs --user kori --token <TOKEN>
 *   # or, if you dropped .kori-token.local next to this file:
 *   node setup-mcp.mjs --user kori
 *
 * After it runs: restart Claude Code, then ask Claude to call handoff_inbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = 'https://wef-handoff.vercel.app';

// ─── Parse args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const user = arg('user', 'kori').toLowerCase();
const VALID = ['imani', 'teresa', 'kori'];
if (!VALID.includes(user)) {
  console.error(`✗ --user must be one of: ${VALID.join(', ')}  (got "${user}")`);
  process.exit(1);
}

// ─── Resolve token ─────────────────────────────────────────────────────────
let token = arg('token') || process.env.WEF_HANDOFF_TOKEN;
if (!token) {
  const tokenFile = path.join(__dirname, `.${user}-token.local`);
  if (fs.existsSync(tokenFile)) {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
    console.log(`• Token read from ${path.basename(tokenFile)}`);
  }
}
if (!token) {
  console.error('✗ No token. Pass --token <TOKEN>, set WEF_HANDOFF_TOKEN, or drop');
  console.error(`  a .${user}-token.local file next to this script.`);
  process.exit(1);
}

// ─── Resolve server path ─────────────────────────────────────────────────────
const serverPath = path.join(__dirname, 'src', 'mcp-server.mjs');
if (!fs.existsSync(serverPath)) {
  console.error(`✗ Cannot find ${serverPath} — run this from inside the cloned repo.`);
  process.exit(1);
}
// Confirm deps installed
const sdkPath = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk');
if (!fs.existsSync(sdkPath)) {
  console.error('✗ Dependencies not installed. Run `npm install` in this folder first.');
  process.exit(1);
}

const envBlock = {
  WEF_HANDOFF_BACKEND: BACKEND,
  WEF_HANDOFF_TOKEN: token,
  WEF_HANDOFF_USER: user,
};

// ─── Path 1: official `claude mcp add-json` ──────────────────────────────────
function tryClaudeCli() {
  const serverJson = JSON.stringify({
    command: 'node',
    args: [serverPath],
    env: envBlock,
  });
  // -s user = user scope (available across all projects)
  const cmd = `claude mcp add-json wef-handoff -s user ${JSON.stringify(serverJson)}`;
  execSync(cmd, { stdio: 'pipe' });
}

// ─── Path 2: direct merge into ~/.claude.json ────────────────────────────────
function directMerge() {
  const cfgPath = path.join(os.homedir(), '.claude.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // SAFETY: refuse to overwrite an existing wef-handoff entry registered to a
    // DIFFERENT user — that's how you accidentally clobber a teammate's own
    // working config. Require --force to proceed.
    const existing = cfg.mcpServers?.['wef-handoff']?.env?.WEF_HANDOFF_USER;
    if (existing && existing !== user && !args.includes('--force')) {
      throw new Error(
        `~/.claude.json already has wef-handoff registered as "${existing}". ` +
        `Refusing to overwrite with "${user}". If this really is ${user}'s machine, ` +
        `re-run with --force. (This guard exists because running --user ${user} on ` +
        `${existing}'s machine would break ${existing}'s handoff comms.)`
      );
    }
    fs.copyFileSync(cfgPath, `${cfgPath}.bak-${Date.now()}`);
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['wef-handoff'] = { type: 'stdio', command: 'node', args: [serverPath], env: envBlock };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfgPath;
}

console.log(`\n• Registering wef-handoff MCP for user "${user}"`);
console.log(`• Server: ${serverPath}`);
console.log(`• Backend: ${BACKEND}\n`);

try {
  tryClaudeCli();
  console.log('✓ Registered via `claude mcp add-json` (user scope).');
} catch (e) {
  console.log('• `claude` CLI not available or failed — falling back to direct config merge.');
  try {
    const cfgPath = directMerge();
    console.log(`✓ Merged wef-handoff into ${cfgPath} (backup written alongside).`);
  } catch (e2) {
    console.error(`✗ Both methods failed.\n  CLI error: ${e.message}\n  Merge error: ${e2.message}`);
    process.exit(1);
  }
}

console.log('\nNext steps:');
console.log('  1. Restart Claude Code (fully quit + reopen).');
console.log('  2. Ask Claude: "check my handoff inbox" — it should return a welcome message, not an auth error.');
console.log('  3. Reply: ask Claude to handoff_send to "imani" to confirm the round-trip.\n');
