# ADR-006 健康条目的键兼容：默认实例保留裸名

> 语言：[中文](ADR-006-health-key-compatibility.md) · [English](ADR-006-health-key-compatibility.en-US.md)

- **状态**：Accepted（2026-11-06，P0 实施中确认）
- **决策范围**：`SourceRegistry.healthEntries` / `sourceContextOf` / `views/sources.ts` 里健康条目的 key 形态
- **关联**：设计文档 §6.6、§4.3；P0 落地工单 §1.5；实施任务 t3

## 1. 背景

设计文档 §6.6/§4.3 要求"健康条目一律按 `instance:entry` 命名"：一个 kind 可有多个实例，只有把实例 ID 拼进 key，同一 kind 的两个实例才能各报各的健康、互不冲突。P0 工单 §1.5 与 §4 风险表 R2 的原始方案也写成"key 一律 `instance:entry`"。

但 P0 的硬约束是"行为零变化"：旧数据库里的设置、旧面板、既有运维脚本都按裸名 `github` / `feishu` / `history` 读取健康条目。若一律改成 `github:github`，旧面板升级瞬间会读不到健康，回滚旧版本也会读不到新形态的键。

## 2. 决定

- **默认实例（`id === kind`，如 `github`、`feishu`）沿用注册时 claim 的裸名条目**：`github`、`feishu`、`history`。
- **具名实例（`id !== kind`，如 `github-2`）惰性 claim `${instance}:${entry}`**：`github-2:github`。
- 理由：
  1. 旧数据库与旧面板读取零变化，升级无需迁移任何持久化数据；
  2. 回滚安全——旧版本仍能按裸名读到默认实例的健康；
  3. 具名实例是新增概念，没有历史包袱，直接采用规范形态。

## 3. 后果

- **键形态不对称**：同一 kind 的默认实例是 `github`，第二实例是 `github-2:github`。所有新增读取方都必须知道这条规则。
- **views 读取必须"先看裸名再看前缀"**：`views/sources.ts` 的 `entryOf` 用 `instance.id === instance.kind ? name : healthEntry(instance.id, name)`；`sourceContextOf` 把 `kind.id ?? kind.kind` 传给 `healthEntries`，由 `healthEntries` 在 `instance === kind` 时走注册期裸名条目、否则惰性 claim 前缀条目。
- **不要"顺手统一"**：把默认实例也改成 `github:github` 会立刻破坏旧面板与回滚兼容，属于需要单独评审的迁移。
- **未来若要统一的迁移步骤**：
  1. 新代码先双写双读：同时维护裸名与 `${instance}:${entry}` 两份键；
  2. 面板与视图先切到前缀形态，裸名保留一个版本作为回退；
  3. 健康是运行期内存态、本身不落库，故持久层通常无需变更；若有监控/脚本另存快照，需同步改读取路径；
  4. 观察一个发布周期无异常后，再删除裸名分支。
- **风险**：双写期间两份键可能短暂不一致（旧代码只写裸名），必须在同一次上报内一起更新；外部消费者若直接读裸名，迁移时会静默丢失告警。

## 4. 验收（测试覆盖的两侧）

- `tests/kv-instances.spec.ts`：覆盖 **key 生成侧**——`healthEntry('wecom-hr','wecom') === 'wecom-hr:wecom'`、与 `wecom-ops` 的不同，及新 KV 家族按实例分键。
- `tests/registry-instances.spec.ts`：覆盖 **claim/上报侧**——两个具名实例（`wecom-ops`/`wecom-hr`）各自 claim `${id}:wecom` 且互不覆盖，`report` 仍只允许 kind 声明的条目；旧 `github` 设置按裸名解析为默认实例（`id === kind` 侧由该文件第 2 条用例守住）。
