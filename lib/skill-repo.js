/**
 * dsh-skill-manager —— GitHub 仓库技能发现与安装核心（快速原型）。
 *
 * 对应 CC Switch skill.rs 的仓库路径（validate_repo_ref / download_repo /
 * scan_dir_recursive / resolve_skill_source_dir），只实现核心：
 *   - 仓库坐标基础校验（owner/repo/branch 字符白名单，防 URL 改写）
 *   - 分支候选：指定分支（空/HEAD = 默认）→ main → master 依次尝试
 *   - 流式下载归档（简单大小上限 + 超时，无代理支持）
 *   - 解压（复用 skill-zip 引擎）→ 剥仓库根目录 → 递归发现 SKILL.md
 *   - 可发现列表（key = owner/repo:directory，跨仓库同名不遮蔽）
 *   - 按目录安装（直接路径 → 按名递归查找 → 仓库根兜底）
 *
 * TODO(防护): URL 出口断言、zip-bomb 预算、symlink 物化、代理。
 */
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractZipBuffer, findSkillDirs, sanitizeInstallName } from "./skill-zip.js";
import { parseFrontmatter, pathExists } from "./skill-files.js";

/** 下载大小上限（与 CC Switch MAX_ARCHIVE_DOWNLOAD_BYTES 一致）。测试可覆盖。 */
export let MAX_ARCHIVE_DOWNLOAD_BYTES = 128 * 1024 * 1024;
/** 单次下载超时（毫秒）。 */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

// ── 仓库坐标校验（镜像 CC Switch 的字符白名单）────────────────────────────

/** GitHub 账号名：ASCII 字母数字 + '-'，≤39。 */
export function isValidGithubOwner(owner) {
  return (
    typeof owner === "string" &&
    owner.length > 0 &&
    owner.length <= 39 &&
    [...owner].every((c) => /[A-Za-z0-9-]/.test(c))
  );
}

/** 仓库名：字母数字 + . - _，不能是 . 或 ..，≤100。 */
export function isValidGithubRepoName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 100 &&
    name !== "." &&
    name !== ".." &&
    [...name].every((c) => /[A-Za-z0-9._-]/.test(c))
  );
}

/** git 分支名：逐段白名单（合法分支可含 /）。空串与 HEAD 是默认分支哨兵。 */
export function isValidGitBranch(branch) {
  if (typeof branch !== "string") return false;
  if (branch.length === 0 || branch.toUpperCase() === "HEAD") return true;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return false;
  if (branch.includes("@{")) return false;
  if ([...branch].some((c) => c < " " || c === "" || " ~^:?*[\\#%".includes(c))) {
    return false;
  }
  return branch.split("/").every(
    (segment) =>
      segment.length > 0 &&
      !segment.startsWith(".") &&
      !segment.endsWith(".") &&
      !segment.endsWith(".lock")
  );
}

/** 校验仓库坐标（任何会拼进 github.com URL 的入口）。 */
export function validateRepoRef(owner, name, branch) {
  if (!isValidGithubOwner(owner) || !isValidGithubRepoName(name)) {
    throw new Error(`无效的仓库地址（INVALID_REPO_REF）：${owner}/${name}`);
  }
  if (!isValidGitBranch(branch)) {
    throw new Error(`无效的分支名（INVALID_REPO_REF）：${branch}`);
  }
}

/** 分支候选：指定分支 → main → master（镜像 download_repo）。 */
export function branchCandidates(branch) {
  const candidates = [];
  if (typeof branch === "string" && branch.length > 0 && branch.toUpperCase() !== "HEAD") {
    candidates.push(branch);
  }
  if (!candidates.includes("main")) candidates.push("main");
  if (!candidates.includes("master")) candidates.push("master");
  return candidates;
}

/**
 * 网络错误的可诊断描述：优先取 undici 的 cause（真实原因如 ECONNRESET）。
 */
function networkFailure(err) {
  const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
  const detail = timedOut
    ? "超时"
    : (err?.cause?.message ?? err?.cause?.code ?? err?.message ?? String(err));
  return new Error("下载失败（DOWNLOAD_FAILED）：" + detail);
}

/** 单次下载尝试（大小上限 + 超时）。网络类失败抛出的错误可重试。 */
async function downloadOnce(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    throw networkFailure(err);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // 确定性失败（404/429 等）：不重试
    throw new Error(`下载失败（DOWNLOAD_FAILED）状态 ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw networkFailure(new Error("响应无内容"));
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new Error(`归档过大（ARCHIVE_TOO_LARGE）上限 ${Math.round(maxBytes / 1024 / 1024)} MiB`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err.message.startsWith("归档过大")) throw err;
    throw networkFailure(err);
  }
  return Buffer.concat(chunks);
}

/**
 * 流式下载归档（大小上限 + 超时 + 网络瞬时失败自动重试）。返回 Buffer。
 * maxBytes 可注入（测试用小上限；默认 128 MiB）；retries 默认 2 次退避重试。
 */
export async function downloadArchive(url, { maxBytes = MAX_ARCHIVE_DOWNLOAD_BYTES, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    try {
      return await downloadOnce(url, maxBytes);
    } catch (err) {
      // 状态错误（404 等）与超限错误是确定性失败，不重试
      if (!err.message.startsWith("下载失败（DOWNLOAD_FAILED）") || err.message.includes("状态")) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * 下载仓库归档（自动回退分支）。baseUrl 可注入（测试用本地 HTTP 服务）。
 * 返回 { buffer, branch, cached }。
 */
export async function fetchRepoArchive(owner, name, branch = "", baseUrl, options = {}) {
  validateRepoRef(owner, name, branch);
  // 显式 baseUrl 优先；否则可用 DSH_SKILL_GITHUB_BASE 指定镜像（如 ghproxy 前缀）
  baseUrl = baseUrl ?? process.env.DSH_SKILL_GITHUB_BASE ?? "https://github.com";
  const cacheDir = options.cacheDir;
  const ttlMs = options.ttlMs ?? ARCHIVE_CACHE_TTL_MS;
  let lastError = null;
  for (const candidate of branchCandidates(branch)) {
    if (cacheDir) {
      const cached = await readCachedArchive(cacheDir, owner, name, candidate, ttlMs);
      if (cached !== undefined) return { buffer: cached, branch: candidate, cached: true };
    }
    const url = `${baseUrl}/${owner}/${name}/archive/refs/heads/${candidate}.zip`;
    try {
      const buffer = await downloadArchive(url);
      if (cacheDir) await writeCachedArchive(cacheDir, owner, name, candidate, buffer);
      return { buffer, branch: candidate, cached: false };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("所有分支下载失败");
}

// ── 归档磁盘缓存（同仓库多次发现/安装只下载一次）───────────────────────────

/** 归档缓存有效期（默认 30 分钟，测试可注入更小值）。 */
export const ARCHIVE_CACHE_TTL_MS = 30 * 60 * 1000;

/** 缓存目录：<dsh home>/cache/dsh-skill-manager。 */
export function archiveCacheDir(dshHome) {
  return join(dshHome, "cache", "dsh-skill-manager");
}

function archiveCacheKey(owner, name, branch) {
  return `${owner}__${name}__${branch}.zip`;
}

/** 读缓存：命中且未过期返回 Buffer，过期删除并返回 undefined。 */
async function readCachedArchive(cacheDir, owner, name, branch, ttlMs) {
  const file = join(cacheDir, archiveCacheKey(owner, name, branch));
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > ttlMs) {
      await rm(file, { force: true });
      return undefined;
    }
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/** 写缓存：失败不影响功能（目录不可写时静默跳过）。 */
async function writeCachedArchive(cacheDir, owner, name, branch, buffer) {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, archiveCacheKey(owner, name, branch)), buffer);
  } catch {
    // 缓存失败不阻断下载与安装
  }
}

// ── 解压 + 仓库根目录定位 ────────────────────────────────────────────────

/**
 * 包装目录判定（GitHub 归档统一带一层 <repo>-<branch>/ 根目录）：
 * 仅当首条目是目录条目且全部条目共享该前缀时才剥根，普通 ZIP 不受影响。
 */
export function findWrapperRoot(entries) {
  if (entries.length === 0) return undefined;
  const first = entries[0].name;
  const seg = first.split("/")[0];
  if (!seg || !first.endsWith("/")) return undefined;
  const prefix = seg + "/";
  return entries.every((e) => e.name === seg || e.name.startsWith(prefix)) ? seg : undefined;
}

/** 解压到临时目录，返回 { tempDir, scanDir }。 */
async function extractRepo(buffer, entries) {
  const tempDir = await mkdtemp(join(tmpdir(), ".dsh-sm-"));
  try {
    await extractZipBuffer(buffer, tempDir);
    const wrapper = findWrapperRoot(entries);
    const scanDir = wrapper ? join(tempDir, wrapper) : tempDir;
    return { tempDir, scanDir };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

/** 仓库内 SKILL.md 相对文档路径（正斜杠）。 */
function docPathFor(scanDir, skillDir) {
  const rel = resolve(skillDir).slice(resolve(scanDir).length).replace(/\\/g, "/");
  return rel.replace(/^\//, "") + (rel === "" ? "" : "/") + "SKILL.md";
}

/**
 * 扫描仓库归档中的可发现技能。
 * @returns {Array<{key,name,description,directory,readmeUrl,repoOwner,repoName,repoBranch}>}
 */
export async function discoverFromArchive(buffer, owner, name, branch) {
  const entries = (await import("./skill-zip.js")).parseZip(buffer);
  const { tempDir, scanDir } = await extractRepo(buffer, entries);
  try {
    const skills = [];
    for (const skillDir of await findSkillDirs(scanDir)) {
      const meta = parseFrontmatter(await readFile(join(skillDir, "SKILL.md"), "utf8"));
      const directory =
        resolve(skillDir) === resolve(scanDir)
          ? name
          : skillDir.slice(scanDir.length).replace(/[\\/]+/g, "/").replace(/^\//, "");
      const docPath = docPathFor(scanDir, skillDir);
      skills.push({
        key: `${owner}/${name}:${directory}`,
        name: meta?.name ?? directory,
        description: meta?.description ?? "",
        directory,
        readmeUrl: `https://github.com/${owner}/${name}/blob/${branch}/${docPath}`,
        repoOwner: owner,
        repoName: name,
        repoBranch: branch
      });
    }
    // 去重（完整 key 小写）并按名排序
    const seen = new Set();
    const deduped = skills.filter((s) => {
      const key = s.key.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return deduped;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * 从已解压仓库中解析真实技能源目录（镜像 resolve_skill_source_dir）：
 * 1. 直接相对路径（校验含 SKILL.md）；2. 按安装名递归查找（深度 ≤3）；
 * 3. 仓库根兜底。
 */
async function findSkillSourceDir(scanDir, rawDirectory, repoName) {
  const raw = String(rawDirectory ?? "");
  // 基本防护：拒绝带 .. 段/绝对路径的目录参数（后续可对齐 CC Switch 全量校验）
  const hasTraversal = raw.split(/[\\/]/).some((seg) => seg === "..") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw);
  const direct = hasTraversal ? undefined : join(scanDir, raw);
  if (direct !== undefined && (await pathExists(join(direct, "SKILL.md")))) return direct;
  // 按名递归查找（末级目录名）
  const installName = raw.split(/[\\/]/).pop();
  if (installName) {
    const found = await findDirByName(scanDir, installName, 0);
    if (found) return found;
  }
  if (await pathExists(join(scanDir, "SKILL.md"))) return scanDir;
  return undefined;
}

async function findDirByName(dir, target, depth) {
  if (depth > 3) return undefined;
  let names;
  try {
    names = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dirent of names) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const path = join(dir, dirent.name);
    if (dirent.name.toLowerCase() === target.toLowerCase() && (await pathExists(join(path, "SKILL.md")))) {
      return path;
    }
    const found = await findDirByName(path, target, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * 从仓库归档安装单个技能到 destRoot。
 * @param {Buffer} buffer 归档缓冲
 * @param {{owner,name,branch,directory,destRoot}} opts
 * @returns {{name,description,dirBundle,file,source,repoOwner,repoName,repoBranch,readmeUrl}|{conflict:true,name}}
 */
export async function installFromRepoBuffer(buffer, { owner, name, branch, directory, destRoot }) {
  const entries = (await import("./skill-zip.js")).parseZip(buffer);
  const { tempDir, scanDir } = await extractRepo(buffer, entries);
  try {
    const sourceDir = await findSkillSourceDir(scanDir, directory ?? name, name);
    if (sourceDir === undefined) {
      throw new Error(`仓库中找不到技能目录（SKILL_NOT_FOUND）：${directory ?? name}`);
    }
    const meta = parseFrontmatter(await readFile(join(sourceDir, "SKILL.md"), "utf8"));
    const installName =
      sanitizeInstallName(sourceDir.split(/[\\/]/).pop()?.replace(/^\./, "") ?? "") ??
      sanitizeInstallName(meta?.name) ??
      sanitizeInstallName(name);
    if (installName === undefined) {
      throw new Error("无法从仓库确定技能名（INVALID_SKILL_DIRECTORY）");
    }
    const dest = join(destRoot, installName);
    if (await pathExists(dest)) return { conflict: true, name: installName };
    await mkdir(destRoot, { recursive: true });
    await cp(sourceDir, dest, { recursive: true });
    return {
      name: installName,
      description: meta?.description ?? "",
      dirBundle: true,
      file: join(dest, "SKILL.md"),
      source: "user-dsh",
      repoOwner: owner,
      repoName: name,
      repoBranch: branch,
      readmeUrl: `https://github.com/${owner}/${name}/blob/${branch}/${docPathFor(scanDir, sourceDir)}`
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
