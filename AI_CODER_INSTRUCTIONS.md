# AI Coder Instructions

**For Claude Code, Kimi, Grok Build, or any coding agent.**

A human wants to run this repo on their Docker server. Do the setup for them, ask only when you truly need input, and never invent values.

## Context

This repo wraps the **Grok Build CLI** in a small HTTP server so apps on the same LAN can call it. It can also fall back to a local OpenAI-compatible model endpoint.

## Setup steps

1. Clone `https://github.com/bitcopath/grok-proxy.git` on the target Docker server.
2. `cd grok-proxy`
3. `cp .env.example .env`
4. Ask the human:
   - What is the full host path to their Grok Build config/auth dir? ( usually `~/.grok` )
   - What free port should the proxy use? (default `8084`)
   - Optional: do they have a local OpenAI-compatible endpoint for cheap drafts? If yes, ask for the URL.
5. Write those values into `.env`.
6. Run `docker compose up -d --build`.
7. Verify the container is running: `docker ps | grep grok-proxy`.
8. Guide the human to authenticate Grok inside the container once:
   - Option A (easiest): open Portainer → Containers → grok-proxy → Console → run `grok login --device-auth`.
   - Option B: `docker exec -it grok-proxy bash` then `grok login --device-auth`.
9. Test health from the server: `curl http://localhost:8084/health` (use their chosen port).
10. Tell the human the LAN URL: `http://<server-ip>:<port>`.

## Rules

- Do **not** put the human's Grok password or `auth.json` in any file, env var, or chat.
- Do **not** expose the proxy port to the public internet.
- Explain that `GROK_PERMISSION_MODE=bypassPermissions` is needed for headless runs but should stay on a trusted LAN.
- If Docker is not installed, install Docker + Docker Compose first or stop and ask the human.

## One-line summary

> Build and run the Docker container, mount the host's `~/.grok` into it, then run `grok login --device-auth` inside the container console.
