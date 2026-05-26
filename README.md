# WEF Handoff MCP

Direct Claude-to-Claude communication channel for **Imani × Teresa (Ariva & Co)**.

A small MCP server + Vercel backend that lets each user's Claude Code dispatch messages mid-session that the other's Claude picks up on its next session.

## Architecture

```
Imani's Claude Code            Teresa's Claude Code
        │                              │
        ▼                              ▼
  ┌──────────────┐              ┌──────────────┐
  │ wef-handoff  │              │ wef-handoff  │
  │  stdio MCP   │              │  stdio MCP   │
  │ (this repo)  │              │ (this repo)  │
  └──────┬───────┘              └──────┬───────┘
         │  HTTPS + bearer            │
         └──────────┬──────────────────┘
                    ▼
         ┌──────────────────────┐
         │   Vercel function    │
         │   /api/handoff       │
         └──────────┬───────────┘
                    ▼
              ┌─────────────┐
              │  Vercel KV  │
              │   (Redis)   │
              └─────────────┘
```

## Tools exposed to Claude

| Tool | Purpose |
|---|---|
| `handoff_send` | Send a message to your teammate |
| `handoff_inbox` | List messages addressed to you |
| `handoff_read` | Read full body of a specific message |
| `handoff_ack` | Mark a message as read |

## Setup (per user)

1. Clone this repo locally:
   ```
   git clone https://github.com/Wellness-Elite-Fitness/wef-handoff-mcp.git
   cd wef-handoff-mcp
   npm install
   ```

2. Add to `~/.claude/mcp.json`:

   **Imani's:**
   ```json
   {
     "mcpServers": {
       "wef-handoff": {
         "command": "node",
         "args": ["C:\\Users\\lower\\OneDrive\\Documents\\Coding Projects\\wef-handoff-mcp\\src\\mcp-server.mjs"],
         "env": {
           "WEF_HANDOFF_USER": "imani",
           "WEF_HANDOFF_TOKEN": "<IMANI_TOKEN>",
           "WEF_HANDOFF_BACKEND": "https://wef-handoff.vercel.app"
         }
       }
     }
   }
   ```

   **Teresa's:**
   ```json
   {
     "mcpServers": {
       "wef-handoff": {
         "command": "node",
         "args": ["<absolute-path-to-cloned-repo>/src/mcp-server.mjs"],
         "env": {
           "WEF_HANDOFF_USER": "teresa",
           "WEF_HANDOFF_TOKEN": "<TERESA_TOKEN>",
           "WEF_HANDOFF_BACKEND": "https://wef-handoff.vercel.app"
         }
       }
     }
   }
   ```

   Tokens are managed by Imani in Vercel env (`WEF_HANDOFF_TOKEN_IMANI` + `WEF_HANDOFF_TOKEN_TERESA`).

3. Restart Claude Code. Verify the MCP loaded by running `/mcp` (it should list `wef-handoff` with 4 tools).

## Usage in Claude Code

After the MCP is connected, just talk to Claude normally:

- "Send Teresa a handoff: 'Cryo CLS fix is live on commit 78759ae — pls verify before EOD'"
- "Check my handoff inbox"
- "Read handoff 7b3a..."
- "Mark that as read"

Claude picks up which tool to call.

## Deployment

```
vercel deploy --prod
```

Env vars required on Vercel:
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — auto-populated when Vercel KV is linked
- `WEF_HANDOFF_TOKEN_IMANI` — long random string, given only to Imani's local MCP env
- `WEF_HANDOFF_TOKEN_TERESA` — long random string, given only to Teresa's local MCP env

## Limits (first cut)

- Pair channel only (imani <-> teresa). Group channels not supported.
- 50KB body max per message. Use the Drive folder for larger payloads; reference by Drive ID via the `ref` field.
- No attachments (use Drive + `ref`).
- No push — recipient's Claude sees messages on next `handoff_inbox` call (typically session start).
- No real-time. Polling-on-demand only.

## Roadmap (post-MVP)

- Group channels (project-scoped)
- Attachment uploads (S3 pre-signed URLs)
- Webhook → push to Teams/Slack/Klaviyo
- Conversation threading (reply chains)
- Audit log export
