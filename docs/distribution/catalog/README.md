# Community Market 目录接入（路径 A：静态 HTTPS JSON）

> 语言：[中文](README.md) · [English](README.en-US.md)

这份目录按 [catalog-adapter-guide.zh.md](../market-adapter-request.md) 的**路径 A** 准备：同一 origin 上发布两份匿名 HTTPS JSON，
用户只登记 manifest URL，无需改动 Market 代码。

## 文件

- `catalog-source.json` —— manifest（`manifestVersion 1.0.0`，`transport.kind = https-json`，endpoint 以 `/v1/plugins` 结尾）。
- `v1/plugins.json` —— 标准 provider page（`schemaVersion 1.0.0`，一条 item，`page` 为空对象表示没有下一页）。

两者都**不含**任何脚本、安装命令、凭据或映射表达式；条目通过 `repository` 与 `package`（npm）声明安装身份，provenance 由 Host 注入。

## 托管

把 `docs/distribution/catalog/` 发布到 `https://baojingyu.github.io/dsh-superagent-multi-channel/`（GitHub Pages，`gh-pages` 分支或
`/docs`），使：

- `https://baojingyu.github.io/dsh-superagent-multi-channel/catalog-source.json`
- `https://baojingyu.github.io/dsh-superagent-multi-channel/v1/plugins.json`

可访问、同 origin、HTTPS、无鉴权。`icon.svg` 也需在同一 origin（用于 `media.icon`）。

## 自检（发布前）

1. 用官方 schema 校验两份 JSON：
   `docs/schemas/catalog-source.schema.json`、`docs/schemas/catalog-provider-page.schema.json`。
2. 确认 `endpoint` 的主机与 manifest 同源，且路径以 `/v1/plugins` 结尾。
3. 用 `curl -s https://…/v1/plugins | jq .` 检查 `items[0].package.name` 与 npm 实际包一致。
4. 在 DSH「插件页 → 已安装 → 实验性插件」启用「自定义插件市场」，添加 manifest URL，确认能看到「dsh-superagent 多通道」并安装成功。

## 备选：路径 B（受审 adapter）

如果将来插件数量增长、需要按 `q/category` 服务端筛选，再按 [market-adapter-request.md](../market-adapter-request.md) 提 adapter 合作；
当前一条目规模不需要。
