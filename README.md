# dsh-skill-manager

DSH（DeepSeek Harness）技能管理插件：在 Web 设置的侧边栏新增「技能管理」分区，
展示**全部已加载 skill**（启用 + 热停用、来源、模型/用户调用策略），支持**热开关**启停。

## 功能

- **全部技能列表**：合并注册表（启用）与磁盘（停用）条目，展示名称、描述、来源、
  调用策略徽章（模型+用户 / 仅模型 / 仅用户 / 已禁用调用）；
- **第三方技能目录**：自动识别常见 CLI 的技能目录并纳入管理——
  Codex（`~/.codex/skills` 与项目 `.codex/skills`，`CODEX_HOME` 可覆盖）与
  Claude（`~/.claude/skills` 与项目 `.claude/skills`，`CLAUDE_CONFIG_DIR` 可覆盖），
  同名技能按目录各自展示、互不遮蔽；
- **第三方技能默认停用，可接入官方 /技能**：codex/claude 目录的技能**默认全部停用**
  （只改插件状态、不动文件，Codex/Claude 自身照常使用）；在技能管理页显式启用后，
  插件向全局技能注册表注册的 provider 会将其纳入，官方 **/技能** 命令与模型侧
  `skill` 工具即可看到并调用。状态存于 `~/.dsh/dsh-skill-manager.json`；
- **热开关（单个）**：切换即重命名 `SKILL.md` ↔ `SKILL.md.disabled`，filesystem provider
  的 watcher 在 ~200ms 内感知，模型技能目录立即更新，无需重启；停用后的技能对
  Codex / Claude 同样生效（它们只认 `SKILL.md`）；
- **目录级一键启停**：按来源分组（本地 / 项目 / Codex / Claude …），组头开关一次
  启停该目录下的全部技能；
- **正文预览**：点击卡片展开查看技能完整内容；
- **搜索**：按名称/描述过滤。

## 架构

双面 Cordis 插件：

| 文件 | 角色 |
|---|---|
| `lib/index.js` | host 半：`skillManager` Typert Remote 服务（list / content / setEnabled），注入 `typert`、`skills`、`sessions`、`agents` |
| `lib/skill-files.js` | 磁盘约定层（零依赖）：扫描根、frontmatter 解析、`.disabled` 启停 |
| `lib/client.js` | 浏览器半：手写 bundle（`window.__ModuleLoader__.load`），注册 `settings.section` 分区（id: `skill-manager`，order: 17），经 `ctx.remote` 调 host |

### 依赖解析说明（Windows）

插件 import `zod` 与 `@deepseek-ai/dsh-typert-protocol`，它们不在 profile 的
node_modules 里，而是随 DSH 安装树分发。插件目录下的 `node_modules` 是一个
**junction**，指向 `<dsh 安装目录>/node_modules`，使 Node 模块解析能够找到这些包。
删除/重建 junction 的命令：

```powershell
# 目标：dsh 安装树的 node_modules（npm 全局安装时）
New-Item -ItemType Junction -Path "node_modules" -Target "C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules"
```

## 测试

使用 Node 内置的 `node:test`（要求 Node ≥ 18），无需额外依赖：

```powershell
# 在插件目录内执行
npm test
```

覆盖范围（`test/`，共 44 个用例）：

- `skill-files.test.js`：frontmatter 解析、路径存在性、项目根锚点、管理根构建与去重、
  目录束/平铺/停用扫描、`.system` 跳过、同名胜出规则；
- `index.test.js`：用假 cordis ctx + 真实临时目录驱动 host 半的 `apply()`，覆盖
  typert manifest 注册、`list` 合并/去重/无会话/scoped 注册表、`content`
  三种定位、`setEnabled` 启停/拒绝 bundled 与 runtime/幂等，并核对真实文件
  重命名结果；
- `client.test.js`：模拟浏览器环境（`window.__ModuleLoader__` + 桩 react）加载
  手写 bundle，覆盖字典注册、远程贡献清单、设置分区注册与 face 方法的
  往返调用（含错误路径）。

## 安装

```powershell
# 在本仓库目录内执行（需要 PATH 中有 pnpm；没有时可用 corepack pnpm 的 shim）
dsh plugin --profile web add .
```

安装后重启 DSH Web 即可在 设置 → 技能管理 看到页面。

## 卸载

```powershell
dsh plugin --profile web remove dsh-skill-manager
```

## 使用限制

- **bundled / runtime 来源的技能不可编辑**（无磁盘文件可操作），开关置灰；
- 停用技能只隐藏文件（`SKILL.md` → `SKILL.md.disabled`），**不删除内容**，随时可恢复；
- 列表按当前会话的 cwd 解析项目根，未开会话时显示用户级 + 全局技能。
