# 006 部署

> 语言：[中文](006-deployment.zh-CN.md) · [English](006-deployment.md)

使用本指南安装、配置和运行 dsh-superagent。它涵盖账户、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 的基础之上。

## 运行内容

- **一个专用的 DeepSeek Harness profile**，本指南中称为 `superagent`。从 Web profile 模板创建它。它加载 bundle，并在 `127.0.0.1` 上提供其面板。把它与你日常工作的 profile 分开：该插件会改变进程级的 `PATH` 和 git 设置，且其进程需要独立的重启和升级。
- **一个 agent 的 GitHub 账户。** agent 以该账户的身份发表评论、推送分支、发起 pull request，通过一个仅以该账户登录的 GitHub CLI 完成。
- **可选：** 一个用于聊天请求的飞书机器人。

插件配置保存状态目录和机器限额。其余一切通过面板操作：来源（Sources）用于仓库和账户，策略（Policy）用于允许名单，执行（Execution）用于 worker 目录和命令。

### 权限与隔离

bundle 为执行器定义了 `dsh-superagent-worker`，为主会话定义了 `dsh-superagent-router`——与 2.3 之前的 bundle 使用的 preset id 相同，因此从旧版本安装切换过来时，会恢复其现有的会话，而不是以 `Unknown agent preset` 失败。它们会出现在 DeepSeek Harness 的 preset 列表中，但仅供本插件使用。不要为个人会话选择它们，也不要禁用它们的配置行。应用需要它们来创建和恢复其会话。

在 Web UI 中打开一个空白托管会话时，可能会选择该 profile 的默认 preset。dsh-superagent 会在第一轮之前恢复其角色专用的 preset。

两个 preset 都以操作员的 OS 用户身份、在 `danger-full-access` 下运行，并从订阅的线程读取消息。账户 wrapper 默认选择 agent 的凭据；它们不隔离进程。worker 可以按路径执行程序并读取操作员的主目录。若需隔离，请使用一个仅包含 agent 凭据的专用 OS 账户。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux
- GitHub CLI（`gh`）2.48 或更高版本。来源的 CLI 字段必须指向 `gh` 或 `lark-cli` wrapper；host 依赖它们的子命令和输出格式。
- 位于 github.com 上的仓库；不支持 GitHub Enterprise Server。要为每个工单创建 checkout，请保留一个本地 clone，prepare 命令可从中添加 worktree。若该仓库使用 Git LFS，请安装 `git-lfs`。
- 为 DeepSeek Harness 配置的模型提供方。除非评估（Eval）或执行（Execution）设置指定了其他模型，dsh-superagent 使用该 profile 的默认模型。
- 飞书：`lark-cli`（已在 1.0.90 测试）以及一个带机器人的飞书或 Lark 应用

## 账户

### Agent 的 GitHub 账户

1. 为 agent 创建一个 GitHub 用户账户，并授予它对仓库的写权限。GitHub App 不能作为 agent，因为 dsh-superagent 读取该账户的通知。
2. 为它提供一个仅使用自身凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以 agent 账户登录；最后一条命令会打印其 login。dsh-superagent 以相同方式读取该 login。

### 飞书机器人（可选）

1. 创建一个具备机器人能力的自建应用。授予其接收消息事件、读取和发送聊天消息、读取聊天成员等权限，然后发布应用版本。
2. 为机器人提供其独立的 `lark-cli` 配置（限定为机器人身份）以及一个 wrapper：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取 app secret。请使用独立的配置目录：`lark-cli` 每个 app id 只允许一个 profile，而你的个人配置可能已经包含该应用的用户登录。

   host 会拒绝一个能以用户身份行动的 CLI。它从机器人配置中读取 app id、飞书/Lark 品牌和机器人的 `open_id`。

   两份配置共享 app secret 的 keychain 条目。要仅移除机器人配置，请删除其目录；不要运行 `lark-cli config remove`，因为它会影响共享的 secret。

## 安装

在一台尚无 `superagent` profile 的机器上，运行以下代码块一次：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本是公开的；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条安装本 bundle。设置 `DSH_HOME` 可重定位默认的 `~/.dsh` 目录。

仅在新安装时运行 profile 创建命令。如果 profile 已存在，该命令会替换它并删除其 `cordis.patch.yml`（包括机器配置）。升级时不要使用它。

## 机器配置

将 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制为 `~/.dsh/profiles/superagent/cordis.patch.yml`（替换该文件），并替换每一个 `<placeholder>`。若使用飞书，还要在那里启用 `dsh-superagent-multi-channel-feishu` 条目。`webserver` 条目设置面板的端口。

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `stateDir` | 否 | 绝对路径：数据库、锁、`worker-bin` 中的命令 shim、agent 的 git 配置，以及默认情况下 `work` 中的工单目录。默认使用已存在的 `~/.dsh/state/superagent`（2.3 之前的安装）或 `~/.dsh/state/dsh-superagent-multi-channel`。升级前请备份 |
| `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大值，以及一次评估在什么时间内读取多少线程页 |

首次启动后，在 **设置 → 部署（Settings → Deployment）** 或 DeepSeek Harness 插件管理器中编辑机器限额。更改无需重启即可生效。`stateDir` 无法在那里修改。无效值或未知的配置键会阻止启动；日志会指出是哪个键。

## 与官方 superagent 并存安装

本 bundle 是一个独立的包，拥有自己的入口 id、agent preset 和面板入口，因此可以**安装**在另一个 superagent bundle 旁边，而不会覆盖它的行、preset 或面板槽位。

一个 Harness Host 上**每个 id 只能有一个来源类型（Source kind）**，而每个 superagent bundle 都注册相同的类型 id（`github`、`feishu`、`projex`……）。因此可以安装两个 superagent bundle，但**同一时刻只能启用一个**；同时启用两个会让第二个 bundle 的来源行报告 `Source kind already registered`。切换就是禁用其中一个 bundle 再启用另一个，且每个 bundle 保留自己的 `stateDir`，所以切回来不会改变其他任何东西。

| | 官方 superagent | 本 bundle |
| --- | --- | --- |
| 包 | 官方包 | `dsh-superagent-multi-channel` |
| profile 入口 id | `dsh-superagent`、`dsh-superagent-<source>` | `dsh-superagent-multi-channel`、`dsh-superagent-multi-channel-<source>` |
| agent preset | `dsh-superagent-worker`、`dsh-superagent-router` | **相同的 id**，这是刻意的：同一时刻只有一个 superagent bundle 被启用，切换后会恢复任一 bundle 创建的会话 |
| 面板入口 | 其自身的入口 | 侧边栏「Superagent 多通道」 |
| 状态 | 一个 `stateDir` | 自己的 `stateDir`（默认值见下文） |

要迁移本 bundle 旧版本的安装：禁用旧 bundle，启用本 bundle，并将 `stateDir` 留空——默认值会沿用现有的 `~/.dsh/state/superagent`，因此数据库、工单和游标一并带过来。如果两者都保持安装，则各自需要**自己的** `stateDir`（一个目录只容许一个实例，锁也会这样说明）。

## 从插件市场或 tarball 安装

- 插件管理器或市场：安装 `dsh-superagent-multi-channel@<version>`。市场从包中读取 `dsh.bundle.patch` 和展示元数据（`locale/en.json`、`locale/zh.json`、`icon.svg`），因此条目会以自己的标题、描述和图标出现。
- 自定义插件索引（「Custom plugin indexes」bundle 的 Discover 标签页）或社区市场：将其指向已发布的包，或托管仓库 tarball 并安装该 URL——profile bundle 也可从 `…/archive/refs/tags/v<version>.tar.gz` 安装。
- 本地开发：用绝对 checkout 目录执行 `plugin_manager` 的 `install_bundle` 会链接工作树，因此重建后无需重新安装即可见；`npm pack --dry-run` 精确显示已发布 tarball 会包含什么。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`，对其他 profile 则为 `dsh-<profile>`。它最多等待一分钟，直到 runtime 就绪或报告某项初始化要求。首次运行时，它会打印缺失的初始化信息。它会拒绝重复的实例，包括在本脚本之外启动的实例。

`stop` 和 `restart` 请求优雅关闭，并最多等待执行器五分钟。它们从不强制杀死进程，也不触碰其他 tmux 会话。

`status` 打印进程 id、健康状况和初始化问题。对于不同的 profile 或端口，使用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 以四种退出码之一退出：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 未运行、运行了两个实例、无响应，或其 runtime 报告错误；重启可能修复 |
| 2 | 正在运行，但除 runtime 之外的某个部分（如某个来源或某个策略同步 `sync:<source id>`）报告错误；重启无法修复 |
| 3 | 正在运行并等待初始化；重启无法修复 |

仍在启动中的来源算作正常运行。初始化无法检查的飞书机器人也算。

`status` 在 `errors` 下返回失败的部分及其细节，在 `setup` 下返回初始化要求。`start` 和 `restart` 将这些以行形式打印；如果服务始终未起来，它们退出码为 1。只有有意的 `stop` 会暂停自动恢复。

每个 profile 在 `.artifacts/` 下存储日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于该脚本。保留最新的 20 个。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁和进程 id。

打开日志中打印的 URL，然后在侧边栏选择 **Superagent**。

### 每小时检查

在你日常使用的 DeepSeek Harness profile 中创建每小时检查，而不是在 `superagent` 中。它必须在 agent 服务停止时继续运行。请该 profile 中的 agent 使用以下提示词创建一个每小时的计划任务，并填入 checkout 路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 保留有意的停止。只有 `stop` 会写入标记；`start` 会清除它。`restart` 不写标记，因此该检查可以恢复一次关闭超时的重启。

## 设置

初始化必须成功，轮询或工作才会开始。概览（Overview）列出缺失的要求并链接到相应设置。设置变更会重新运行初始化。如果你在应用之外修复了某些东西（如 CLI 认证），请选择 **重新检查（Check again）**。

1. **来源（Sources）。** 设置 GitHub 仓库（`owner/name`）和 agent CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过 agent 账户的通知到达。提及该账户的新 Issue 或评论会在下一次轮询时到达；通过编辑现有 Issue 正文添加的提述则不会。请改为发表新评论。对于飞书，设置机器人 CLI、聊天、每个聊天的接收全部或仅提述模式，以及是否接收私聊消息。
2. **策略（Policy）。** 两条示例规则可以编辑或删除。在 **每个来源上（On each Source）** 下，添加可以请求工作的 GitHub 账户和飞书用户；在名单中有人之前，任何请求都无法变成工单。使用飞书时，可以选择一个聊天作为名单的同步来源，在启动时和点击 **立即同步（Sync now）** 时同步。
3. **执行（Execution）。** 目录根和一个 prepare 命令。要为每个工单提供仓库的 checkout：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   将个人 CLI（例如登录到你本人账户的 CLI）列为被阻止的命令。
4. **提示词（Prompts）。** 设置团队段落：GitHub 披露行、审查机器人、提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，agent 也可以调用它。`SETUP.md` 用它保存设置，服务脚本读取 `GET state`。

向 `http://127.0.0.1:<port>/orchestrator/api/` 发送请求，并带上 `x-orchestrator-request: 1`。host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少该请求头，或 `Origin` 来自其他站点，会收到 403。

API 保存拥有面板的权限。与通过主会话工具所做的保存不同，它们可以更改执行环境和初始化账户字段。

agent 可以依赖以下路由和字段。`src/app/api.ts` 中的其他路由为面板服务，并随面板变化。

| 请求 | 应答 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`，含 `problem` 和 `feishuProblem`，每个为 `null` 或一个含 `place`、`code`、`values` 和 `detail` 的初始化问题，以及初始化解析后的 `accounts`；`health`，每个部分一条，见下文，含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，执行器会话 `running`、工单 `queued` 和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，各自带其 `value` 和 `revision`；`sources`：来源实例，各带 `id`、`kind`、`installed`、其块的 `value`、`{"enabled": …, "config": {…}}` 和 `revision`、其 kind 的表单，以及其初始化 `problem`（若有）；`policyVersion`；和 `environment`，即执行环境的 `root` 和 `variables` |
| `GET sources` | 每个来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分的 `health`、其初始化 `problem`、最近一天的 `stats`、当天它 `filtered`（过滤）掉的触发，以及当天它 `dropped`（丢弃）的消息（最新的丢弃在前），每条带其 `channel`、`preview`、`ticket`（`id` 和 `title`，当它属于某个工单时）、其 `thread`（当存储中有它时），以及 `dropped.at` 和 `dropped.reason`、`channelGone` 或 `channelIgnored` |
| `PUT settings/<block>` 带 `{"value": …, "revision": n}` | 保存一个块：`saved`、该块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是整个块，与 `GET settings` 所持的一致；缺失的键取其默认值 |
| `POST executor/pause` 带 `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 重新运行初始化：`restarting: true`。当初始化没有可修复项时会拒绝 |
| `POST policy-sync/<source id>` | 立即同步该来源的允许名单：`policy`，即该来源部分按保存时的状态 |
| `GET prompts`、`PUT prompts` 带 `{"config", "baseRevision"}` | 读取提示词配置：`current`，带其 `revision` 和 `config`、`defaults`、`sections`（团队段落，按会话读取它们的顺序）、`skillName`（团队技能名称的模式）、`builtin`（团队技能不能使用的名称）和 `skillPrefix`（会话加载技能名称时所处的前缀）。或保存它：返回新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 重试或停止一个工单，与面板一致 |

健康条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 正在等待模型预算重试的会话 |
| `evals` | 最近一小时内不可用、之后既无判定也无驳回的评估 |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | [003 执行](003-execution.md) 中描述的存储工作；delivery 统计等待中的工作，而 reply 涵盖 Channel 消息 |
| `worker` | 执行器会话的事件处理；在其首次失败后出现 |
| `github`、`feishu`、`history` | 来源轮询、事件和历史恢复 |
| `sync:<source id>` | 允许名单同步 |

一次拒绝带有一个状态码和 `error`（其英文文本）：

- 400：无效值（`issues`，各带其 `path`）、账户检查失败（`setup`）、固定拒绝（`code` 和 `values`），或请求体不是 JSON 或过大。
- 404：某物不存在。
- 409：过期的 revision。
- 500：其他任何情况。

各块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的 config 有 `repository` 和 `cli`，以及开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`（默认关闭），它们接收仓库中每个新 Issue、新 pull request、评论以及默认分支的 CI；飞书的 config 有 `cli`、以 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`（或 `"all"`）表示的 `chats`、`directMessages`，以及取值为 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可成为推断候选的机器人。`admission` 行以 chat id 为键，飞书用 `other` 或 `direct`，GitHub 用 `issues`、`pulls`、`comments` 或 `ci`；未设置的单元格取其默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是其自身的设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行相应的初始化检查。检查失败会返回 400，详情在 `setup` 中。成功的账户更改，或在初始化待定期间的任何保存，会返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 初始化检查

初始化使用 DeepSeek Harness 的子进程服务，与 worker shell 一样。它会移除名称包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

初始化验证 GitHub 仓库和 agent 的推送权限，写入 worker 环境，并检查 git 对 github.com 仅使用 agent 凭据。飞书初始化失败只会禁用飞书来源。

初始化写入的进程环境：

- **命令 shim** 位于 `<stateDir>/worker-bin`，在 `PATH` 中排在最前：`gh` 运行 agent 的 CLI；`lark-cli` 运行机器人的 CLI；被阻止的命令会失败。shim 在运行其目标前会从 `PATH` 中移除自身所在目录。
- **git 配置** 位于 `<stateDir>/worker-gitconfig`：替换操作员的全局和系统 git 配置。它选择 agent CLI 作为 github.com 的凭据助手，将 GitHub SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。诸如 HTTP 代理之类的个人 git 设置不适用。此处不设置提交身份，git 从不提示凭据，且 `GH_TOKEN` 和 `GITHUB_TOKEN` 会被移除。

`worker-bin` 或 `worker-gitconfig` 中一个并非由 dsh-superagent 写入的文件会终止初始化。位于某个自身配置添加了凭据的 git 仓库内的工单目录，会使该工单失败。

## 试一试

用一个被允许的 GitHub 账户，打开一个 Issue 或发表一条包含 `@<agent login> <request>` 的评论。在一个轮询周期内（默认一分钟），概览应显示一个工单。agent 会确认请求，在其自己的会话和目录中工作，并在原对话中交付。对于飞书，在已配置的聊天中提述机器人。

## 升级

1. 等到没有执行器正处于一轮的中间。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

重启会结束正在运行的 Assignment，并以恢复说明启动替代者。团队文本和被覆盖的提示词部分会保留；没有覆盖的部分遵循新的默认值。升级后请复查标记为 **默认已更新（Default updated）** 的部分。

由较新版本迁移过的数据库无法被较旧版本打开。因此回滚需要升级前的备份。升级 DeepSeek Harness 本身之后，重启正在运行的实例，以便面板加载匹配的制品。

### Agent preset

worker 和 router 这两个 preset 会在 5 秒后将 shell 命令移到后台。会话若没有其 preset 就无法加载。在会话使用时，请在 `cordis.patch.yml` 中保留 `dsh-superagent-worker` 和 `dsh-superagent-router` 两行；否则恢复会以 `agent-preset/not-found` 失败。

## 故障排查

初始化问题会以面板的语言显示在概览上，并附有修复链接；日志和 API 显示下面的英文文本。

| 症状 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置 agent 的 CLI |
| `The agent GitHub CLI was not found.` | 设置 wrapper 的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该 wrapper |
| `@… cannot read …` 或 `@… cannot push to …` | 授予 agent 账户对仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库 `owner/name` |
| 一个工单以 `The prepare command failed: …` 失败 | 输出会指出原因，例如错误的 clone 路径；修正命令，然后重试该工单 |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 一个工单以 `The git configuration of the repository in … sets …` 失败 | 从该 clone 的 `.git/config` 中移除所指名的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 将所指名的文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或另选一个 `stateDir` |
| `The bot lark-cli allows user identities` | 将飞书来源指向一个仅机器人配置，如上面的飞书机器人一节 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置的 app id 和 secret |
| `The Feishu bot is not a member of the chat.` | 在聊天设置中将机器人加入该聊天；下一次尝试会成功 |
| `status` 退出码为 2 | 某个部分报告错误，重启无法修复：`errors` 指出每个部分（如管理 API 下所列）及其细节；每个部分一旦恢复正常就会清除自己的条目 |
| `status` 退出码为 3 | 初始化在等待：`setup` 说明缺少什么，概览会链接到修复它的设置 |
| `status` 退出码为 1 | 服务未运行、运行了两个实例、无响应，或其 runtime 报告错误；输出和最新日志会说明是哪种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | 某个 CLI 失败但未打印原因；以操作员用户身份手动运行所指名的程序，以查看它自己的消息 |
| 面板显示 dsh-superagent 无响应 | 它正在重启，或因配置未启动；DeepSeek Harness 日志会指出原因 |
| `dsh-superagent configuration has keys it does not use`（日志） | 移除所指名的键；消息会说明每个值现在在哪里 |
| 日志显示该插件与正在运行的 dsh 不兼容 | 安装一个处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| DeepSeek Harness 升级后，面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| 提述后没有任何反应 | 检查作者是否在该来源的允许名单上、来源是否开启、处理是否未暂停。在 GitHub 上，通过编辑 Issue 正文添加的提述不会被接收；请在评论中提述 agent |
