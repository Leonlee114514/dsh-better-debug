window.__ModuleLoader__.load({
	id: "dsh-better-debug",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		// 面板本体在 web/index.html 里（原生 JS/SVG，不经过 React），
		// 这里只负责给 iframe 一个能撑满 section 的壳。
		const css = [
			".bd-view{display:flex;flex-direction:column;width:100%;min-height:0}",
			".bd-frame{flex:1;width:100%;min-height:640px;border:0;display:block;background:transparent}",
			".bd-fail{font-size:12px;opacity:.72;padding:8px 0;line-height:1.6}"
		].join("");
		const tagId = "dsh-better-debug/style";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-better-debug";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		/** 面板地址。相对路径即可：和 DSH 同源，由插件的 webServer 前缀路由提供。 */
		const panelSrc = "/better-debug/index.html";

		//#region locale
		// 可见文案走 Client locale 服务（dsh-doc references/ui-plugin.md：
		// "Route visible UI text through the Client locale service"）。
		// 导航标签 `better-debug` 是稳定标识符，中英一致，不进字典；
		// 进字典的是无障碍标题与失败提示这两处真正的自然语言。
		const LOCALE_NS = "better-debug";
		const DICTS = {
			zh: {
				title: "better-debug 观测面板",
				fail: "面板没有加载：/better-debug 路由未注册。检查配置里的 panel 是否被设为 false，以及宿主 webServer 是否可用。"
			},
			en: {
				title: "better-debug panel",
				fail: "The panel did not load: the /better-debug route is not registered. Check whether `panel` is set to false in the config, and whether the host webServer is available."
			}
		};
		const FALLBACK = DICTS.zh;
		/** 当前语言的文案。locale 服务缺席时退回中文，面板不会因为缺服务而不显示。 */
		let text = FALLBACK;
		//#endregion

		function BetterDebugPanel() {
			// iframe 的 onError 在「路由没挂上、返回 404 页面」时并不触发（那是一次成功的导航），
			// 所以这里用一次同源 HEAD 探针判断面板是否真的存在 —— 否则用户只会看到 640px 的空白。
			const [failed, setFailed] = react.useState(false);
			react.useEffect(() => {
				if (typeof fetch !== "function") return;
				let live = true;
				fetch(panelSrc, { method: "HEAD", cache: "no-store" })
					.then((res) => { if (live && !res.ok) setFailed(true); })
					.catch(() => { if (live) setFailed(true); });
				return () => { live = false; };
			}, []);
			if (failed) {
				return react_jsx_runtime.jsx("div", { className: "bd-fail", children: text.fail });
			}
			return react_jsx_runtime.jsx("div", {
				className: "bd-view",
				children: react_jsx_runtime.jsx("iframe", {
					className: "bd-frame",
					src: panelSrc,
					title: text.title
				})
			});
		}

		/**
		 * `slots` 必须**静态声明**，不能走 `ctx.inject([...], cb)` 动态订阅。
		 *
		 * 客户端插件拿到的是 dynamic facade（dsh-cordis-client-runner 的
		 * dynamicCordisContext）：只有 CTX_VERBS（effect / on / once / provide / 定时器
		 * 六兄弟）和**本插件 inject 数组里声明过的服务**可读，其余属性一律 rejectGuard
		 * 抛错。`inject` 自己不在白名单里 —— 于是 `ctx.inject(["slots"], mount)` 直接抛
		 * `dynamic ctx does not expose "inject"`，mount 永不执行，面板静默消失。
		 *
		 * 宿主侧（lib/index.js）能这么写，是因为宿主插件拿到的是真 cordis Context，
		 * 不是这个 facade；两边规则不同，不要互相照抄。
		 *
		 * `slots` 是 UI 座位本身，没有它这个插件无事可做；声明之后若服务缺席，cordis
		 * 只把 fiber 挂在 waitingFor 上，不会崩。`locale` 是真正的可选项，用
		 * `ctx.get("locale")` 取 —— facade 的 `get` 不做声明校验，缺席只影响文案语言。
		 */
		const inject = ["slots"];

		function apply(ctx) {
			const effect = (run, label) => {
				if (typeof ctx.effect === "function") ctx.effect(run, label);
				else run();
			};

			const slots = ctx.slots;
			if (slots === void 0 || typeof slots.inject !== "function") return;

			// locale 是可选服务：facade 的 get() 不做声明校验，缺席只影响文案语言。
			const locale = typeof ctx.get === "function" ? ctx.get("locale") : void 0;
			if (locale !== void 0 && typeof locale.register === "function") {
				// 同一 (ns, locale) 重复注册会抛（locale 服务是单占位语义），
				// 所以必须交给 effect 管清理，热重载时才不会炸在第二次注册上。
				effect(() => locale.register(LOCALE_NS, DICTS), "better-debug: dictionaries");
				if (typeof locale.bind === "function") {
					const t = locale.bind(LOCALE_NS);
					const pick = (key) => {
						try {
							const value = t(key);
							return typeof value === "string" && value.length > 0 ? value : FALLBACK[key];
						} catch {
							return FALLBACK[key];
						}
					};
					text = { title: pick("title"), fail: pick("fail") };
				}
			}

			// register 的返回值是 disposer：必须交给 effect，否则插件卸载 / 热重载
			// 之后同名 section 会一代代堆积（官方写法见 dsh-client-ui-settings-account）。
			effect(
				() => slots.inject("settings.section", () => slots.register({
					name: "settings.section",
					id: "better-debug",
					order: 40,
					// label 是 registrant 自己本地化的显示文本：这里中英一致，
					// 保持稳定标识符，避免用户在两份 README 之间找不到入口。
					label: () => "better-debug",
					locale: LOCALE_NS
				}, BetterDebugPanel)),
				"better-debug: settings section"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
