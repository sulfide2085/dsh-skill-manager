# dsh-skill-manager · DSH 技能中枢

> **一句话定位：在 DSH 设置页里统一管理 DSH / Codex / Claude 的全部 AI 技能——热开关启停、GitHub 技能市场一键发现安装、本地 ZIP 即装即用，装完立刻被 /技能 与模型看见。**
>
> **One-liner: One panel to manage every skill across DSH, Codex and Claude — hot-toggle, discover & install from GitHub skill marketplaces, or import from a local ZIP, all live without restart.**

## 这是什么

DSH（DeepSeek Harness）的技能管理插件。AI 编程生态的技能散落在各处：DSH 自己的技能目录、Codex 的 `~/.codex/skills`、Claude 的 `~/.claude/skills`、GitHub 上成百上千的技能仓库。本插件把这些全部收进**一个设置面板**，谁启用、谁停用、从哪来、装什么新技能，一目了然。

本插件收录于 GitHub [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题（DeepSeek Harness 插件市场），可在 DSH 内用 `dsh plugin` 管理。

## 功能

- **跨 Agent 统一管理**：合并 DSH 注册表（启用）+ 磁盘（停用）条目，覆盖 DSH / Codex / Claude（用户级 + 项目级目录自动识别，`CODEX_HOME` / `CLAUDE_CONFIG_DIR` 可覆盖），同名技能按来源各自展示；
- **热开关启停**：切一下开关即重命名 `SKILL.md` ↔ `SKILL.md.disabled`，filesystem watcher ~200ms 内生效——对 DSH、Codex、Claude 同时有效，无需重启；第三方技能默认停用、显式启用后才进入官方 `/技能` 注册表；
- **目录级一键启停**：按来源分组（DeepSeek Harness / Agents / 项目 / Codex / Claude），组头开关一次启停整组；
- **GitHub 技能市场（发现与安装）**：预置 `anthropics/skills`、`obra/superpowers` 两大知名技能仓库；添加任意仓库（owner/name/分支，默认 main→master 回退）→ 点「搜索技能」下载归档扫描出仓库内全部 SKILL.md（可自动搜索、展开/收起结果）→ 逐个一键安装；安装后的技能进入本地列表（DeepSeek Harness 组），卡片带 GitHub 来源标签（悬停显示仓库坐标）；归档带 30 分钟磁盘缓存（`~/.dsh/cache/dsh-skill-manager/`），同仓库多次发现/安装只下载一次；
- **ZIP 安装**：选一个本地 `.zip`（≤64 MiB），自动解压、发现包内技能（目录束或平铺 `.md`）、查重后装入用户技能目录并立即启用；
- **双搜索框**：本地列表按名称/描述搜索已安装技能；GitHub 市场独立搜索框跨所有已添加仓库搜索技能（自动确保各仓库已搜索，命中即一键安装）；点击卡片展开查看技能全文；
- **安装即刷新**：ZIP / 仓库安装成功后列表自动刷新，列表标题旁另有手动「刷新」按钮——装完立刻可见，无需重开页面。

## 架构

双面 Cordis 插件（零 npm 运行时依赖，仅 node 内置）：

| 文件 | 角色 |
|---|---|
| `lib/index.js` | host 半：`skillManager` Typert Remote 服务（list / content / setEnabled / installZip / 仓库接口），注入 `typert`、`skills`、`sessions`、`agents` |
| `lib/skill-files.js` | 磁盘约定层：扫描根、frontmatter 解析、`.disabled` 启停 |
| `lib/skill-zip.js` | ZIP 安装核心：解析/解压（store+deflate）、CRC32 校验、条目名安全过滤、包内技能发现、定名/查重/落盘 |
| `lib/skill-repo.js` | GitHub 仓库发现核心：坐标白名单校验、分支回退下载（128 MiB 上限 + 60s 超时 + 瞬时失败自动重试 + 磁盘缓存 + 镜像前缀）、包装根剥除、可发现技能扫描、按目录安装 |
| `lib/client.js` | 浏览器半：手写 bundle，注册 `settings.section` 分区（id: `skill-manager`，order: 17），含 ZIP 安装与仓库发现面板，经 `ctx.remote` 调 host |

### 依赖解析说明（Windows）

插件 import `zod` 与 `@deepseek-ai/dsh-typert-protocol`，它们随 DSH 安装树分发。插件目录下的 `node_modules` 是一个 **junction**，指向 `<dsh 安装目录>/node_modules`。重建命令：

```powershell
New-Item -ItemType Junction -Path "node_modules" -Target "C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
```

## 安装 / 卸载

```powershell
dsh plugin --profile web add .     # 安装（在插件目录内执行）
dsh plugin --profile web remove dsh-skill-manager   # 卸载
```

安装（或代码更新）后**重启 DSH Web** 生效：host 半的 manifest 在网关进程启动时注册，不重启会报 HTTP 404。

## 测试

Node 内置 `node:test`（Node ≥ 18），共 **100 个用例**：

```powershell
npm test
```

- `skill-zip.test.js`：ZIP 解析/解压、CRC、zip-slip 过滤、嵌套/根目录/平铺技能发现、定名回退、冲突跳过、坏包与临时目录清理；
- `skill-repo.test.js`：仓库坐标校验、分支回退、本地 HTTP 服务的下载/超限/404、包装根剥除、发现去重排序、按目录/按名安装；
- `index.test.js`：假 cordis ctx + 真实临时目录驱动 host，覆盖全部远程方法、状态文件（启停 + 仓库 + GitHub 安装标注）持久化；
- `client.test.js`：模拟浏览器环境加载手写 bundle，覆盖字典、10 个远程描述符、分区注册与 face 往返。

## 使用限制

- bundled / runtime 来源的技能不可编辑（无磁盘文件），开关置灰；
- 停用只隐藏文件（`SKILL.md` → `SKILL.md.disabled`），不删除内容，随时可恢复；
- 仓库归档带 30 分钟磁盘缓存（`~/.dsh/cache/dsh-skill-manager/`），同仓库多次搜索/安装只下载一次，过期自动重新拉取；下载带**自动重试**（网络瞬时失败退避重试 3 次，404 等确定性错误不重试），错误信息含真实原因；可用环境变量 `DSH_SKILL_GITHUB_BASE` 指定镜像前缀（如 `https://ghproxy.com/https://github.com`，国内网络友好）；
- 防护预留项（TODO）：zip-bomb 预算、symlink 物化、ZIP64、下载代理支持；
- 列表按当前会话 cwd 解析项目根，未开会话时显示用户级 + 全局技能。
