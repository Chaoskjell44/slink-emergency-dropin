# Slink maintenance drop-in

A temporary `503 Service Unavailable` maintenance page for [Slink](https://github.com/andrii-kryvoviaz/slink).

Built on `node:26.12.1-alpine`. Direct image links at `/image/IMAGE_HASH.ext` can
keep working while the Slink web UI is offline. Images can be served from the
local filesystem, an SMB/CIFS share, or an S3 / S3-compatible bucket.

## Why?

I made this as a temporary way to still serve images from my slink instance while taking slink itself offline to protect myself from the `PHP2SHELL` attack vector disclosed on the 21st of October 2026 by the PHP Project and decided to provide it to others incase of somebody needing to take their slink offline while still providing the images or just to have a page that informs users what's happening and why the webui is offline.

## Quick start

```bash
mkdir slink-dropin
cd slink-dropin
git clone https://github.com/chaoskjell44/slink-emergency-dropin.git

cp .env.example .env
```
edit .env, then:

```bash
docker compose up --build -d
```

The container binds to the same port (`3000`) that the real
Slink container uses, so your reverse proxy does not need to be reconfigured.

Make sure the real Slink stack is stopped before starting the drop-in, or the
container port will conflict.

## Configuration

Copy `.env.example` to `.env` and set at least `STORAGE_PROVIDER` and the
matching backend details.

### Local filesystem (default)

```dotenv
STORAGE_PROVIDER=local
IMAGES_DIR=/app/images
```

The compose file mounts `../slink/images` to `/app/images:ro`, matching the
upstream Slink layout. Adjust the volume path if your host layout differs.

### SMB / CIFS

```dotenv
STORAGE_PROVIDER=smb
SMB_HOST=192.168.1.100
SMB_SHARE=slink-storage
SMB_USERNAME=slink-user
SMB_PASSWORD=your-secure-password
SMB_WORKGROUP=WORKGROUP
SMB_PORT=445
SMB_IMAGE_PATH=slink/images
```

- `SMB_HOST`, `SMB_SHARE`, `SMB_USERNAME`, and `SMB_PASSWORD` are required.
- `SMB_WORKGROUP` defaults to `WORKGROUP`.
- `SMB_PORT` defaults to `445`.
- `SMB_IMAGE_PATH` defaults to `slink/images`, the layout the upstream Slink
  SMB provider creates on the share.

When using SMB you can omit the local `./slink/images` volume.

### S3 / S3-compatible

```dotenv
STORAGE_PROVIDER=s3
AMAZON_S3_BUCKET=my-slink-bucket
AMAZON_S3_REGION=us-east-1
AMAZON_S3_ACCESS_KEY_ID=...
AMAZON_S3_SECRET_ACCESS_KEY=...
```

For MinIO / Backblaze B2 / another S3-compatible service:

```dotenv
AMAZON_S3_ENDPOINT=https://s3.example.com
AMAZON_S3_FORCE_PATH_STYLE=true
AMAZON_S3_USE_CUSTOM_PROVIDER=true
```

On AWS you can omit keys and use an IAM role:

```dotenv
AMAZON_S3_USE_IAM_ROLE=true
```

## Disable image forwarding

Set `SERVE_IMAGES=false` in `.env` to return the maintenance page on every
route instead of serving images on the general image path slink uses.

```dotenv
SERVE_IMAGES=false
```

## Customising the page

Edit `content.json`. The HTML template uses placeholders such as:

- `{{title}}`, `{{domain}}`
- `{{h1_text}}`
- `{{lede_paragraph_1}}`, `{{lede_paragraph_2}}`, `{{lede_paragraph_3}}`
- `{{status_label}}`, `{{status_big}}`, `{{timer_note}}`
- `{{source_url}}`, `{{source_text}}`
- `{{foot_text}}`
- `{{accent_color}}`

Restart the container after changing `content.json`.

## Restoring the real service

```bash
docker compose down
# then, from your real Slink compose directory:
docker compose up -d
```

## Related

- [Slink](https://github.com/andrii-kryvoviaz/slink) — the upstream Slink image board.
