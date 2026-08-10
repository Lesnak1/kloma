# Hetzner WebSocket worker

This worker is the low-latency execution plane. It subscribes to Loaf's public `orderbook:{tokenName}` channels using the exchange's required `channels` array frame. Incoming updates are matched to the cached property by `propertyId`. Vercel remains the control plane and dashboard; Upstash provides the shared distributed lock, durable risk state and telemetry.

## Server choice

Create one Ubuntu 24.04 LTS Cloud server in the region with the lowest measured latency to `api.loafmarkets.com`. A small shared-vCPU server is sufficient for the current 12-market worker; choose 2 vCPU / 4 GB RAM if you want operational headroom. Add an SSH key during creation, enable Hetzner firewall rules for inbound SSH only, and enable deletion protection. Do not expose an HTTP port for this worker.

## One-time operating-system setup

Run as root after connecting through SSH key authentication:

```bash
apt-get update && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
adduser --system --group --home /opt/loaf-worker loafbot
ufw allow OpenSSH
ufw --force enable
```

Clone the repository and install the exact lockfile:

```bash
git clone https://github.com/Lesnak1/kloma.git /opt/loaf-worker
chown -R loafbot:loafbot /opt/loaf-worker
cd /opt/loaf-worker
sudo -u loafbot npm ci
```

## Secrets and service

1. Copy `deploy/hetzner/loaf-worker.env.example` to `/etc/loaf-worker.env`.
2. Fill it with the same Loaf, Upstash and strategy values as Vercel. Keep `TRADING_ENABLED=false` and set `WORKER_ENABLED=true` for the first service boot.
3. Set permissions: `chown root:loafbot /etc/loaf-worker.env && chmod 640 /etc/loaf-worker.env`.
4. Copy `deploy/hetzner/loaf-worker.service` to `/etc/systemd/system/loaf-worker.service`.
5. Run `systemctl daemon-reload && systemctl enable --now loaf-worker`.
6. Inspect only structured logs: `journalctl -u loaf-worker -f`.

The worker must log `worker_started`, then `websocket_connected`. During the DRAFT round it must log `tick_complete` with `mode:"halted"` and no placements.

## Live cutover

After the DRAFT-mode health check succeeds:

1. Leave `WORKER_ENABLED=true` and `TRADING_ENABLED=false`; verify WebSocket connectivity and DRAFT-mode logs.
2. Confirm admission to the active round in Loaf.
3. Set `TRADING_ENABLED=true`; restart `loaf-worker`.
4. Keep the Vercel cron job only as a short rollback fallback. Once worker logs show stable event-driven ticks, disable its tick job in cron-job.org to avoid unnecessary REST reconciliation.

The shared Upstash NX lock prevents overlapping Vercel and worker ticks. It is not a license to run multiple independent trading strategies.

## Upgrades and rollback

```bash
cd /opt/loaf-worker
sudo -u loafbot git pull --ff-only origin main
sudo -u loafbot npm ci
systemctl restart loaf-worker
```

Before a major update, take a Hetzner snapshot. Keep a known-good Git commit hash for rollback; use `git checkout <known-good-commit>` only after stopping the service.
