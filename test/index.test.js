/**
 * dsh-skill-manager —— host 半集成测试。
 *
 * 用一个假 cordis ctx（reflect.provide / typert.register / skills / sessions /
 * agents / agentPresets）驱动 lib/index.js 的 apply()，取出注册的
 * skillManager 服务实例，直接调用 list / content / setEnabled 并核对
 * 真实文件系统上的重命名结果。
 *
 * 运行：node --test test/index.test.js
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, inject, name } from "../lib/index.js";
import { buildRoots, collectSkillEntries, DISABLED_SUFFIX, pathExists } from "../lib/skill-files.js";

/** 生成一个合法技能的原始文本。 */
function skillRaw(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

/**
 * 基于磁盘动态构建的假技能注册表：每次 list/get 都重新扫描根目录，
 * 只返回启用条目（与真实 skill-filesystem 提供方行为一致），同名技能
 * 按根优先级只保留胜出者；list/get 尊重传入的 cwd（无 cwd 时只扫用户根）。
 * extra 用于注入不走磁盘的技能（runtime / bundled）。
 */
function makeRegistry({ roots, extra = [] }) {
  // 真实 filesystem 提供方只覆盖 DSH/agents 官方根，不扫描 codex/claude 目录
  const managedRoots = roots.filter((root) => root.source.startsWith("user-") || root.source.startsWith("project-"));
  const activeFor = (cwd) => (cwd === undefined ? managedRoots.filter((root) => root.source.startsWith("user-")) : managedRoots);
  const scanLive = async (cwd) => {
    const live = [];
    const seen = new Set();
    for (const entry of await collectSkillEntries(activeFor(cwd))) {
      if (!entry.enabled || seen.has(entry.name)) continue;
      seen.add(entry.name);
      live.push({
        name: entry.name,
        description: entry.description,
        provider: "filesystem",
        source: entry.source,
        invocation: { modelInvocable: true, userInvocable: true },
        content: "已加载正文 " + entry.name,
        path: entry.file
      });
    }
    for (const skill of extra) live.push(skill);
    return live;
  };
  return {
    async list({ cwd } = {}) {
      return scanLive(cwd);
    },
    async get(skillName, { cwd } = {}) {
      return (await scanLive(cwd)).find((skill) => skill.name === skillName);
    }
  };
}

/** 假 cordis ctx：只提供插件实际用到的能力。 */
function makeContext({ registry, sessions = {}, agents = {}, agentPresets } = {}) {
  const provided = new Map();
  let manifest;
  const ctx = {
    skills: registry,
    sessions: { get: (id) => sessions[id] },
    agents: { get: (id) => agents[id] },
    typert: { register: (m) => { manifest = m; } },
    get: (key) => (key === "agentPresets" ? agentPresets : undefined),
    reflect: { provide: (key, value) => provided.set(key, value) },
    effect: (fn) => { fn(); return () => {}; },
    provided,
    manifest: () => manifest
  };
  return ctx;
}

// ── 测试脚手架：每个用例独立临时目录 ─────────────────────────────────────

let tmp;
let projectRoot;
let homeRoot;
let gateway;
let ctx;
let registry;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "skm-host-"));
  projectRoot = tmp;

  // 项目根（.git 锚点）+ 项目级技能
  await mkdir(join(tmp, ".git"));
  await mkdir(join(tmp, ".dsh", "skills", "skill-a"), { recursive: true });
  await writeFile(join(tmp, ".dsh", "skills", "skill-a", "SKILL.md"), skillRaw("skill-a", "技能 A", "正文 A"));
  await mkdir(join(tmp, ".dsh", "skills", "skill-c"), { recursive: true });
  await writeFile(join(tmp, ".dsh", "skills", "skill-c", "SKILL.md" + DISABLED_SUFFIX), skillRaw("skill-c", "技能 C", "正文 C"));

  // 用户级技能（DSH_HOME / DSH_AGENTS_HOME 指向它）
  homeRoot = join(tmp, "home");
  await mkdir(join(homeRoot, ".dsh", "skills", "skill-u"), { recursive: true });
  await writeFile(join(homeRoot, ".dsh", "skills", "skill-u", "SKILL.md"), skillRaw("skill-u", "技能 U", "正文 U"));
  process.env.DSH_HOME = join(homeRoot, ".dsh");
  process.env.DSH_AGENTS_HOME = join(homeRoot, ".agents");

  process.env.CODEX_HOME = join(homeRoot, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(homeRoot, "claude");

  const roots = await buildRoots(projectRoot, {
    dshHome: process.env.DSH_HOME,
    agentsHome: process.env.DSH_AGENTS_HOME,
    codexHome: process.env.CODEX_HOME,
    claudeHome: process.env.CLAUDE_CONFIG_DIR
  });
  registry = makeRegistry({
    roots,
    extra: [
      {
        name: "skill-rt",
        description: "运行时技能",
        provider: "runtime",
        source: "runtime",
        invocation: { modelInvocable: true, userInvocable: false },
        content: "# runtime"
      },
      {
        name: "skill-bd",
        description: "随包技能",
        provider: "filesystem",
        source: "bundled",
        invocation: { modelInvocable: false, userInvocable: true },
        content: "# bundled",
        path: join(tmp, ".dsh", "skills", "skill-bd", "SKILL.md")
      }
    ]
  });

  ctx = makeContext({
    registry,
    sessions: { s1: { header: { cwd: projectRoot } } },
    agents: { s1: {} }
  });
  apply(ctx);
  gateway = ctx.provided.get("skillManager");
  assert.ok(gateway, "apply 后应注册 skillManager 服务");
});

afterEach(async () => {
  delete process.env.DSH_HOME;
  delete process.env.DSH_AGENTS_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(tmp, { recursive: true, force: true });
});

// ── 注册与清单 ──────────────────────────────────────────────────────────

describe("插件注册", () => {
  test("导出 name/inject/apply", () => {
    assert.equal(name, "skill-manager");
    assert.deepEqual(inject, ["typert", "skills", "sessions", "agents"]);
    assert.equal(typeof apply, "function");
  });

  test("typert manifest 包含 4 个远程调用", () => {
    const manifest = ctx.manifest();
    assert.equal(manifest.package, "dsh-skill-manager");
    assert.equal(manifest.face, "host");
    const ids = manifest.invocations.map((invocation) => invocation.id);
    assert.deepEqual(ids, [
      "dsh-skill-manager#skillManager/list",
      "dsh-skill-manager#skillManager/content",
      "dsh-skill-manager#skillManager/setEnabled",
      "dsh-skill-manager#skillManager/setSourceEnabled"
    ]);
  });
});

// ── list ────────────────────────────────────────────────────────────────

describe("skillManager.list", () => {
  test("合并注册表（启用）与磁盘（停用）条目", async () => {
    const { skills } = await gateway.list("s1");
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));

    // 启用：项目根 + 用户根 + 注入
    assert.equal(byName["skill-a"].enabled, true);
    assert.equal(byName["skill-a"].source, "project-dsh");
    assert.equal(byName["skill-a"].provider, "filesystem");
    assert.equal(byName["skill-u"].source, "user-dsh");
    assert.equal(byName["skill-rt"].source, "runtime");
    assert.equal(byName["skill-rt"].modelInvocable, true);
    assert.equal(byName["skill-rt"].userInvocable, false);
    // 停用：来自磁盘扫描
    assert.equal(byName["skill-c"].enabled, false);
    assert.equal(byName["skill-c"].provider, "filesystem");
    assert.equal(byName["skill-c"].source, "project-dsh");
    assert.equal(byName["skill-c"].modelInvocable, false);
    assert.equal(byName["skill-c"].userInvocable, false);

    const names = skills.map((skill) => skill.name).sort();
    assert.deepEqual(names, ["skill-a", "skill-bd", "skill-c", "skill-rt", "skill-u"]);
  });

  test("无会话时只用用户根扫描磁盘", async () => {
    const { skills } = await gateway.list(undefined);
    const names = skills.map((skill) => skill.name).sort();
    // 项目根的 skill-a / skill-c 不出现，只有用户根 skill-u + 注入项
    assert.deepEqual(names, ["skill-bd", "skill-rt", "skill-u"]);
  });

  test("会话使用 agentPresets 提供的 scoped 注册表", async () => {
    const scopedRegistry = makeRegistry({
      roots: [],
      extra: [{ name: "scoped-only", description: "预设隔离技能", provider: "filesystem", source: "project-agents", invocation: { modelInvocable: true, userInvocable: true }, content: "x", path: "/x/SKILL.md" }]
    });
    const scopedCtx = makeContext({
      registry,
      sessions: { s2: { header: { cwd: projectRoot } } },
      agents: { s2: { preset: "demo" } },
      agentPresets: { serviceFor: (live, key) => (key === "skills" ? scopedRegistry : undefined) }
    });
    apply(scopedCtx);
    const scopedGateway = scopedCtx.provided.get("skillManager");

    const { skills } = await scopedGateway.list("s2");
    const names = skills.map((skill) => skill.name).sort();
    // live 列表来自 scoped 注册表；磁盘停用列表仍按会话 cwd 扫描
    assert.deepEqual(names, ["scoped-only", "skill-c"]);
    assert.equal(skills.find((skill) => skill.name === "scoped-only").enabled, true);
    assert.equal(skills.find((skill) => skill.name === "scoped-only").source, "project-agents");
    assert.equal(skills.find((skill) => skill.name === "skill-c").enabled, false);
  });

  test("注册表视图为空时回退到磁盘：启用 + 停用条目都展示，且可预览/启停", async () => {
    // 用户根放一个已停用的技能，验证回退视图也展示停用条目
    await mkdir(join(homeRoot, ".dsh", "skills", "skill-d"), { recursive: true });
    await writeFile(join(homeRoot, ".dsh", "skills", "skill-d", "SKILL.md" + DISABLED_SUFFIX), skillRaw("skill-d", "用户版停用", "正文"));

    // 真实环境中无 scoped 提供方时，ctx.skills 全局视图返回空列表
    const emptyRegistry = {
      async list() { return []; },
      async get() { return undefined; }
    };
    const emptyCtx = makeContext({ registry: emptyRegistry, sessions: {}, agents: {} });
    apply(emptyCtx);
    const emptyGateway = emptyCtx.provided.get("skillManager");

    const { skills } = await emptyGateway.list(undefined);
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
    // 用户根启用技能照常展示
    assert.equal(byName["skill-u"].enabled, true);
    assert.equal(byName["skill-u"].source, "user-dsh");
    assert.equal(byName["skill-u"].modelInvocable, true);
    // 用户根停用技能也展示
    assert.equal(byName["skill-d"].enabled, false);
    assert.equal(byName["skill-d"].modelInvocable, false);
    // 无会话时磁盘扫描只用用户根，项目根不出现在列表里
    assert.equal(byName["skill-a"], undefined);

    // 回退视图下启用条目可预览磁盘原文
    const content = await emptyGateway.content("skill-u", undefined);
    assert.match(content.content, /^---\nname: skill-u/);
    assert.equal(content.path, join(homeRoot, ".dsh", "skills", "skill-u", "SKILL.md"));

    // 回退视图下启用条目可停用（重命名为 *.disabled）
    const result = await emptyGateway.setEnabled("skill-u", undefined, false);
    assert.deepEqual(result, { name: "skill-u", enabled: false });
    assert.equal(await pathExists(join(homeRoot, ".dsh", "skills", "skill-u", "SKILL.md")), false);
    assert.equal(await pathExists(join(homeRoot, ".dsh", "skills", "skill-u", "SKILL.md" + DISABLED_SUFFIX)), true);

    // 停用后可恢复
    const restore = await emptyGateway.setEnabled("skill-u", undefined, true);
    assert.deepEqual(restore, { name: "skill-u", enabled: true });
    assert.equal(await pathExists(join(homeRoot, ".dsh", "skills", "skill-u", "SKILL.md")), true);
  });

  test("同名技能在注册表中已启用时，磁盘停用条目不重复追加", async () => {
    // 用户根放一个与项目根同名的已停用技能：注册表里已启用，不应重复追加
    await mkdir(join(homeRoot, ".dsh", "skills", "skill-a"), { recursive: true });
    await writeFile(join(homeRoot, ".dsh", "skills", "skill-a", "SKILL.md" + DISABLED_SUFFIX), skillRaw("skill-a", "用户版停用", "正文"));
    const { skills } = await gateway.list("s1");
    assert.equal(skills.filter((skill) => skill.name === "skill-a").length, 1);
    assert.equal(skills.find((skill) => skill.name === "skill-a").enabled, true);
  });
});

// ── 第三方目录（codex / claude） ────────────────────────────────────────

describe("第三方技能目录（codex / claude）", () => {
  test("识别并展示 codex/claude 用户目录技能（非回退视图也展示启用条目）", async () => {
    const codexRoot = join(homeRoot, "codex", "skills");
    const claudeRoot = join(homeRoot, "claude", "skills");
    await mkdir(join(codexRoot, "cx-a"), { recursive: true });
    await writeFile(join(codexRoot, "cx-a", "SKILL.md"), skillRaw("cx-a", "Codex 技能 A", "正文"));
    await mkdir(join(claudeRoot, "cl-a"), { recursive: true });
    await writeFile(join(claudeRoot, "cl-a", "SKILL.md"), skillRaw("cl-a", "Claude 技能 A", "正文"));

    // 有会话（非回退）：注册表不包含第三方条目，但它们必须照常展示
    const { skills } = await gateway.list("s1");
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
    assert.equal(byName["cx-a"].source, "codex-user");
    assert.equal(byName["cx-a"].enabled, true);
    assert.equal(byName["cl-a"].source, "claude-user");
    assert.equal(byName["cl-a"].enabled, true);
  });

  test("项目级 .codex/skills 与 .claude/skills 也识别", async () => {
    await mkdir(join(projectRoot, ".codex", "skills", "cx-p"), { recursive: true });
    await writeFile(join(projectRoot, ".codex", "skills", "cx-p", "SKILL.md"), skillRaw("cx-p", "项目 Codex", "正文"));
    await mkdir(join(projectRoot, ".claude", "skills", "cl-p"), { recursive: true });
    await writeFile(join(projectRoot, ".claude", "skills", "cl-p", "SKILL.md"), skillRaw("cl-p", "项目 Claude", "正文"));

    const { skills } = await gateway.list("s1");
    const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
    assert.equal(byName["cx-p"].source, "codex-project");
    assert.equal(byName["cl-p"].source, "claude-project");
    assert.equal(byName["cx-p"].enabled, true);
  });

  test("目录级一键停用/启用（setSourceEnabled）", async () => {
    const codexRoot = join(homeRoot, "codex", "skills");
    await mkdir(join(codexRoot, "cx-a"), { recursive: true });
    await writeFile(join(codexRoot, "cx-a", "SKILL.md"), skillRaw("cx-a", "Codex A", "正文"));
    await mkdir(join(codexRoot, "cx-b"), { recursive: true });
    await writeFile(join(codexRoot, "cx-b", "SKILL.md"), skillRaw("cx-b", "Codex B", "正文"));
    // 已停用的不参与本次变更
    await mkdir(join(codexRoot, "cx-c"), { recursive: true });
    await writeFile(join(codexRoot, "cx-c", "SKILL.md" + DISABLED_SUFFIX), skillRaw("cx-c", "Codex C", "正文"));

    // 一键停用：两个启用条目被改名，已停用的跳过
    const off = await gateway.setSourceEnabled("codex-user", "s1", false);
    assert.deepEqual(off, { source: "codex-user", enabled: false, toggled: 2 });
    assert.equal(await pathExists(join(codexRoot, "cx-a", "SKILL.md")), false);
    assert.equal(await pathExists(join(codexRoot, "cx-a", "SKILL.md.disabled")), true);
    assert.equal(await pathExists(join(codexRoot, "cx-b", "SKILL.md.disabled")), true);
    assert.equal(await pathExists(join(codexRoot, "cx-c", "SKILL.md.disabled")), true, "已停用的保持原状");

    // list 立即反映：全部停用
    let { skills } = await gateway.list("s1");
    assert.deepEqual(
      skills.filter((skill) => skill.source === "codex-user").map((skill) => skill.enabled),
      [false, false, false]
    );

    // 幂等：再停一次 → toggled 0
    const again = await gateway.setSourceEnabled("codex-user", "s1", false);
    assert.deepEqual(again, { source: "codex-user", enabled: false, toggled: 0 });

    // 一键启用：三个全部恢复
    const on = await gateway.setSourceEnabled("codex-user", "s1", true);
    assert.deepEqual(on, { source: "codex-user", enabled: true, toggled: 3 });
    assert.equal(await pathExists(join(codexRoot, "cx-a", "SKILL.md")), true);
    assert.equal(await pathExists(join(codexRoot, "cx-b", "SKILL.md")), true);
    assert.equal(await pathExists(join(codexRoot, "cx-c", "SKILL.md")), true);

    ({ skills } = await gateway.list("s1"));
    assert.deepEqual(
      skills.filter((skill) => skill.source === "codex-user").map((skill) => skill.enabled),
      [true, true, true]
    );
  });

  test("目录级启停不触碰其他来源", async () => {
    await mkdir(join(homeRoot, "codex", "skills", "cx-a"), { recursive: true });
    await writeFile(join(homeRoot, "codex", "skills", "cx-a", "SKILL.md"), skillRaw("cx-a", "Codex A", "正文"));
    await gateway.setSourceEnabled("codex-user", "s1", false);
    // 用户 dsh 技能不受影响
    assert.equal(await pathExists(join(homeRoot, ".dsh", "skills", "skill-u", "SKILL.md")), true);
    const { skills } = await gateway.list("s1");
    assert.equal(skills.find((skill) => skill.name === "skill-u").enabled, true);
  });

  test("不存在的来源目录返回 toggled 0", async () => {
    const result = await gateway.setSourceEnabled("claude-user", "s1", false);
    assert.deepEqual(result, { source: "claude-user", enabled: false, toggled: 0 });
  });

  test("同名技能在不同来源目录各自展示、互不遮蔽", async () => {
    const codexRoot = join(homeRoot, "codex", "skills");
    const claudeRoot = join(homeRoot, "claude", "skills");
    await mkdir(join(codexRoot, "agents-sdk"), { recursive: true });
    await writeFile(join(codexRoot, "agents-sdk", "SKILL.md"), skillRaw("agents-sdk", "Codex 版", "正文"));
    await mkdir(join(claudeRoot, "agents-sdk"), { recursive: true });
    await writeFile(join(claudeRoot, "agents-sdk", "SKILL.md"), skillRaw("agents-sdk", "Claude 版", "正文"));

    const { skills } = await gateway.list("s1");
    const matches = skills.filter((skill) => skill.name === "agents-sdk");
    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((skill) => skill.source).sort(), ["claude-user", "codex-user"]);

    // 带 source 启停：只影响指定目录的文件
    await gateway.setEnabled("agents-sdk", "s1", false, "claude-user");
    assert.equal(await pathExists(join(claudeRoot, "agents-sdk", "SKILL.md")), false);
    assert.equal(await pathExists(join(claudeRoot, "agents-sdk", "SKILL.md.disabled")), true);
    assert.equal(await pathExists(join(codexRoot, "agents-sdk", "SKILL.md")), true, "codex 的不受影响");

    // list 反映：claude 停用、codex 仍启用
    const after = (await gateway.list("s1")).skills.filter((skill) => skill.name === "agents-sdk");
    assert.equal(after.find((skill) => skill.source === "claude-user").enabled, false);
    assert.equal(after.find((skill) => skill.source === "codex-user").enabled, true);
  });
});

// ── content ─────────────────────────────────────────────────────────────

describe("skillManager.content", () => {
  test("启用技能返回注册表正文", async () => {
    const result = await gateway.content("skill-a", "s1");
    assert.equal(result.name, "skill-a");
    assert.equal(result.content, "已加载正文 skill-a");
    assert.equal(result.provider, "filesystem");
  });

  test("停用技能返回磁盘原文与路径", async () => {
    const result = await gateway.content("skill-c", "s1");
    assert.equal(result.name, "skill-c");
    assert.match(result.content, /^---\nname: skill-c/);
    assert.equal(result.path, join(tmp, ".dsh", "skills", "skill-c", "SKILL.md.disabled"));
  });

  test("不存在的技能返回 null", async () => {
    assert.equal(await gateway.content("no-such", "s1"), null);
  });
});

// ── setEnabled ──────────────────────────────────────────────────────────

describe("skillManager.setEnabled", () => {
  test("停用启用技能：SKILL.md 重命名为 SKILL.md.disabled", async () => {
    const skillFile = join(tmp, ".dsh", "skills", "skill-a", "SKILL.md");
    const disabledFile = skillFile + DISABLED_SUFFIX;
    const result = await gateway.setEnabled("skill-a", "s1", false);
    assert.deepEqual(result, { name: "skill-a", enabled: false });
    assert.equal(await pathExists(skillFile), false, "原文件应被移走");
    assert.equal(await pathExists(disabledFile), true, "应生成 .disabled 文件");
  });

  test("启用停用技能：SKILL.md.disabled 重命名回 SKILL.md", async () => {
    const skillFile = join(tmp, ".dsh", "skills", "skill-c", "SKILL.md");
    const disabledFile = skillFile + DISABLED_SUFFIX;
    const result = await gateway.setEnabled("skill-c", "s1", true);
    assert.deepEqual(result, { name: "skill-c", enabled: true });
    assert.equal(await pathExists(disabledFile), false);
    assert.equal(await pathExists(skillFile), true);
  });

  test("停用后 list 立即反映磁盘状态", async () => {
    await gateway.setEnabled("skill-a", "s1", false);
    const { skills } = await gateway.list("s1");
    const skillA = skills.find((skill) => skill.name === "skill-a");
    assert.equal(skillA.enabled, false);
    assert.equal(skillA.source, "project-dsh");
  });

  test("随包技能拒绝修改", async () => {
    await assert.rejects(
      () => gateway.setEnabled("skill-bd", "s1", false),
      /随部署附带/
    );
  });

  test("无文件的运行时技能拒绝修改", async () => {
    await assert.rejects(
      () => gateway.setEnabled("skill-rt", "s1", false),
      /没有可修改的文件/
    );
  });

  test("不存在的技能抛错", async () => {
    await assert.rejects(
      () => gateway.setEnabled("no-such", "s1", false),
      /不存在/
    );
  });

  test("幂等：停用已停用的技能不报错", async () => {
    const result = await gateway.setEnabled("skill-c", "s1", false);
    assert.deepEqual(result, { name: "skill-c", enabled: false });
    // 文件仍是 .disabled
    assert.equal(await pathExists(join(tmp, ".dsh", "skills", "skill-c", "SKILL.md" + DISABLED_SUFFIX)), true);
  });

  test("幂等：启用已启用的技能不报错", async () => {
    const result = await gateway.setEnabled("skill-a", "s1", true);
    assert.deepEqual(result, { name: "skill-a", enabled: true });
    assert.equal(await pathExists(join(tmp, ".dsh", "skills", "skill-a", "SKILL.md")), true);
  });
});
