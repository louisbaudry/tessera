# Deploying Tessera to one VPS

Backlog `#36b` (the outward half of `#36`). `deploy/` holds what runs on the host:
the image from the repository's `Dockerfile` behind Caddy, which obtains and renews
the TLS certificate. The image terminates no HTTPS itself (`#36a`).

The choice of host was Louis's: a VPS in the United States from a hosting provider,
with a persistent disk. Nothing here names the provider, an address or an account;
those stay in the operator's password manager and the infrastructure register.

## What you need before starting

- A VPS running a current Ubuntu LTS, 2 vCPU and 4 GB of RAM or more (the image build
  compiles `better-sqlite3` only when no prebuilt binary matches), with 20 GB of disk.
- A DNS **A record** for the name you will serve, pointing at the VPS's address,
  before the first start: Caddy asks Let's Encrypt for the certificate on boot.
- Ports 80 and 443 open to the internet (80 is how Let's Encrypt proves the name).

## First deployment

On the host, as a non-root user with `sudo`:

```sh
# Docker Engine and the compose plugin: follow docs.docker.com/engine/install/ubuntu
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable

git clone https://github.com/louisbaudry/tessera.git && cd tessera/deploy
cp .env.example .env && "${EDITOR:-nano}" .env      # SITE_ADDRESS=the name you pointed at the host
docker compose up -d --build
docker compose logs -f caddy                        # wait for "certificate obtained successfully"
```

Create the one account **on the host**. The script takes the password as an argument
and has no prompt, so read it into a variable instead of typing it on the command line
(which would land in the shell history). Never put it in a chat, an issue or a file in
the repository:

```sh
read -rsp 'Password: ' PW; echo
docker compose run --rm tessera node dist/create-account.js you@example.com "$PW"; unset PW
```

## Done when (issue 21)

1. `https://<SITE_ADDRESS>/` loads the SPA over a valid certificate.
2. The account logs in.
3. The volume survives a restart: `docker compose down && docker compose up -d`
   (not `down -v`, which deletes the volume), then log in again and see the same projects.

## Backup

`backup.sh` writes a dated archive of `/data` and keeps two weeks. It stops the app
for a few seconds, which is why it runs at night:

```sh
sudo crontab -e   # 15 3 * * * /home/<user>/tessera/deploy/backup.sh >>/var/log/tessera-backup.log 2>&1
```

An archive on the same disk is not a backup against losing the disk. Copy
`/var/backups/tessera` off the host (the provider's snapshots, or `rsync` to another
machine) before relying on it. **Restore** is untested until you do it once on a
scratch volume: stop the app, extract the archive into the volume, start it.

## Updating

```sh
cd tessera && git pull --ff-only && cd deploy && docker compose up -d --build
```

The server applies any pending migration of a file the next time that file is opened,
with the runner's pre-migration backup beside it. A volume moved to another host moves
every stored `tm_ref.path` with it (`v1-spec.md` §4.2).

## What this deliberately does not do

- **No draft engine.** `ANTHROPIC_API_KEY` and `DEEPL_API_KEY` are not passed to the
  container, so no client text can leave for an engine. Enabling one needs the consent
  rows in the application (`CLAUDE.md`, "The draft engine") and a decision to add the key
  to `docker-compose.yml`.
- **No registry, no automatic deploy.** The image is built on the host from a checkout.
  A published image and a deploy workflow are a later card, once there is more than one
  host or more than one person deploying.
- **No signup.** There is no registration endpoint; accounts exist only because this script ran on the host
  (`v1-spec.md` §4.1a). A second account is the same command with another email.

## Verification status

The compose file validates (`docker compose config`). It has **not** been run: the
session that wrote it had no Docker daemon. The first real run on the host is the check.
