# Connect your app to Grok Proxy

**For:** any app project on another computer  
**What this is:** a home-server API that talks to **Super Grok** so your app can use chat, image understanding, and web search **without** putting an xAI API key in the app.

---

## 0. Paste this to your coding agent

```text
Read docs/CLIENT_APP_GUIDE.md in the grok-proxy repo completely.

You are wiring THIS app to a home grok-proxy. Do not invent a different AI provider unless the proxy is unreachable.

Do this in order:
1. Read the whole guide, especially the API contract and checklist.
2. From this machine, verify the proxy:
     curl -sS http://YOUR_PROXY_IP:YOUR_PROXY_PORT/health
   If health fails, stop and report the error. Do not fake success.
3. Add env config:
     GROK_PROXY_URL=http://YOUR_PROXY_IP:YOUR_PROXY_PORT
     AI_PROVIDER=grok
     AI_MAX_TURNS=4
   Use .env.local (or this project's usual env file) and ensure it is gitignored.
4. Implement a small client helper (e.g. src/lib/grokProxy.ts) with askAi() and checkProxyHealth() as in the guide. Use fetch + POST /query JSON — not a public xAI API key.
5. Wire at least one real UI/feature to askAi() with provider "grok".
6. Optionally add a cheap path with provider "local-qwen" for drafts.
7. Surface errors in the UI; in dev, log usage / durationMs / totalCostUsd when present.
8. Update the project README with one short section: AI goes through home grok-proxy.
9. When done, summarize what you changed (files + how to test) and run a real health check from this machine.

Rules:
- No Super Grok password or auth.json in the app.
- No exposing or changing home server ports.
- Prefer short prompts and maxTurns=1 for simple tests.
```

---

## 1. Big picture

```
┌──────────────────────────┐     Wi-Fi / LAN      ┌─────────────────────────┐
│  Your computer           │ ───────────────────→ │  Home Docker server     │
│  App + coding agent      │   HTTP port 8084     │  grok-proxy container   │
│  (this machine)          │                      │  + Super Grok login     │
└──────────────────────────┘                      └───────────┬─────────────┘
                                                              │
                                                              ▼
                                                      Grok Build CLI
                                                      (membership / quota)
```

| Thing | Value |
|--------|--------|
| **Base URL** | `http://YOUR_PROXY_IP:YOUR_PROXY_PORT` |
| **Health check** | `GET http://YOUR_PROXY_IP:YOUR_PROXY_PORT/health` |
| **Main API** | `POST http://YOUR_PROXY_IP:YOUR_PROXY_PORT/query` |
| **Providers tip** | `GET http://YOUR_PROXY_IP:YOUR_PROXY_PORT/providers` |
| **Who pays** | Super Grok membership on the **server** (not a card in your app) |
| **Network** | Your PC must be on the **same home Wi-Fi / LAN / VPN** as the server |

There is also a **free** path for simple work:

| Provider | When to use | Cost |
|----------|-------------|------|
| `grok` (default) | Web search, harder reasoning, best quality | Membership quota |
| `local-qwen` | Drafts, short summaries, cheap trials | Free (home GPU) |

**Rule of thumb:** try `local-qwen` first for drafts; use `grok` when you need quality or web search.

---

## 2. Quick test from this computer

```bash
# Is the server up?
curl -sS http://YOUR_PROXY_IP:YOUR_PROXY_PORT/health

# Simple Grok call
curl -sS http://YOUR_PROXY_IP:YOUR_PROXY_PORT/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello in one short sentence.","maxTurns":1}'

# Free local model (only if the server owner configured one)
curl -sS http://YOUR_PROXY_IP:YOUR_PROXY_PORT/query \
  -H "Content-Type: application/json" \
  -d '{"provider":"local-qwen","prompt":"Summarize in 5 words: the sky is blue."}'
```

---

## 3. API contract

This is **not** the public xAI cloud API. It is a simple home proxy.

### `POST /query`

```json
{
  "prompt": "Your instruction to the model. Required.",
  "provider": "grok",
  "sessionId": null,
  "imagePath": null,
  "tools": null,
  "model": null,
  "maxTurns": 4
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | **Yes** | Full text instruction. |
| `provider` | No | `"grok"` (default) or `"local-qwen"` / `"local"` / `"qwen"` |
| `sessionId` | No | Resume a previous conversation |
| `imagePath` | No | Path **on the server** under its data folder (advanced) |
| `tools` | No | Tool allowlist for Grok, e.g. `"web_search,web_fetch"` |
| `model` | No | Optional model id override |
| `maxTurns` | No | Cap agent steps (default from server env) |

### Other endpoints

```http
GET /health      → is the proxy alive?
GET /providers   → short tip: grok vs local-qwen
```

---

## 4. Recommended client helper (TypeScript / JavaScript)

```ts
// src/lib/grokProxy.ts
const BASE_URL = process.env.GROK_PROXY_URL || "http://YOUR_PROXY_IP:YOUR_PROXY_PORT";

export type AiProvider = "grok" | "local-qwen" | "local" | "qwen";

export type GrokProxyRequest = {
  prompt: string;
  provider?: AiProvider;
  sessionId?: string | null;
  maxTurns?: number;
  tools?: string | null;
  model?: string | null;
};

export type GrokProxyResponse = {
  success: boolean;
  response?: string;
  error?: string;
  durationMs?: number;
  requestId?: string;
  sessionId?: string | null;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  totalCostUsd?: number | null;
};

export async function askAi(req: GrokProxyRequest): Promise<GrokProxyResponse> {
  const res = await fetch(`${BASE_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: req.prompt,
      provider: req.provider || process.env.AI_PROVIDER || "grok",
      sessionId: req.sessionId ?? null,
      maxTurns: req.maxTurns ?? Number(process.env.AI_MAX_TURNS || 4),
      tools: req.tools ?? null,
      model: req.model ?? null,
    }),
  });
  const data = (await res.json()) as GrokProxyResponse;
  if (!res.ok || !data.success) {
    throw new Error(data.error || `Grok proxy HTTP ${res.status}`);
  }
  return data;
}

export async function checkProxyHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { method: "GET" });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === "ok";
  } catch {
    return false;
  }
}
```

---

## 5. Checklist for your agent

- [ ] Confirm LAN: `curl http://YOUR_PROXY_IP:YOUR_PROXY_PORT/health` works from this computer
- [ ] Add `GROK_PROXY_URL` (and optional `AI_PROVIDER`, `AI_MAX_TURNS`) to env
- [ ] Add client helper `askAi()` / `checkProxyHealth()`
- [ ] Wire one real screen/feature to call `askAi` with `provider: "grok"`
- [ ] Wire one cheap path with `provider: "local-qwen"` if local AI is available
- [ ] Surface errors to the UI (`success: false` / thrown Error)
- [ ] Log or show `usage` / `durationMs` in dev
- [ ] Do **not** put Super Grok passwords or `auth.json` in the app
- [ ] Document in the project README: “AI goes through home grok-proxy”

---

## 6. Performance & quota tips

1. **Short prompts** when possible — less tokens, faster, cheaper.
2. **`maxTurns: 1`** for simple answers; raise only when tools/search are needed.
3. **`local-qwen`** for drafts, rewrites, brainstorming.
4. **`grok`** for final copy, web search, harder judgment.
5. Read **`usage`** and **`totalCostUsd`** after calls — that is how you learn quota.

---

## 7. Security notes

- The proxy is on the **home network**. Do not expose its port to the public internet.
- Your app does **not** need the Super Grok password.
- Anyone on the same LAN who knows the URL could call the proxy — treat your LAN as trusted.
- Never commit `.env` files with secrets.

---

## 8. One-liner for your app README

> Integrate AI through a home **grok-proxy** at `http://YOUR_PROXY_IP:YOUR_PROXY_PORT`.  
> Use `POST /query` with JSON `{ prompt, provider?, maxTurns?, sessionId?, tools? }`.  
> Default provider `grok` (Super Grok membership on the server). Optional `local-qwen` for free drafts.  
> No xAI API key in the app.
