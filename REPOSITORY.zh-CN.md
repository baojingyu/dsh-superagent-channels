# 这个仓库怎么管

[English](REPOSITORY.md) · **简体中文**

## 它是什么

一个**独立仓库**，不是用来提 PR 的 fork。

本版所生长的原型明确不合并外部提交。fork 的意义是「把改动提回去」；那条路关掉之后，fork 就只剩一个标签——
而且这个标签是有代价的：**公开仓库的 fork 本身也是公开的，并且会列在上游的 fork network 里**，
任何人看上游都能看到它的分支和提交。无论从「不想被上游看到」还是从「工作区该保持私密」来看，
都没有理由保留这层关系。

所以这里的形态是**下游发行版（downstream distribution）**：这个仓库拥有自己的历史、自己的发版节奏、
自己的分支布局。来源信息写在 README 里，MIT 许可与上游版权声明保留——这也是许可证要求的最小动作。

## 二开项目通常怎么管

四种形态，按大多数项目的选择顺序：

| 形态 | 结构 | 什么时候选它 |
| --- | --- | --- |
| **PR fork** | fork → 分支 → 向上游提 PR | 上游接受贡献。**本项目不适用。** |
| **下游发行版** | 自己的仓库与历史；可选一个只 fetch 不 push 的 `upstream` remote | 上游仍在出修复，你想按自己的节奏吸收。**推荐。** |
| **整体拷贝（hard fork）** | 自己的仓库，与上游无任何关系，代码拷一次 | 分歧已大到合并成本超过收益，或上游已停更 |
| **叠加层 / 补丁队列** | 上游作为依赖或 submodule，自己的改动是补丁序列 | 改动很少，想机械地跟上游 tag |

真正的区别是**谁去吸收上游将来的工作**。下游发行版把这个门留着，代价是合并要自己做；
整体拷贝把门关掉。本版是**直接修改上游文件**而不是包一层，所以叠加层不适用；
而分歧已经不小，如果哪天合并变得很痛，整体拷贝是一个合理的退路。

保留 `upstream` remote **不等于**仍然是 fork。remote 只是本地做 `git fetch` 的便利；
fork network 是服务端元数据。去掉后者不需要去掉前者。

## 把副本彻底摘开：操作规程

GitHub 没有「取消 fork」按钮。可靠的路径是新建一个仓库；至于某个 fork 能不能就地改可见性，
取决于它的状态，别把计划建在这上面（实测：把一个公开仓库的 fork `PATCH` 成 private 会返回 **422**）。

```bash
# 1. 在旧检出里确认每个你在意的分支都在本地
git branch -a
git tag -l

# 2. 先建新仓库（网页或 `gh repo create`），需要私密就设为 private。
#    不要在网页上勾 README / .gitignore / licence：这次推送自带历史。

# 3. 把 origin 指到新仓库，逐个显式推送分支与标签
git remote set-url origin https://github.com/<owner>/<new-repo>.git
git push -u origin main
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do git push -u origin "$b"; done
git push --tags origin

# 4. 删任何东西之前，先核对真的推上去了
git ls-remote --heads origin
git ls-remote --tags origin
```

然后到旧仓库设置里**删除 fork**。删掉的 fork 会从上游的 fork 列表里消失。
但删除**不会**影响别人的克隆、缓存与搜索引擎索引，所以任何曾经公开过的内容都按「已公开」处理。

删除仓库的 API 需要 `delete_repo` 作用域（细粒度 token 需要 *Administration: write*）。
只带 `repo` 作用域的 token 可以建仓库、改仓库名与设置，但**删不了仓库**——这一步要么补作用域，
要么在网页上点。

如果还要继续吸收上游修复：

```bash
git remote add upstream https://github.com/<upstream-owner>/<upstream-repo>.git
git fetch upstream --no-tags
git log --oneline upstream/main ^main     # 上游有、你没有的
```

然后有选择地 merge 或 cherry-pick。**永远不要 push 到 `upstream`**；只 fetch 它的仓库依然是一个独立仓库。

## 本仓库守的规矩

1. **只有一个可写的 remote。** `origin` 是本项目；`upstream`（若有）只读。
2. **历史里不放个人数据。** 提交、提交信息、文档与测试夹具一律用占位符
   （`<wxid>`、`<昵称>`、`<群名>`、`<成员>`、`<微信号>`），绝不写真实账号、联系人或群名。
   含真实聊天内容的取证物——探针报告、消息 dump——只留在本地，永不提交。
3. **源码里不放机器专属路径。** 只在一台机器上存在的路径属于命令行参数或环境变量，不属于默认值。
   sidecar 的 `--venv` / `WXBRIDGE_VENV` 发现逻辑就是可复制的范式。
4. **基于 `main` 拉分支开发。** 每个需求或开发任务一个分支（`feat/…`、`fix/…`、`docs/…`），
   `--no-ff` 合并回 `main` 后即删。这样 `main` 保持可评审，分支列表也不会堆积——已合并的分支没有理由继续存在。
5. **README 是改动的一部分。** 改变行为的提交，必须在同一个提交里同步中英文档。

## 如果这个仓库将来要公开

有两件事必须先复核，因为它们事后改不掉：

- **历史。** 首次公开之前重写很便宜；公开之后，别人的克隆和缓存可能留住旧对象。
  占位符检查要跑遍**每一个提交**，不只是 tip。
- **sidecar 目录。** 它在仓库之外（同级 `dsh-superagent-channels-ext/`），不受本仓库的历史规则约束。
  里面是 sidecar、探针和契约；如果要发布，同样按上面这套规矩处理。
