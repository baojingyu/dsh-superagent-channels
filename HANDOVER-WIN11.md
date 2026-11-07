# 交接文档：迁移到 Win11 继续开发

面向：接手本任务的工程师
基线日期：2026-11-07　基线提交：`b7bb154`
前置决定（已由 owner 确认，交接期内不改变）：**仓库不改名、不回退**；所有后续改动只提交到
`baojingyu/open-dsh-superagent`。

> 读完 §5 再动手。**§3.7 有一个 Windows 专属阻塞**，不处理的话所有 token 文件校验都会失败。

---

## 1. 当前状态基线

| 项 | 值 |
| --- | --- |
| 仓库（唯一 remote） | `https://github.com/baojingyu/open-dsh-superagent.git` |
| remote 配置 | `origin` fetch/push 均指向上面这一个 URL；**没有 `upstream` 等第二 remote** |
| 主分支 | `main` = `b7bb154`（`docs: this repository now describes itself, in English and Chinese`） |
| 主分支上一个提交 | `692e6b1`（`merge: self-hosted sources ...`，`--no-ff` 合并提交） |
| 备查分支 | `feat/multi-instance-sources` = `dc614f6`（内容与 `main` 一致，仅无 merge 提交；**保留，不删**） |
| 工作树 | 干净（`git status --porcelain` 为空） |
| 分支拓扑 | `8c32a9d`（上游原型）→ 7 个功能提交 → `692e6b1` merge → `b7bb154` docs |
| 默认启用状态 | 五个新插件在 `cordis.patch.yml` 里全部 `disabled: true` |

复核命令（Windows PowerShell，任意目录）：

```powershell
cd C:\dev\open-dsh-superagent
git remote -v
git log --oneline -3
git status --porcelain
git branch -vv
```

预期：`origin` 只有一行 fetch、一行 push，URL 均为 `baojingyu/open-dsh-superagent`；
`HEAD -> main` 指向 `b7bb154`；`git status` 无输出；`feat/multi-instance-sources` 与 `main` 内容一致。

---

## 2. 验证复核结果（迁移前基线）

以下结果在 **macOS arm64 / node 22.23.2 / npm 依赖通过 `--legacy-peer-deps` 安装** 的环境下取得。
迁移到 Win11 后**必须逐条复跑并与本表比对**，数字一致或更优才算环境搭好。

| # | 检查 | 命令 | 基线结果 |
| --- | --- | --- | --- |
| 1 | 类型检查 | `.\node_modules\.bin\tsc.cmd --noEmit` | 退出码 **0**，无输出 |
| 2 | 全量测试 | `.\node_modules\.bin\vitest.cmd run --maxWorkers=2` | **83 files**（80 passed + 3 skipped）/ **1435 tests**（1421 passed + 14 skipped）/ **0 failed** |
| 3 | 构建 | `.\node_modules\.bin\tsdown.cmd` | `Build complete`，**8 个入口**：`lib/index.js` + `lib/{github,feishu,weixin,gitlab,projex,dingtalk,wecom}-watch.js` |
| 4 | 真实环境用例 | `$env:LIVE='1'; .\node_modules\.bin\vitest.cmd run tests/live` | **3 files passed**，**13 passed + 1 skipped**（跳过项是 gitlab 匿名读评论 401，按设计跳过并打印原因） |
| 5 | 文档链接校验 | `.\node_modules\.bin\vitest.cmd run tests/docs.spec.ts` | **6 tests passed**（编号连续、链接可解析、模块表/测试表无遗漏、无 STALE） |

> 3 个 live 文件默认被 `describe.skipIf(process.env.LIVE !== '1')` 跳过，所以第 2 条里出现
> `3 skipped` 是正常的；它们只在第 4 条里真跑。

---

## 3. Win11 环境搭建步骤

### 3.1 依赖

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Git for Windows | 最新 | clone / push |
| Node.js | **22.x（`engines: ^22.19.0 \|\| >=24.0.0`）** | DSH bundle 与全部测试 |
| Python | **3.11–3.13** | 微信 sidecar、探针（均只用标准库，无需 pip 依赖） |
| WSL2（**推荐**，见 §3.7） | Ubuntu 22.04+ | 跑 Node 侧，规避 Windows 权限位问题 |

### 3.2 目录约定（**目录名必须这样，live 测试写死了相对路径**）

```
C:\dev\
  open-dsh-superagent\            ← 本仓库（clone 到这里）
  open-dsh-superagent-ext\        ← 设计/验收文档 + sidecar + 探针（同级目录）
    sidecar\wxauto-bridge\server.py
    poc\win_diag.py
    poc\probe_wxauto.py
```

原因：`tests/live/weixin-bridge.live.spec.ts` 用
`resolve(REPO, '..', 'open-dsh-superagent-ext', 'sidecar', 'wxauto-bridge', 'server.py')`
定位 sidecar。**只 clone 主仓库，第 4 条检查必失败**（`sidecar server.py 不存在`）。
把 `open-dsh-superagent-ext` 放在主仓库同级目录即可；也可放在别处并改那一行常量（需同步改测试）。

```powershell
cd C:\dev
git clone https://github.com/baojingyu/open-dsh-superagent.git
cd open-dsh-superagent
git checkout main
git pull --ff-only
# 把 open-dsh-superagent-ext 整个目录拷到 C:\dev\ 下（可从原开发机复制）
```

### 3.3 安装依赖（不要用 pnpm）

```powershell
cd C:\dev\open-dsh-superagent
npm install --ignore-scripts --legacy-peer-deps
```

- **为什么不用 pnpm**：本机 pnpm 11 会因 `ERR_PNPM_IGNORED_BUILDS`（`@anthropic-ai/claude-code` 的
  构建脚本未批准）直接失败，且非交互环境无法 `pnpm approve-builds`；`npm --legacy-peer-deps`
  可绕开 `@deepseek-ai/*` 的 peer 冲突。
- 若遇 `Cannot find package '@deepseek-ai/cordis-plugin-include'` 或
  `'@deepseek-ai/dsh-http-proxy'`（`tests/environment.spec.ts`、`tests/bundle-patch.spec.ts` 会红）：

```powershell
npm i @deepseek-ai/cordis-plugin-include@~1.0.10-alpha.1 @deepseek-ai/dsh-http-proxy@0.2.1-alpha.2 --legacy-peer-deps
```
  这两个包是 `dsh-subprocess` / bundle patch 的隐式依赖，pnpm 会装、`--legacy-peer-deps` 的 npm 不会。

### 3.4 跑第 2 节的五条检查（逐条执行，别合并）

```powershell
cd C:\dev\open-dsh-superagent

# 1) 类型检查
.\node_modules\.bin\tsc.cmd --noEmit; echo "tsc=$?"

# 2) 全量（限并发：并发过高会让计时敏感用例抖动）
.\node_modules\.bin\vitest.cmd run --maxWorkers=2

# 3) 构建
.\node_modules\.bin\tsdown.cmd; dir lib\*-watch.js

# 4) 真实环境（先决条件见 §3.5）
$env:LIVE='1'
.\node_modules\.bin\vitest.cmd run tests/live
Remove-Item Env:\LIVE

# 5) 文档门禁
.\node_modules\.bin\vitest.cmd run tests/docs.spec.ts
```

> **`--maxWorkers=2` 不是可选项**：无限制并发时，`runtime` / `panel` 一类计时敏感用例在高负载下会
> 偶发失败（本机曾出现 1~55 例抖动，串行或限并发后稳定 0 失败）。若出现失败，先单跑该文件确认，
> 再判断是不是真回归。

### 3.5 `LIVE=1` 的三个文件各自需要什么

| 文件 | 需要 | 不需要 |
| --- | --- | --- |
| `tests/live/weixin-bridge.live.spec.ts` | Python 3 + §3.2 的 sidecar 路径；自动 spawn `--backend fake` 并回收进程 | 微信客户端、任何 token、任何凭据 |
| `tests/live/gitlab-contract.live.spec.ts` | 能出网访问 `https://gitlab.com/api/v4` | token（匿名读公开 MR 列表；读 notes 会 401 → 按设计 skip） |
| `tests/live/thirdparty-errors.live.spec.ts` | 能出网访问企微 / 钉钉 / 云效 OpenAPI | 真实凭据（**故意用伪造凭据**触发真实鉴权失败，验证错误映射与不泄密） |

**结论：跑这三条不需要任何真实凭据。** 真实凭据只在你要真正启用某个来源（§3.6）时才需要。

手工验证 sidecar 能单独启动（可选，但排障时很有用）：

```powershell
cd C:\dev\open-dsh-superagent-ext\sidecar\wxauto-bridge
python server.py --backend fake --port 8787 --token dev-only
# 另一个窗口：
curl.exe -s -H "Authorization: Bearer dev-only" 127.0.0.1:8787/health
```

### 3.6 真实凭据的配置项与配置位置

凭据**不进 settings**：settings 里存的是**文件路径**，Node 每次调用读取该文件（并校验 `0600`，见 §3.7）。

| 来源 | 面板字段（Settings → Source） | 凭据文件 | 备注 |
| --- | --- | --- | --- |
| GitLab | `hostUrl`、`project`(group/name)、`tokenFile`、`organizationId?`、`pollSeconds` | PAT（scope `api`），一行纯文本 | 自建实例写 `https://gitlab.example.com` |
| 云效 Projex | `organizationId`、`project`、`tokenFile`、`categories`、`writeBack`(默认 false)、`pollSeconds` | `pt-…` 个人访问令牌 | `assignedTo` 是阿里云 accountID，配置里必须存机器人自己的 accountID |
| 微信 | `baseUrl`、`tokenFile`、`selfWxid`、`rooms[{id,name}]`、`atOnly`、`pollSeconds` | sidecar 的 Bearer token | `tokenFile` 与 sidecar 启动时的 `--token` 必须一致 |
| 钉钉 | `clientId`、`clientSecret`、`tokenFile?`、`robotCode?`、`atOnly`、`pollSeconds` | 可选（clientSecret 可放进文件） | 需要 `dingtalk-stream` SDK 注入 `connect`，否则只注册不启动 |
| 企业微信 | `corpId`、`corpSecret`、`agentId`、`tokenFile?`、`encodingAesKeyFile?`、`atOnly`、`pollSeconds` | 可选 | 回调需公网反代；`encodingAesKeyFile` 是 43 字符的 EncodingAESKey |

字段以面板为准；改完保存后按提示重启该实例。

### 3.7 ⚠ Windows 专属阻塞：`0600` 校验在 Windows 上必然失败

代码里有 5 处 POSIX 权限校验，例如 `src/infra/hosting-api.ts:71`：

```ts
if ((info.mode & 0o777) !== 0o600) throw new Error('The hosting token file must be owner-only (mode 0600)')
```

Node 在 Windows 上**合成** `mode`（普通文件通常是 `0o666`，只读是 `0o444`），不会反映 ACL。
结果是：**任何 tokenFile / keyFile 在 Windows 原生 Node 上都会被判为"权限不对"而抛错**，
五个来源都启用不了（测试不受影响，因为测试用注入桩或临时文件，不校验真实路径——但真实运行会撞）。

两种解法，二选一：

**A. 推荐：Node 侧跑在 WSL2 里**（微信客户端与探针仍在 Windows 原生侧）

```powershell
wsl --install -d Ubuntu-22.04
# 进入 WSL 后：
cd /mnt/c/dev/open-dsh-superagent
npm install --ignore-scripts --legacy-peer-deps
./node_modules/.bin/vitest run --maxWorkers=2      # 与 §2 基线一致
```
sidecar 仍跑在 Windows（`python server.py ...`），WSL 里的 Node 通过 `127.0.0.1` 访问即可
（WSL2 默认与宿主共享回环，若不通见 `netsh interface portproxy`）。

**B. 改代码：加平台守卫**（需要一次评审，属未做项）

```ts
const ownerOnly = process.platform !== 'win32'   // Windows 用 ACL，不用 POSIX 位
if (ownerOnly && (info.mode & 0o777) !== 0o600) throw new Error(...)
```
涉及文件：`src/infra/hosting-api.ts`、`src/infra/yunxiao-api.ts`、
`src/sources/chat/weixin/bridge.ts`、`src/sources/chat/wecom/{adapter,webhook}.ts`、
`src/sources/chat/dingtalk/adapter.ts`。若走 B，请同时补一条单测（模拟 `process.platform === 'win32'`）
并在 Windows 上用 `icacls` 收紧 ACL：

```powershell
icacls C:\secrets\gitlab.token /inheritance:r /grant:r "%USERNAME%:R"
```

### 3.8 微信真机链路（本机的重点，也是唯一未验证的能力）

```powershell
cd C:\dev\open-dsh-superagent-ext\poc
pip install wxautox4            # 微信 4.x + Python 3.9–3.13（商业版，已有授权）
python win_diag.py              # 先确认：客户端可见 + 客户端代际 + 建议安装哪个包
python probe_wxauto.py --selftest
python probe_wxauto.py --group "研发-交付群" --media --wait 120
```

- `win_diag.py` 必须输出 `"conclusion": "a WeChat window is visible in this session"`；
  否则先解决会话问题（**探针必须与已登录客户端在同一个交互式桌面会话**，不能从 SSH/服务/断开的 RDP 跑）。
- 报告路径会打印成绝对路径：`[probe] report written: ...\probe-report.json`。
- 客户端若是 4.x（`Weixin.exe` / `Qt51514QWindowIcon`），必须用 `wxauto4`/`wxautox4`；
  3.9.x 才用 `wxauto`。分类错误的典型报错是
  `the wxauto 3.9 accessibility tree was not found`。
- 相关历史与判定依据见 `docs/extensions/ADR-005-weixin-backend.md` §7。

---

## 4. 微信集成测试的待办与阻塞项

### 4.1 阻塞项（唯一）：Q1 缺证据

打开 `probe-report.json`，只看两个字段：

| 字段 | 含义 |
| --- | --- |
| `checks[]` 中 `"Q1 structured mentions"` | 是否有结构化 `@` 证据 |
| `q1SampleMessage.atListCandidates` | 具体是哪些字段（例如 `info.at_list`、`ats`） |

分支处理：

| 结果 | 动作 | 影响面 |
| --- | --- | --- |
| `atListCandidates` **非空** | 把真实字段名接进 `src/sources/chat/weixin/kind.ts` 的 `scope()`（当前读 `meta.ats`），并把 `bridge.toChatEvent` 的 `ats` 映射改成该字段；补 spec；**L0（pc-uia）准入** | 只改 weixin，其余不动 |
| `atListCandidates` **为空** | 群 `@` **不得**用 `@昵称` 文本反解（硬规则），后端切 **L2（WeChatPadPro, iPad 协议）** | 只改 sidecar 后端与 weixin 的字段映射；Node 侧结构不变 |

> 备注：`ChatEvent.ats` 目前由 sidecar 的 `atUsers`/`ats` 字段填充；若真机字段名不同，
> 由 sidecar 统一改名即可，Node 侧无需感知——这是当初把微信放到 sidecar 后面的收益。

### 4.2 低优先级、已记录未修

| 编号 | 问题 | 位置 | 建议修法 |
| --- | --- | --- | --- |
| IMG-1 | 只校验单图 `maxImageBytes`，未叠加 `maxMessageImageBytes` / 每消息图片数上限 | `src/sources/chat/weixin/media.ts` | 在 `readWeixinImage` 之前汇总本条消息所有 media 的总字节与数量 |
| IMG-2 | 先整块 `arrayBuffer` 再查限，未做流式上限 | `src/sources/chat/weixin/bridge.ts` (`media()`) | 校验响应 `Content-Length`，或读流并累计超过上限即中止 |
| IMG-3 | sidecar `/media` 成功分支未显式拒零字节 | `open-dsh-superagent-ext/sidecar/wxauto-bridge/server.py` | `if not raw: return 404` |
| IMG-4 | `imageIds()` 从正文解析 `[image:<id>]`，用户可自造标记触发一次请求 | `src/sources/chat/weixin/media.ts` / `thread.ts` | 只接受 `Trigger.meta.media` 里出现过的 id（需给 `threadContext` 传白名单） |

| 编号 | 问题 | 说明 |
| --- | --- | --- |
| t41-review | t41 那次修复（钉钉 `idempotency` 改 `none`、重连 `setTimeout` 改可中断）只做了命令级复跑，**未做正式代码级复审** | 建议与下批合并做一次 `review` 轮，重点看 `src/sources/chat/dingtalk/stream.ts` 的 abort 语义 |

### 4.3 微信外的下一步（可选，按业务优先级）

1. 真实凭据联调：GitLab 发评论（需 PAT）、云效工作项读写（需 `pt-` token）；
2. 企微回调挂到 `app/http.ts` 的公共路由 + 公网反代（当前只有纯函数 `handleWebhook`）；
3. 钉钉 Stream 植入 `dingtalk-stream` SDK 的 `connect`；
4. 面板多实例的像素级验收（需要一个能与本会话分离的 DSH 宿主，否则加载插件会重启宿主）。

---

## 5. 交接注意事项

1. **先复跑、再动手。** 到岗后第一件事是按 §3.4 跑完五条检查，把结果填进 §2 的表格。任何一条与基线不一致，先解决环境，不要开始改代码。
2. **只推 `origin`。** `git remote -v` 里应当只有 `baojingyu/open-dsh-superagent` 一个 remote；**不要**添加任何指向官方/上游仓库的 remote，也不要向其它仓库推送。
3. **不改名、不回退。** 仓库名与 main 历史均保持现状；`feat/multi-instance-sources` 保留备查，不删。
4. **不要在 `main` 上做实验。** 起 `feat/<topic>` 分支，`--no-ff` 合并回 `main`，保持提交可回溯。
5. **必须等外部输入才能推进的项**（不要靠猜）：
   - 微信群 `@` 的字段名 → 等 `probe-report.json` 的 Q1（§4.1）
   - GitLab 写操作 → 等 PAT
   - 云效读写 → 等 `pt-` token 与 organizationId
   - 企微回调 → 等公网入口与反代
   - 钉钉 Stream → 等 SDK 接入方案确定
6. **两条硬规则，别绕过**：群 `@` 绝不按文本判定；`src/sources` 不得 `import src/app`（会导致架构反向依赖）。
7. **`--maxWorkers=2`**：全量测试一律限并发，失败先单跑确认是否计时抖动。
8. **Windows 上先看 §3.7**：`0600` 校验会让真实凭据全部抛错，选 A（WSL2）或 B（加守卫）后再接真实来源。

---

## 附：命令速查

```powershell
# 环境
cd C:\dev\open-dsh-superagent
npm install --ignore-scripts --legacy-peer-deps

# 五条基线
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\vitest.cmd run --maxWorkers=2
.\node_modules\.bin\tsdown.cmd
$env:LIVE='1'; .\node_modules\.bin\vitest.cmd run tests/live; Remove-Item Env:\LIVE
.\node_modules\.bin\vitest.cmd run tests/docs.spec.ts

# sidecar（排障）
cd C:\dev\open-dsh-superagent-ext\sidecar\wxauto-bridge
python server.py --backend fake --port 8787 --token dev-only

# 微信真机探针
cd C:\dev\open-dsh-superagent-ext\poc
python win_diag.py
python probe_wxauto.py --selftest
python probe_wxauto.py --group "研发-交付群" --media --wait 120

# 提交（只在 topic 分支上）
git switch -c feat/<topic>
git add -A; git commit -m "feat(...): ..."
git push -u origin feat/<topic>
```

| 症状 | 处理 |
| --- | --- |
| `ERR_PNPM_IGNORED_BUILDS` | 不要用 pnpm，按 §3.3 用 npm |
| `Cannot find package '@deepseek-ai/cordis-plugin-include'` | 按 §3.3 补装两个包 |
| live weixin 报 `sidecar server.py` 不存在 | 目录不是同级（§3.2） |
| `must be owner-only (mode 0600)` | Windows 权限位问题（§3.7） |
| gitlab live 里 notes 被 skip | 预期行为：匿名读评论 401，不是失败 |
| 全量测试偶发失败 | 加 `--maxWorkers=2` 重跑，单跑该文件确认 |
| `the wxauto 3.9 accessibility tree was not found` | 客户端是 4.x，装 `wxauto4`/`wxautox4`（§3.8） |
| 探针 `no WeChat window` | 与客户端不在同一交互式会话（§3.8） |
