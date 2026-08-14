import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  crc32,
  installFromZipBuffer,
  parseZip,
  sanitizeInstallName,
  extractZipBuffer
} from "../lib/skill-zip.js";

// ── ZIP 构造器（独立 CRC 实现，避免与库实现共享潜在缺陷）───────────────────

function crc32b(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 构造内存 ZIP。
 * files: [{ name, data?, method? (0|8, 默认 8), flags?, externalAttr?, crcOverride?, utf8? }]
 * data 为 undefined 时视为空文件/目录（配合 name 结尾 "/" 或 externalAttr 目录位）。
 */
export function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const flags = f.flags ?? (f.utf8 === false ? 0 : 0x800);
    const method = f.method ?? 8;
    const data = f.data === undefined ? Buffer.alloc(0) : Buffer.from(f.data);
    const compressed = data.length === 0 || method === 0 ? data : deflateRawSync(data);
    const crc = f.crcOverride !== undefined ? f.crcOverride : crc32b(data);
    const externalAttr = f.externalAttr ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cd, eocd]);
}

const SKILL_MD = (name, description = "d") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文。`;

// ── 解析与解压 ────────────────────────────────────────────────────────────

test("parseZip：store/deflate 条目字段与数据区定位", () => {
  const buf = makeZip([
    { name: "a.txt", data: "hello", method: 0 },
    { name: "dir/b.txt", data: "world".repeat(10), method: 8 }
  ]);
  const entries = parseZip(buf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "a.txt");
  assert.equal(entries[0].method, 0);
  assert.equal(entries[1].name, "dir/b.txt");
  assert.equal(entries[1].method, 8);
  assert.equal(buf.subarray(entries[0].dataOffset, entries[0].dataOffset + 5).toString(), "hello");
});

test("parseZip：无效数据报错", () => {
  assert.throws(() => parseZip(Buffer.from("not a zip at all")), /不是有效的 ZIP/);
  assert.throws(() => parseZip(Buffer.alloc(0)), /不是有效的 ZIP/);
});

test("inflateEntry：CRC 校验失败抛错（经 extractZipBuffer）", async () => {
  const dir = join(tmpdir(), "dsh-sm-test-" + Date.now());
  await mkdir(dir, { recursive: true });
  const buf = makeZip([
    { name: "x.txt", data: "payload", method: 8, crcOverride: 0xdeadbeef }
  ]);
  await assert.rejects(extractZipBuffer(buf, dir), /CRC 校验失败：x.txt/);
});

test("extractZipBuffer：嵌套目录、内容与解压正确", async () => {
  const dir = join(tmpdir(), "dsh-sm-test-" + Date.now());
  await mkdir(dir, { recursive: true });
  const buf = makeZip([
    { name: "a/", data: undefined, method: 0, externalAttr: 0x40000000 },
    { name: "a/b/c.txt", data: "nested content", method: 8 },
    { name: "flat.txt", data: "flat", method: 0 }
  ]);
  const { extracted, skipped } = await extractZipBuffer(buf, dir);
  assert.equal(extracted, 3);
  assert.equal(skipped.length, 0);
  assert.equal(await readFile(join(dir, "a", "b", "c.txt"), "utf8"), "nested content");
  assert.equal(await readFile(join(dir, "flat.txt"), "utf8"), "flat");
});

test("extractZipBuffer：zip-slip 条目跳过（绝对路径/../盘符）", async () => {
  const dir = join(tmpdir(), "dsh-sm-test-" + Date.now());
  await mkdir(dir, { recursive: true });
  const buf = makeZip([
    { name: "ok.txt", data: "fine", method: 0 },
    { name: "../evil.txt", data: "escape", method: 0 },
    { name: "/abs.txt", data: "abs", method: 0 },
    { name: "C:/win.txt", data: "drive", method: 0 }
  ]);
  const { extracted, skipped } = await extractZipBuffer(buf, dir);
  assert.equal(extracted, 1);
  assert.deepEqual(skipped.map((s) => s.name).sort(), ["../evil.txt", "/abs.txt", "C:/win.txt"]);
  assert.equal(await readFile(join(dir, "ok.txt"), "utf8"), "fine");
});

test("extractZipBuffer：symlink 条目跳过（TODO 后续物化）", async () => {
  const dir = join(tmpdir(), "dsh-sm-test-" + Date.now());
  await mkdir(dir, { recursive: true });
  const buf = makeZip([
    { name: "link", data: "target.txt", method: 0, externalAttr: 0xa0000000 }
  ]);
  const { extracted, skipped } = await extractZipBuffer(buf, dir);
  assert.equal(extracted, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "symlink");
});

// ── 安装名清洗 ────────────────────────────────────────────────────────────

test("sanitizeInstallName：拒绝路径/点段/隐藏名", () => {
  assert.equal(sanitizeInstallName("foo-bar"), "foo-bar");
  assert.equal(sanitizeInstallName("  spaced  "), "spaced");
  assert.equal(sanitizeInstallName("a/b"), undefined);
  assert.equal(sanitizeInstallName("a\\b"), undefined);
  assert.equal(sanitizeInstallName("."), undefined);
  assert.equal(sanitizeInstallName(".."), undefined);
  assert.equal(sanitizeInstallName(".hidden"), undefined);
  assert.equal(sanitizeInstallName(""), undefined);
  assert.equal(sanitizeInstallName("  "), undefined);
});

// ── installFromZipBuffer 端到端 ───────────────────────────────────────────

async function install(buf, destRoot, zipFileName = "pack.zip") {
  return installFromZipBuffer(buf, { zipFileName, destRoot });
}

test("安装：嵌套目录束技能 → destRoot/<name>/SKILL.md 启用形态", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const buf = makeZip([
    { name: "my-pack/", data: undefined, method: 0, externalAttr: 0x40000000 },
    { name: "my-pack/foo/", data: undefined, method: 0, externalAttr: 0x40000000 },
    { name: "my-pack/foo/SKILL.md", data: SKILL_MD("foo", "Foo skill"), method: 8 },
    { name: "my-pack/foo/extra.txt", data: "aux", method: 0 }
  ]);
  const result = await install(buf, destRoot);
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].name, "foo");
  assert.equal(result.installed[0].dirBundle, true);
  assert.equal(result.installed[0].description, "Foo skill");
  const md = await readFile(join(destRoot, "foo", "SKILL.md"), "utf8");
  assert.match(md, /name: foo/);
  assert.equal(await readFile(join(destRoot, "foo", "extra.txt"), "utf8"), "aux");
  // 启用形态：不存在 .disabled
  await assert.rejects(stat(join(destRoot, "foo", "SKILL.md.disabled")));
});

test("安装：一个 ZIP 多个技能（skill pack）", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const buf = makeZip([
    { name: "alpha/SKILL.md", data: SKILL_MD("alpha"), method: 8 },
    { name: "beta/SKILL.md", data: SKILL_MD("beta"), method: 8 }
  ]);
  const result = await install(buf, destRoot);
  assert.deepEqual(result.installed.map((s) => s.name).sort(), ["alpha", "beta"]);
  assert.equal(result.conflicts.length, 0);
});

test("安装：SKILL.md 在 ZIP 根目录 → frontmatter name 定名，无 name 时回退 ZIP 文件名", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const withName = makeZip([{ name: "SKILL.md", data: SKILL_MD("root-skill"), method: 8 }]);
  let result = await install(withName, destRoot, "whatever.zip");
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].name, "root-skill");

  const destRoot2 = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const noName = makeZip([{ name: "SKILL.md", data: "---\ndescription: d\n---\nbody", method: 0 }]);
  result = await install(noName, destRoot2, "my-cool-pack.zip");
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].name, "my-cool-pack");
});

test("安装：平铺 .md 技能 → destRoot/<name>.md", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const buf = makeZip([
    { name: "hello.md", data: SKILL_MD("hello-skill", "hi"), method: 0 }
  ]);
  const result = await install(buf, destRoot);
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].dirBundle, false);
  assert.match(await readFile(join(destRoot, "hello-skill.md"), "utf8"), /name: hello-skill/);
});

test("安装：同名冲突跳过", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  await mkdir(join(destRoot, "foo"), { recursive: true });
  const buf = makeZip([{ name: "foo/SKILL.md", data: SKILL_MD("foo"), method: 8 }]);
  const result = await install(buf, destRoot);
  assert.equal(result.installed.length, 0);
  assert.deepEqual(result.conflicts, [{ name: "foo", reason: "conflict" }]);
});

test("安装：平铺冲突（含 .disabled 占用）", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  await mkdir(destRoot, { recursive: true });
  await import("node:fs/promises").then((f) => f.writeFile(join(destRoot, "hello.md.disabled"), "x"));
  const buf = makeZip([{ name: "hello.md", data: SKILL_MD("hello"), method: 0 }]);
  const result = await install(buf, destRoot);
  assert.equal(result.installed.length, 0);
  assert.equal(result.conflicts[0].name, "hello");
});

test("安装：无技能 ZIP 报 NO_SKILLS_IN_ZIP；坏 ZIP 报错", async () => {
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const empty = makeZip([{ name: "readme.txt", data: "nothing here", method: 0 }]);
  await assert.rejects(install(empty, destRoot), /NO_SKILLS_IN_ZIP/);
  await assert.rejects(install(Buffer.from("garbage"), destRoot), /不是有效的 ZIP/);
});

test("安装：解压失败不残留临时目录", async () => {
  const before = await readdir(tmpdir());
  const destRoot = join(tmpdir(), "dsh-sm-inst-" + Date.now());
  const bad = makeZip([{ name: "x.txt", data: "boom", method: 8, crcOverride: 0x1 }]);
  await assert.rejects(install(bad, destRoot), /CRC/);
  const after = await readdir(tmpdir());
  assert.deepEqual(
    after.filter((n) => n.startsWith(".dsh-sm-") && !before.includes(n)),
    []
  );
});
