# 扩展说明：自建接入层

[English](EXTENSIONS.md) · **简体中文**

本分支是 [`open-dsh-superagent`](https://github.com/baojingyu/open-dsh-superagent) 的二次开发
（上游是研究原型，非 DeepSeek 官方产品），运行在 DeepSeek Harness 之上。上游只监听一个 GitHub
仓库（可选飞书）；本分支保留上游全部行为，并补上国内团队实际在用的接入来源。

上游自带文档描述的是 agent 本身；这个文件说明**加了什么**。

## 新增了什么

| 上游缺口 | 本分支补上 | 位置 |
| --- | --- | --- |
| 只有 GitHub | **GitLab**（自建）：合并请求、评论、流水线 | `src/sources/hosting/*` |
| 没有工作项 | **云效 Projex**：需求/缺陷/任务、评论、分页 | `src/sources/work/*` |
| 只有飞书 | **微信个人号**：群 `@`、消息图片 | `src/sources/chat/weixin/*` |
| — | **钉钉** Stream、**企业微信**加密回调 | `src/sources/chat/{dingtalk,wecom}/*` |
| 一个 kind 只能一个实例 | **一个 kind 多个实例**，配置/健康/KV 按实例隔离 | `src/sources/instance.ts`、`src/sources/registry.ts` |

五个可选插件随 bundle 发布，在 `cordis.patch.yml` 里**默认 `disabled: true`**：
`weixin`、`gitlab`、`projex`、`dingtalk`、`wecom`。它们各自是独立入口（`lib/*-watch.js`），
启用 = 改补丁 + 保存实例配置。

## 必须改掉的那个假设

上游只有一个扩展点 `SourceKind`，但它把「一种类型」当成「一个实例」：`registry.resolve()` 里
硬写 `id: kind.kind`。于是「两个 GitLab 项目」「两个微信号」都做不到。本分支把**设置键（实例 id）**
与**行为 id（kind id）**拆开，并保留一条兼容铁律：

> 默认实例 id 恒等于 kind id，因此已存的 Trigger、Thread、Mandate、Policy 无需迁移即可解析。

其余工作都从这一点出发——加**三个窄端口**，而不是三套临时集成：

```
src/sources/hosting/   HostAdapter  → hostingKind()   变更请求、评论、CI
src/sources/work/      WorkAdapter  → workKind()      工作项、评论、状态
src/sources/chat/      ChatAdapter  → chatKind()      消息、线程、图片
                       InboundTransport（poll | stream | webhook）、DeliveredRing
```

接一个新厂商 = 写一个几百行的适配器：Trigger 形状、MR 生命周期、CI 摘要、评论幂等、卡片与提示词
全部原样复用；只有身份与可见范围是厂商专属的。

## 微信为什么需要一个 sidecar

微信桌面客户端无法从 Node 直接驱动，所以它被放在一个**回环 HTTP sidecar** 后面，契约冻结
（七个端点、JSON 事件、`0600` Bearer token）。Node 侧只认契约，因此后端可替换：

| 层 | 后端 | 什么时候用 |
| --- | --- | --- |
| L0 | `wxauto` / `wxauto4` / `wxautox4`（UIAutomation） | 默认；需要**交互式 Windows 桌面会话** |
| L1 | `wxhelper` 一类注入 | L0 受窗口或版本限制时 |
| L2 | `WeChatPadPro`（iPad 协议） | 没有 Windows 机器 |
| L3 | 托管 API | 上面全挂且业务不能停 |

三条踩出来的事实，已经体现在本分支的行为里：

1. **客户端代际决定用哪个包。** 微信 4.x（`Weixin.exe`、`Qt51514QWindowIcon`）没有 3.9 的
   无障碍树，`wxauto` 3.9 装不上；要用 `wxauto4`/`wxautox4`，或把客户端钉在 3.9.11.17。
2. **探针必须与客户端在同一交互式桌面会话**。从 SSH、服务或已断开的 RDP 里跑，一个窗口都看不到。
3. **群 `@` 绝不按文本判定。** `scope` 只读结构化的 `ats`/mention 列表；机器人改昵称必须仍然生效。
   给不出这种列表的后端就不合格——这也是为什么后端是阶梯，而不是押一个开源项目。

## 消息图片

群里发的一张图，往往就是整份 bug 报告。链路：

```
sidecar /messages  →  ChatEvent.media  →  Trigger.meta.media
                   →  threadContext.read() 追加 [image:<id>]
                   →  images(text) 提取  →  image() 下载  →  作为附件给模型
```

保证：图片只按**魔数**判定，绝不信任远端 Content-Type；超过附件字节上限或格式未知，
**在落盘之前**就拒绝；`/media` 与 `/send` 共用同一把 UI 串行锁；没有 `ImageMessage.download()`
的后端返回 `501` 且不列 media，而不是下发一个下不了的 id。

## 验证状态

本分支实测（node 22.23.2）：

```bash
tsc --noEmit                      # 0
vitest run --maxWorkers=2         # 83 files（80 passed + 3 skipped）/ 1435 tests（1421 passed + 14 skipped），0 失败
tsdown                            # 构建成功，8 个入口：index + 7 个 watch 插件
LIVE=1 vitest run tests/live      # 对真实服务：13 passed + 1 skipped
```

对**真实对象**验证过（不只是 mock）：

- 真实 sidecar 进程 + 回环 HTTP：六个端点、幂等发送、`0600` token、`/media` 返回 PNG
- 真实 `gitlab.com` 公开 API：MR 映射；伪 token 映射为 401 且不回显 token
- 真实企微 / 钉钉 / 云效：鉴权失败被映射成可诊断错误
- 面板数据层：同一 kind 两个实例、删除一个、无 `kind` 的旧设置

**没有验证，也不在此声称：**

- 微信真机：是否存在结构化 `@` 列表仍未定，而它决定 L0 还是 L2
- 对真实代码托管/工作项的任何**写**操作（此处无凭据）
- 企微回调走公网反代；钉钉 Stream 未植 SDK
- 企微/钉钉的消息图片（只实现了微信这条路径）

## 改代码时要守的约定

- **`@` 绝不按文本判定。** 只读结构化 mention 列表；后端没有，就不合格。
- **一份状态一个写者。** Source 只能经 `SourceContext.tickets` 改工单；健康条目按实例 claim；
  回执只由 Outbox 写。
- **幂等是声明的。** `capabilities.idempotency` 取 `keyed` / `marker` / `none`，面板显示代码的
  真实行为；企微是 at-least-once，就写 at-least-once。
- **凭据来自文件**，每次调用读取并校验 `0600`，永不进消息。
- **`src/sources` 不 import `src/app`。** 双方都要用的类型留在 `src/sources`。

## 文件在哪

| 路径 | 内容 |
| --- | --- |
| `src/sources/instance.ts` | 实例 id 与 kind id 的拆分与兼容助手 |
| `src/sources/{hosting,work,chat}/port.ts` | 三个厂商契约 |
| `src/sources/{weixin,gitlab,projex,dingtalk,wecom}-watch.ts` | 五个可选插件 |
| `src/infra/{hosting-api,yunxiao-api}.ts` | 带 token 文件与路径白名单的 HTTP 客户端 |
| `cordis.patch.yml` | 五条 insert，全部 `disabled: true` |
| `docs/007-architecture.md` | 上游的模块与测试表，已为每个新文件补齐 |
| `tests/live/*.live.spec.ts` | 真实联调套件，由 `LIVE=1` 门控 |

## 许可

上游是 MIT 协议的研究原型；本分支沿用该协议，不额外提供任何保证。微信的 UI 自动化属于第三方工具：
未获腾讯授权，可能被客户端或平台限制，必须遵守上面的边界——只在被 `@` 时回复，不做群发，不批量加好友。
