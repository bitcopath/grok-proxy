# Grok Proxy

Turn your **Grok Build CLI** (Super Grok) membership into a simple HTTP API on your home network.

Any app, script, or AI coder agent on the same Wi-Fi can send a prompt and get a response — no xAI API key in the app, no cloud billing surprises.

```
┌─────────────┐   HTTP (LAN)   ┌─────────────┐   CLI   ┌─────────────┐
│  Your app   │ ─────────────→ │  grok-proxy │ ──────→ │ Grok Build  │
│  / agent    │                │  (Docker)   │         │  Super Grok │
└─────────────┘                └─────────────┘         └─────────────┘
            │
            │ optional fallback
            ▼
   ┌─────────────────┐
   │ local model API │  (free drafts)
   └─────────────────┘
```

## What you need

- A computer/server that stays on (a mini-PC, old laptop, NAS, etc.).
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose installed.
- A **Grok Build CLI** account with an active **Super Grok** membership.
- Both devices on the same network (or VPN).
- Optional: a local OpenAI-compatible model endpoint (e.g. llama.cpp, Ollama) for free drafts.

> **Not a Grok user?** This same pattern works for Claude Code, Codex, Kimi, or any CLI that accepts a prompt. See [bitcopath/kimi-proxy](https://github.com/bitcopath/kimi-proxy) for the Kimi version.

---

## Easiest setup: paste this to your AI coder

Copy the block below and paste it into **Claude Code**, **Kimi**, **Grok Build**, or any coding agent:

```text
Set up the repo https://github.com/bitcopath/grok-proxy on my Docker server.

Steps:
1. Clone it.
2. Copy .env.example to .env and ask me for the correct HOST_GROK_PATH and SERVER_PORT.
3. Build and start with docker compose up -d.
4. Open Portainer (or ssh into the server), enter the grok-proxy container console, and run `grok login --device-auth` so I can authenticate.
5. Test with: curl http://THIS_SERVER_IP:SERVER_PORT/health
6. Report the working URL.
```

---

## Manual setup

### 1. Clone the repo

```bash
git clone https://github.com/bitcopath/grok-proxy.git
cd grok-proxy
```

### 2. Copy the example environment file

```bash
cp .env.example .env
```

### 3. Edit `.env`

The only value you really need is `HOST_GROK_PATH`.

| Variable | What to put | Example |
|----------|-------------|---------|
| `SERVER_PORT` | Free port on your server. | `8084` |
| `HOST_GROK_PATH` | Where Grok Build stores your login on the server. | `/home/yourname/.grok` |
| `GROK_TIMEOUT_MS` | How long one call can run. | `300000` (5 min) |
| `GROK_MAX_TURNS` | Max tool/agent steps per request. | `8` |
| `GROK_PERMISSION_MODE` | Keep `bypassPermissions` for headless runs. | `bypassPermissions` |
| `LOCAL_AI_BASE_URL` | Optional free local model. | `http://your-pc:8080/v1` |
| `LOG_LEVEL` | How chatty the logs are. | `info` |
| `LOG_SENSITIVE` | Set to `true` only while debugging. | `false` |

**How to find `HOST_GROK_PATH`:**

```bash
# On the Docker server, run:
ls -la ~/.grok
# Use that full path in .env
```

### 4. Start the container

```bash
docker compose up -d --build
```

### 5. Log in to Grok inside the container

The container has the Grok CLI installed, but **you** must authenticate it once. The easiest way is through **Portainer**:

1. Install [Portainer CE](https://docs.portainer.io/start/install) (free web UI for Docker).
2. Open Portainer → **Containers** → click `grok-proxy`.
3. Click **Console** → **Connect**.
4. Run `grok login --device-auth` and follow the browser steps.

See [docs/PORTAINER_SETUP.md](docs/PORTAINER_SETUP.md) for screenshots.

> Alternative: `docker exec -it grok-proxy bash` then `grok login --device-auth`.

### 6. Test

Find your server IP (usually in your router admin or with `ip addr` on Linux).

```bash
curl http://YOUR_SERVER_IP:8084/health
```

You should get `{"status":"ok"}`.

```bash
curl -sS http://YOUR_SERVER_IP:8084/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello in one short sentence.","maxTurns":1}'
```

---

## API

### `POST /query`

```json
{
  "prompt": "Explain Docker in one paragraph.",
  "provider": "grok",
  "sessionId": "optional-resume-id",
  "tools": "web_search,web_fetch",
  "maxTurns": 4,
  "model": "optional-model-id"
}
```

Response:

```json
{
  "success": true,
  "response": "Docker is...",
  "durationMs": 3200,
  "requestId": "req_...",
  "sessionId": "optional-resume-id",
  "provider": "grok",
  "usage": { "input_tokens": 100, "output_tokens": 50, "total_tokens": 150 },
  "totalCostUsd": 0.007
}
```

**Providers:**

| `provider` | Backend | Cost |
|------------|---------|------|
| `grok` (default) | Grok Build CLI | Super Grok quota |
| `local-qwen` / `local` / `qwen` | OpenAI-compatible local endpoint | Free |

### `GET /health`

Returns `{"status":"ok"}` when the proxy is alive.

### `GET /providers`

Returns a human-readable tip about when to use Grok vs local model.

---

## Use it from your app

```javascript
const res = await fetch('http://YOUR_SERVER_IP:8084/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Write a todo list for today.',
    maxTurns: 1
  })
});
const data = await res.json();
console.log(data.response);
```

See [docs/CLIENT_APP_GUIDE.md](docs/CLIENT_APP_GUIDE.md) for a full client helper, env vars, and TypeScript example.

---

## Security notes

- Keep this on your home network or VPN. Do not expose the port to the public internet.
- `GROK_PERMISSION_MODE=bypassPermissions` lets Grok run tools headlessly. Only use this on a trusted LAN.
- Your Grok auth lives only in the mounted host path (`HOST_GROK_PATH`), not in the repo.
- `LOG_SENSITIVE=false` by default so prompts and responses are not written to disk.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot connect` from another computer | Same Wi-Fi/VPN? Firewall? Check `YOUR_SERVER_IP`. |
| `grok not found` | Did `docker compose up -d --build` finish? Check `grok --version` inside the container console. |
| `Not signed in` / auth error | Run `grok login --device-auth` inside the container console. |
| `Missing required variable HOST_GROK_PATH` | You forgot to copy `.env.example` → `.env` or left the placeholder path. |
| Local model fails | Check `LOCAL_AI_BASE_URL` and that the local endpoint is reachable from the Docker server. |

---

## License

MIT — see [LICENSE](LICENSE).
