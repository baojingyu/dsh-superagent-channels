# 发布与收录材料（待审）

**状态：等待项目所有者 review，尚未开源、尚未提交任何收录申请。** 本目录只是准备好、可直接发送的文本与清单。

## 发布前清单（Lead 已核对）

- [x] `pnpm typecheck` 0，`pnpm test` 102 文件 / 1624 通过 / 0 失败，`pnpm build` 8 入口
- [x] `package.json` 名称 `dsh-superagent-multi-channel`、版本 `2.4.0`、`files` 含 `lib`、`cordis.patch.yml`、`locale`、`skills`、`icon.svg`
- [x] README 中英文均按 2.4.0 现状重写，含实机截图（敏感信息已打码）与示意图
- [x] 能力矩阵与平台限制成文（`docs/extensions/capability-matrix.md`）
- [x] 六个来源技能齐备；`docs/images/` 只含打码后的截图
- [ ] **待所有者确认**：仓库地址（`package.json` 暂填 `github.com/baojingyu/dsh-superagent-multi-channel`）
- [ ] **待所有者确认**：npm 发布账号与是否使用 `@dsh-community` scope
- [ ] 开源（打 tag `v2.4.0`、推送仓库）——**review 通过后执行**
- [ ] 向下列平台提交收录——**开源后执行**

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
