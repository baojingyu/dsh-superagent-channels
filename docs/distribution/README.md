# 发布与收录材料（待审）

**状态：文档已 review 通过并开源（2026-11-14）；npm 发布被登录状态阻塞，尚未向任何平台提交收录。**

## 已完成

- [x] 开源：`main` 已推送（commit `5f2ade3`、`15565ac`），tag `v2.4.0` 已推送
- [x] 仓库：https://github.com/baojingyu/dsh-superagent-multi-channel （PUBLIC）
- [x] Release v2.4.0 与可直接安装的 tarball：
      https://github.com/baojingyu/dsh-superagent-multi-channel/releases/download/v2.4.0/dsh-superagent-multi-channel-2.4.0.tgz
- [x] GitHub topics 已加 `dsh-plugin`、`deepseek-harness` 等（dshfind / 1024Store 按 topic 扫描）
- [x] **dsh-desktop Issue #1650**：https://github.com/anywhere-labs/dsh-desktop/issues/1650
- [x] **dshfind Issue #80**：https://github.com/hikariming/dshfind/issues/80
- [x] **npm 已发布**：`dsh-superagent-multi-channel@2.4.0`，latest 已指向 2.4.0
      https://www.npmjs.com/package/dsh-superagent-multi-channel
- [x] GitHub Pages 已开启（main /docs）；目录 manifest：
      https://baojingyu.github.io/dsh-superagent-multi-channel/distribution/catalog/catalog-source.json
      endpoint：https://baojingyu.github.io/dsh-superagent-multi-channel/distribution/catalog/v1/plugins

## 阻塞项

- [ ] **npm 登录/2FA**：已登录 `juelianyu`；两次 access token 都能读（`npm whoami` 正常）但 `npm publish` 均报
      `403 Two-factor authentication or granular access token with bypass 2fa enabled is required`。需要：
      ① npmjs → Access Tokens → 生成 **Granular Access Token** 并勾选 **Bypass 2FA**、权限 Read and write；或
      ② 提供当前 **6 位 OTP 数字**（不是 token）；或 ③ 在本机终端执行 `npm publish --access public`。
      发布前 dshfind 的「npm 包与仓库对得上」不满足，Issue #80 已注明首发中。
- [ ] **deepseek1024**：站点没有公开提交表单，按 GitHub 仓库/topic 自动索引（14k+ 插件）；仓库已加 `dsh-plugin` topic，
      预期被扫入。若你有站点联系人/表单，请给我入口，我补发。
- [ ] **Community Market 托管**：`transport.endpoint` 必须是 HTTPS 且路径以 `/v1/plugins` 结尾（无 `.json`），并返回 JSON
      content-type；GitHub Pages 对无扩展名文件按 `application/octet-stream` 返回，可能被 Host 拒绝。发送前需部署到可设
      content-type 的静态主机（Cloudflare Pages / Vercel / 自有反代），或改走路径 B（受审 adapter）。已在 Issue #1650 说明。

## 发布前清单（Lead 已核对）

- [x] `pnpm typecheck` 0，`pnpm test` 102 文件 / 1624 通过 / 0 失败，`pnpm build` 8 入口
- [x] `package.json` 名称 `dsh-superagent-multi-channel`、版本 `2.4.0`、`files` 含 `lib`、`cordis.patch.yml`、`locale`、`skills`、`icon.svg`
- [x] README 中英文均按 2.4.0 现状重写，含实机截图（敏感信息已打码）与示意图
- [x] 能力矩阵与平台限制成文（`docs/extensions/capability-matrix.md`）
- [x] 六个来源技能齐备；`docs/images/` 只含打码后的截图
- [x] 仓库地址已确认为 `github.com/baojingyu/dsh-superagent-multi-channel`
- [x] npm 包名确认为无 scope 的 `dsh-superagent-multi-channel`
- [x] 开源：`main` 推送（`5f2ade3`）+ tag `v2.4.0` 推送
- [ ] npm 发布——**待本机 `npm login`**（当前 `ENEEDAUTH`）
- [ ] 向下列平台提交收录——**npm 发布后执行**

## 收录目标与材料

| 平台 | 入口 | 用哪份材料 |
| --- | --- | --- |
| DSH Community Market | 目录接入（路径 A：静态 manifest + `/v1/plugins`） | [`catalog/`](catalog/) 的 manifest 与 page，托管到 GitHub Pages；或按 [market-adapter-request.md](market-adapter-request.md) 走路径 B |
| dshfind | 站点/其 GitHub 仓库提交收录 | [dshfind-submission.md](dshfind-submission.md) |
| deepseek1024 | 站点收录/联系 | [1024-submission.md](1024-submission.md) |
| dsh-desktop Issues | 新 issue | [dsh-desktop-issue.md](dsh-desktop-issue.md) |

## 统一一句话介绍

> dsh-superagent 多通道：给 DSH 的 superagent 增加微信、企业微信、钉钉、云效 Projex，并把六种来源统一到「评估 → 工单 → 执行 → 回复」闭环；与官方飞书/GitHub 通道并存安装。

## 统一要点（各平台通用）

- 包名：`dsh-superagent-multi-channel`；版本 2.4.0；许可 MIT。
- 与官方 `dsh-superagent` 的关系：并存安装，入口 id/面板入口/状态目录独立；同一 Host 同一时刻只启用一个 superagent（同种 Source kind 只能注册一次）。
- 数据与隐私：全部状态在本机 `stateDir`；令牌优先 0600 文件；只被动回复，不群发、不拉群、不加好友。
- 平台限制（公开写明，不夸大）：微信/企业微信/钉钉无消息深链；企业微信、钉钉无历史回补；钉钉 Stream 需部署注入 SDK 连接；微信为第三方 UI 自动化。
- 截图：README 中三张实机截图（策略、云效来源卡、提示词），敏感信息已打码。
