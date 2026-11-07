# 交接文档：迁移到 Win11 继续开发

面向：接手本任务的工程师
基线日期：2026-11-07　文档版本：**v4**（随本轮微信收口更新）　基线提交：见 §1
前置决定（已由 owner 确认，交接期内不改变）：**仓库不改名、不回退**；所有后续改动只提交到
`baojingyu/open-dsh-superagent`。

> 读完 §5 再动手。**§3.7 的 Windows 阻塞已在 v3 修掉**（平台守卫），但**微信群 `@` 的结论是
> 「L0 拿不到」**，见 §4.1 —— 这一条改变了微信的可用范围，务必先读。

### 文档变更记录

| 版本 | 变更 |
| --- | --- |
| v1 | 初版，基线 `b7bb154` |
| v2 | 基线更新为 `4b7a7f8`（本文档自身所在的提交）；补充 `README.md`/`README.zh-CN.md` 中 sidecar 路径修正的说明；故障速查表新增 `push` 代理抖动（`Proxy CONNECT aborted`）的处理方式 |
| v3 | Win11 机器上真正跑起来了：§2 基线在 Windows 上**逐条复跑**并补齐 64 个 Windows 专属失败；§3.7 阻塞改为**已修复**（平台守卫 + `icacls` 分工）；§4.1 的 Q1 **已有真机定论：L0 拿不到结构化 `@`**，后端按 ADR-005 落 L2/L1；新增 §4.4 后端能力自述与 L1 证据；§3.2 补充 `open-dsh-superagent-ext` 在本机的实际位置；速查表新增 Python 解释器与 `sleep` 两条 |
| v4 | **§4.1 结论修正**：v3 的「L0 不可用」判断是错的——收消息要改用监听模式（`AddListenChat` + `StartListening`），群 `@` 用客户端自己的 mention 标记（`@名` + `U+2005`）判定，`capabilities.mentions` 从布尔改为 `structured`/`markup`/`none` 三态；新增 §4.2 的 `POST /listen`（面板一次配置）与 `wxname_<hash>` 身份；判据名改 60 秒 TTL 重读，**改名不用重启**；ADR-005 §7 记录 L1 密钥突击的实测边界（未拿到密钥，附已排除项与校准方法） |

---

## 1. 当前状态基线

| 项 | 值 |
| --- | --- |
| 仓库（唯一 remote） | `https://github.com/baojingyu/open-dsh-superagent.git` |
| remote 配置 | `origin` fetch/push 均指向上面这一个 URL；**没有 `upstream` 等第二 remote** |
| 主分支 | `main` = v3 落地提交（`feat/win11-portability` 以 `--no-ff` 合并） |
| 主分支近期提交 | `b7bb154`（README 改写为仓库首页）→ `692e6b1`（`merge: self-hosted sources ...`，`--no-ff` 合并提交）→ `4b7a7f8`（v2 本文档）→ `f2891e8`（v2 文档变更记录） |
| 备查分支 | `feat/multi-instance-sources` = `dc614f6`（内容与 `main` 一致，仅无 merge 提交；**保留，不删**） |
| 工作树 | 干净（`git status --porcelain` 为空） |
| 分支拓扑 | `8c32a9d`（上游原型）→ 7 个功能提交 → `692e6b1` merge → `b7bb154` README → `4b7a7f8` v2 文档 → `f2891e8` → v3 移植提交 |
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
`HEAD -> main` 指向 `4b7a7f8`；`git status` 无输出；`feat/multi-instance-sources` 与 `main` 内容一致。

---

## 2. 验证复核结果（迁移前基线）

以下结果在 **macOS arm64 / node 22.23.2 / npm 依赖通过 `--legacy-peer-deps` 安装** 的环境下取得。
迁移到 Win11 后**必须逐条复跑并与本表比对**，数字一致或更优才算环境搭好。

| # | 检查 | 命令 | 基线结果（macOS） | Win11 实测（v3） |
| --- | --- | --- | --- | --- |
| 1 | 类型检查 | `.\node_modules\.bin\tsc.cmd --noEmit` | 退出码 **0**，无输出 | **0**，无输出 |
| 2 | 全量测试 | `.\node_modules\.bin\vitest.cmd run --maxWorkers=2` | **83 files**（80 passed + 3 skipped）/ **1435 tests**（1421 passed + 14 skipped）/ **0 failed** | **84 files**（81 passed + 3 skipped）/ **1456 tests**（1421 passed + **35 skipped**）/ **0 failed** |
| 3 | 构建 | `.\node_modules\.bin\tsdown.cmd` | `Build complete`，**8 个入口** | `Build complete`，**8 个入口**（`lib/index.js` + 7 个 `*-watch.js`） |
| 4 | 真实环境用例 | `$env:LIVE='1'; .\node_modules\.bin\vitest.cmd run tests/live` | **3 files passed**，**13 passed + 1 skipped** | **3 files passed**，**13 passed + 1 skipped**（weixin 的 8 条全绿，含真实 Python sidecar 进程） |
| 5 | 文档链接校验 | `.\node_modules\.bin\vitest.cmd run tests/docs.spec.ts` | **6 tests passed** | **6 tests passed** |

> 3 个 live 文件默认被 `describe.skipIf(process.env.LIVE !== '1')` 跳过，所以第 2 条里出现
> `3 skipped` 是正常的；它们只在第 4 条里真跑。

**Windows 上跳过数从 14 变成 35，这是预期且已登记的**，不是回归：

| 跳过来源 | 条数 | 说明 |
| --- | --- | --- |
| live 文件的 `LIVE=1` 门控 | 14 | 与 macOS 相同（8 + 3 + 3） |
| `tests/service-script.spec.ts` | 15 | 被测算物 `scripts/dsh-superagent` 是 POSIX 服务管理器（`fcntl`/`flock`/`ps`/`tmux`/`killpg`），Windows 支持属未做项，见 §5.10 |
| `tests/sources.spec.ts` | 6 | 飞书假 CLI 必须是活子进程，而 Windows `spawn` 只能起 PE 映像；真实 `lark-cli` 是原生二进制 |

每处 `it.skipIf` 都在注释里写明**跳过后哪部分行为未被覆盖**，没有删测试。新增的
`tests/secret-file.spec.ts`（8 条）与 weixin 的 13 条新断言全部真跑通过，所以 `passed` 仍是 1421。

### 2.1 Win11 上原样迁入时的失败（v3 已全部修掉）

把 macOS 上全绿的提交直接 clone 到 Win11 跑，得到 **15 failed files / 64 failed tests**，
外加 **`tests/environment.spec.ts` 的 6 条**（合计 16 个文件 / 70 条）。

> 为什么容易漏掉最后这 6 条：vitest 的 JSON 报告把它记成**文件级 0 断言**
> （`{p:0,f:0,s:0}`），`assertionResults` 是空的，所以按断言枚举失败的脚本一条都抓不到。
> **核对 Windows 基线时必须同时看汇总行里的 `Errors N errors`**，那是文件级失败与
> unhandled rejection 的出口。

这不是环境没搭好，而是**测试与少数产品代码里写死了 POSIX 假设**。分类与处理：

| 组 | 数量 | 位置 | 根因 | 处理 |
| --- | --- | --- | --- | --- |
| A | 23 | weixin-bridge / weixin-media / work-projex / hosting-gitlab / wecom-webhook / dingtalk-adapter | `mode & 0o777 === 0o600`：Windows 上 Node **合成** mode（`0o666`/`0o444`），`chmod 0o644` 与 `0o600` 不可区分 | 见 §3.7：新增 `src/infra/secret-file.ts` 平台守卫；相关断言在 Windows 上把平台打桩成 `linux` 继续验证 POSIX 分支 |
| B | 19 | `tests/service-script.spec.ts`、`tests/commands.spec.ts` | 测试 spawn `sh`/`sleep`/`echo`/`env`；Windows 上 `ENOENT` 或退出码 **9009**（命令未找到） | 改用 `process.execPath -e` 等等价替代，保住退出码/停止/锁/日志保留的语义 |
| C | 5 | `tests/deployment.spec.ts` + `src/deployment.ts` | schema 用 `/^\//` 要求 POSIX 绝对路径，`C:\...` 直接不过 | **产品 bug**：改为平台感知的绝对路径判定：`C:\x`、`C:/x`、`\\server\share`、前导 `/` 都接受；`C:state`（盘符相对）、相对路径、`~/dir` 仍拒绝 |
| D | 3 | `tests/docs.spec.ts` | 三处叠加：`path.relative()` 产出 `src\admission.ts`；`split('\n')` 不剥 CRLF 导致 `indexOf('## Modules')` 返回 `-1`；`lastIndexOf('/')` 在 Windows 绝对路径上取不到文件名 | 比较前 `posix()` 归一、`split(/\r?\n/)`、`basename()` |
| E | 1 | `tests/store.spec.ts` | 断言目录 `0o700` / 文件 `0o600` | 同 A 的处理方式（`src/app/store.ts` 本身没有 owner-only 校验，只有尽力而为的 `chmod`，产品侧无需改） |
| F | 1 | `tests/runtime.spec.ts` | **产品是对的**：它按 gitconfig 规则转义 `\`，而测试期望用裸路径。macOS 上路径无反斜杠，转义是恒等变换，所以一直绿 | 测试按同一套转义规则比对；同一测试里的 `check[0] === 'env'` 与 `PATH.split(':')` 一并改对 |
| G | 6 | `tests/sources.spec.ts` | 飞书假 CLI 是 `#!` 脚本，产品自己 `spawn` 它；Windows `spawn` 只能起 PE 映像（`#!` → ENOENT，`.cmd` → EINVAL） | 6 条带注释 `it.skipIf(win32)`（见 §2 跳过说明） |
| H | 2 | `tests/bundle-patch.spec.ts` | 缺 `@deepseek-ai/cordis-plugin-include` / `@deepseek-ai/dsh-http-proxy` | §3.3 的两个补装包，纯环境问题 |
| I | 6 | `tests/environment.spec.ts` | 假 CLI 与产品生成的 shim 都是 `#!/bin/sh`；`PATH.split(':')`；`--show-origin` 不带 `-z` 时 git for Windows 会给含反斜杠的路径加 C 风格引号（**产品用的是 `-z`，输出原样，所以产品无 bug**） | shim 交给 Git for Windows 自带的 `sh` 执行；`delimiter` 拼拆；改成 `-z` 并按 NUL 切分 |
| J | — | `src/deployment.ts` | **产品 bug（部署级）**：`workerProbe` / `resolveFeishuBot` 给子进程加前导 `env` 命令，Windows 没有 `env.exe` → **worker 侧所有 CLI 探针在 Windows 上必失败** | `Probe` 增加 env 参数、交给 `runAsWorker(..., env)`；PATH 语义核实为「替换」而非「追加」 |

另外两条与 Python 相关的坑（不在上表之内，但会让人以为 sidecar 坏了）：

- `python3` 在 Windows 上是 **Microsoft Store 的占位程序**，执行即报
  `Python was not found`。`tests/live/weixin-bridge.live.spec.ts` 现在按
  `process.env.PYTHON ?? (win32 ? 'python' : 'python3')` 解析解释器。
- Node 的 `kill('SIGTERM')` 在 Windows 上是 `TerminateProcess`，Python 收不到信号；
  端口仍会释放，`leaves no listener behind` 照样成立。sidecar 自己也装了
  `CTRL_BREAK` 处理器，正常停机时退出码 0 并打印 `stopped`。

---

## 3. Win11 环境搭建步骤

### 3.1 依赖

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Git for Windows | 最新 | clone / push |
| Node.js | **22.x（`engines: ^22.19.0 \|\| >=24.0.0`）** | DSH bundle 与全部测试 |
| Python | **3.11–3.13** | 微信 sidecar、探针（均只用标准库，无需 pip 依赖） |
| WSL2 | **不再需要**（v3 起） | §3.7 的权限位问题已由平台守卫解决，Node 侧可以直接跑在 Windows 上 |

> Python 用哪个解释器很重要：`python3` 在本机是 Microsoft Store 的占位程序（执行即
> `Python was not found`）。真实解释器是 `python`（3.12.10）。要跑 `wxautox4` 时用装了它的那个
> 解释器，本机是 `D:\<wxauto4-env>\<wxbot-dir>\.venv\Scripts\python.exe`；
> 只跑 sidecar 的 `fake` 后端和探针的 `--selftest` 时，系统 `python` 就够。

### 3.2 目录约定（**目录名必须这样，live 测试写死了相对路径**）

```
C:\dev\
  open-dsh-superagent\            ← 本仓库（clone 到这里）
  open-dsh-superagent-ext\        ← 设计/验收文档 + sidecar + 探针（同级目录）
    sidecar\wxauto-bridge\server.py       ← 契约实现（fake / pc-uia / pad）
    sidecar\wxauto-bridge\contract.md     ← 冻结契约（bridge.ts 引用的就是它）
    poc\win_diag.py                       ← 会话/窗口/代际诊断
    poc\probe_wxauto.py                   ← Q1/Q2/Q4 探针，产出 probe-report.json
    verify\live-contract.mjs              ← 用真实 bridge.ts 跑契约断言
    verify\signal-check.py                ← 停机 / 零字节 / 绑定 / 只读性断言
```

原因：`tests/live/weixin-bridge.live.spec.ts` 用
`resolve(REPO, '..', 'open-dsh-superagent-ext', 'sidecar', 'wxauto-bridge', 'server.py')`
定位 sidecar。**只 clone 主仓库，第 4 条检查必失败**（`sidecar server.py 不存在`）。
把 `open-dsh-superagent-ext` 放在主仓库同级目录即可；也可放在别处并改那一行常量（需同步改测试）。

> v3 之前 `open-dsh-superagent-ext` 不在版本库里，本机是按契约重新实现的。它现在的结构就是上面这张表；
> 契约的权威定义是 `contract.md`，Node 侧的权威消费者是 `src/sources/chat/weixin/bridge.ts`，
> 两者必须逐字段一致（`verify/live-contract.mjs` 就是拿真实客户端跑这份一致性）。

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

> **解释器**：`weixin-bridge.live.spec.ts` 用
> `process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')` 选解释器。
> Windows 上 `python3` 是 Microsoft Store 的占位程序（执行即 `Python was not found`，退出码 9009），
> 所以默认用 `python`。要用别的解释器就 `$env:PYTHON='C:\path\to\python.exe'`。
> 该 spec 用 `--backend fake`，**不需要 `wxautox4`**，标准库足够。

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

### 3.7 `0600` 校验：v3 已修复（平台守卫 + ACL 分工）

**问题**：代码里有多处 POSIX 权限校验，例如原来的 `src/infra/hosting-api.ts:71`：

```ts
if ((info.mode & 0o777) !== 0o600) throw new Error('The hosting token file must be owner-only (mode 0600)')
```

Node 在 Windows 上**合成** `mode`（普通文件 `0o666`，只读 `0o444`），不反映 ACL。于是任何
tokenFile / keyFile 在 Windows 原生 Node 上都被判「权限不对」，五个来源全部启用不了，
而且**测试也会红**（测试同样会写临时 token 文件并 `chmod 0600`）。

**v3 的做法：平台守卫**（不是 WSL2）。所有读取点统一走
`src/infra/secret-file.ts`：

```ts
/** Reads a secret file whose contents must be readable only by this account. */
export function readSecretFile(file: string, what: string): string
/** The owner-only check the readers share; POSIX bits only, and Windows has none. */
export function requireOwnerOnly(mode: number, file: string, what: string): void
```

- **POSIX（`process.platform !== 'win32'`）**：行为完全不变，`mode & 0o777 !== 0o600` 仍然抛错。
- **Windows**：跳过 POSIX 位检查（那些位没有意义），但仍拒绝**缺失 / 目录 / 空文件**。
- 错误文案逐点保留（各调用点的 `0600`、`owner-only`、`Yunxiao token file must have mode 0600` 都没改）。

调用点：`src/infra/hosting-api.ts`、`src/infra/yunxiao-api.ts`、
`src/sources/chat/weixin/bridge.ts`、`src/sources/chat/wecom/{adapter,webhook}.ts`、
`src/sources/chat/dingtalk/adapter.ts`。

**Windows 上权限靠 ACL，不靠 mode 位——这是运维动作，不是代码动作**：

```powershell
# 去掉继承，只给当前用户读
icacls C:\secrets\gitlab.token /inheritance:r /grant:r "%USERNAME%:R"
```

**测试怎么处理**：POSIX 位这条语义不能因为平台就丢掉。相关断言在 Windows 上把
`process.platform` 打桩成 `'linux'` 后继续跑（`Object.defineProperty` + `finally` 还原），
于是「0644 必须被拒」在所有平台上都被验证；只有确实无法表达的用例才
`it.skipIf(process.platform === 'win32')` 并写明原因。Windows 上若还有跳过数，都是这一类。

### 3.8 微信真机链路

**v3 已跑通，并且已经得出结论（见 §4.1）：L0 拿不到结构化 `@`。** 这里只留操作方式。

```powershell
cd C:\dev\open-dsh-superagent-ext\poc
# 用装了 wxautox4 的那个解释器；本机是：
$PY = "D:\<wxauto4-env>\<wxbot-dir>\.venv\Scripts\python.exe"
& $PY win_diag.py                 # 会话 + 窗口 + 代际 + 建议装哪个包
& $PY probe_wxauto.py --selftest  # 不碰微信，只验证报告链路
& $PY probe_wxauto.py --group "<群名>" --media `
```

- `win_diag.py` 必须输出 `"conclusion": "a WeChat window is visible in this session"`；
  否则先解决会话问题（**探针必须与已登录客户端在同一个交互式桌面会话**，不能从 SSH/服务/断开的 RDP 跑）。
  它同时打印每个微信窗口的 `session` 和 `visible`，以及客户端进程的会话。
- 报告路径会打印成绝对路径：`[probe] report written: ...\probe-report.json`。
  **报告一定写**：`--selftest` 与异常路径都会写，这是 v3 的硬要求（旧版「跑完没有报告」无从排查）。
- 客户端若是 4.x（`Weixin.exe` / `Qt51514QWindowIcon`），必须用 `wxauto4`/`wxautox4`；
  3.9.x 才用 `wxauto`。分类错误的典型报错是
  `the wxauto 3.9 accessibility tree was not found`。
  进程退出即失效）；不传则按未授权处理，探针照样出报告。
- **`GetAllMessage()` 只覆盖当前窗口已渲染的消息**，而 `ChatWith()` 在目标已是当前会话时
  不会重绘、返回空列表。探针的做法是「先切到 `--away`（默认 `文件传输助手`）再切回来 + 轮询」，
  sidecar 轮询必须复用同一策略，否则会周期性读到 0 条。
- 相关历史与判定依据见 `docs/extensions/ADR-005-weixin-backend.md` §7。

---

## 4. 微信集成测试的待办与阻塞项

### 4.1 群 `@` 与收消息：**结论修正**（v3 的第一版判断错了）

先说结论，再说我错在哪，因为按错的结论会把一个能用的后端关掉。

**现在的事实**：`pc-uia` 可以收真实群消息与私聊，并且能判定群 `@`。判定强度是 `markup`
（客户端自己的 mention 标记），不是 `structured`（结构化列表）。微信 4.x 上**确实没有**
结构化列表，这一点原判断是对的；**错的是从它推出「后端不可用」**。

#### 错误一：用 `GetAllMessage()` 轮询收消息

`GetAllMessage()` 只返回当前窗口**已渲染**的消息，而 `ChatWith()` 在目标已是当前会话时不会重绘，
于是周期性读到 0 条。我把这个现象当成了「L0 收不到群消息」。

本机有一个能跑的生产实现 `D:\<wxauto4-env>\<wxbot-dir>\wxbot_core.py`
（owner 确认它能收群消息、私聊并自动回复），它收消息用的是**监听模式**：

```python
self.wx.AddListenChat(nickname=..., callback=self.message_handle_callback)
self.wx.StartListening()
```

真机复测（只用「文件传输助手」自测）确认：`StartListening()` 之后 `SendMsg` 一条，回调**实时触发**，
`chat` 给出 `{'who': '文件传输助手', 'chat_type': 'friend'}`。**推送式，不依赖窗口渲染。**

> **坑（sidecar 已按此实现）**：微信 4.x 的监听**必须注册在主线程**，且此后任何跨线程的微信调用
> 都会让回调彻底失效。三种组合实测：全主线程 ✅ / worker 线程 setup ❌ 0 次回调 /
> 主线程 setup + worker 只 `SendMsg` ❌ 0 次。所以 HTTP 服务走后台线程、主线程归微信，
> 所有微信调用经主线程执行器串行排队（顺带满足 UI 串行化）。
> 主线程还必须**每 200ms 回到解释器循环**，否则收不到 `SIGBREAK`/`SIGINT`（阻塞在
> `Event.wait()` 上时信号不被处理，停机变成「永不退出」）。

#### 错误二：把「没有结构化列表」推成「不准入」

生产实现用的是文本子串匹配：

```python
self.config.AtMe = "@" + self.wx.nickname      # wxbot_core.py:2714
if self.config.AtMe in message.content: ...    # 3381 / 3405 / 3729 / 3748
```

它确实工作。但子串匹配连「他刚才说了 `@<昵称>` 这句话」都会误判。**更好的判据是客户端自己的标记**：
真的从 mention 列表里选人时，微信插入的是 `@<显示名>` + **`U+2005`（四分宽空格）**；人工手打是
`U+0020`。真机 dump 的证据：

```
"@<成员>\u2005一会儿带两个豆浆回来，我们吃过了"
"@<成员>\u2005妈"
```

所以判据是「`@本账号显示名` + `U+2005`」或「以 `@本账号显示名` 结尾」，另外 `@所有人\u2005`
也算对本账号说话。**这不是文本反解**——它要求客户端生成的标记，手打不出来。

#### 三条代价，必须记住

1. **判据名会变**：判据含本账号显示名。现在**不用重启**——显示名按 **60 秒 TTL** 重读
   （`--self-name-ttl`），`POST /listen` 时**强制重读**，`/messages` 轮询也顺带刷新；
   `/health` 与 `/status` 的 `detail` 直接写出当前判据名（`群 @ 判据：@<昵称>`）。
   读失败保留旧名并记 note——清空会让判定永远不命中，比旧值更糟；
2. **可伪造**：分隔符能被粘贴，所以它比子串匹配强，但**不是不可伪造**；
3. 因此「群 `@` 可以当授权」这句话只在 `capabilities.mentions` 声明了强度之后才成立。

Node 侧结构不变：`kind.ts` 只读 `meta.ats`，sidecar 决定怎么填。

### 4.2 后端能力自述：`/health.capabilities`（v3 新增，本轮改为三态）

面板必须说实话，而不是让「没被 @」和「看不出有没有 @」长得一样。

```json
"capabilities": { "mentions": "markup", "members": "observed", "media": true }
```

| 后端 | `mentions` | `members` | `media` |
| --- | --- | --- | --- |
| `fake`（契约参考实现） | `structured` | `full` | `true` |
| `pc-uia`（微信 4.x，监听模式） | `markup` | `observed` | 取决于 Plus 构建的 `download()` |
| `pad`（桩） | `none` | `none` | `false` |

`mentions` 三态：`structured`（客户端给的列表）/ `markup`（客户端标记 + 本账号显示名）/ `none`。
`members` 三态：`full` / `observed`（只列已见过的发送人）/ `none`。
`media` 保持布尔。**布尔仍被接受**（`true` → `structured`/`full`，`false` → `none`），老 sidecar 不会因此报错。

Node 侧消费方式（已落地，有测试）：

- `bridge.ts`：`BridgeCapabilities` + `health()` 逐字段解析并归一布尔；**整体缺失时该字段为 `undefined`**，
  「没报告」和「报告了有能力」是两件事，不能混。
- `kind.ts` 的 `scope()`：只有 `mentions === 'none'` 才走「判不出」分支，记
  `reason: 'mentions_unsupported'`（而不是 `group_ambient`）。差别是：`group_ambient` 声称
  「看过了，没人 @ 你」，`mentions_unsupported` 说的是「这个后端根本看不出」。
  `markup` 与 `structured` 走同一条判定路径——都能产出 `ats`，差别只在证据强度。
- `kind.ts` 的 `facts()`：按三态给出不同措辞。`markup` 明确写出「改本账号昵称即失效，粘贴分隔符可伪造」，
  因为把可伪造的信号当授权是真实风险。
- `kind.ts` 的 `refreshLabels()`：`wxname_<hash>` 解析回显示名，供面板行显示（复用 Feishu 那套机制）。
- `weixin-watch.ts`：每轮读一次 `/health`（loopback，很便宜），换后端不用重启插件。

#### 身份：`wxname_<hash>` 命名空间，而不是放宽 id 正则

L0 拿不到 chatroomId，也拿不到发送人 wxid（`sender_info()` 实测滞后一条消息、有时为 `null`）。
Node 侧 `rooms[].id` / `policy.allowed[].id` 的 `^[A-Za-z0-9_-]+$` 会拒绝中文显示名——
**这个严格性要保住**，因为它是准入闸门。所以身份归一做在 sidecar：

- 会话与发送人：`wxname_<sha1(显示名)[:16]>`，`name` 字段带显示名；
- `/send` 的 `room` 同时接受 `wxname_…` 与显示名；
- `refreshLabels` 把 id 解析回显示名。

代价同样要写明：**显示名改了 id 就变**，配置要跟着改。这是没有 chatroomId 的必然结果，不是 bug。

#### 监听集合由面板决定：`POST /listen`

监听模式下 sidecar 必须先知道「听哪些会话」。第一版只给了 `--listen` 命令行参数，
于是运维要在 sidecar 启动参数和面板里各写一遍同一批群，漏一处就「配了但收不到」。
现在补了第 7 个端点，配置只在面板里写一次：

```http
POST /listen
{"rooms": ["研发-交付群", "wxname_3da351bad1d722cb"]}
→ 200 {"listening":[{"id":"wxname_…","name":"研发-交付群"}],
        "added":["研发-交付群"], "removed":[], "failed":[]}
```

- **集合替换、幂等**：目标是「只听这些」，多退少补，完全相同时**一个微信调用都不发**。
- `rooms` 里既接受显示名也接受 `wxname_…` id（面板存的是 id）。
- **部分失败仍 200**：能加的照加，解析不到的进 `failed`；只有后端不可用才 `502`。
- `weixin-watch` 每轮轮询前下发 `config.rooms` 的 id 列表；`rooms` 为空时**不调用**
  （否则会静默掉别人手工配好的 sidecar），并把「在听 N/M、哪些没听上」写进健康详情。
- 后端不支持运行时改监听集合时，`listen` 方法在 seam 上是可选的，循环直接不问它。

面板里 `rooms[].id` 与 `policy.allowed[].id` 是**下拉选**而不是手填：`wxname_<hash>` 保住了 id 正则，
但没人能手打，所以「刷新会话列表」会把 `/rooms` 与各会话的 `/members` 载入成标签，再从列表里挑。
`refreshLabels` 就是这条链路，与 Feishu 用的是同一套机制。

`/rooms` 的语义是「本后端**能看到的**会话」，不是「正在听的」：`pc-uia` 上是
`GetAllRecentGroups()` 的全部群 + `GetSession()` 里当前可见的会话（按显示名排序，上限 500）。
**因此滚出会话列表的单聊不在候选里**——先打开那个单聊一次，再点刷新。正在听什么只看
`POST /listen` 的 `listening`。
#### L0 的另外四个契约缺口（同样是「已知缺口，不是 bug」）

| 契约字段 | L0 实际情况 |
| --- | --- |
| `room`（chatroomId） | 拿不到。`ChatInfo()` 只有 `chat_type/chat_name/group_member_count`；`SessionElement` 只有 `name/time/content/isnew/new_count/ismute`；因此用 `wxname_<hash>` |
| `sender.id` | 只有显示名。`sender_info()` 的 `id` 是微信号（如 `<微信号>`）不是 `wxid_`，且**实测滞后一条消息、有时返回 `null`**；因此用 `wxname_<hash>` |
| `at`（消息时间） | 普通消息无时间字段，只有 `TimeMessage` 分隔符带 `time` → 只能用服务端接收时间 |
| `/members` | 无群成员 API（`_api` 只有 `add_group_members`）→ 能力为 `observed`：只列已见过的发送人，不是完整成员表 |

注意 `rooms[].id` 的 schema 是 `^[A-Za-z0-9_-]+$`，中文群名过不了——**这个严格性要保住**，
它是准入闸门。真群的稳定 ID 要靠 `wxname_<hash>` 归一（见上）或 L2/L1。
| `/members` | 无群成员 API（`_api` 只有 `add_group_members`）→ 能力为 `observed`：只列已见过的发送人，不是完整成员表 |


#### L1（DB 读取器）的证据与下一步

本机已确认消息库位置与加密形态，这是**不注入进程也能拿到全部结构化字段**的唯一路线：

```
C:\Users\Administrator\Documents\xwechat_files\<account>_<hash>\db_storage\
  message\message_0.db   11,882,496 B   ← 群/单聊消息
  contact\contact.db     23,150,592 B   ← 联系人、群成员
```

`message_0.db` 前 64 字节是随机字节（`79 4b ad 98 12 22 ba 23 …`），**不是** `SQLite format 3`
→ SQLCipher 加密（微信 4.x：4096 字节页、AES-256-CBC、页尾 HMAC-SHA512）。客户端运行时文件被独占，
读取需 `FileShare.ReadWrite`。

拿到密钥后，协议自带字段即可直接映射契约：`username`（= chatroomId）、`sender`（= wxid）、
`create_time`（= 真实时间）、消息 proto 里的 at 列表（= `ats`）。**一条同时解决 Q1 与 Q2。**
密钥要从 `Weixin.exe` 进程内存取（本机是管理员会话，具备条件），属 L1 的「内存读取」风险档，
需业务方书面接受。做法与风险见 `docs/extensions/ADR-005-weixin-backend.md` §7。

### 4.3 低优先级、已记录未修

| 编号 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- |
| IMG-1 | 只校验单图 `maxImageBytes`，未叠加 `maxMessageImageBytes` / 每消息图片数上限 | `src/sources/chat/weixin/media.ts` | **v3 已修**：单图预算取两者较小值并下传给下载侧；每消息图片数在**任何下载之前**拒绝 |
| IMG-2 | 先整块 `arrayBuffer` 再查限，未做流式上限 | `src/sources/chat/weixin/bridge.ts` (`media()`) | **v3 已修**：`Content-Length` 先判，否则逐块累计、超限即 `cancel()` |
| IMG-3 | sidecar `/media` 成功分支未显式拒零字节 | `ext/sidecar/wxauto-bridge/server.py` | **v3 已修**：零字节走 `MediaGone` → 404，绝不 200 |
| IMG-4 | `imageIds()` 从正文解析 `[image:<id>]`，用户可自造标记触发一次请求 | `media.ts` / `thread.ts` | **v3 已修**：`read()` 剥掉自造 marker；`image()` 白名单只认 `meta.media` 与该消息渲染文本里的 id |

> IMG-4 的落地形态与原始建议略有偏离，记录在此：`ThreadContext.images(text)` 不带 `trigger`
> （`src/sources/kind.ts` 的签名），所以**没有**在 `images()` 里做有状态白名单——那样会把 Trigger
> 自身的图片也滤掉（`app/assessment.ts` 用 `trigger.text` 调它）。拦截点放在 `image()`，
> 由 `read()` 的剥除保证 `images()` 的正确性，sidecar 的 404 是最后一道。

| 编号 | 问题 | 说明 |
| --- | --- | --- |
| t41-review | t41 那次修复（钉钉 `idempotency` 改 `none`、重连 `setTimeout` 改可中断）只做了命令级复跑，**未做正式代码级复审** | 仍未做。建议与下批合并做一次 `review` 轮，重点看 `src/sources/chat/dingtalk/stream.ts` 的 abort 语义 |

### 4.4 微信外的下一步（可选，按业务优先级）

1. 真实凭据联调：GitLab 发评论（需 PAT）、云效工作项读写（需 `pt-` token）；
2. 企微回调挂到 `app/http.ts` 的公共路由 + 公网反代（当前只有纯函数 `handleWebhook`）；
3. 钉钉 Stream 植入 `dingtalk-stream` SDK 的 `connect`；
4. 面板多实例的像素级验收（需要一个能与本会话分离的 DSH 宿主，否则加载插件会重启宿主）。

---

## 5. 交接注意事项

1. **先复跑、再动手。** 到岗后第一件事是按 §3.4 跑完五条检查，把结果填进 §2 的表格。任何一条与基线不一致，先解决环境，不要开始改代码。**v3 已经把 Win11 上的 64 个失败清零**，所以现在的基线是「Windows 上也是 0 failed」；再出现红，先怀疑是本地状态而不是已知问题。
2. **只推 `origin`。** `git remote -v` 里应当只有 `baojingyu/open-dsh-superagent` 一个 remote；**不要**添加任何指向官方/上游仓库的 remote，也不要向其它仓库推送。
3. **不改名、不回退。** 仓库名与 main 历史均保持现状；`feat/multi-instance-sources` 保留备查，不删。
4. **不要在 `main` 上做实验。** 起 `feat/<topic>` 分支，`--no-ff` 合并回 `main`，保持提交可回溯。
5. **必须等外部输入才能推进的项**（不要靠猜）：
   - 微信群 `@` → **v3 已有定论：L0 拿不到**（§4.1）。要真群 `@` 只能等 L2 的 pad 服务，或批准 L1 的 DB 读取器（§4.2）
   - GitLab 写操作 → 等 PAT
   - 云效读写 → 等 `pt-` token 与 organizationId
   - 企微回调 → 等公网入口与反代
   - 钉钉 Stream → 等 SDK 接入方案确定
6. **三条硬规则，别绕过**：
   - 群 `@` 绝不按文本判定（`U+2005`、`@昵称`、会话列表预览里的 `@` 都算文本）；
   - `src/sources` 不得 `import src/app`（会导致架构反向依赖）；
   - 取消息属性时**绝不调用可能改状态的方法**。`FriendMessage.at` 是「拍一拍」，调一次就骚扰一个群成员。
7. **`--maxWorkers=2`**：全量测试一律限并发，失败先单跑确认是否计时抖动。
8. **凭据文件**：§3.7 已把 `0600` 改成平台守卫。POSIX 上仍是硬校验；**Windows 上靠 ACL，装好凭据后必须自己 `icacls` 收紧**，否则等于没保护。
9. **不要为了让测试变绿去放宽身份 schema。** `rooms[].id` / `policy.allowed[].id` 的 `^[A-Za-z0-9_-]+$` 是**准入闸门**：它挡住了「拿显示名当稳定 ID」的不达标部署（§4.2）。真要支持显示名，前提是后端能给出稳定 ID，而不是把校验删掉。
10. **Windows 上的服务常驻是未做项。** `scripts/dsh-superagent` 依赖 `fcntl`/`flock`/`ps`/`tmux`/`killpg`，在 Windows 上不可用（对应 `tests/service-script.spec.ts` 整文件 skip）。Windows 上要常驻，目前用 `dsh web` 手动起，或自行包 `sc.exe`/`nssm`。这是已知缺口，不是回归。
11. **行尾**：本工作区 `core.autocrlf=true`，全仓是 CRLF。任何「多行精确匹配文件内容」的断言都必须容忍 CRLF（`split(/\r?\n/)`）。要彻底解决需要单独一个提交引入 `.gitattributes` + 全仓 `renormalize`，**不要**把它混进功能提交。

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

# sidecar（真机；--listen 已不再需要，群从面板的 POST /listen 下发）
$PY = "D:\<wxauto4-env>\<wxbot-dir>\.venv\Scripts\python.exe"
& $PY server.py --backend pc-uia --port 8787 --token <TOKEN> `
    --self-name-ttl 60          # 群 @ 判据名的重读间隔（秒）
# 验证：curl -H "Authorization: Bearer <TOKEN>" 127.0.0.1:8787/health
#       detail 里能看到 `群 @ 判据：@<本账号显示名>`

# 微信真机探针
cd C:\dev\open-dsh-superagent-ext\poc
python win_diag.py                                   # 会话/窗口/代际
python probe_wxauto.py --selftest                    # 不碰微信，只验证报告链路

# sidecar 契约自测（不依赖微信）
cd C:\dev\open-dsh-superagent-ext\verify
node --experimental-strip-types --no-warnings live-contract.mjs
python signal-check.py

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
| `must be owner-only (mode 0600)` | v3 起 Windows 上不再抛；若在 **POSIX** 上看到，就是文件权限真的不对，`chmod 600` |
| `Python was not found` / live 用例退出码 **9009** | `python3` 是 Microsoft Store 占位程序。用 `python`，或 `$env:PYTHON='C:\path\python.exe'` |
| `spawn sleep ENOENT` / `spawn sh ENOENT` / 9009 | 测试或产品里还有 POSIX 命令假设。测试改用 `process.execPath -e`；产品侧见 §2.1 的 B 组 |
| `$.stateDir expect string to match regexp /^\//` | v3 前的老问题；v3 已按平台判定，`C:\...` 与 UNC 都接受 |
| `docs.spec` 报「每个文件都缺」 | 工作区是 CRLF（`core.autocrlf=true`）+ 反斜杠。v3 已让 spec 容忍；若再出现，查是不是有人加了 `split('\n')` |
| gitlab live 里 notes 被 skip | 预期行为：匿名读评论 401，不是失败 |
| 全量测试偶发失败 | 加 `--maxWorkers=2` 重跑，单跑该文件确认 |
| `push` 报 `Proxy CONNECT aborted` / `HTTP2 framing layer` | 代理抖动：`git -c http.version=HTTP/1.1 push origin main` 重试；直连不通时不要 `unset` 代理 |
| `the wxauto 3.9 accessibility tree was not found` | 客户端是 4.x，装 `wxauto4`/`wxautox4`（§3.8） |
| 探针 `no WeChat window` | 与客户端不在同一交互式会话（§3.8） |
| 探针报 `atListCandidates` 非空（与 v3 结论相反） | 说明客户端或 `wxautox4` 升级后补上了结构化 at。**先复核 `uia.childCount` 与 `patterns`**，确认不是把 `attr` 之类当成了列表，再按 §4.1 原分支表接进 `ats` |
| `tests/service-script.spec.ts` 在 Windows 上全 skip | 预期行为：`scripts/dsh-superagent` 是 POSIX 服务管理器（`fcntl`/`flock`/`ps`/`tmux`/`killpg`），Windows 支持属未做项 |
