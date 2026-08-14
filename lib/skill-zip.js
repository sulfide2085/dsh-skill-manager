/**
 * dsh-skill-manager —— ZIP 安装与技能发现核心（仅 node 内置，零 npm 依赖）。
 *
 * 对应 CC Switch skill.rs 的「从 ZIP 文件安装」路径（install_from_zip /
 * scan_skills_recursive / sanitize_install_name），按本插件磁盘约定落地：
 *   - 目录束：<root>/<name>/SKILL.md
 *   - 平铺技能：<root>/<name>.md
 *
 * 当前为快速原型（核心功能）：store + deflate 解压、CRC32 校验、UTF-8/兼容名
 * 解码、基本 zip-slip 条目名校验。zip-bomb 预算、symlink 物化、ZIP64 等
 * 防护留待后续拓展（代码中已留 TODO 标注）。
 */
import { inflateRawSync } from "node:zlib";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter, pathExists } from "./skill-files.js";

// ── ZIP 解析（读取内存缓冲，信任中央目录）────────────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const S_IFLNK = 0xa000;

/** 从缓冲区末尾扫描 EOCD 记录（comment 最长 65535）。 */
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 解析 ZIP 缓冲，返回条目数组（字段取自中央目录）。
 * 不支持 ZIP64（遇到 0xFFFF/0xFFFFFFFF 哨兵值直接报错，见 TODO）。
 */
export function parseZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("不是有效的 ZIP 文件：数据太短");
  }
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error("不是有效的 ZIP 文件：找不到中央目录记录");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  // TODO(防护): ZIP64 支持（哨兵值出现时按 0xFFFFFFFF 语义处理）
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new Error("暂不支持 ZIP64 归档");
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new Error("不是有效的 ZIP 文件：中央目录越界");
  }

  const entries = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;
  while (pos + 46 <= end) {
    if (buffer.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error("不是有效的 ZIP 文件：中央目录记录损坏");
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const crc32 = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const externalAttr = buffer.readUInt32LE(pos + 38);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameBytes = buffer.subarray(pos + 46, pos + 46 + nameLen);
    if (pos + 46 + nameLen + extraLen + commentLen > end) {
      throw new Error("不是有效的 ZIP 文件：目录条目越界");
    }
    entries.push({
      name: decodeZipName(nameBytes, (flags & FLAG_UTF8) !== 0),
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      externalAttr,
      localOffset
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // 定位每条目在缓冲中的实际数据区（经本地文件头）。
  for (const entry of entries) {
    const lh = entry.localOffset;
    if (lh + 30 > buffer.length || buffer.readUInt32LE(lh) !== SIG_LOCAL) {
      throw new Error("不是有效的 ZIP 文件：本地文件头缺失");
    }
    const nameLen = buffer.readUInt16LE(lh + 26);
    const extraLen = buffer.readUInt16LE(lh + 28);
    entry.dataOffset = lh + 30 + nameLen + extraLen;
    if (entry.dataOffset + entry.compressedSize > buffer.length) {
      throw new Error("不是有效的 ZIP 文件：条目数据越界：" + entry.name);
    }
  }
  return entries;
}

/** 解码条目名：UTF-8 标志位优先，否则按 latin1 逐字节映射（核心够用）。 */
export function decodeZipName(bytes, utf8) {
  if (utf8) return bytes.toString("utf8");
  // CP437/其他编码的字节 → latin1 逐字节（ASCII 部分无损）
  return bytes.toString("latin1");
}

/** 标准 CRC-32（多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 条目是否为目录（名以分隔符结尾或 unix 目录位）。 */
export function isDirEntry(entry) {
  if (entry.name.endsWith("/") || entry.name.endsWith("\\")) return true;
  return (entry.externalAttr >>> 16 & 0xf000) === 0x4000;
}

/** 条目是否为 symlink（unix 模式位）。TODO(防护): 物化 symlink。 */
export function isSymlinkEntry(entry) {
  return (entry.externalAttr >>> 16 & 0xf000) === S_IFLNK;
}

/** 取条目的压缩数据。 */
export function entryData(buffer, entry) {
  return buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
}

/** 解压单条目数据（store / deflate），并做 CRC32 校验。 */
export function inflateEntry(buffer, entry) {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw new Error("不支持的加密 ZIP 条目：" + entry.name);
  }
  const data = entryData(buffer, entry);
  let out;
  if (entry.method === METHOD_STORE) {
    out = data;
  } else if (entry.method === METHOD_DEFLATE) {
    out = inflateRawSync(data); // TODO(防护): 解压预算（zip-bomb）
  } else {
    throw new Error("不支持的压缩方式 " + entry.method + "：" + entry.name);
  }
  if (crc32(out) !== (entry.crc32 >>> 0)) {
    throw new Error("ZIP 条目 CRC 校验失败：" + entry.name);
  }
  return out;
}

/**
 * 条目名安全检查（zip-slip 基础防护）：拒绝绝对路径、盘符、
 * `..` 段与 NUL。TODO(防护): 与 CC Switch 对齐的 enclosed_name 语义 + 预算。
 */
export function sanitizeEntryPath(rawName) {
  const name = rawName.replace(/\\/g, "/");
  if (name.length === 0 || name.includes("\0")) return undefined;
  if (name.startsWith("/")) return undefined;
  if (/^[A-Za-z]:/.test(name)) return undefined;
  const parts = name.split("/");
  for (const part of parts) {
    if (part === "..") return undefined;
  }
  return name;
}

/**
 * 解压整个 ZIP 缓冲到 destDir（纯文件系统操作，不做技能语义）。
 * 返回 { extracted, skipped }：skipped 为不安全/符号链接条目的名字。
 */
export async function extractZipBuffer(buffer, destDir) {
  const entries = parseZip(buffer);
  const skipped = [];
  for (const entry of entries) {
    const safe = sanitizeEntryPath(entry.name);
    if (safe === undefined) {
      skipped.push({ name: entry.name, reason: "unsafe-path" });
      continue;
    }
    if (isSymlinkEntry(entry)) {
      skipped.push({ name: entry.name, reason: "symlink" }); // TODO(防护): 物化
      continue;
    }
    const target = join(destDir, safe);
    if (isDirEntry(entry)) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, inflateEntry(buffer, entry));
  }
  return { extracted: entries.length - skipped.length, skipped };
}

// ── 技能发现（与 CC Switch scan_skills_recursive 对齐）────────────────────

/**
 * 递归收集含 SKILL.md 的目录（目录束技能）。找到后不再深入；
 * 隐藏目录（以 . 开头）跳过。
 */
export async function findSkillDirs(current, results = []) {
  if (await pathExists(join(current, "SKILL.md"))) {
    results.push(current);
    return results;
  }
  let names;
  try {
    names = await readdir(current, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const dirent of names) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    await findSkillDirs(join(current, dirent.name), results);
  }
  return results;
}

/** 平铺技能：根目录下带有效 frontmatter 的 *.md（与 scanRoot 的约定一致）。 */
export async function findFlatSkills(root) {
  const out = [];
  let names;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of names) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    if (dirent.name === "SKILL.md") continue; // 目录束标记，不是平铺技能
    try {
      const parsed = parseFrontmatter(await readFile(join(root, dirent.name), "utf8"));
      if (parsed !== undefined) out.push({ file: join(root, dirent.name), meta: parsed });
    } catch {
      // 跳过不可读文件
    }
  }
  return out;
}

/**
 * 安装名清洗（对应 CC Switch sanitize_install_name）：
 * 单段、非空、不是 . / ..、不以 . 开头、不含 / 与 \。
 */
export function sanitizeInstallName(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\")) return undefined;
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) return undefined;
  return trimmed;
}

/**
 * 从 ZIP 缓冲安装技能到 destRoot（用户 .dsh/skills）。
 * 流程：解压到临时目录 → 递归发现 SKILL.md 目录束 + 平铺 .md → 定名（目录名
 * → frontmatter name → ZIP 文件名，逐级回退）→ 冲突跳过 → 复制/写入。
 * 成功后文件即启用形态（SKILL.md），filesystem watcher 自动发现。
 *
 * @returns {{installed: Array<{name,description,dirBundle,file,source}>, conflicts: Array<{name,reason}>, skipped: Array<{name,reason}>}}
 */
export async function installFromZipBuffer(buffer, { zipFileName, destRoot }) {
  const tempDir = await mkdtemp(join(tmpdir(), ".dsh-sm-"));
  let installed = [];
  let conflicts = [];
  let skipped = [];
  try {
    const { skipped: unsafe } = await extractZipBuffer(buffer, tempDir);
    skipped = unsafe.map((s) => ({ name: s.name, reason: s.reason }));

    const zipStem = sanitizeInstallName(
      typeof zipFileName === "string" ? zipFileName.replace(/\.zip$/i, "") : undefined
    );

    const dirBundles = await findSkillDirs(tempDir);
    const flatSkills = await findFlatSkills(tempDir);
    if (dirBundles.length === 0 && flatSkills.length === 0) {
      throw new Error("ZIP 中未发现任何技能（NO_SKILLS_IN_ZIP）");
    }

    const tempRoot = resolve(tempDir);
    for (const skillDir of dirBundles) {
      const meta = parseFrontmatter(await readFile(join(skillDir, "SKILL.md"), "utf8"));
      const dirName = skillDir.split(/[\\/]/).pop() ?? "";
      const atRoot = resolve(skillDir) === tempRoot || dirName.startsWith(".");
      // 定名：目录名 → frontmatter name → ZIP 文件名（根目录技能跳过目录名）
      const installName =
        sanitizeInstallName(!atRoot ? dirName : undefined) ??
        sanitizeInstallName(meta?.name) ??
        zipStem;
      if (installName === undefined) {
        throw new Error("无法从 ZIP 确定技能名（INVALID_SKILL_DIRECTORY）");
      }
      const dest = join(destRoot, installName);
      if (await pathExists(dest)) {
        conflicts.push({ name: installName, reason: "conflict" });
        continue;
      }
      await mkdir(destRoot, { recursive: true });
      await cp(skillDir, dest, { recursive: true });
      installed.push({
        name: installName,
        description: meta?.description ?? "",
        dirBundle: true,
        file: join(dest, "SKILL.md"),
        source: "user-dsh"
      });
    }

    for (const { file, meta } of flatSkills) {
      const installName = meta.name; // parseFrontmatter 已保证合法 kebab 名
      const destFile = join(destRoot, installName + ".md");
      if ((await pathExists(destFile)) || (await pathExists(destFile + ".disabled"))) {
        conflicts.push({ name: installName, reason: "conflict" });
        continue;
      }
      await mkdir(destRoot, { recursive: true });
      await writeFile(destFile, await readFile(file, "utf8"), "utf8");
      installed.push({
        name: installName,
        description: meta.description ?? "",
        dirBundle: false,
        file: destFile,
        source: "user-dsh"
      });
    }
    return { installed, conflicts, skipped };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
