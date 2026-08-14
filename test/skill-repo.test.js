import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeZip } from "./helpers/zip-builder.js";
import {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  branchCandidates,
  discoverFromArchive,
  downloadArchive,
  fetchRepoArchive,
  installFromRepoBuffer,
  isValidGitBranch,
  isValidGithubOwner,
  isValidGithubRepoName,
  validateRepoRef
} from "../lib/skill-repo.js";

const SKILL_MD = (name, description = "d") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文。`;

// ── 坐标校验 ──────────────────────────────────────────────────────────────

test("validateRepoRef：合法/非法组合", () => {
  assert.doesNotThrow(() => validateRepoRef("anthropics", "skills", "main"));
  assert.doesNotThrow(() => validateRepoRef("a-b", "repo.name_x", "feature/x"));
  assert.throws(() => validateRepoRef("bad/owner", "r", "main"), /INVALID_REPO_REF/);
  assert.throws(() => validateRepoRef("owner", "..", "main"), /INVALID_REPO_REF/);
  assert.throws(() => validateRepoRef("owner", "r", "../../evil"), /INVALID_REPO_REF/);
  assert.throws(() => validateRepoRef("owner", "r", "a%20b"), /INVALID_REPO_REF/);
  assert.throws(() => validateRepoRef("owner", "r", "a#b"), /INVALID_REPO_REF/);
  assert.throws(() => validateRepoRef("", "r", "main"), /INVALID_REPO_REF/);
});

test("isValidGitBranch：默认分支哨兵与段规则", () => {
  assert.equal(isValidGitBranch(""), true);
  assert.equal(isValidGitBranch("HEAD"), true);
  assert.equal(isValidGitBranch("feat/x"), true);
  assert.equal(isValidGitBranch(".hidden"), false);
  assert.equal(isValidGitBranch("a.lock"), false);
  assert.equal(isValidGitBranch("a..b"), true); // 单段非 . 开头/结尾即可（CC Switch 同款规则）
  assert.equal(isValidGitBranch("a@{b}"), false);
  assert.equal(isValidGitBranch("a//b"), false);
});

test("branchCandidates：指定 → main → master", () => {
  assert.deepEqual(branchCandidates("dev"), ["dev", "main", "master"]);
  assert.deepEqual(branchCandidates(""), ["main", "master"]);
  assert.deepEqual(branchCandidates("HEAD"), ["main", "master"]);
  assert.deepEqual(branchCandidates("main"), ["main", "master"]);
});

test("isValidGithubOwner/RepoName 边界", () => {
  assert.equal(isValidGithubOwner("ok-name"), true);
  assert.equal(isValidGithubOwner("a".repeat(40)), false);
  assert.equal(isValidGithubRepoName("repo.name"), true);
  assert.equal(isValidGithubRepoName("."), false);
  assert.equal(isValidGithubRepoName(".."), false);
});

// ── 下载（本地 HTTP 服务）─────────────────────────────────────────────────

function serveZip(zipBuffer) {
  const server = createServer((req, res) => {
    if (req.url === "/repo.zip") {
      res.writeHead(200, { "Content-Type": "application/zip" });
      res.end(zipBuffer);
    } else if (req.url === "/big.zip") {
      // 超过测试上限的响应
      res.writeHead(200);
      res.end(Buffer.alloc(MAX_ARCHIVE_DOWNLOAD_BYTES + 1, 7));
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const serverUrl = async (server) => "http://127.0.0.1:" + server.address().port;

test("downloadArchive：成功取回与 404", async () => {
  const zip = makeZip([{ name: "x.txt", data: "hi", method: 0 }]);
  const server = await serveZip(zip);
  try {
    const url = await serverUrl(server);
    const buf = await downloadArchive(url + "/repo.zip");
    assert.equal(buf.length, zip.length);
    await assert.rejects(downloadArchive(url + "/missing.zip"), /DOWNLOAD_FAILED/);
  } finally {
    server.close();
  }
});

test("downloadArchive：超限报 ARCHIVE_TOO_LARGE", async () => {
  const server = await serveZip(Buffer.alloc(0));
  try {
    const url = await serverUrl(server);
    await assert.rejects(downloadArchive(url + "/big.zip", { maxBytes: 64 }), /ARCHIVE_TOO_LARGE/);
  } finally {
    server.close();
  }
});

test("fetchRepoArchive：分支回退（main 404 → master 命中）", async () => {
  const zip = makeZip([{ name: "x.txt", data: "hi", method: 0 }]);
  const server = createServer((req, res) => {
    if (req.url?.includes("master.zip")) {
      res.writeHead(200);
      res.end(zip);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const { buffer, branch } = await fetchRepoArchive("owner", "repo", "", base);
    assert.equal(branch, "master");
    assert.equal(buffer.length, zip.length);
  } finally {
    server.close();
  }
  // 显式错误分支：全部 404 → 抛错
  const failServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => failServer.listen(0, "127.0.0.1", resolve));
  try {
    const failBase = "http://127.0.0.1:" + failServer.address().port;
    await assert.rejects(fetchRepoArchive("owner", "repo", "nope", failBase), /DOWNLOAD_FAILED/);
  } finally {
    failServer.close();
  }
});

// ── 仓库内发现 ────────────────────────────────────────────────────────────

test("discoverFromArchive：GitHub 包装根剥除 + 嵌套技能", async () => {
  // GitHub 归档形态：<repo>-<branch>/ 一层根目录（首条目是目录且全部共享前缀）
  const zip = makeZip([
    { name: "skills-repo-main/", data: undefined, method: 0, externalAttr: 0x40000000 },
    { name: "skills-repo-main/skills/alpha/SKILL.md", data: SKILL_MD("alpha-skill", "Alpha"), method: 8 },
    { name: "skills-repo-main/skills/beta/SKILL.md", data: SKILL_MD("beta-skill", "Beta"), method: 8 },
    { name: "skills-repo-main/README.md", data: "# readme", method: 0 }
  ]);
  const list = await discoverFromArchive(zip, "owner", "skills-repo", "main");
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((s) => s.name),
    ["alpha-skill", "beta-skill"]
  );
  const alpha = list.find((s) => s.name === "alpha-skill");
  assert.equal(alpha.directory, "skills/alpha");
  assert.equal(alpha.key, "owner/skills-repo:skills/alpha");
  assert.equal(alpha.readmeUrl, "https://github.com/owner/skills-repo/blob/main/skills/alpha/SKILL.md");
});

test("discoverFromArchive：仓库根自带 SKILL.md → 整仓一个技能（不再深入）", async () => {
  const zip = makeZip([
    { name: "r-main/", data: undefined, method: 0, externalAttr: 0x40000000 },
    { name: "r-main/SKILL.md", data: SKILL_MD("repo-root-skill"), method: 8 },
    { name: "r-main/extra.txt", data: "x", method: 0 }
  ]);
  const list = await discoverFromArchive(zip, "owner", "r", "main");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "repo-root-skill");
  assert.equal(list[0].directory, "r"); // 仓库根 = 仓库名
});

test("discoverFromArchive：无根目录包装（普通 zip）也能扫", async () => {
  const zip = makeZip([{ name: "foo/SKILL.md", data: SKILL_MD("foo"), method: 8 }]);
  const list = await discoverFromArchive(zip, "o", "r", "main");
  assert.equal(list.length, 1);
  assert.equal(list[0].directory, "foo");
});

// ── 仓库安装 ──────────────────────────────────────────────────────────────

test("installFromRepoBuffer：直接路径安装", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-repo-" + Date.now());
  const zip = makeZip([
    { name: "r-main/", data: undefined, method: 0, externalAttr: 0x40000000 },
    { name: "r-main/skills/alpha/SKILL.md", data: SKILL_MD("alpha", "A"), method: 8 },
    { name: "r-main/skills/alpha/ref.txt", data: "ref", method: 0 }
  ]);
  const result = await installFromRepoBuffer(zip, {
    owner: "o", name: "r", branch: "main", directory: "skills/alpha", destRoot
  });
  assert.equal(result.conflict, undefined);
  assert.equal(result.name, "alpha");
  assert.match(await readFile(join(destRoot, "alpha", "SKILL.md"), "utf8"), /name: alpha/);
  assert.equal(await readFile(join(destRoot, "alpha", "ref.txt"), "utf8"), "ref");
  assert.equal(result.repoOwner, "o");
  assert.equal(result.repoBranch, "main");
});

test("installFromRepoBuffer：按名递归回退（directory 只有末级名）", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-repo-" + Date.now());
  const zip = makeZip([
    { name: "r-main/deep/nested/foo/SKILL.md", data: SKILL_MD("foo"), method: 8 }
  ]);
  const result = await installFromRepoBuffer(zip, {
    owner: "o", name: "r", branch: "main", directory: "foo", destRoot
  });
  assert.equal(result.name, "foo");
  assert.equal(result.file.endsWith("foo\\SKILL.md") || result.file.endsWith("foo/SKILL.md"), true);
});

test("installFromRepoBuffer：冲突跳过；找不到报错", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-repo-" + Date.now());
  await mkdir(join(destRoot, "alpha"), { recursive: true });
  const zip = makeZip([{ name: "r-main/alpha/SKILL.md", data: SKILL_MD("alpha"), method: 8 }]);
  const conflicted = await installFromRepoBuffer(zip, {
    owner: "o", name: "r", branch: "main", directory: "alpha", destRoot
  });
  assert.equal(conflicted.conflict, true);

  const zip2 = makeZip([{ name: "r-main/other/SKILL.md", data: SKILL_MD("other"), method: 8 }]);
  await assert.rejects(
    installFromRepoBuffer(zip2, { owner: "o", name: "r", branch: "main", directory: "missing", destRoot }),
    /SKILL_NOT_FOUND/
  );
});
