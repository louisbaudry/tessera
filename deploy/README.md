# Deploying Tessera to one VPS

Backlog `#36b` (the outward half of `#36`). `deploy/` holds what runs on the host:
the image from the repository's `Dockerfile` behind Caddy, which obtains and renews
the TLS certificate, and (issue #325) the client portal as a second container on the same
host. The images terminate no HTTPS themselves (`#36a`).

The choice of host was Louis's: a VPS in the United States from a hosting provider,
with a persistent disk. Nothing here names the provider, an address or an account;
those stay in the operator's password manager and the infrastructure register.

## What you need before starting

- A VPS running a current Ubuntu LTS, 2 vCPU and 4 GB of RAM or more (the image build
  compiles `better-sqlite3` only when no prebuilt binary matches), with 20 GB of disk.
- A DNS **A record** for the name you will serve, pointing at the VPS's address,
  before the first start: Caddy asks Let's Encrypt for the certificate on boot. Add it in
  the domain's **DNS settings**, not through a hosting panel's "add subdomain" (Plesk and
  the like), which builds a site on that panel's own server and points the name there.
  Check it from a public resolver (`nslookup <name> 8.8.8.8`) before the first start. Your
  own router can keep serving the old answer for the whole TTL, so judge the server from a
  phone on mobile data, not from your PC, while it settles.
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

## The client portal (issue #325)

The same `docker compose up -d --build` also starts the portal (`portal-server`, on port
3300 inside the project's network). Caddy sends its paths to it and everything else to the
app, on the **same host name**: `/client.html`, `/admin.html`, their scripts and
stylesheet, `/api/admin/*` and `/api/client/*`. None of these is a path of the app's, so
nothing needs a second DNS record or certificate.

One thing to know about a shared host: the portal's pages and the app's share a browser
origin, so a script flaw in a portal page could reach the app's sign-in on the same
browser. The known one is fixed (#323); if you would rather not rely on that, give the
portal its own name later (a second A record and a second site block in the `Caddyfile`).

Set the name its pages show in `deploy/.env` (`PORTAL_DISPLAY_NAME`, blank is "Translation
Portal"), then `docker compose up -d`. **Mail is off by default**: notifications go to the
log (`docker compose logs portal`). To turn mail on set `PORTAL_SMTP_HOST`, `PORTAL_SMTP_FROM`
and `PORTAL_ADMIN_EMAIL` together; a host without a sender refuses to start.

**The admin and the first client.** Create the portal admin once, on the host. The password is read into a
variable, so it appears in no command line or history; never put one in a chat, an issue or a file in the
repository:

```sh
cd tessera/deploy
read -rsp 'Admin password: ' PW; echo
docker compose run --rm portal node dist/create-admin.js you@example.com "$PW"; unset PW
```

Then everything else is in the browser. Sign in at `https://<SITE_ADDRESS>/admin.html`:

- **Rates** (issue #328): add one row per language pair a client may order (codes such as `en`, `es`, `pt-BR`,
  a price per word and a minimum price for a job). A client can only choose pairs that have a rate. Saving a
  pair that exists updates it.
- **Clients**: add a client by name and email address. The page then shows that client's **private link**
  (`/client.html#token=...`); the **Copy link** button on each row shows it again. The link is the client's
  whole credential: send it only to them. The portal mails nothing without SMTP, so you send it yourself.
- **Orders**: a client's requests, to price and deliver as before.

The two screens use the routes `POST /api/admin/clients` and `POST /api/admin/rates`, which check their input
(a duplicate address is refused). Neither screen edits or deletes yet. Prices still show a `$` whatever the
currency (issue #327).

## Done when (issue 21)

1. `https://<SITE_ADDRESS>/` loads the SPA over a valid certificate.
2. The account logs in.
3. The volume survives a restart: `docker compose down && docker compose up -d`
   (not `down -v`, which deletes the volume), then log in again and see the same projects.

## Backup

`backup.sh` writes a dated archive of each `/data` volume (`tessera-data-*` for the app,
`portal-data-*` for the portal) and keeps two weeks. It stops both for a few seconds, which is
why it runs at night. Run it once by hand first, as your own
user, into your home directory (`./backup.sh ~/backups`; the default `/var/backups/tessera`
needs root), and check the archive lists with `tar -tzf`. Then schedule it:

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

The first update that carries the portal adds a container and changes the `Caddyfile`; `up -d` recreates
Caddy for it. If it ever does not, `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`
reloads the file.

## What this deliberately does not do

- **No draft engine.** `ANTHROPIC_API_KEY` and `DEEPL_API_KEY` are not passed to the
  container, so no client text can leave for an engine. Enabling one needs the consent
  rows in the application (`CLAUDE.md`, "The draft engine") and a decision to add the key
  to `docker-compose.yml`.
- **No single sign-on.** The provider ids and secrets and `SSO_CALLBACK_ORIGIN` are not passed to the
  container, and Caddy routes no `auth.<domain>` host, so signing in with Microsoft or Google is
  off. Enabling it needs the two registrations (`planning/sso-spec.md` §4), the five variables in
  `docker-compose.yml`, and `auth.<domain>` on the certificate and in the Caddyfile.
- **No registry, no automatic deploy.** The image is built on the host from a checkout.
  A published image and a deploy workflow are a later card, once there is more than one
  host or more than one person deploying.
- **No portal mail by default**, and no way yet to edit or delete a client or a rate. See the
  portal section above.
- **No signup.** There is no registration endpoint; accounts exist only because this script ran on the host
  (`v1-spec.md` §4.1a). A second account is the same command with another email.

## Verification status

Run on the host on 2026-10-26: the build, Caddy's certificate, the login over HTTPS and
the account surviving a `down` and `up` are verified. **The backup script and a restore
have not been run on the host yet**; do both before real client files depend on it.
