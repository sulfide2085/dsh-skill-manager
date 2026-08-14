/**
 * dsh-skill-manager —— skill-files.js 单元测试。
 *
 * 覆盖磁盘约定层的全部导出函数：frontmatter 解析、路径存在性、
 * 项目根锚点、管理根构建、目录扫描与同名胜出规则。
 *
 * 运行：node --test test/skill-files.test.js
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DISABLED_SUFFIX,
  findProjectRoot,
  pathExists,
  parseFrontmatter,
  buildRoots,
  collectSkillEntries,
  winnerEntry
} from "../lib/skill-files.js";

/** 生成一个合法技能的原始文本。 */
function skillRaw(name, description = "描述", body = "正文", extra = "") {
  return `---\nname: ${name}\ndescription: ${description}${extra}\n---\n${body}`;
}

// 每个测试独立临时目录，测试结束后统一清理。
const temps = [];
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "skm-unit-"));
  temps.push(dir);
  return dir;
}

describe("parseFrontmatter", () => {
  test("解析完整 frontmatter（name/description/whenToUse/body）", () => {
    const parsed = parseFrontmatter(skillRaw("my-skill", "一个示例技能", "正文第一行\n正文第二行", "\nwhenToUse: 需要示例时"));
    assert.equal(parsed.name, "my-skill");
    assert.equal(parsed.description, "一个示例技能");
    assert.equal(parsed.whenToUse, "需要示例时");
    assert.equal(parsed.body, "正文第一行\n正文第二行");
  });

  test("去掉 name/description 两侧的引号", () => {
    const raw = '---\nname: "quoted-skill"\ndescription: \'带引号的描述\'\n---\n正文';
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.name, "quoted-skill");
    assert.equal(parsed.description, "带引号的描述");
  });

  test("whenToUse 缺失时返回 undefined", () => {
    const parsed = parseFrontmatter(skillRaw("plain-skill"));
    assert.equal(parsed.whenToUse, undefined);
  });

  test("没有 frontmatter 的纯正文返回 undefined", () => {
    assert.equal(parseFrontmatter("# 标题\n普通 Markdown"), undefined);
  });

  test("缺少 name 返回 undefined", () => {
    assert.equal(parseFrontmatter("---\ndescription: 没有名字\n---\n正文"), undefined);
  });

  test("非法 name（大写/中文/空格）返回 undefined", () => {
    assert.equal(parseFrontmatter(skillRaw("My-Skill")), undefined);
    assert.equal(parseFrontmatter(skillRaw("我的技能")), undefined);
    assert.equal(parseFrontmatter(skillRaw("has space")), undefined);
  });

  test("body 为空时返回空字符串", () => {
    const parsed = parseFrontmatter("---\nname: empty-skill\ndescription: 空正文\n---\n");
    assert.equal(parsed.body, "");
  });
});

describe("pathExists", () => {
  test("存在的路径返回 true", async () => {
    const dir = await tempDir();
    const file = join(dir, "a.txt");
    await writeFile(file, "x");
    assert.equal(await pathExists(file), true);
  });

  test("不存在的路径返回 false", async () => {
    const dir = await tempDir();
    assert.equal(await pathExists(join(dir, "missing.txt")), false);
  });
});

describe("findProjectRoot", () => {
  test("从嵌套目录向上找到最近的 .git 祖先", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".git"));
    const nested = join(dir, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    assert.equal(await findProjectRoot(nested), dir);
  });

  test("没有 .git 时回退到 cwd 自身", async () => {
    const dir = await tempDir();
    const nested = join(dir, "x");
    await mkdir(nested, { recursive: true });
    assert.equal(await findProjectRoot(nested), nested);
  });
});

describe("buildRoots", () => {
  test("cwd 存在时按 项目.dsh > 项目.agents > 用户.dsh > 用户.agents 顺序返回", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".git"));
    const project = join(dir, "repo");
    await mkdir(project, { recursive: true });
    await mkdir(join(project, ".git"));
    const userDsh = join(dir, "u", ".dsh");
    const userAgents = join(dir, "u", ".agents");
    const roots = await buildRoots(project, { dshHome: userDsh, agentsHome: userAgents });
    assert.deepEqual(
      roots.map((root) => root.source),
      ["project-dsh", "project-agents", "user-dsh", "user-agents"]
    );
    assert.deepEqual(
      roots.map((root) => root.path),
      [
        join(project, ".dsh", "skills"),
        join(project, ".agents", "skills"),
        join(userDsh, "skills"),
        join(userAgents, "skills")
      ]
    );
  });

  test("cwd 为 undefined 时只返回用户根", async () => {
    const dir = await tempDir();
    const roots = await buildRoots(undefined, {
      dshHome: join(dir, "u", ".dsh"),
      agentsHome: join(dir, "u", ".agents")
    });
    assert.deepEqual(
      roots.map((root) => root.source),
      ["user-dsh", "user-agents"]
    );
  });

  test("项目根与用户根指向同一目录时去重", async () => {
    const dir = await tempDir();
    const project = join(dir, "repo");
    await mkdir(join(project, ".git"), { recursive: true });
    // 用户 .dsh 恰好是项目内的 .dsh，则 project-dsh 与 user-dsh 相同
    const roots = await buildRoots(project, { dshHome: join(project, ".dsh") });
    const projectDsh = roots.filter((root) => root.source === "project-dsh");
    const userDsh = roots.filter((root) => root.source === "user-dsh");
    assert.equal(projectDsh.length, 1);
    assert.equal(userDsh.length, 0);
    assert.equal(projectDsh[0].path, join(project, ".dsh", "skills"));
  });
});

describe("collectSkillEntries", () => {
  test("扫描目录束、平铺、停用条目，跳过无效目录与 .system", async () => {
    const root = await tempDir();
    const skills = join(root, "skills");
    await mkdir(join(skills, "dir-a"), { recursive: true });
    await mkdir(join(skills, "dir-b"), { recursive: true });
    await mkdir(join(skills, "not-skill"), { recursive: true });
    await mkdir(join(skills, "bad-skill"), { recursive: true });
    await mkdir(join(skills, ".system"), { recursive: true });
    await writeFile(join(skills, "dir-a", "SKILL.md"), skillRaw("dir-a", "目录束技能"));
    await writeFile(join(skills, "dir-b", "SKILL.md" + DISABLED_SUFFIX), skillRaw("dir-b", "已停用目录束"));
    await writeFile(join(skills, "flat-c.md"), skillRaw("flat-c", "平铺技能"));
    await writeFile(join(skills, "flat-d.md" + DISABLED_SUFFIX), skillRaw("flat-d", "已停用平铺"));
    await writeFile(join(skills, "bad-skill", "SKILL.md"), "# 没有 frontmatter 的文件\n");
    await writeFile(join(skills, ".system", "SKILL.md"), skillRaw("hidden", "系统目录"));

    const entries = await collectSkillEntries([{ path: skills, source: "project-dsh" }]);
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));

    assert.equal(entries.length, 4, "应扫描出 4 个技能条目（2 启用 + 2 停用）");
    assert.equal(byName["dir-a"].enabled, true);
    assert.equal(byName["dir-a"].dirBundle, true);
    assert.equal(byName["dir-b"].enabled, false);
    assert.equal(byName["dir-b"].dirBundle, true);
    assert.equal(byName["flat-c"].enabled, true);
    assert.equal(byName["flat-c"].dirBundle, false);
    assert.equal(byName["flat-d"].enabled, false);
    assert.equal(byName["flat-d"].dirBundle, false);
    for (const entry of Object.values(byName)) {
      assert.equal(entry.source, "project-dsh");
    }
  });

  test("根目录不存在时返回空数组", async () => {
    const entries = await collectSkillEntries([{ path: join(await tempDir(), "nope"), source: "user-dsh" }]);
    assert.deepEqual(entries, []);
  });
});

describe("winnerEntry", () => {
  const makeEntry = (name, enabled) => ({ name, enabled, file: "/x/" + name });

  test("同名时优先返回启用的条目", async () => {
    const entries = [
      makeEntry("a", false),
      makeEntry("a", true),
      makeEntry("b", true)
    ];
    const winner = await winnerEntry(entries, "a");
    assert.equal(winner.enabled, true);
  });

  test("只有停用条目时返回停用条目（兜底）", async () => {
    const entries = [makeEntry("a", false), makeEntry("b", true)];
    const winner = await winnerEntry(entries, "a");
    assert.equal(winner.enabled, false);
  });

  test("没有匹配条目时返回 undefined", async () => {
    assert.equal(await winnerEntry([makeEntry("a", true)], "zzz"), undefined);
  });
});
