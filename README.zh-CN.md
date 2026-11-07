# open-dsh-superagent — 自建接入层分支

[English](README.md) · **简体中文**

本仓是 DeepSeek Harness 团队公开的 **open-dsh-superagent** 研究原型的二次开发。原版是一个面向
**单个 GitHub 仓库**（可选飞书）的主动式编码 agent，以 bundle 形式运行在
[DeepSeek Harness](https://www.deepseek.com/en/harness/) 上。本分支保留它的全部行为，
并补上国内团队实际在用的接入来源。

> 上游是**研究代码，不是 DeepSeek 官方产品**；本分支也与 DeepSeek 无隶属关系。两者都是 MIT。
> 在任何重要环境使用前，请自行审阅与适配。

## 本分支新增了什么

| 上游 | 本分支 |
| --- | --- |
| 只有 GitHub | **GitLab**（自建）：合并请求、评论、流水线 |
| 只有飞书 | **微信个人号**（群 `@`、消息图片）、**钉钉** Stream、**企业微信**加密回调 |
| 没有工作项 | **云效 Projex**：需求/缺陷/任务、评论、分页 |
| 一个 kind 只能一个实例 | **一个 kind 多个实例**，配置、健康、KV 全部按实例隔离 |

五个新插件随 bundle 发布，在 `cordis.patch.yml` 里**默认 `disabled: true`**：
`weixin`、`gitlab`、`projex`、`dingtalk`、`wecom`。

## 状态

`main` 上实测（node 22.23.2）：

```bash
tsc --noEmit                      # 0
vitest run --maxWorkers=2         # 83 files（80 passed + 3 skipped）/ 1435 tests（1421 passed + 14 skipped），0 失败
tsdown                            # 构建成功，8 个入口：index + 7 个 watch 插件
LIVE=1 vitest run tests/live      # 对真实服务：13 passed + 1 skipped
```

对**真实对象**验证过（不只是 mock）：真实 sidecar 进程 + 回环 HTTP（六个端点、幂等发送、
`0600` token、图片字节）；真实 `gitlab.com` 公开 API（MR 映射、伪 token 映射为 401 且不回显）；
真实企微/钉钉/云效的鉴权失败被映射成可诊断错误；以及面板数据层（同 kind 两实例、删除一个、
无 `kind` 的旧设置）。

**微信真机：已实测。** sidecar 的 `pc-uia` 后端通过 `wxautox4` 以**监听模式**
（`AddListenChat` + `StartListening`）驱动微信 4.x，消息是**推送**来的，不是从窗口当前渲染的内容里刮的。
本机已验证：真实群消息与私聊、本账号身份、图片下载。

这个后端**能证明什么、不能证明什么**按实例发布为 `capabilities`，不用猜：

| 能力 | `pc-uia` | 含义 |
| --- | --- | --- |
| `mentions` | `markup` | 群 `@` 读的是客户端自己的 mention 标记（`@名字` + `U+2005`），不是手打的 `@名字`。判据名按 60 秒 TTL 重读、`/listen` 时强制重读，所以本账号改名**不用重启**就会自愈；粘贴分隔符仍可伪造 |
| `members` | `observed` | 只有已观测到的发送人，没有完整成员表 |
| `media` | 视构建 | Plus 构建有 `download()`，免费构建没有 |

配置群只写一次，在面板里：轮询循环每轮把配置的会话下发给 `POST /listen`，sidecar 只对差异动作，
所以增删一个群不用重启 sidecar。解析不到的会话会**按名字**回报，不会表现成「这个群很安静」。
群与发送人这两行是**下拉选**，不是手填：`wxname_<hash>` 这样的 id 保住了设置里的 id 正则，
但没人能手打，所以刷新一次会把桥见过的会话和发送人载入，再从列表里挑。`/rooms` 给的是「全部近期群 + 当前会话列表里可见的会话」，所以滚出列表的单聊要先打开一次才会出现在候选里。
**诚实的缺口**：微信 4.x 上**没有**结构化 mention 列表——消息气泡是扁平叶子
（`childCount == 0`，无 text/value/legacy pattern），所以 `ats` 只能做到 `markup` 档。
声明 `mentions: none` 的后端仍可用于单聊，其群聊则只靠 Policy 规则判定。

**不作声称的部分**：对真实代码托管/工作项的任何写操作、企微回调走公网反代、钉钉 Stream 未植 SDK、
像素级 GUI 验收、微信上的稳定会话 ID 与发送人 `wxid`（两者都是显示名，命名空间化为
`wxname_<hash>`）、企微/钉钉的消息图片（只实现了微信这条路径）。

## 快速开始

```bash
npm install --ignore-scripts --legacy-peer-deps     # 本机 pnpm 11 会卡在 ERR_PNPM_IGNORED_BUILDS
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --maxWorkers=2
./node_modules/.bin/tsdown                          # 产出 lib/*-watch.js
```

上游的安装指南仍然适用：[SETUP.md](SETUP.md) 会用 agent 帮你安装与配置。微信客户端无法从 Node
直接驱动，所以它放在一个回环 sidecar 后面、契约冻结——后端阶梯与探针见 [EXTENSIONS.zh-CN.md](EXTENSIONS.zh-CN.md)。

## 启用某个来源

1. 在 `cordis.patch.yml` 里把该插件的 `disabled` 改为 `false`；
2. 重新构建（`tsdown`）并重启 harness；
3. 在面板 Settings → Source 保存一个实例。**设置键就是实例 id**，`kind` 才是行为 id；
   默认实例 id 恒等于 kind id。

凭据不进 settings：每个客户端都接收 `tokenFile`（或 `keyFile`）路径，每次调用读取，且只接受
权限 `0600` 的普通文件。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/sources/instance.ts` | 实例 id 与 kind id 的拆分与兼容助手 |
| `src/sources/{hosting,work,chat}/port.ts` | 三个厂商契约 |
| `src/sources/{weixin,gitlab,projex,dingtalk,wecom}-watch.ts` | 五个可选插件 |
| `src/infra/{hosting-api,yunxiao-api}.ts` | 带 token 文件与路径白名单的 HTTP 客户端 |
| `../open-dsh-superagent-ext/sidecar/` | 微信 sidecar（契约 + 零依赖实现）。放在同级目录，因为 live 测试按该相对路径定位；见 [HANDOVER-WIN11.md](HANDOVER-WIN11.md) §3.2 |
| `tests/live/*.live.spec.ts` | 真实联调套件，由 `LIVE=1` 门控 |

## 改代码时要守的约定

- **`@` 绝不按文本判定。** 群 `scope` 只读 `ats`，绝不取正文子串。`ats` 可以由客户端自己的
  mention 标记得出，但**强度必须声明**在 `capabilities.mentions`
  （`structured` / `markup` / `none`）里，让人看得出一个群 `@` 是证据还是线索。
- **后端差异留在 sidecar。** 没有稳定 ID 的后端把会话与人命名为 `wxname_<hash>`，由
  `refreshLabels` 解析回显示名；设置里的 id 正则因此保持严格，不为迁就显示名而放宽。
- **一份状态一个写者。** Source 只能经 `SourceContext.tickets` 改工单；健康条目按实例 claim；
  回执只由 Outbox 写。
- **幂等是声明的。** `capabilities.idempotency` 取 `keyed` / `marker` / `none`，面板显示代码的
  真实行为。
- **图片只按魔数判定**，绝不信任远端 Content-Type；超限或格式未知在落盘前拒绝。
- **`src/sources` 不 import `src/app`。** 双方都要用的类型留在 `src/sources`。

## 文档

上游的编号文档仍然描述 agent 本身，建议按顺序阅读：

- [000 设计哲学](docs/000-philosophy.md) · [001 领域模型](docs/001-domain.md) · [002 授权](docs/002-authorization.md) · [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md) · [005 面板](docs/005-panel.md) · [006 部署](docs/006-deployment.md) · [007 架构](docs/007-architecture.md) · [008 扩展手册](docs/008-cookbook.md)

本分支做的决策与理由：

- [docs/extensions/ADR-005-weixin-backend.md](docs/extensions/ADR-005-weixin-backend.md) —— 微信后端阶梯、交互式会话要求、探针记录与图片能力
- [docs/extensions/ADR-006-health-key-compatibility.md](docs/extensions/ADR-006-health-key-compatibility.md) —— 默认实例健康键为何不对称
- [EXTENSIONS.zh-CN.md](EXTENSIONS.zh-CN.md) —— 扩展详细说明（中文），[EXTENSIONS.md](EXTENSIONS.md) 为英文

## 许可

MIT，与上游一致。微信的 UI 自动化属于第三方工具：未获腾讯授权，可能被客户端或平台限制，
必须遵守 ADR-005 记录的边界——只在被 `@` 时回复，不做群发，不批量加好友。
