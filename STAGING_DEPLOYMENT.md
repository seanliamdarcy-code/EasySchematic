# EasySchematic Staging Deployment

This repository has a separate staging lane for testing EasySchematic changes in a live VPS environment before promoting them to the production site.

## Environments

| Environment | Branch | Hostname | VPS path | Compose project | Local port |
| --- | --- | --- | --- | --- | --- |
| Production | `master` | `schematic.tateside.online` | `/home/debian/EasySchematic` | `easyschematic` | `127.0.0.1:8080` |
| Staging | `staging` | `testschematic.tateside.online` | `/home/debian/EasySchematic-staging` | `easyschematic-staging` | `127.0.0.1:8081` |

## Branch flow

Use this promotion path:

```text
feature branch -> staging -> testschematic.tateside.online -> master -> schematic.tateside.online
```

Recommended workflow:

1. Develop changes on a feature branch.
2. Merge or cherry-pick approved work into `staging`.
3. Deploy `staging` to `/home/debian/EasySchematic-staging`.
4. Test at `testschematic.tateside.online`.
5. Merge the tested staging changes into `master`.
6. Deploy `master` to `/home/debian/EasySchematic`.

## Staging deploy

Run these commands on the VPS:

```bash
cd /home/debian/EasySchematic-staging
git fetch origin
git checkout staging
git pull --ff-only origin staging
docker compose -p easyschematic-staging -f compose.staging.yml up -d --build
curl -I http://127.0.0.1:8081
```

The staging Compose file binds nginx to `127.0.0.1:8081`, keeping it separate from production on `127.0.0.1:8080`.

## Production deploy

Run these commands on the VPS only when changes have passed staging:

```bash
cd /home/debian/EasySchematic
git fetch origin
git checkout master
git pull --ff-only origin master
docker compose -p easyschematic -f compose.yml up -d --build
curl -I http://127.0.0.1:8080
```

## Caddy hostnames

Production currently proxies:

```caddyfile
schematic.tateside.online {
    @tatesideApi path /api/tateside/*
    reverse_proxy @tatesideApi 127.0.0.1:8788

    reverse_proxy localhost:8080
}
```

Staging should proxy:

```caddyfile
testschematic.tateside.online {
    @tatesideApi path /api/tateside/*
    reverse_proxy @tatesideApi 127.0.0.1:8788

    reverse_proxy localhost:8081
}
```

At the moment staging uses the same `/api/tateside/*` backend as production. If staging later needs isolated API testing, create a separate staging API service and change the Caddy route accordingly.

## Safety notes

Do not run staging Compose commands inside `/home/debian/EasySchematic`.

Do not run production Compose commands inside `/home/debian/EasySchematic-staging`.

Keep staging and production as separate checkouts, separate Compose projects, and separate localhost ports.

Before reloading Caddy after any change:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```
