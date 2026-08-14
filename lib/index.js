/**
 * dsh-skill-manager —— host 半。
 *
 * 一个 Typert Remote 服务（"skillManager"）暴露当前会话的技能目录
 * （启用 + 热停用）与热管理操作：
 *   - list：注册表（启用）+ 磁盘（停用）的合并目录，含来源与调用策略
 *   - content：技能正文
 *   - setEnabled：重命名 SKILL.md <-> SKILL.md.disabled 实现热启停
 *
 * skill-filesystem 提供方的文件 watcher 会在 ~200ms 内感知每次变更，
 * 因此所有操作无需重启网关即可生效。
 */
import { z } from "zod";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  DISABLED_SUFFIX,
  buildRoots,
  collectSkillEntries,
  findProjectRoot,
  isExternalSource,
  isManagedSource,
  parseFrontmatter,
  pathExists,
  resolveAgentsHome,
  resolveClaudeHome,
  resolveCodexHome,
  resolveDshHome,
  scanRoot,
  winnerEntry
} from "./skill-files.js";

export const name = "skill-manager";
export const inject = ["typert", "skills", "sessions", "agents"];

/** 第三方（codex/claude）技能在注册表中的优先级：低于用户 agents 根（500）、高于 bundled（600）。 */
const EXTERNAL_SKILL_RANK = 550;

/** 插件启停状态文件名（DSH home 下）。 */
const STATE_FILE_NAME = "dsh-skill-manager.json";

/** 插件状态文件：记录第三方目录中被显式启用的技能（默认全部停用）。 */
function stateFilePath() {
  return join(resolveDshHome(), STATE_FILE_NAME);
}

async function loadExternalEnabled() {
  try {
    const raw = await readFile(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.enabled)) return new Set(parsed.enabled);
  } catch {
    // 文件不存在或损坏：视为全停用
  }
  return new Set();
}

async function saveExternalEnabled(enabled) {
  await writeFile(stateFilePath(), JSON.stringify({ enabled: [...enabled].sort() }, null, 2), "utf8");
}

/** 第三方目录根（codex / claude，用户级 + 项目级）。 */
async function externalRoots(cwd) {
  const roots = [];
  if (cwd !== undefined) {
    const project = await findProjectRoot(cwd);
    roots.push({ path: join(project, ".codex", "skills"), source: "codex-project" });
    roots.push({ path: join(project, ".claude", "skills"), source: "claude-project" });
  }
  roots.push({ path: join(resolveCodexHome(), "skills"), source: "codex-user" });
  roots.push({ path: join(resolveClaudeHome(), "skills"), source: "claude-user" });
  return roots;
}

// ── wire schemas（zod）─────────────────────────────────────────────────────

const sessionIdSchema = z.string().optional();

const skillSourceSchema = z.string().optional();

const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  provider: z.string(),
  source: z.string(),
  enabled: z.boolean(),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean()
});

const listResultSchema = z.object({ skills: z.array(skillSummarySchema) });

const contentResultSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    content: z.string(),
    provider: z.string(),
    whenToUse: z.string().optional(),
    path: z.string().optional()
  })
  .nullable();

const setEnabledResultSchema = z.object({ name: z.string(), enabled: z.boolean() });

const setSourceEnabledResultSchema = z.object({
  source: z.string(),
  enabled: z.boolean(),
  toggled: z.number()
});

/** 注册到 API 网关的远程描述符。 */
const MANIFEST = {
  package: "dsh-skill-manager",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-skill-manager#skillManager/list",
      service: "skillManager",
      namespace: "skillManager",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-manager#sessionId", schema: sessionIdSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-manager#SkillListResult", schema: listResultSchema }
    },
    {
      id: "dsh-skill-manager#skillManager/content",
      service: "skillManager",
      namespace: "skillManager",
      method: "content",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-manager#SkillName", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-manager#sessionId", schema: sessionIdSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-manager#SkillContent", schema: contentResultSchema }
    },
    {
      id: "dsh-skill-manager#skillManager/setEnabled",
      service: "skillManager",
      namespace: "skillManager",
      method: "setEnabled",
      invocation: { kind: "direct" },
      parameters: [
        { name: "name", wire: "name", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-manager#SkillName", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-manager#sessionId", schema: sessionIdSchema } },
        { name: "enabled", wire: "enabled", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-manager#EnabledFlag", schema: z.boolean() } },
        { name: "source", wire: "source", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-manager#SkillSource", schema: skillSourceSchema } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-manager#SetEnabledResult", schema: setEnabledResultSchema }
    },
    {
      id: "dsh-skill-manager#skillManager/setSourceEnabled",
      service: "skillManager",
      namespace: "skillManager",
      method: "setSourceEnabled",
      invocation: { kind: "direct" },
      parameters: [
        { name: "source", wire: "source", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-manager#SkillSource", schema: z.string() } },
        { name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: { mode: "strict", typeSymbol: "dsh-skill-manager#sessionId", schema: sessionIdSchema } },
        { name: "enabled", wire: "enabled", source: "json", codec: { mode: "strict", typeSymbol: "dsh-skill-manager#EnabledFlag", schema: z.boolean() } }
      ],
      result: { mode: "strict", typeSymbol: "dsh-skill-manager#SetSourceEnabledResult", schema: setSourceEnabledResultSchema }
    }
  ],
  model: { services: [], events: [], objects: [] }
};

/**
 * 第三方目录（codex/claude）技能提供方：注册进全局技能层，
 * 使官方 /技能 命令可见。只有插件状态里显式启用（默认停用）
 * 且磁盘上未停用的技能才会进入目录。
 */
class ExternalSkillProvider {
  constructor(ctx, control) {
    this.ctx = ctx;
    this.control = control;
    this.name = "external-cli";
  }

  async list(options) {
    const enabled = await loadExternalEnabled();
    const candidates = [];
    for (const root of await externalRoots(options?.cwd)) {
      for (const entry of await scanRoot(root)) {
        if (!entry.enabled) continue;
        const key = entry.source + "|" + entry.name;
        if (!enabled.has(key)) continue;
        candidates.push({
          name: entry.name,
          description: entry.description,
          ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
          invocation: { modelInvocable: true, userInvocable: true },
          source: entry.source,
          rank: EXTERNAL_SKILL_RANK,
          provider: this.name,
          path: entry.file,
          locator: { kind: "directory", path: entry.file, directory: entry.root }
        });
      }
    }
    return { candidates, complete: true };
  }

  async get(candidate) {
    const raw = await readFile(candidate.locator.path, "utf8");
    const parsed = parseFrontmatter(raw);
    if (parsed === undefined) return undefined;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: { modelInvocable: true, userInvocable: true },
      source: candidate.source,
      provider: this.name,
      content: raw,
      path: candidate.locator.path,
      resourceBase: { kind: "directory", path: candidate.locator.directory }
    };
  }
}

/**
 * Remote 服务实例。构造即注册 "skillManager" cordis 服务，
 * 上面的 manifest 让 API 网关能分派端点。
 */
class SkillManagerGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "skillManager");
    this.externalControl = undefined;
  }

  /** apply() 注册第三方提供方时注入其失效控制。 */
  setExternalControl(control) {
    this.externalControl = control;
  }

  /** 状态变更后让注册表重扫（/技能 与列表即时反映）。 */
  invalidateExternal() {
    this.externalControl?.invalidate();
  }

  // ── 会话视图解析（与官方 skill.list 的解析路径一致）────────────────────────

  registryFor(sessionId) {
    const live = sessionId === undefined ? undefined : this.ctx.agents.get(sessionId);
    if (live !== undefined) {
      const scoped = this.ctx.get("agentPresets")?.serviceFor(live, "skills");
      if (scoped !== undefined) return scoped;
    }
    return this.ctx.skills;
  }

  viewFor(sessionId) {
    const registry = this.registryFor(sessionId);
    const session = sessionId === undefined ? undefined : this.ctx.sessions.get(sessionId);
    const scope = sessionId === undefined ? undefined : this.ctx.agents.get(sessionId);
    return { registry, cwd: session?.header?.cwd, scope };
  }

  /** 一个会话视图的管理根（项目 + 用户）。 */
  async rootsFor(sessionId) {
    const { cwd } = this.viewFor(sessionId);
    return buildRoots(cwd, {
      dshHome: resolveDshHome(),
      agentsHome: resolveAgentsHome(),
      codexHome: resolveCodexHome(),
      claudeHome: resolveClaudeHome()
    });
  }

  /** 一个会话视图的全部文件级条目（启用 + 停用）。 */
  async fileEntries(sessionId) {
    return collectSkillEntries(await this.rootsFor(sessionId));
  }

  // ── 远程方法 ──────────────────────────────────────────────────────────────

  /** 合并目录：注册表（启用）+ 磁盘条目（停用 / 第三方默认停用）。 */
  async list(sessionId) {
    const { registry, cwd, scope } = this.viewFor(sessionId);
    const listed = await registry.list({ cwd, scope });
    const skills = listed.map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      provider: skill.provider,
      source: skill.source ?? (skill.provider === "runtime" ? "runtime" : ""),
      enabled: true,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable
    }));
    const seen = new Set(skills.map((skill) => skill.name));
    // 官方根（dsh/agents）：按名称去重、优先级胜出，注册表已覆盖的启用条目跳过；
    // 第三方目录（codex/claude）：按 (来源, 名称) 去重、各目录独立展示（同名不同源
    // 互不遮蔽），且默认停用（显式启用后才在注册表 / 官方 /技能 中可见）。
    const seenManaged = new Set();
    const seenFileExternal = new Set();
    const seenRegistryExternal = new Set();
    for (const skill of skills) if (!isManagedSource(skill.source)) seenRegistryExternal.add(skill.source + "|" + skill.name);
    const externalEnabled = await loadExternalEnabled();
    for (const entry of await this.fileEntries(sessionId)) {
      if (isManagedSource(entry.source)) {
        if (seenManaged.has(entry.name)) continue;
        seenManaged.add(entry.name);
        if (entry.enabled && seen.has(entry.name)) continue;
        skills.push({
          name: entry.name,
          description: entry.description,
          provider: "filesystem",
          source: entry.source,
          enabled: entry.enabled,
          modelInvocable: entry.enabled,
          userInvocable: entry.enabled
        });
      } else {
        const key = entry.source + "|" + entry.name;
        if (seenFileExternal.has(key) || seenRegistryExternal.has(key)) continue;
        seenFileExternal.add(key);
        const on = entry.enabled && externalEnabled.has(key);
        skills.push({
          name: entry.name,
          description: entry.description,
          provider: "filesystem",
          source: entry.source,
          enabled: on,
          modelInvocable: on,
          userInvocable: on
        });
      }
    }
    return { skills };
  }

  /** 定位技能：注册表（启用）、磁盘文件（启用/停用）或缺失。source 限定磁盘来源。 */
  async locate(name, sessionId, source) {
    const { registry, cwd, scope } = this.viewFor(sessionId);
    if (source === undefined) {
      const skill = await registry.get(name, { cwd, scope });
      if (skill !== undefined) return { kind: "live", skill };
    }
    const entries = await this.fileEntries(sessionId);
    const scoped = source === undefined ? entries : entries.filter((entry) => entry.source === source);
    const entry = await winnerEntry(scoped, name);
    if (entry !== undefined) return { kind: entry.enabled ? "file" : "disabled", entry };
    return { kind: "missing" };
  }

  /** 完整正文：注册表定义，或磁盘原文（启用/停用文件条目）。 */
  async content(name, sessionId) {
    const located = await this.locate(name, sessionId);
    if (located.kind === "missing") return null;
    if (located.kind === "file" || located.kind === "disabled") {
      const raw = await readFile(located.entry.file, "utf8");
      return {
        name: located.entry.name,
        description: located.entry.description,
        content: raw,
        provider: "filesystem",
        path: located.entry.file
      };
    }
    const skill = located.skill;
    return {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      provider: skill.provider,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      ...(skill.path === undefined ? {} : { path: skill.path })
    };
  }

  /** 只有文件技能可编辑；随包（bundled）/ 运行时（runtime）技能拒绝修改。 */
  assertEditable(skill) {
    if (skill.source === "bundled") throw new Error('技能 "' + skill.name + '" 随部署附带，不可修改');
    if (typeof skill.path !== "string" || skill.path.length === 0) throw new Error('技能 "' + skill.name + '" 没有可修改的文件');
  }

  /** 第三方目录（codex/claude）技能的启停：改插件状态，不改文件。 */
  async setExternalEnabled(name, source, sessionId, enabled) {
    const entries = (await this.fileEntries(sessionId)).filter((entry) => entry.source === source);
    const entry = await winnerEntry(entries, name);
    if (entry === undefined) throw new Error('技能 "' + name + '" 不存在');
    const state = await loadExternalEnabled();
    const key = source + "|" + name;
    if (enabled) state.add(key);
    else state.delete(key);
    await saveExternalEnabled(state);
    this.invalidateExternal();
    return { name, enabled };
  }

  /** 热启停：官方根重命名 SKILL.md <-> SKILL.md.disabled；第三方目录改插件状态。 */
  async setEnabled(name, sessionId, enabled, source) {
    if (source !== undefined && isExternalSource(source)) {
      return this.setExternalEnabled(name, source, sessionId, enabled);
    }
    const located = await this.locate(name, sessionId, source);
    if (located.kind === "missing") throw new Error('技能 "' + name + '" 不存在');
    if (located.kind === "live") {
      const skill = located.skill;
      if (isExternalSource(skill.source)) return this.setExternalEnabled(name, skill.source, sessionId, enabled);
      this.assertEditable(skill);
      if (enabled) return { name, enabled: true };
      const target = skill.path + DISABLED_SUFFIX;
      if (await pathExists(target)) throw new Error("目标文件已存在：" + target);
      await rename(skill.path, target);
      return { name, enabled: false };
    }
    if (isExternalSource(located.entry.source)) {
      return this.setExternalEnabled(name, located.entry.source, sessionId, enabled);
    }
    if (located.kind === "disabled") {
      if (!enabled) return { name, enabled: false };
      const target = located.entry.file.slice(0, -DISABLED_SUFFIX.length);
      await rename(located.entry.file, target);
      return { name, enabled: true };
    }
    // 启用中的磁盘条目：停用 = 重命名为 *.disabled
    if (enabled) return { name, enabled: true };
    const target = located.entry.file + DISABLED_SUFFIX;
    if (await pathExists(target)) throw new Error("目标文件已存在：" + target);
    await rename(located.entry.file, target);
    return { name, enabled: false };
  }

  /**
   * 目录级一键启停：把一个来源根（如 codex-user / claude-user）下的全部
   * 技能文件统一重命名（SKILL.md <-> SKILL.md.disabled）。幂等：已处于
   * 目标状态的条目跳过。返回实际变更的条目数。
   */
  /** 第三方目录一键启停：整目录切换插件状态（默认全停用）。 */
  async setSourceExternal(source, sessionId, enabled) {
    const entries = (await this.fileEntries(sessionId)).filter((entry) => entry.source === source);
    const state = await loadExternalEnabled();
    let toggled = 0;
    for (const entry of entries) {
      const key = source + "|" + entry.name;
      if (enabled) {
        if (!state.has(key)) {
          state.add(key);
          toggled += 1;
        }
      } else if (state.delete(key)) {
        toggled += 1;
      }
    }
    await saveExternalEnabled(state);
    this.invalidateExternal();
    return { source, enabled, toggled };
  }

  /** 目录级一键启停：官方根重命名文件；第三方目录切换插件状态。 */
  async setSourceEnabled(source, sessionId, enabled) {
    if (isExternalSource(source)) return this.setSourceExternal(source, sessionId, enabled);
    const entries = (await this.fileEntries(sessionId)).filter((entry) => entry.source === source);
    let toggled = 0;
    for (const entry of entries) {
      if (entry.enabled === enabled) continue;
      const target = enabled
        ? entry.file.slice(0, -DISABLED_SUFFIX.length)
        : entry.file + DISABLED_SUFFIX;
      if (await pathExists(target)) throw new Error("目标文件已存在：" + target);
      await rename(entry.file, target);
      toggled += 1;
    }
    return { source, enabled, toggled };
  }
}

export function apply(ctx) {
  const gateway = new SkillManagerGateway(ctx);
  // 注册第三方（codex/claude）提供方到全局技能层：显式启用的技能
  // 进入官方注册表（/技能 命令可见），默认全部停用。
  ctx.skills.registerProvider((control) => {
    gateway.setExternalControl(control);
    return new ExternalSkillProvider(ctx, control);
  });
  ctx.effect(() => ctx.typert.register(MANIFEST), "skill-manager: typert manifest");
}
