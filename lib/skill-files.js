/**
 * dsh-skill-manager —— 技能文件层。
 *
 * 与 @deepseek-ai/dsh-skill-filesystem 的磁盘约定保持一致：
 *   - 目录束：<root>/<name>/SKILL.md（name 来自 frontmatter）
 *   - 平铺技能：<root>/<name>.md
 *   - 停用 = 重命名为 "*.disabled"，filesystem provider 的 watcher
 *     会立即把它从技能目录中移除（反之恢复）
 *   - frontmatter：YAML 块，必填 name + description
 *
 * 本模块零依赖（仅 node:fs / node:path / node:os）。
 */
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** 标记热停用技能文件的后缀。 */
export const DISABLED_SUFFIX = ".disabled";

/** DSH 官方管理根（注册表 filesystem 提供方覆盖的目录）。 */
export const MANAGED_SOURCES = new Set(["user-dsh", "user-agents", "project-dsh", "project-agents"]);

/** 是否为 DSH 官方管理根（false = 第三方目录，如 codex/claude）。 */
export function isManagedSource(source) {
  return MANAGED_SOURCES.has(source);
}

/** 是否为第三方目录来源（codex / claude）。 */
export function isExternalSource(source) {
  return source.startsWith("codex-") || source.startsWith("claude-");
}

/** 技能名的公开语法（kebab-case，小写字母数字）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 路径是否存在。 */
export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 项目锚点：最近的含 .git 的祖先目录，找不到则用 cwd 自身。 */
export async function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** 解析 DSH home（与 dsh-home-paths 的默认规则一致）。 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return resolve(env.trim());
  return resolve(join(homedir(), ".dsh"));
}

/** 解析共享 agents home（默认 ~/.agents）。 */
export function resolveAgentsHome() {
  const env = process.env.DSH_AGENTS_HOME;
  if (typeof env === "string" && env.trim().length > 0) return resolve(env.trim());
  return resolve(join(homedir(), ".agents"));
}

/** 解析 Codex 用户目录（CODEX_HOME 覆盖，默认 ~/.codex）。 */
export function resolveCodexHome() {
  const env = process.env.CODEX_HOME;
  if (typeof env === "string" && env.trim().length > 0) return resolve(env.trim());
  return resolve(join(homedir(), ".codex"));
}

/** 解析 Claude 配置目录（CLAUDE_CONFIG_DIR 覆盖，默认 ~/.claude）。 */
export function resolveClaudeHome() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (typeof env === "string" && env.trim().length > 0) return resolve(env.trim());
  return resolve(join(homedir(), ".claude"));
}

/**
 * 宽松读取 frontmatter（用于列表展示）：name + description + whenToUse + body。
 * 文件不像一个技能时返回 undefined。
 */
export function parseFrontmatter(raw) {
  const text = raw.trimStart();
  if (!text.startsWith("---")) return undefined;
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1) return undefined;
  const closing = text.indexOf("\n---", firstEnd + 1);
  const fmEnd = closing === -1 ? text.length : closing;
  const fm = text.slice(3, fmEnd);
  let body = "";
  if (closing !== -1) {
    const at = text.indexOf("\n", closing + 3);
    if (at !== -1) body = text.slice(at + 1);
  }
  const pick = (key) => {
    const m = new RegExp("^" + key + ":\\s*(.+)$", "m").exec(fm);
    if (m === null) return undefined;
    const value = m[1].trim();
    return value.replace(/^["']|["']$/g, "");
  };
  const name = pick("name");
  if (name === undefined || !SKILL_NAME_RE.test(name)) return undefined;
  return { name, description: pick("description") ?? "", whenToUse: pick("whenToUse"), body: body.trim() };
}

/**
 * 管理根目录：项目根（cwd 的 git 锚点）+ 用户根。
 * 顺序 = 发现优先级（靠前的赢），与提供方 rank 一致：
 * 项目 .dsh > 项目 .agents > 项目 .codex > 项目 .claude
 *   > 用户 .dsh > 用户 .agents > 用户 .codex > 用户 .claude。
 * 相同目录去重（例如在 home 下运行，项目锚点回退到 cwd 自身）。
 */
export async function buildRoots(cwd, options = {}) {
  const roots = [];
  const seen = new Set();
  const push = (path, source) => {
    const normalized = resolve(path);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path, source });
  };
  if (cwd !== undefined) {
    const project = await findProjectRoot(cwd);
    push(join(project, ".dsh", "skills"), "project-dsh");
    push(join(project, ".agents", "skills"), "project-agents");
    push(join(project, ".codex", "skills"), "codex-project");
    push(join(project, ".claude", "skills"), "claude-project");
  }
  if (options.dshHome !== undefined) push(join(options.dshHome, "skills"), "user-dsh");
  if (options.agentsHome !== undefined) push(join(options.agentsHome, "skills"), "user-agents");
  if (options.codexHome !== undefined) push(join(options.codexHome, "skills"), "codex-user");
  if (options.claudeHome !== undefined) push(join(options.claudeHome, "skills"), "claude-user");
  return roots;
}

/**
 * 一个文件级技能条目（启用或停用）。
 * @typedef {Object} SkillFileEntry
 * @property {string} name 技能名（kebab-case）
 * @property {string} description 单行简介
 * @property {string} file SKILL.md（或 *.disabled）的绝对路径
 * @property {boolean} dirBundle 是否为目录束（true）还是平铺文件（false）
 * @property {string} source 来源标签（project-dsh / project-agents / user-dsh / user-agents）
 * @property {boolean} enabled 当前是否启用
 * @property {string} root 所属扫描根
 */

/** 扫描一个根目录下的全部技能条目（启用 + 停用）。root 为 { path, source }。 */
export async function scanRoot(root) {
  const entries = [];
  let names;
  try {
    names = await readdir(root.path, { withFileTypes: true });
  } catch {
    return entries; // 根不存在或不可读：视为空
  }
  for (const dirent of names) {
    // 跳过系统目录（用户根下的 .system 由 DSH 保留）
    if (dirent.name === ".system") continue;
    if (dirent.isDirectory()) {
      const base = join(root.path, dirent.name);
      const skillFile = join(base, "SKILL.md");
      const disabledFile = join(base, "SKILL.md" + DISABLED_SUFFIX);
      let file;
      let enabled;
      if (await pathExists(skillFile)) {
        file = skillFile;
        enabled = true;
      } else if (await pathExists(disabledFile)) {
        file = disabledFile;
        enabled = false;
      } else {
        continue; // 没有 SKILL.md 的目录不算技能
      }
      let parsed;
      try {
        parsed = parseFrontmatter(await readFile(file, "utf8"));
      } catch {
        continue;
      }
      if (parsed === undefined) continue;
      entries.push({ name: parsed.name, description: parsed.description, file, dirBundle: true, enabled, source: root.source, root: root.path });
    } else if (dirent.name.endsWith(".md") || dirent.name.endsWith(".md" + DISABLED_SUFFIX)) {
      const file = join(root.path, dirent.name);
      const enabled = dirent.name.endsWith(".md");
      let parsed;
      try {
        parsed = parseFrontmatter(await readFile(file, "utf8"));
      } catch {
        continue;
      }
      if (parsed === undefined) continue;
      entries.push({ name: parsed.name, description: parsed.description, file, dirBundle: false, enabled, source: root.source, root: root.path });
    }
  }
  return entries;
}

/** 收集全部根下的所有技能条目（启用 + 停用），按根优先级排序。 */
export async function collectSkillEntries(roots) {
  const out = [];
  for (const root of roots) {
    out.push(...(await scanRoot(root)));
  }
  return out;
}

/** 按名称取胜出条目（靠前的根优先）；同名时启用的优先于停用的。 */
export async function winnerEntry(entries, name) {
  let fallback;
  for (const entry of entries) {
    if (entry.name !== name) continue;
    if (entry.enabled) return entry;
    if (fallback === undefined) fallback = entry;
  }
  return fallback;
}
