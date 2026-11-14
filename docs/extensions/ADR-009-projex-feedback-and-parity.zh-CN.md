# ADR-009：Projex 反馈、附件、成员同步与检索——我们能走通的那些路由

> 语言：[中文](ADR-009-projex-feedback-and-parity.zh-CN.md) · [English](ADR-009-projex-feedback-and-parity.md)

状态：已接受（2026-11-13）· 范围：`src/sources/work/**`、`src/infra/yunxiao-api.ts`、`src/app/store-read.ts`

## 背景

Projex 渠道已经能接收工作项并对其评论，但一次协作的三个阶段各自缺了一块：一次评论的评估只能看到那条评论本身；worker 不知道自己所在的是哪个工作项；看板从来没有动过。把这三块补齐时冒出四个问题，它们的答案无法从代码里直接看出来，因为官方 OpenAPI 把一些路由放在了客户端自身安全规则够不到的地方。本 ADR 记录我们调用什么、不调用什么，以及为什么。

## 决定

### 1. 状态按名称配置，并对该实例已读取过的状态解析

云效公布了一份工作流状态列表，但可达的形态是
`GET /oapi/v1/projex/projects/{projectId}/workitemTypes/{id}/workflows`——**仅 Region 版**：没有组织段（客户端会拒绝任何不含 `/oapi/v1/organizations/{白名单}/` 的路径），而且它需要一个适配器并不持有的 `workitemTypeId`。旧的 `GET /organization/{org}/workitems/workflow/listWorkflowStatus` 早于 `/oapi/v1/`，而网关已经下线了其它旧路径（`GET /listWorkitems` 返回 404），所以它不是一条可以依托的路由。

每个工作项**确实**都携带的是它当前的状态：`{id, name}`。因此一次轮询会记录它读到的状态名与 id（`KV.work.statuses`，上限 200），两个回写字段都接受名称或 id。一个不透明的 ASCII 记号会作为「我们没见过的 id」透传；一个我们没见过的人类名称会被拒绝，并给出获取它的位置（来源卡片上的 **Observed statuses** 动作，它列出上一次读取返回的内容）。这是用完整性换可达性：词表就是该项目近期工作项所展现的内容，而那恰好就是运维者会从中挑选的那个集合。

### 2. 附件先上传到工作项，再嵌入评论

`POST /oapi/v1/projex/organizations/{org}/workitems/{id}/attachments`（multipart `file`）可达且有文档。它返回 `embedMarkdown` / `embedUrl` / `url`；评论正文是工作渠道唯一拥有的写入面，所以上传返回的 Markdown 嵌入（图片）或 Markdown 链接（其它文件）会被追加到评论文本中。

三道护栏，因为这是一个让文件离开本机的渠道：worker 的 `orchestrator_report` 已经把每个路径解析到工单目录内，并拒绝可执行文件与超过 20 MiB 的文件；来源的 `sendFiles` 开关（默认**关**）在渠道里会被再读一次；渠道自己的 10 MiB 上限在 provider 里强制执行，超限的文件会在评论里被点名说明，而不是让这次投递失败。Projex 的真实大小上限未知，所以宿主侧的拒绝仍是最终裁定——那种失败会像任何其它回复失败一样，从 outbox 浮出来。

### 3. 成员名单从项目同步，而不是从组织同步

`GET /oapi/v1/platform/organizations/{org}/members` 可达，但整个组织对「谁可以在本项目上发起工作」来说是错误的范围。新式的 `GET /oapi/v1/projex/organizations/{org}/projects/{id}/members` 返回带 `userId` 与 `userName` 的项目成员，这才是正确的集合与正确的 id 形态：策略用 `allowed[].id` 与工作项的 `assignedTo` 比较，而在中心版里那就是成员的 `userId`。这个假设是被记录下来的，而不是被证明的（这里没有可用的在线 token）；一旦不匹配，会表现为每个工作项都被判为不在名单内，而策略卡片已经就此给出警告。

同步是共享 work 工厂上的一个 `policy.sync`，由新的 `syncMembers` 开关控制（默认**关**），因为同步会**替换**一份手工维护的名单。与飞书的同步一样，它只作用于默认实例：`Settings.syncable()` 解析 `kind(instance.id)`，而这只找得到 id 等于其实例 id 的 kind。

### 4. 检索解析的是流水号，不是线程

面板检索触发与线程；而人们输入的是工作项的人类编号（`ESFX-6228`）。`projexKind.find` 把裸流水号或一个 `…/workitem/…` 地址转成检索词，`Store.read.search` 精确匹配 `meta.serial`，与它此前精确匹配飞书 `meta.messageId` 的方式相同。工作项页面按流水号寻址，而线程以内部工作项 id 为键，所以这个解析能找出该工作项的触发与工单，但不会凭一个粘贴的 URL 绑定线程；绑定仍然走轮询写入的那个会话 id。

## 后果

- 有两件事仍未对真实组织验证：状态回写（从名称解析 id 已被证明，PUT 没有）以及附件嵌入在 RICH TEXT 评论里的版面。两者都在 `EXTENSIONS.md` 里标记为缺口；适配器的形状来自已公布的请求语法。
- 状态词表只随工作项被读取而增长。一个项目的工作项从未使用过的状态，在有一个工作项使用它之前无法按名称指定；直接输入它的 id 仍然可行。
- `sendFiles` 与 `syncMembers` 默认关闭，所以升级在运维者主动要求之前不改变任何行为。
