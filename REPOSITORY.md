# How this repository is managed

**English** · [简体中文](REPOSITORY.zh-CN.md)

## What it is

An **independent repository**, not a pull-request fork of the prototype it grew from.

The prototype states that it does not merge outside contributions. A fork exists to propose changes
back; when that path is closed, a fork is only a label — and a label with a cost: a fork of a public
repository is itself public and is listed in the upstream's fork network, so its branches and commits
are visible to anyone who looks at the upstream. Neither the maintainers' privacy nor the ability to
keep work in progress argues for keeping that relationship.

So the model here is a **downstream distribution**: this repository owns its history, its release
cadence and its branch layout. Provenance is recorded in the README and the MIT notice is kept, which
is what the licence asks for.

## How secondary-development projects usually do this

Four patterns, in the order most projects pick them:

| Pattern | Shape | Pick it when |
| --- | --- | --- |
| **PR fork** | fork, branch, open a pull request upstream | upstream accepts contributions. **Not applicable here.** |
| **Downstream distribution** | own repository, own history; optionally an `upstream` remote that is only ever fetched | upstream still ships fixes you want to absorb on your own schedule. **This is the recommended model.** |
| **Vendored hard fork** | own repository, no relationship at all, upstream code copied once | you have diverged so far that merges cost more than they are worth, or upstream is abandoned |
| **Overlay / patch queue** | upstream kept as a dependency or submodule; your work lives as a patch series | you change little and want to track upstream tags mechanically |

The difference that matters is **who absorbs upstream's future work**. A downstream distribution
keeps that door open at the cost of doing the merges yourself; a vendored hard fork closes it. Since
this edition modifies upstream files rather than wrapping them, an overlay is not an option, and
since the divergence is already substantial, a vendored hard fork is a legitimate fallback if merges
ever become painful.

Keeping an `upstream` remote is **not** the same as being a fork. The remote is a local convenience
for `git fetch`; the fork network is server-side metadata. Removing the second does not require
removing the first.

## Detaching a copy: the runbook

GitHub has no "unfork" button. The reliable path is a new repository; whether a given fork's
visibility can be flipped in place depends on its state, so do not build a plan on it.

```bash
# 1. From the existing checkout, make sure every branch you care about exists locally.
git branch -a
git tag -l

# 2. Create the new repository first (web UI or `gh repo create`), private if that is the intent.
#    Do not initialise it with a README: this push brings its own history.

# 3. Point `origin` at the new repository and push every branch and tag explicitly.
git remote set-url origin https://github.com/<owner>/<new-repo>.git
git push -u origin main
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do git push -u origin "$b"; done
git push --tags origin

# 4. Verify what actually landed before deleting anything.
git ls-remote --heads origin
git ls-remote --tags origin
```

Then, in the old repository's settings: **delete the fork**. A deleted fork disappears from the
upstream's fork list. Deleting does not reach into other people's clones, caches or search indexes,
so treat anything that was ever public as public.

If the intent is to keep absorbing upstream fixes:

```bash
git remote add upstream https://github.com/<upstream-owner>/<upstream-repo>.git
git fetch upstream --no-tags
git log --oneline upstream/main ^main     # what upstream has that you do not
```

and merge or cherry-pick deliberately. **Never push to `upstream`.** A repository that only ever
fetches from it is still an independent repository.

## Rules this repository keeps

1. **One remote that is written to.** `origin` is this project. `upstream`, if present, is read-only.
2. **No personal data in history.** Commits, commit messages, documentation and test fixtures carry
   placeholders (`<wxid>`, `<nickname>`, `<group>`, `<member>`, `<wechat-id>`), never a real account,
   contact or group. Evidence that contains real chat content — a probe report, a message dump —
   stays local and is never committed.
3. **No machine-specific paths in source.** Paths that only exist on one machine belong in flags or
   environment variables, not in a default. The sidecar's `--venv` / `WXBRIDGE_VENV` discovery is the
   pattern to copy.
4. **Develop on a branch off `main`.** Every requirement or piece of development gets its own branch
   (`feat/…`, `fix/…`, `docs/…`), merged back with `--no-ff` and then deleted. `main` stays reviewable,
   and the branch list stays short because a merged branch has no reason to survive.
5. **The README is part of the change.** A commit that changes behaviour updates the documentation in
   the same commit, in both languages.

## If this repository ever becomes public

Two things to re-check first, because they cannot be undone by editing:

- **History.** A rewrite before the first public push is cheap; after it, other clones and caches may
  keep the old objects. Run the placeholder check over every commit, not just the tip.
- **The sidecar is part of this repository** (`sidecar/wxauto-bridge/`), so these rules cover it: no
  personal data, no machine paths, and nothing that circumvents a licence check.
