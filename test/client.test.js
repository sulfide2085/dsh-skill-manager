/**
 * dsh-skill-manager —— client 半冒烟测试。
 *
 * 在 Node 里模拟浏览器环境（window.__ModuleLoader__ + 桩 react），
 * 验证手写 bundle 能正常加载、apply() 不抛错、字典与设置分区正确注册，
 * 以及 face 方法经 remote 桩完成往返调用（含错误路径）。
 *
 * 运行：node --test test/client.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ── 模拟浏览器环境 ──────────────────────────────────────────────────────

const fakeReact = {
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: (fn) => { fn(); }
};

const loaded = {};
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.entry = entry;
      loaded.exports = entry.factory((id) => {
        if (id === "react") return fakeReact;
        if (id === "react/jsx-runtime") return { jsx: (...args) => ({ $$jsx: args }), Fragment: "Fragment" };
        throw new Error("未预期的 require: " + id);
      });
    }
  }
};

// 触发 client.js 的模块加载
await import("../lib/client.js");
const mod = loaded.exports;

// ── 假 cordis ctx ───────────────────────────────────────────────────────

function makeCtx(remoteStub) {
  const calls = { register: null, bind: null, inject: null, registerSlot: null, mount: null };
  const ctx = {
    effect: (fn) => { fn(); },
    locale: {
      register: (ns, dicts) => { calls.register = { ns, dicts }; },
      bind: (ns) => (key) => {
        calls.bind = { ns, key };
        return key;
      }
    },
    remote: {
      $mount: (contribution) => {
        calls.mount = contribution;
        return Promise.resolve();
      }
    },
    get: (key) => {
      if (key === "sessions") return { currentProvideInfo: { getSnapshot: () => ({ sessionId: "s1" }) } };
      if (key === "remote.skillManager") return remoteStub;
      return undefined;
    },
    slots: {
      inject: (name, provider) => { calls.inject = { name, provider }; },
      register: (config, Component) => {
        calls.registerSlot = { config, Component };
        return "slot-id";
      }
    },
    calls
  };
  return ctx;
}

// ── 测试 ────────────────────────────────────────────────────────────────

/** 模拟 slot 挂载并取出分区 face（config.inject() 的结果）。 */
function mountFace(ctx) {
  ctx.calls.inject.provider();
  return ctx.calls.registerSlot.config.inject();
}

describe("client bundle 加载", () => {
  test("导出 apply / inject / NS", () => {
    assert.equal(typeof mod.apply, "function");
    assert.deepEqual(mod.inject, ["slots", "locale", "remote", "sessions"]);
    assert.equal(mod.NS, "settings.skillManager");
  });

  test("通过 __ModuleLoader__.load 注册模块", () => {
    assert.equal(loaded.entry.id, "dsh-skill-manager");
  });
});

describe("client apply", () => {
  test("注册中英文字典", () => {
    const remoteStub = makeRemoteStub();
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    assert.equal(ctx.calls.register.ns, "settings.skillManager");
    assert.equal(ctx.calls.register.dicts.zh.nav, "技能管理");
    assert.equal(ctx.calls.register.dicts.en.nav, "Skill Manager");
    assert.equal(ctx.calls.register.dicts.zh.disabled, "已停用");
    assert.equal(ctx.calls.register.dicts.en.disabled, "Disabled");
    assert.equal(ctx.calls.register.dicts.zh.github, "GitHub");
  });

  test("挂载远程贡献清单（10 个描述符）", () => {
    const ctx = makeCtx(makeRemoteStub());
    mod.apply(ctx);
    const descriptors = ctx.calls.mount.descriptors;
    assert.equal(descriptors.length, 10);
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.method),
      ["list", "content", "setEnabled", "setSourceEnabled", "installZip", "listRepos", "addRepo", "removeRepo", "discoverRepo", "installFromRepo"]
    );
  });

  test("注册 settings.section 分区（id/order/标签）", () => {
    const ctx = makeCtx(makeRemoteStub());
    mod.apply(ctx);
    assert.equal(ctx.calls.inject.name, "settings.section");
    // 模拟 slot 挂载：调用注册函数
    const slotId = ctx.calls.inject.provider();
    assert.equal(slotId, "slot-id");
    const config = ctx.calls.registerSlot.config;
    assert.equal(config.id, "skill-manager");
    assert.equal(config.order, 17);
    assert.equal(config.label(), "nav");
    assert.equal(typeof ctx.calls.registerSlot.Component, "function");
  });


  test("组件按真实渲染器契约解构：face 方法作为顶层 props，face 键缺失时不崩溃", async () => {
    const remoteStub = {
      list: async () => ({ ok: true, value: { skills: [
        { name: "demo-skill", description: "演示", source: "user-dsh", enabled: true, modelInvocable: true, userInvocable: true }
      ] } }),
      content: async () => ({ ok: true, value: { name: "demo-skill", description: "演示", content: "正文", provider: "filesystem" } }),
      setEnabled: async () => ({ ok: true, value: { name: "demo-skill", enabled: false } }),
      listRepos: async () => ({ ok: true, value: { repos: [] } })
    };
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    const face = mountFace(ctx);
    // 真实渲染器（dsh-client-web-react renderEntry）把 inject 结果展开为
    // 顶层 props 传给组件，并不提供名为 face 的键；组件必须按此契约解构
    const props = { ...face, t: (key) => key, close: () => {} };
    const jsx = await mod.SkillsSection(props);
    assert.ok(jsx && typeof jsx === "object", "组件应能正常渲染，不因 face 解构崩溃");
    // face 上必须提供渲染器展开所需的全部方法
    assert.equal(typeof face.listSkills, "function");
    assert.equal(typeof face.loadContent, "function");
    assert.equal(typeof face.setSkillEnabled, "function");
    assert.equal(typeof face.installZip, "function");
    assert.equal(typeof face.listRepos, "function");
    assert.equal(typeof face.discoverRepo, "function");
    assert.equal(typeof face.installFromRepo, "function");
  });

  test("face.installZip 经 remote 桩往返调用（含数据与结果）", async () => {
    const remoteStub = {
      installZip: async (fileName, dataBase64) => ({
        ok: true,
        value: { installed: [{ name: "foo", description: "d", dirBundle: true, file: "C:\\x\\foo\\SKILL.md", source: "user-dsh" }], conflicts: [], skipped: [] }
      })
    };
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    const face = mountFace(ctx);
    const result = await face.installZip("pack.zip", "UEsDBA==");
    assert.equal(result.installed[0].name, "foo");
  });

  test("face.installFromRepo 经 remote 桩往返（安装结果含冲突标记）", async () => {
    const remoteStub = {
      installFromRepo: async (owner, name, branch, directory) => ({
        ok: true,
        value: { conflict: true, name: "foo" }
      })
    };
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    const face = mountFace(ctx);
    const result = await face.installFromRepo("o", "r", "main", "skills/foo");
    assert.equal(result.conflict, true);
    assert.equal(result.name, "foo");
  });

  test("face.listSkills 经 remote 桩调用并返回结果", async () => {
    const remoteStub = makeRemoteStub();
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    const face = mountFace(ctx);
    const result = await face.listSkills();
    assert.equal(remoteStub.listArgs[0], "s1", "应传入当前会话 id");
    assert.equal(result.skills[0].name, "demo-skill");
  });

  test("face.setSourceEnabled 按来源传递参数并返回 toggled", async () => {
    const ctx = makeCtx(makeRemoteStub());
    mod.apply(ctx);
    const face = mountFace(ctx);
    const result = await face.setSourceEnabled("codex-user", false);
    assert.equal(result.toggled, 2);
  });

  test("face.setSkillEnabled 传递启用参数", async () => {
    const remoteStub = makeRemoteStub();
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    const face = mountFace(ctx);
    const result = await face.setSkillEnabled("demo-skill", false);
    assert.deepEqual(remoteStub.setEnabledArgs, ["demo-skill", "s1", false]);
    assert.equal(result.enabled, false);
  });

  test("remote 失败时 face 方法抛出带 code 的错误", async () => {
    const remoteStub = makeRemoteStub();
    remoteStub.list = async () => ({ ok: false, error: { code: "E_NOENT", message: "技能不存在" } });
    const ctx = makeCtx(remoteStub);
    mod.apply(ctx);
    const face = mountFace(ctx);
    await assert.rejects(() => face.listSkills(), /E_NOENT: 技能不存在/);
  });

  test("回归：启停成功后的 idle 状态不显示为操作失败", () => {
    // 组件在成功收尾时把操作状态置为 "idle"；渲染逻辑不得把它当作错误字符串展示。
    // （曾出现"操作失败: idle"的误报：操作实际成功，仅 UI 误判状态。）
    const failed = "操作失败";
    assert.equal(mod.opErrorText("idle", failed), "", "idle 是成功状态，不应展示失败文案");
    assert.equal(mod.opErrorText("busy", failed), "", "busy 进行中不展示文案");
    assert.equal(mod.opErrorText(undefined, failed), "", "无状态不展示文案");
    assert.equal(mod.opErrorText("E_NOENT: 技能不存在", failed), "操作失败: E_NOENT: 技能不存在", "真实错误仍按原格式展示");
  });
});

function makeRemoteStub() {
  return {
    listArgs: null,
    setEnabledArgs: null,
    async list(sessionId) {
      this.listArgs = [sessionId];
      return { ok: true, value: { skills: [{ name: "demo-skill", description: "演示", enabled: true }] } };
    },
    async content() {
      return { ok: true, value: { name: "demo-skill", content: "# demo" } };
    },
    async setEnabled(name, sessionId, enabled) {
      this.setEnabledArgs = [name, sessionId, enabled];
      return { ok: true, value: { name, enabled } };
    },
    async setSourceEnabled(source, sessionId, enabled) {
      this.setSourceEnabledArgs = [source, sessionId, enabled];
      return { ok: true, value: { source, enabled, toggled: 2 } };
    }
  };
}
