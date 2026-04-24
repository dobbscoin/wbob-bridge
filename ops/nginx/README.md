# wBOB Bridge — nginx vhost

Public-facing front door for the bridge:
`https://bridge.subgenius.finance/`  →  portal + API on same origin.

## Deploy (one-time, per host)

```bash
# 1. Make sure DNS is set:  bridge.subgenius.finance A <public-IP>
dig +short bridge.subgenius.finance

# 2. Install the vhost + enable it
sudo cp ops/nginx/bridge.subgenius.finance /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/bridge.subgenius.finance \
           /etc/nginx/sites-enabled/bridge.subgenius.finance
sudo nginx -t && sudo systemctl reload nginx

# 3. Issue Let's Encrypt cert; certbot rewrites the file to add :443 + TLS directives
sudo certbot --nginx -d bridge.subgenius.finance \
     --agree-tos --redirect --no-eff-email -m you@example.com

# 4. Verify
curl -s https://bridge.subgenius.finance/v1/health | jq
```

Routing:
| Path | Upstream |
|---|---|
| `/v1/*`  | `http://127.0.0.1:13013` (Fastify backend) |
| `/health` | `http://127.0.0.1:13013` (legacy pre-v1) |
| `/` (everything else) | `http://127.0.0.1:8888` (Next portal) |

Renewal: certbot's systemd timer auto-renews. Verify:
`sudo systemctl status certbot.timer`

## Firewall reminder

Only `80, 443, 22` should be open on the public interface. The bridge's backend
(13013) and portal (8888) listen on `0.0.0.0` currently so they're directly
reachable — after the nginx route is proven working, tighten them to
`127.0.0.1` by editing the backend's `api/server.ts` listen host (and the
portal's `npm run dev --hostname 127.0.0.1`).
