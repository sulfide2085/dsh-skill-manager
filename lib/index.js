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
import { readFile, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  DISABLED_SUFFIX,
  buildRoots,
  collectSkillEntries,
  pathExists,
  resolveAgentsHome,
  resolveClaudeHome,
  resolveCodexHome,
  resolveDshHome,
  winnerEntry
} from "./skill-files.js";

export const name = "skill-manager";
export const inject = ["typert", "skills", "sessions", "agents"];

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
 * Remote 服务实例。构造即注册 "skillManager" cordis 服务，
 * 上面的 manifest 让 API 网关能分派端点。
 */
class SkillManagerGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "skillManager");
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

  /** 合并目录：注册表（启用）+ 磁盘条目（停用，或注册表视图为空时的回退）。 */
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
    // 注册表视图可用（返回了技能）时只补充停用条目；注册表为空（如未开会话、
    // 会话未挂载、无 scoped 提供方）时回退到磁盘扫描，启用条目也一并展示
    // （README：未开会话时显示用户级 + 全局技能）。
    // DSH 官方根（user-/project- dsh/agents）按名称去重、优先级胜出，
    // 且非回退时启用条目由注册表提供；第三方目录（codex/claude）的条目
    // 注册表永远没有，按 (来源, 名称) 去重、各目录独立展示（同名不同源
    // 的代码库技能互不遮蔽）。
    const fallback = skills.length === 0;
    const seenManaged = new Set();
    const seenExternal = new Set();
    for (const entry of await this.fileEntries(sessionId)) {
      const managedRoot = entry.source === "user-dsh" || entry.source === "user-agents" || entry.source === "project-dsh" || entry.source === "project-agents";
      if (managedRoot) {
        if (seenManaged.has(entry.name)) continue;
        seenManaged.add(entry.name);
        // 非回退时注册表（真实 filesystem 提供方）已覆盖官方根的启用条目
        if (!fallback && entry.enabled) continue;
      } else {
        const key = entry.source + "|" + entry.name;
        if (seenExternal.has(key)) continue;
        seenExternal.add(key);
      }
      skills.push({
        name: entry.name,
        description: entry.description,
        provider: "filesystem",
        source: entry.source,
        enabled: entry.enabled,
        modelInvocable: entry.enabled,
        userInvocable: entry.enabled
      });
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

  /** 热启停：把技能文件重命名为 *.disabled（或反向恢复）。 */
  async setEnabled(name, sessionId, enabled, source) {
    const located = await this.locate(name, sessionId, source);
    if (located.kind === "missing") throw new Error('技能 "' + name + '" 不存在');
    if (located.kind === "live") {
      const skill = located.skill;
      this.assertEditable(skill);
      if (enabled) return { name, enabled: true };
      const target = skill.path + DISABLED_SUFFIX;
      if (await pathExists(target)) throw new Error("目标文件已存在：" + target);
      await rename(skill.path, target);
      return { name, enabled: false };
    }
    if (located.kind === "disabled") {
      if (!enabled) return { name, enabled: false };
      const target = located.entry.file.slice(0, -DISABLED_SUFFIX.length);
      await rename(located.entry.file, target);
      return { name, enabled: true };
    }
    // 启用中的磁盘条目（回退视图）：停用 = 重命名为 *.disabled
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
  async setSourceEnabled(source, sessionId, enabled) {
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
  new SkillManagerGateway(ctx);
  ctx.effect(() => ctx.typert.register(MANIFEST), "skill-manager: typert manifest");
}
