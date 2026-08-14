/**
 * dsh-skill-manager —— client 半（浏览器）。
 *
 * 手写 bundle（非构建产物）：
 *   - 由 host 在 /plugins/dsh-skill-manager/client.js 提供
 *   - 只能 require shell 的 seed 词（react / react/jsx-runtime / primitives）
 *   - 在设置中注册 "技能管理" 分区（settings.section slot）
 *
 * 功能：全部技能列表（启用 + 停用）、来源/调用策略标签、热开关、搜索。
 */
window.__ModuleLoader__.load({
	id: "dsh-skill-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const { jsx, Fragment } = react_jsx_runtime;

		// ── 样式（手写 CSS 字符串，前缀 SKM_ 避免冲突）────────────────────────
		const css = [
			// 页面骨架
			".SKM_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}",
			".SKM_status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
			".SKM_failure{color:var(--dsw-alias-state-error-primary);align-items:center;gap:10px;display:flex}",
			".SKM_failure p{margin:0}.SKM_failure button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px}",
			".SKM_catalog{flex-direction:column;gap:12px;display:flex}",
			// 搜索框
			".SKM_search{width:100%;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative}",
			".SKM_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 34px;font-size:13px;box-sizing:border-box}",
			".SKM_search input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".SKM_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}",
			// 统计行
			".SKM_stats{align-items:baseline;gap:7px;padding:0 2px;display:flex}",
			".SKM_stats h3{font-size:13px;font-weight:600;line-height:20px;margin:0}",
			".SKM_stats span{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}",
			// 卡片
			".SKM_cards{grid-template-columns:minmax(0,1fr);align-items:stretch;gap:12px;margin:0;padding:0;list-style:none;display:grid}",
			".SKM_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;overflow:hidden;box-sizing:border-box}",
			".SKM_card[data-open=true]{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1)}"
			+ ".SKM_cardRow{align-items:center;gap:16px;padding:16px 18px;display:flex;box-sizing:border-box}"
			+ ".SKM_cardMain{min-width:0;flex:1;flex-direction:column;gap:6px;display:flex}"
			+ ".SKM_cardSide{flex:none;flex-direction:column;align-items:flex-end;justify-content:center;gap:4px;display:flex}"
			+ ".SKM_cardSide .SKM_status{font-size:11px;line-height:16px;max-width:160px;text-align:right}",
			".SKM_cardHead{width:100%;align-items:center;gap:10px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;padding:0;display:flex;text-align:left}",
			".SKM_cardTitle{min-width:0;flex:1;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:13px;font-weight:500;line-height:20px;transition:color .2s ease}",
			".SKM_cardTitle[data-enabled=false]{color:var(--dsw-alias-label-tertiary)}",
			".SKM_tag{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:5px;align-items:center;padding:1px 6px;font-size:11px;line-height:16px;display:inline-flex}",
			".SKM_tag[data-kind=source]{color:var(--dsw-alias-label-tertiary)}",
			".SKM_tag[data-kind=model]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);color:var(--dsw-alias-state-business-primary)}",
			".SKM_tag[data-kind=user]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);color:var(--dsw-alias-state-success-primary)}",
			".SKM_tag[data-kind=disabled]{color:var(--dsw-alias-state-error-primary)}",
			// 开关
			".SKM_switch{position:relative;width:34px;height:20px;flex:none;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;padding:0;transition:background-color .2s ease,border-color .2s ease}",
			".SKM_switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .2s ease,background-color .2s ease}",
			".SKM_switch[data-on=true]{background:var(--dsw-alias-state-success-primary);border-color:transparent}",
			".SKM_switch[data-on=true]::after{transform:translateX(14px);background:var(--dsw-alias-bg-layer-3)}",
			".SKM_switch:disabled{opacity:.5;cursor:default}",
			// 展开正文
			".SKM_body{border-top:1px solid var(--dsw-alias-border-l2);padding:16px 18px;max-height:260px;overflow:auto}",
			".SKM_body pre{margin:0;font:inherit;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".SKM_desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
			".SKM_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:18px 2px;margin:0}"
			+ ".SKM_groupHead{align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 16px;display:flex}"
			+ ".SKM_groupLabel{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:13px;font-weight:600;line-height:20px}"
			+ ".SKM_groupCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}"
			+ ".SKM_groupHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			// 安装面板
			".SKM_panel{flex-direction:column;gap:12px;display:flex}",
			".SKM_panelBlock{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:14px 16px;flex-direction:column;gap:8px;display:flex}",
			".SKM_panelTitle{font-size:13px;font-weight:600;line-height:20px;margin:0}",
			".SKM_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}",
			".SKM_row{align-items:center;gap:8px;flex-wrap:wrap;display:flex}",
			".SKM_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:6px;padding:0 10px;font-size:12px;box-sizing:border-box}",
			".SKM_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".SKM_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:12px}",
			".SKM_btn:disabled{opacity:.5;cursor:default}",
			".SKM_btn[data-kind=primary]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-3)}",
			".SKM_btn[data-file=true]{display:inline-block;position:relative;overflow:hidden}",
			".SKM_btn input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}",
			".SKM_msg{margin:0;font-size:12px;line-height:18px}",
			".SKM_msg[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}",
			".SKM_msg[data-kind=err]{color:var(--dsw-alias-state-error-primary)}",
			".SKM_repoList{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}",
			".SKM_repoItem{align-items:center;gap:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1);border-radius:6px;display:flex;flex-wrap:wrap}",
			".SKM_repoLabel{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}"
		].join("");
		const tagId = "dsh-skill-manager/SkillsSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-skill-manager";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const c = {
			section: "SKM_section",
			status: "SKM_status",
			failure: "SKM_failure",
			catalog: "SKM_catalog",
			search: "SKM_search",
			stats: "SKM_stats",
			cards: "SKM_cards",
			groupHead: "SKM_groupHead",
			groupLabel: "SKM_groupLabel",
			groupCount: "SKM_groupCount",
			groupHint: "SKM_groupHint",
			card: "SKM_card",
			cardRow: "SKM_cardRow",
			cardMain: "SKM_cardMain",
			cardSide: "SKM_cardSide",
			cardHead: "SKM_cardHead",
			cardTitle: "SKM_cardTitle",
			tag: "SKM_tag",
			switch: "SKM_switch",
			body: "SKM_body",
			desc: "SKM_desc",
			empty: "SKM_empty",
			panel: "SKM_panel",
			panelBlock: "SKM_panelBlock",
			panelTitle: "SKM_panelTitle",
			hint: "SKM_hint",
			row: "SKM_row",
			input: "SKM_input",
			btn: "SKM_btn",
			msg: "SKM_msg",
			repoList: "SKM_repoList",
			repoItem: "SKM_repoItem",
			repoLabel: "SKM_repoLabel"
		};

		// ── 本地化 ─────────────────────────────────────────────────────────────
		const NS = "settings.skillManager";

		const zh = {
			nav: "技能管理",
			loading: "正在读取技能…",
			error: "暂时无法读取技能。",
			retry: "重试",
			search: "搜索技能",
			catalog: "本地技能列表",
			enabledCount: "个已启用",
			disabledCount: "个已停用",
			disabled: "已停用",
			github: "GitHub",
			github: "GitHub",
			empty: "暂无技能。",
			emptySearch: "没有匹配的技能。",
			modelOnly: "仅模型",
			userOnly: "仅用户",
			both: "模型+用户",
			none: "已禁用调用",
			enable: "启用",
			disable: "停用",
			opFailed: "操作失败",
			contentError: "技能内容加载失败。",
			installTitle: "ZIP 安装",
			installHint: "选择本地 ZIP 文件：自动解压、发现包内 SKILL.md 技能（目录束或平铺 .md），安装到用户技能目录后立即生效。",
			pickZip: "选择 ZIP 文件…",
			zipBusy: "正在安装…",
			zipInstalled: "已安装",
			zipConflict: "跳过（同名已存在）",
			zipSkipped: "忽略不安全条目",
			zipEmpty: "ZIP 中没有发现可安装的技能",
			zipReadError: "读取文件失败",
			repoTitle: "GitHub 技能市场",
			repoHint: "输入仓库坐标（owner / 仓库名，分支可选，默认 main→master 回退），添加后即可在市场中发现仓库内技能并一键安装。",
			owner: "owner",
			repoName: "仓库名",
			branch: "分支（可选）",
			addRepo: "添加仓库",
			removeRepo: "移除",
			discover: "搜索技能",
			discoverBusy: "搜索中…",
			discoverEmpty: "该仓库未发现技能",
			install: "安装",
			installBusy: "安装中…",
			conflictHint: "（已存在，跳过）"
		};

		const en = {
			nav: "Skill Manager",
			loading: "Reading skills…",
			error: "Skills are temporarily unavailable.",
			retry: "Retry",
			search: "Search skills",
			catalog: "Local Skills",
			enabledCount: "enabled",
			disabledCount: "disabled",
			disabled: "Disabled",
			github: "GitHub",
			github: "GitHub",
			empty: "No skills are available.",
			emptySearch: "No matching skills.",
			modelOnly: "Model only",
			userOnly: "User only",
			both: "Model + user",
			none: "Invocation disabled",
			enable: "Enable",
			disable: "Disable",
			opFailed: "Operation failed",
			contentError: "Failed to load skill content.",
			installTitle: "Install from ZIP",
			installHint: "Pick a local ZIP: it will be extracted, SKILL.md skills (bundles or flat .md) discovered, and installed into your user skills directory immediately.",
			pickZip: "Choose ZIP file…",
			zipBusy: "Installing…",
			zipInstalled: "Installed",
			zipConflict: "Skipped (name exists)",
			zipSkipped: "Ignored unsafe entries",
			zipEmpty: "No installable skills found in the ZIP",
			zipReadError: "Failed to read file",
			repoTitle: "GitHub skill marketplace",
			repoHint: "Enter repo coordinates (owner / name, optional branch; falls back to main→master). Add, then discover and install skills from the repo in the marketplace.",
			owner: "owner",
			repoName: "repo name",
			branch: "branch (optional)",
			addRepo: "Add repo",
			removeRepo: "Remove",
			discover: "Search",
			discoverBusy: "Searching…",
			discoverEmpty: "No skills found in this repo",
			install: "Install",
			installBusy: "Installing…",
			conflictHint: "(exists, skipped)"
		};

		// 操作状态展示：busy（进行中）与 idle（成功收尾）都不是错误；
		// 只有真正的错误字符串（远程调用抛出的消息）需要展示成"操作失败"。
		const opErrorText = (op, label) =>
			typeof op === "string" && op !== "busy" && op !== "idle" ? label + ": " + op : "";

		// ── 远程贡献（手写 codec：客户端边界只要求 parse）──────────────────────
		const identity = (value) => value;
		const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });

		const CONTRIBUTION = {
			package: "dsh-skill-manager",
			descriptors: [
				{
					id: "dsh-skill-manager#skillManager/list",
					service: "skillManager",
					namespace: "skillManager",
					method: "list",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#sessionId") }
					],
					result: codec("dsh-skill-manager#SkillListResult")
				},
				{
					id: "dsh-skill-manager#skillManager/content",
					service: "skillManager",
					namespace: "skillManager",
					method: "content",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-manager#SkillName") },
						{ name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#sessionId") }
					],
					result: codec("dsh-skill-manager#SkillContent")
				},
				{
					id: "dsh-skill-manager#skillManager/setEnabled",
					service: "skillManager",
					namespace: "skillManager",
					method: "setEnabled",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-manager#SkillName") },
						{ name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#sessionId") },
						{ name: "enabled", wire: "enabled", source: "json", codec: codec("dsh-skill-manager#EnabledFlag") },
						{ name: "source", wire: "source", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#SkillSource") }
					],
					result: codec("dsh-skill-manager#SetEnabledResult")
				},
				{
					id: "dsh-skill-manager#skillManager/setSourceEnabled",
					service: "skillManager",
					namespace: "skillManager",
					method: "setSourceEnabled",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "source", wire: "source", source: "json", codec: codec("dsh-skill-manager#SkillSource") },
						{ name: "sessionId", wire: "sessionId", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#sessionId") },
						{ name: "enabled", wire: "enabled", source: "json", codec: codec("dsh-skill-manager#EnabledFlag") }
					],
					result: codec("dsh-skill-manager#SetSourceEnabledResult")
				},
				{
					id: "dsh-skill-manager#skillManager/installZip",
					service: "skillManager",
					namespace: "skillManager",
					method: "installZip",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "fileName", wire: "fileName", source: "json", codec: codec("dsh-skill-manager#ZipFileName") },
						{ name: "dataBase64", wire: "dataBase64", source: "json", codec: codec("dsh-skill-manager#ZipDataBase64") }
					],
					result: codec("dsh-skill-manager#InstallZipResult")
				},
				{
					id: "dsh-skill-manager#skillManager/listRepos",
					service: "skillManager",
					namespace: "skillManager",
					method: "listRepos",
					invocation: { kind: "direct" },
					parameters: [],
					result: codec("dsh-skill-manager#RepoListResult")
				},
				{
					id: "dsh-skill-manager#skillManager/addRepo",
					service: "skillManager",
					namespace: "skillManager",
					method: "addRepo",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "owner", wire: "owner", source: "json", codec: codec("dsh-skill-manager#RepoOwner") },
						{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-manager#RepoName") },
						{ name: "branch", wire: "branch", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#RepoBranch") }
					],
					result: codec("dsh-skill-manager#RepoListResult")
				},
				{
					id: "dsh-skill-manager#skillManager/removeRepo",
					service: "skillManager",
					namespace: "skillManager",
					method: "removeRepo",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "owner", wire: "owner", source: "json", codec: codec("dsh-skill-manager#RepoOwner") },
						{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-manager#RepoName") }
					],
					result: codec("dsh-skill-manager#RepoListResult")
				},
				{
					id: "dsh-skill-manager#skillManager/discoverRepo",
					service: "skillManager",
					namespace: "skillManager",
					method: "discoverRepo",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "owner", wire: "owner", source: "json", codec: codec("dsh-skill-manager#RepoOwner") },
						{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-manager#RepoName") },
						{ name: "branch", wire: "branch", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#RepoBranch") }
					],
					result: codec("dsh-skill-manager#DiscoverResult")
				},
				{
					id: "dsh-skill-manager#skillManager/installFromRepo",
					service: "skillManager",
					namespace: "skillManager",
					method: "installFromRepo",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "owner", wire: "owner", source: "json", codec: codec("dsh-skill-manager#RepoOwner") },
						{ name: "name", wire: "name", source: "json", codec: codec("dsh-skill-manager#RepoName") },
						{ name: "branch", wire: "branch", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#RepoBranch") },
						{ name: "directory", wire: "directory", source: "json", acceptsUndefined: true, codec: codec("dsh-skill-manager#RepoSkillDirectory") }
					],
					result: codec("dsh-skill-manager#InstallFromRepoResult")
				}
			]
		};

		// ── 设置页组件 ──────────────────────────────────────────────────────────
		function SkillsSection({ listSkills, loadContent, setSkillEnabled, setSourceEnabled, installZip, listRepos, addRepo, removeRepo, discoverRepo, installFromRepo, t }) {
			const [query, setQuery] = react.useState("");
			const [listState, setListState] = react.useState({ status: "loading" });
			const [expanded, setExpanded] = react.useState(null);
			const [bodies, setBodies] = react.useState({});
			const [ops, setOps] = react.useState({});
			const [request, setRequest] = react.useState(0);

			react.useEffect(() => {
				let alive = true;
				setListState({ status: "loading" });
				listSkills().then(
					(result) => {
						if (!alive) return;
						setListState({ status: "ready", skills: result.skills });
					},
					(error) => {
						if (!alive) return;
						setListState({ status: "error", message: error.message });
					}
				);
				return () => {
					alive = false;
				};
			}, [listSkills, request]);

			// 展开卡片时按需加载正文
			react.useEffect(() => {
				if (expanded === null || bodies[expanded] !== undefined || listState.status !== "ready") return;
				let alive = true;
				loadContent(expanded).then(
					(result) => {
						if (!alive) return;
						setBodies((prev) => ({ ...prev, [expanded]: result }));
					},
					(error) => {
						if (!alive) return;
						setBodies((prev) => ({ ...prev, [expanded]: { error: error.message } }));
					}
				);
				return () => {
					alive = false;
				};
			}, [expanded, bodies, loadContent, listState.status]);

			const applySetEnabled = (skill, source) => {
				if (ops[skill.name] === "busy") return;
				setOps((prev) => ({ ...prev, [skill.name]: "busy" }));
				setSkillEnabled(skill.name, !skill.enabled, source).then(
					() => {
						setOps((prev) => ({ ...prev, [skill.name]: "idle" }));
						setRequest((n) => n + 1);
					},
					(error) => {
						setOps((prev) => ({ ...prev, [skill.name]: error.message }));
					}
				);
			};

			// 目录级一键启停（按 source 根分组）
			const applySetSource = (source, enabled) => {
				const key = "src:" + source;
				if (ops[key] === "busy") return;
				setOps((prev) => ({ ...prev, [key]: "busy" }));
				setSourceEnabled(source, enabled).then(
					() => {
						setOps((prev) => ({ ...prev, [key]: "idle" }));
						setRequest((n) => n + 1);
					},
					(error) => {
						setOps((prev) => ({ ...prev, [key]: error.message }));
					}
				);
			};

			if (listState.status === "loading") {
				return jsx("p", { className: c.status, children: t("loading") });
			}
			if (listState.status === "error") {
				return jsx("div", { className: c.failure, children: [
					jsx("p", { children: t("error") }),
					jsx("button", { onClick: () => setRequest((n) => n + 1), children: t("retry") })
				] });
			}

			const skills = listState.skills;
			const q = query.trim().toLowerCase();
			const filtered = q.length === 0 ? skills : skills.filter((skill) =>
				skill.name.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q)
			);
			const enabledCount = skills.filter((skill) => skill.enabled).length;

			// 来源标签（目录级分组头 + 卡片角标共用）
			const SOURCE_LABELS = {
				"user-dsh": "DeepSeek Harness",
				"user-agents": "Agents",
				"project-dsh": "项目",
				"project-agents": "项目 Agents",
				"codex-user": "Codex",
				"codex-project": "项目 Codex",
				"claude-user": "Claude",
				"claude-project": "项目 Claude",
				custom: "自定义",
				bundled: "内置",
				runtime: "运行时",
			github: "GitHub"
			};
			const srcLabel = (source) => SOURCE_LABELS[source] ?? source;

			// 按来源分组（保持首次出现顺序），目录头 + 组内卡片
			const groups = [];
			const groupOf = (source) => {
				for (const group of groups) if (group.source === source) return group;
				const group = { source, skills: [] };
				groups.push(group);
				return group;
			};
			for (const skill of filtered) groupOf(skill.repo ? "github" : skill.source).skills.push(skill);
			// 分组顺序：DeepSeek Harness 置顶，其余保持首次出现顺序（稳定排序）
			const GROUP_PRIORITY = { "user-dsh": 0, "user-agents": 1, github: 2 };
			groups.sort((a, b) => (GROUP_PRIORITY[a.source] ?? 99) - (GROUP_PRIORITY[b.source] ?? 99));

			return jsx("div", { className: c.section, children: [
				jsx(InstallPanel, { installZip, listRepos, addRepo, removeRepo, discoverRepo, installFromRepo, t }),
				jsx("div", { className: c.search, children:
					jsx("input", {
						type: "search",
						placeholder: t("search"),
						value: query,
						onChange: (event) => setQuery(event.target.value)
					})
				}),
				jsx("div", { className: c.stats, children: [
					jsx("h3", { children: t("catalog") }),
					jsx("span", { children: enabledCount + " " + t("enabledCount") + " · " + (skills.length - enabledCount) + " " + t("disabledCount") })
				] }),
				filtered.length === 0
					? jsx("p", { className: c.empty, children: q.length === 0 ? t("empty") : t("emptySearch") })
					: jsx("ul", { className: c.cards, children: groups.flatMap((group) => {
						const toggleable = group.skills.filter((skill) => skill.source !== "bundled" && skill.source !== "runtime");
						const allEnabled = toggleable.length > 0 && toggleable.every((skill) => skill.enabled);
						const srcOp = ops["src:" + group.source];
						const srcBusy = srcOp === "busy";
						const srcError = opErrorText(srcOp, t("opFailed")) !== "";
						return [
							jsx("li", { key: "src-" + group.source, className: c.groupHead, children: [
								jsx("span", { className: c.groupLabel, children: srcLabel(group.source) }),
								jsx("span", { className: c.groupCount, children:
									toggleable.filter((skill) => skill.enabled).length + "/" + toggleable.length + " " + t("enabledCount") }),
								srcError ? jsx("span", { className: c.groupHint, children: opErrorText(srcOp, t("opFailed")) }) : null,
								group.source === "github"
									? null // GitHub 是伪分组（真实来源 user-dsh），不做目录级开关
									: jsx("button", {
										className: c.switch,
										"data-on": allEnabled,
										disabled: srcBusy || toggleable.length === 0,
										"aria-label": allEnabled ? t("disable") : t("enable"),
										title: srcLabel(group.source) + (allEnabled ? t("disable") : t("enable")),
										onClick: () => applySetSource(group.source, !allEnabled)
									})
							] }),
							...group.skills.map((skill) => {
								const open = expanded === skill.name;
								const op = ops[skill.name];
								const invocation = skill.modelInvocable && skill.userInvocable
									? t("both")
									: skill.modelInvocable
										? t("modelOnly")
										: skill.userInvocable
											? t("userOnly")
											: t("none");
								const body = bodies[skill.name];
								return jsx("li", { key: skill.name, className: c.card, "data-open": open, children: [
									jsx("div", { className: c.cardRow, children: [
										jsx("div", { className: c.cardMain, children: [
											jsx("button", {
												className: c.cardHead,
												onClick: () => setExpanded(open ? null : skill.name),
												children: [
													jsx("span", { className: c.cardTitle, "data-enabled": skill.enabled, children: skill.name }),
													jsx("span", { className: c.tag, "data-kind": "source", title: skill.repo ? skill.repo.owner + "/" + skill.repo.name : undefined, children: skill.repo ? t("github") : srcLabel(skill.source) }),
													jsx("span", { className: c.tag, "data-kind": skill.enabled ? "model" : "disabled", children: skill.enabled ? invocation : t("disabled") })
												]
											}),
											jsx("p", { className: c.desc, children: skill.description })
										] }),
										jsx("div", { className: c.cardSide, children: [
											jsx("button", {
												className: c.switch,
												"data-on": skill.enabled,
												disabled: op === "busy" || skill.source === "bundled" || skill.source === "runtime",
												"aria-label": skill.enabled ? t("disable") : t("enable"),
												title: skill.source === "bundled" || skill.source === "runtime" ? skill.name + " (" + srcLabel(skill.source) + ")" : skill.enabled ? t("disable") : t("enable"),
												onClick: () => applySetEnabled(skill, skill.source)
											}),
											jsx("span", { className: c.status, children: opErrorText(op, t("opFailed")) })
										] })
									] }),
									open ? jsx("div", { className: c.body, children:
										body === undefined
											? jsx("pre", { children: t("contentError") })
											: "error" in body
												? jsx("pre", { children: body.error })
												: jsx("pre", { children: body?.content ?? "" })
									}) : null
								] });
							})
						];
					}) })
			] });
		}

		// ── 安装面板（ZIP 安装 + GitHub 仓库发现）──────────────────────────────
		function InstallPanel({ installZip, listRepos, addRepo, removeRepo, discoverRepo, installFromRepo, t }) {
			const enabled = typeof installZip === "function" && typeof listRepos === "function";
			const [zipMsg, setZipMsg] = react.useState(null);
			const [zipBusy, setZipBusy] = react.useState(false);
			const [repos, setRepos] = react.useState([]);
			const [repoError, setRepoError] = react.useState(null);
			const [form, setForm] = react.useState({ owner: "", name: "", branch: "" });
			const [discovery, setDiscovery] = react.useState({});
			const [ops, setOps] = react.useState({});

			react.useEffect(() => {
				if (!enabled) return;
				// 延迟到微任务：远程桩缺失时同步抛错也要落进 error 分支
				Promise.resolve().then(() => listRepos()).then(
					(result) => setRepos(result.repos),
					(error) => setRepoError(error.message)
				);
			}, [enabled, listRepos]);

			if (!enabled) return null;

			const repoKey = (repo) => repo.owner + "/" + repo.name;
			const refreshRepos = () => listRepos().then(
				(result) => { setRepos(result.repos); setRepoError(null); },
				(error) => setRepoError(error.message)
			);

			const onPickZip = (file) => {
				if (file === undefined) return;
				setZipBusy(true);
				setZipMsg(null);
				const reader = new FileReader();
				reader.onload = () => {
					const text = String(reader.result);
					const base64 = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
					installZip(file.name, base64).then(
						(result) => {
							const parts = [];
							if (result.installed.length > 0) {
								parts.push(t("zipInstalled") + ": " + result.installed.map((skill) => skill.name).join(", "));
							}
							if (result.conflicts.length > 0) {
								parts.push(t("zipConflict") + ": " + result.conflicts.map((skill) => skill.name).join(", "));
							}
							if (result.skipped.length > 0) {
								parts.push(t("zipSkipped") + ": " + result.skipped.map((skill) => skill.name).join(", "));
							}
							setZipMsg({ kind: "ok", text: parts.length > 0 ? parts.join("；") : t("zipEmpty") });
							setZipBusy(false);
						},
						(error) => {
							setZipMsg({ kind: "err", text: error.message });
							setZipBusy(false);
						}
					);
				};
				reader.onerror = () => {
					setZipMsg({ kind: "err", text: t("zipReadError") });
					setZipBusy(false);
				};
				reader.readAsDataURL(file);
			};

			const submitRepo = () => {
				const owner = form.owner.trim();
				const name = form.name.trim();
				if (owner.length === 0 || name.length === 0) return;
				setOps((prev) => ({ ...prev, add: "busy" }));
				addRepo(owner, name, form.branch.trim() || undefined).then(
					(result) => {
						setRepos(result.repos);
						setRepoError(null);
						setForm({ owner: "", name: "", branch: "" });
						setOps((prev) => ({ ...prev, add: "idle" }));
					},
					(error) => setOps((prev) => ({ ...prev, add: error.message }))
				);
			};

			const runDiscover = (repo) => {
				const key = "disc:" + repoKey(repo);
				setDiscovery((prev) => ({ ...prev, [key]: { status: "busy" } }));
				discoverRepo(repo.owner, repo.name, repo.branch || undefined).then(
					(result) => setDiscovery((prev) => ({ ...prev, [key]: { status: "ready", skills: result.skills } })),
					(error) => setDiscovery((prev) => ({ ...prev, [key]: { status: "error", error: error.message } }))
				);
			};

			const runInstall = (repo, skill) => {
				const key = "inst:" + repoKey(repo) + ":" + skill.directory;
				setOps((prev) => ({ ...prev, [key]: "busy" }));
				installFromRepo(repo.owner, repo.name, repo.branch || undefined, skill.directory).then(
					(result) => setOps((prev) => ({ ...prev, [key]: result.conflict === true ? t("conflictHint") : t("zipInstalled") })),
					(error) => setOps((prev) => ({ ...prev, [key]: error.message }))
				);
			};

			const addOpError = opErrorText(ops.add, t("opFailed"));

			return jsx("div", { className: c.panel, children: [
				// ZIP 安装
				jsx("div", { className: c.panelBlock, children: [
					jsx("h4", { className: c.panelTitle, children: t("installTitle") }),
					jsx("p", { className: c.hint, children: t("installHint") }),
					jsx("div", { className: c.row, children: [
						jsx("span", { className: c.btn, "data-file": true, children: [
							zipBusy ? t("zipBusy") : t("pickZip"),
							jsx("input", {
								type: "file",
								accept: ".zip,application/zip",
								disabled: zipBusy,
								onChange: (event) => {
									const file = event.target.files && event.target.files[0];
									event.target.value = "";
									onPickZip(file);
								}
							})
						] })
					] }),
					zipMsg ? jsx("p", { className: c.msg, "data-kind": zipMsg.kind, children: zipMsg.text }) : null
				] }),
				// GitHub 仓库发现
				jsx("div", { className: c.panelBlock, children: [
					jsx("h4", { className: c.panelTitle, children: t("repoTitle") }),
					jsx("p", { className: c.hint, children: t("repoHint") }),
					jsx("div", { className: c.row, children: [
						jsx("input", { className: c.input, placeholder: t("owner"), value: form.owner, onChange: (event) => setForm({ ...form, owner: event.target.value }) }),
						jsx("input", { className: c.input, placeholder: t("repoName"), value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) }),
						jsx("input", { className: c.input, placeholder: t("branch"), value: form.branch, onChange: (event) => setForm({ ...form, branch: event.target.value }) }),
						jsx("button", { className: c.btn, "data-kind": "primary", disabled: ops.add === "busy", onClick: submitRepo, children: t("addRepo") })
					] }),
					addOpError !== "" ? jsx("p", { className: c.msg, "data-kind": "err", children: addOpError }) : null,
					repoError ? jsx("p", { className: c.msg, "data-kind": "err", children: repoError }) : null,
					repos.length === 0
						? null
						: jsx("ul", { className: c.repoList, children: repos.map((repo) => {
							const key = repoKey(repo);
							const disc = discovery["disc:" + key];
							const installStatus = (skill) => ops["inst:" + key + ":" + skill.directory];
							return [
								jsx("li", { key: key, className: c.repoItem, children: [
									jsx("span", { className: c.repoLabel, children: key + (repo.branch ? " (" + repo.branch + ")" : "") }),
									jsx("button", { className: c.btn, disabled: disc !== undefined && disc.status === "busy", onClick: () => runDiscover(repo), children: disc !== undefined && disc.status === "busy" ? t("discoverBusy") : t("discover") }),
									jsx("button", { className: c.btn, onClick: () => removeRepo(repo.owner, repo.name).then(refreshRepos), children: t("removeRepo") })
								] }),
								disc !== undefined && disc.status === "ready" && disc.skills.length === 0
									? jsx("li", { key: key + "-empty", className: c.repoItem, children: jsx("span", { className: c.hint, children: t("discoverEmpty") }) })
									: disc !== undefined && disc.status === "ready"
										? disc.skills.map((skill) => jsx("li", { key: key + "-" + skill.directory, className: c.repoItem, children: [
											jsx("span", { className: c.repoLabel, children: skill.name + " — " + skill.description }),
											jsx("button", { className: c.btn, "data-kind": "primary", disabled: installStatus(skill) === "busy", onClick: () => runInstall(repo, skill), children: installStatus(skill) === "busy" ? t("installBusy") : installStatus(skill) || t("install") })
										] }))
										: disc !== undefined && disc.status === "error"
											? jsx("li", { key: key + "-err", className: c.repoItem, children: jsx("span", { className: c.msg, "data-kind": "err", children: disc.error }) })
											: null
							];
						}) })
				] })
			] });
		}

		// ── cordis 插件体 ─────────────────────────────────────────────────────
		const inject = ["slots", "locale", "remote", "sessions"];

		function apply(ctx) {
			// 字典注册（生命周期随插件 fiber）
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-manager: dictionaries");

			const t = ctx.locale.bind(NS);

			// 挂载远程贡献；所有远程调用都等待挂载完成后再取命名空间服务。
			const mount = ctx.remote.$mount(CONTRIBUTION);
			const currentSessionId = () => ctx.get("sessions").currentProvideInfo.getSnapshot().sessionId;
			const callRemote = async (method, ...args) => {
				await mount;
				const remote = ctx.get("remote.skillManager");
				const result = await remote[method](...args);
				if (!result.ok) throw new Error("skillManager." + method + " failed: " + result.error.code + ": " + result.error.message);
				return result.value;
			};
			const sectionFace = () => ({
				currentSessionId,
				listSkills: () => callRemote("list", currentSessionId()),
				loadContent: (name) => callRemote("content", name, currentSessionId()),
				setSkillEnabled: (name, enabled, source) => callRemote("setEnabled", name, currentSessionId(), enabled, source),
				setSourceEnabled: (source, enabled) => callRemote("setSourceEnabled", source, currentSessionId(), enabled),
				installZip: (fileName, dataBase64) => callRemote("installZip", fileName, dataBase64),
				listRepos: () => callRemote("listRepos"),
				addRepo: (owner, name, branch) => callRemote("addRepo", owner, name, branch),
				removeRepo: (owner, name) => callRemote("removeRepo", owner, name),
				discoverRepo: (owner, name, branch) => callRemote("discoverRepo", owner, name, branch),
				installFromRepo: (owner, name, branch, directory) => callRemote("installFromRepo", owner, name, branch, directory)
			});
			// 注册"技能管理"设置分区（order 17：位于"插件"15 与"agent 预设"20 之间）
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skill-manager",
				order: 17,
				label: () => t("nav"),
				locale: NS,
				inject: sectionFace
			}, SkillsSection));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.SkillsSection = SkillsSection;
		exports.InstallPanel = InstallPanel;
		exports.opErrorText = opErrorText;
		return module.exports;
	}
});
