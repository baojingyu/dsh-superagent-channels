# dsh-superagent-channels · 多通道版

[English](README.md) · **简体中文**

一个面向软件团队的主动式 Agent，打包成 [DeepSeek Harness](https://dsh.dev)（DSH）bundle。
它监听团队本来就在说话的地方，以及团队的工作项系统——代码托管、工作项跟踪、四个聊天平台——
按 Policy 评估每一条进来的消息，把获得授权的转成 Ticket，每个 Ticket 在自己的 DSH Session 里执行。

上游只监听一个 GitHub 仓库、可选飞书。**本版保留上游全部行为，补上国内团队真正在用的通道**：
GitLab、云效 Projex、微信、钉钉、企业微信，以及同一种通道的多实例。

这是一个**独立仓库**，不是提 PR 的 fork：上游明确不合并外部提交，所以本版自行维护。
仓库怎么管、保留哪些来源信息、以及如何把一份副本从原型上彻底摘开，见
[REPOSITORY.md](REPOSITORY.md)（中文：[REPOSITORY.zh-CN.md](REPOSITORY.zh-CN.md)）。

## 加了什么

| 上游 | 本版 |
| --- | --- |
| 只有 GitHub | **GitLab**（可自建）：合并请求、评论、流水线 |
| 只有飞书 | **微信个人号**：群 `@`、消息图片、语音转写 |
| 没有工作项 | **云效 Projex**：需求 / 缺陷 / 任务、评论、分页 |
| — | **钉钉** Stream 与**企业微信**加密回调 |
| 一种通道一个实例 | **同种通道多实例**，配置、健康与游标按实例隔离 |

五个新插件在 `cordis.patch.yml` 里默认 `disabled`，并各自构建成独立入口（`lib/*-watch.js`），
所以启用一个通道 = 改一行 patch + 在面板里存一个实例。

逐项功能细节——每个字段、端点、幂等规则、能力状态与已知缺口——见
[EXTENSIONS.md](EXTENSIONS.md)（中文：[EXTENSIONS.zh-CN.md](EXTENSIONS.zh-CN.md)）。

## 状态

`main` 上实测，两个开发平台都跑：

| 检查 | macOS arm64 / node 22.23.2 | Windows 11 / node 22.21.1 |
| --- | --- | --- |
| `tsc --noEmit` | 0 | 0 |
| `vitest run --maxWorkers=2` | 83 files / 1435 tests / 1421 passed / 14 skipped / 0 失败 | 85 files / 1467 tests / 1431 passed / 36 skipped / 0 失败 |
| `tsdown` | 构建成功，8 个入口 | 同左 |
| `LIVE=1 vitest run tests/live` | 13 passed + 1 skipped | 13 passed + 1 skipped |

Windows 多出的 21 条跳过逐文件登记在 [HANDOVER-WIN11.md](HANDOVER-WIN11.md) §2：POSIX 服务管理器
与一条需要活子进程的飞书桩。没有任何一条是为了「让失败消失」而跳过的。

对**真实系统**验证过，不只是 mock：真实微信 4.x 客户端 + 真实 sidecar 进程（群与私聊推送接收、
群 `@`、图片下载、幂等发送）、真实 `gitlab.com` API（MR 映射、伪 token 映射为 401 且不回显）、
真实企微/钉钉/云效的鉴权失败被映射成可诊断错误。

## 快速开始

```bash
npm install --ignore-scripts --legacy-peer-deps   # 本机 pnpm 11 会卡在 ERR_PNPM_IGNORED_BUILDS
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --maxWorkers=2     # 必须限并发：无限制时计时敏感用例会抖
./node_modules/.bin/tsdown                        # 产出 lib/*-watch.js
```

然后按 [SETUP.md](SETUP.md) 把 bundle 装进 profile，在 `cordis.patch.yml` 里启用一个通道，
再在面板（Settings → Source）里存一个实例。

有两个可选依赖不在 `package.json` 里：`@deepseek-ai/cordis-plugin-include` 与
`@deepseek-ai/dsh-http-proxy`。原因是仓库的规范锁文件是 pnpm 的，而 pnpm 在本机不可用、无法重新生成锁文件。
`tests/environment.spec.ts` 或 `tests/bundle-patch.spec.ts` 解析不到它们时，手动装这两个包即可。

## 微信，以及它为什么有 sidecar

微信桌面客户端没法从 Node 驱动，所以它放在一个回环 HTTP sidecar 后面，契约是冻结的
（JSON 事件、`0600` bearer token、只听 127.0.0.1）。Node 侧只认契约，这才让后端可替换：

| 层 | 后端 | 适用 |
| --- | --- | --- |
| L0 | `wxauto` / `wxauto4` / `wxautox4`（UI 自动化） | 默认；需要一个交互式 Windows 桌面会话 |
| L1 | `wxhelper` 一类注入插件 | **已划掉**：只适配微信 3.9.x，且消息载荷里没有 mention 列表，装了也拿不到 `@`（ADR-005 §7） |
| L2 | `WeChatPadPro` 一类 iPad 协议服务 | 没有 Windows 机器时 |
| L3 | 托管 API | 其它全挂且业务不能停 |

`L0` 已实现并对真机跑通。收消息走**监听模式**（`AddListenChat` + `StartListening`），
所以消息是发出来就到，而不是从窗口当前渲染的内容里刮。

后端**能证明什么**按实例发布，不用猜：

| 能力 | L0 现状 | 含义 |
| --- | --- | --- |
| `mentions` | `markup` | 群 `@` 读的是客户端自己的 mention 标记（`@名字` + `U+2005`），不是手打的 `@名字`；粘贴分隔符仍可伪造 |
| `members` | `observed` | 只有已观测到的发送人，没有完整成员表 |
| `media` | 视构建 | 付费构建有 `download()`，免费构建没有 |

诚实的缺口：微信 4.x **没有**结构化 mention 列表——消息气泡是扁平的无障碍叶子节点——所以这一档
`ats` 做不到 `structured`。这一点、以及什么能补上它，记录在
[ADR-005 §7](docs/extensions/ADR-005-weixin-backend.md)。

配置群只写一次，在面板里：轮询循环每轮把配置的会话下发给 `POST /listen`，sidecar 只对差异动作，
所以增删一个群不用重启。群与发送人这两行是**下拉选**——`wxname_<hash>` 保住了 id 正则的严格性，
但没人能手打。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/sources/{hosting,work,chat}/port.ts` | 三份 provider 契约：变更请求、工作项、聊天 |
| `src/sources/instance.ts` | 实例 id 与通道 id，以及兼容规则 |
| `src/sources/{weixin,gitlab,projex,dingtalk,wecom}-watch.ts` | 五个可选插件 |
| `src/infra/{hosting-api,yunxiao-api,secret-file}.ts` | token 文件 HTTP 客户端、路径白名单、owner-only 规则 |
| `../dsh-superagent-channels-ext/sidecar/` | 微信 sidecar 与契约（同级目录，live 测试按这个路径找它） |
| `tests/live/*.live.spec.ts` | live 用例，由 `LIVE=1` 门控 |

## 文档

- [EXTENSIONS.zh-CN.md](EXTENSIONS.zh-CN.md) — 功能细节：每个通道加了什么，以及怎么再加一个
- [REPOSITORY.zh-CN.md](REPOSITORY.zh-CN.md) — 仓库怎么管、来源信息、以及如何把副本彻底摘开
- [HANDOVER-WIN11.md](HANDOVER-WIN11.md) — 在 Windows 上跑：实测基线、必须修掉的失败、微信探针
- [SETUP.md](SETUP.md) — 把 bundle 装进 profile
- 决策记录：[ADR-005 微信后端](docs/extensions/ADR-005-weixin-backend.md) · [ADR-006 健康键](docs/extensions/ADR-006-health-key-compatibility.md)
- 上游的编号文档仍然描述 Agent 本身：[000](docs/000-philosophy.md) · [001](docs/001-domain.md) · [002](docs/002-authorization.md) · [003](docs/003-execution.md) · [004](docs/004-prompts.md) · [005](docs/005-panel.md) · [006](docs/006-deployment.md) · [007](docs/007-architecture.md) · [008](docs/008-cookbook.md)

## 许可与边界

MIT，与本版所生长的原型一致；上游版权声明保留。来源说明见
[REPOSITORY.zh-CN.md](REPOSITORY.zh-CN.md)。

微信的 UI 自动化是第三方工具：未经腾讯授权，可能随时被客户端或平台限制，必须守在 ADR-005 记录的边界内
——只在被 `@` 时回复、不群发、不批量加好友、同一时刻只有一个账号在线。
