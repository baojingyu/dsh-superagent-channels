# Community Market Path B (reviewed adapter) Alternative Application

> Language: [English](market-adapter-request.en-US.md) · [中文](market-adapter-request.md)

Only needed when the entry count grows and server-side filtering is required. For the current single entry, [path A](catalog/README.md) suffices. Per the "path B" of
[catalog-adapter-guide.zh.md](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-community-market/docs/catalog-adapter-guide.zh.md),
prepare the following materials for the Market team:

1. **Public endpoint docs and response schema**: this plugin's catalog is static JSON with no private API; if converted to a dynamic catalog, OpenAPI and examples will be provided.
2. **Samples with secrets removed**: one each of a success page, empty-result page, paginated page, and error page.
3. **Stable field semantics and pagination rules**: the semantics of `id/name/displayName/summary/package/repository` and the ownership of `nextCursor`.
4. **Provenance statement, rate limit, and icon ownership**: statically hosted on GitHub Pages with no rate limit; the icon `icon.svg` is owned by this project (MIT).
5. **No overreach**: the manifest and page contain no JavaScript, install commands, credentials, or mapping expressions.

> Conclusion: path B is not needed for now. This file is kept only as a checklist for future expansion.
