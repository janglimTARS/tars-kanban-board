# TARS Kanban Board Deployment Guide

## Prerequisites
- Node.js and Wrangler CLI: `npm i -g wrangler`
- Cloudflare account
- Custom domain pointed to Cloudflare
- Cloudflare API token with Workers/KV edit perms (for wrangler auth: `wrangler auth login`)

## Setup
1. Login: `cd kanban-board &amp;&amp; wrangler auth login`
2. Create KV namespaces:
   ```
   wrangler kv:namespace create TASKS_KV
   wrangler kv:namespace create SUBAGENTS_KV
   ```
   Copy the [production] IDs into `wrangler.toml` (replace ~replace-with-...~)

3. Set secrets:
   ```
   wrangler secret put API_KEY
   ```
   Enter your desired API key (alphanumeric string).

4. (Optional) Update `OPENCLAW_API` var in wrangler.toml with actual OpenClaw API endpoint.

5. Deploy:
   ```
   wrangler deploy
   ```
   Note the URL: https://tars-kanban-board.youraccount.workers.dev

## Custom Domain
1. In Cloudflare Dashboard &gt; Workers &amp; Pages &gt; your-worker &gt; Triggers &gt; Add Custom Domain
2. Enter your domain/subdomain (e.g., kanban.yourdomain.com)
3. Ensure DNS: CNAME kanban.yourdomain.com -&gt; tars-kanban-board.youraccount.workers.dev
   Or for apex/root: use Cloudflare proxy.

## Usage
- Open the deployed URL
- Enter API Key (same as set in secret)
- Manage tasks, assign subagents, etc.

## OpenClaw Integration
- Update `OPENCLAW_API` to point to OpenClaw Gateway API.
- Assumed endpoints:
  - POST /spawn {taskId, instructions} -&gt; returns subagentId
  - POST /manage/{subagentId} {action: 'kill'}
- Webhook: POST /api/webhook {taskId, subagentId, status, log} (no auth needed, or add secret)

## Authentication
Currently API key based (Bearer token).
Frontend stores in localStorage.

To change: modify index.js auth checks.

## Updating
`wrangler deploy` after changes.

## Auth Alternatives
- Password: replace API key with hashed password check.
- JWT: implement login endpoint.
