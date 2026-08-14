# dsh-skill-manager · DSH 技能管理插件

[English](README.en.md) · 中文

> 在 DSH 设置页里统一管理 DSH / Codex / Claude 的全部 AI 技能——热开关启停、GitHub 技能市场一键发现安装、本地 ZIP 即装即用，装完立刻被 /技能 与模型看见。

![DSH 技能管理预览](docs/screenshots/social-preview.jpg)

## 这是什么

DSH（DeepSeek Harness）的技能管理插件。技能文件散落在各处：DSH 自己的技能目录、Codex 的 `~/.codex/skills`、Claude 的 `~/.claude/skills`、GitHub 上的技能仓库。本插件在设置页加了一个"技能管理"分区，把这些来源的技能收进一个面板统一查看和管理。

本插件收录于 GitHub [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题。

## 功能

- **技能列表**：合并注册表（启用）与磁盘（停用）条目，按来源分组（DeepSeek Harness / Agents / 项目 / Codex / Claude），显示名称、描述、来源、调用策略与启用状态；从 GitHub 安装的技能带来源标签。
- **启停**：DSH / Agents 目录的启停通过重命名 `SKILL.md` ↔ `SKILL.md.disabled` 实现，filesystem watcher 约 200ms 生效，DSH、Codex、Claude 都遵循这个约定；codex / claude 目录的技能默认停用，显式启用后才进入官方 `/技能` 注册表。
- **目录级启停**：组头的开关一次操作整个来源目录。
- **ZIP 安装**：选择本地 `.zip`（≤64 MiB），解压后自动查找包内的技能（SKILL.md 目录束或平铺 `.md`），查重后装入 `~/.dsh/skills` 并启用；包内没有技能时报错。
- **GitHub 技能搜索**：添加仓库（owner / name / 分支，分支可留空，默认 main→master 回退），输入关键词跨所有已添加仓库搜索技能，命中可逐个安装；本地列表另有独立搜索框，过滤已安装技能。
- **安装即刷新**：ZIP / 仓库安装成功后列表自动刷新，标题旁另有手动刷新按钮；点击卡片可展开查看技能全文。

![技能管理界面](docs/screenshots/skill-manager-v2.png)

## 文件结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 半：`skillManager` 远程服务（list / content / setEnabled / installZip / 仓库接口） |
| `lib/skill-files.js` | 磁盘约定：扫描根、frontmatter 解析、`.disabled` 启停 |
| `lib/skill-zip.js` | ZIP 解析/解压（store+deflate）、CRC32 校验、条目名安全检查、包内技能发现与安装 |
| `lib/skill-repo.js` | GitHub 归档下载（大小上限 / 超时 / 重试 / 缓存 / 镜像）、仓库技能扫描、按目录安装 |
| `lib/client.js` | 浏览器半：手写 bundle，注册 `settings.section` 分区（id: `skill-manager`，order: 17） |

## 安装

```powershell
dsh plugin --profile web add .   # 在插件目录内执行
```

代码更新后需要重启 DSH Web 生效（host 的 manifest 在网关启动时注册，不重启新接口会 404）。

Windows 下插件依赖 `zod` 与 `@deepseek-ai/dsh-typert-protocol`，它们随 DSH 安装树分发，插件目录下的 `node_modules` 是指向 `<dsh 安装目录>/node_modules` 的 junction。删除后重建：

```powershell
New-Item -ItemType Junction -Path "node_modules" -Target "C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
```

## 测试

使用 Node 内置 `node:test`，无需额外依赖，共 100 个用例：

```powershell
npm test
```

覆盖：`skill-zip`（解析/解压/安全过滤/发现/冲突/坏包）、`skill-repo`（坐标校验/分支回退/缓存/重试/安装）、`index`（host 远程方法 + 状态文件持久化）、`client`（bundle 加载/描述符/face 往返）。

## 限制

- bundled / runtime 来源的技能没有磁盘文件，不可编辑，开关置灰。
- 停用只是重命名文件，不删除内容，随时可恢复。
- 未开会话时只显示用户级与全局技能（项目级技能依赖会话的 cwd）。
- 尚未实现：zip-bomb 预算、symlink 物化、ZIP64、下载代理支持。
