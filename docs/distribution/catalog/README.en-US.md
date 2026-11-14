# Community Market Catalog Integration (Path A: static HTTPS JSON)

> Language: [English](README.en-US.md) · [中文](README.md)

This catalog is prepared per **path A** of [catalog-adapter-guide.zh.md](../market-adapter-request.md): two anonymous HTTPS JSON files are published on the same origin; users only register the manifest URL, with no changes to Market code.

## Files

- `catalog-source.json` — the manifest (`manifestVersion 1.0.0`, `transport.kind = https-json`, endpoint ending in `/v1/plugins`).
- `v1/plugins.json` — the standard provider page (`schemaVersion 1.0.0`, one item, an empty `page` object meaning no next page).

Both **contain no** scripts, install commands, credentials, or mapping expressions; entries declare their install identity via `repository` and `package` (npm), and provenance is injected by the Host.

## Hosting

Publish `docs/distribution/catalog/` to `https://baojingyu.github.io/dsh-superagent-multi-channel/` (GitHub Pages, the `gh-pages` branch or `/docs`), so that:

- `https://baojingyu.github.io/dsh-superagent-multi-channel/catalog-source.json`
- `https://baojingyu.github.io/dsh-superagent-multi-channel/v1/plugins.json`

are reachable, same origin, HTTPS, and unauthenticated. `icon.svg` must also be on the same origin (used for `media.icon`).

## Self-check (before publishing)

1. Validate both JSON files with the official schemas:
   `docs/schemas/catalog-source.schema.json`, `docs/schemas/catalog-provider-page.schema.json`.
2. Confirm that the `endpoint` host is same-origin with the manifest and the path ends in `/v1/plugins`.
3. Use `curl -s https://…/v1/plugins | jq .` to check that `items[0].package.name` matches the actual npm package.
4. In DSH "Plugins → Installed → Experimental plugins", enable "Custom plugin market", add the manifest URL, and confirm you can see "dsh-superagent multi-channel" and install it successfully.

## Alternative: Path B (reviewed adapter)

If the plugin count grows in the future and server-side filtering by `q/category` is needed, then propose adapter cooperation per [market-adapter-request.md](../market-adapter-request.md); the current single-entry scale does not require it.
