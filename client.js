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
			".bd-fail{font-size:12px;opacity:.72;padding:8px 0}"
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

		function BetterDebugPanel() {
			return react_jsx_runtime.jsx("div", {
				className: "bd-view",
				children: react_jsx_runtime.jsx("iframe", {
					className: "bd-frame",
					src: panelSrc,
					title: "better-debug 观测面板"
				})
			});
		}

		/**
		 * 不声明静态 inject —— 和宿主侧同一个理由。
		 *
		 * cordis 的 `Fiber._refresh()` 只要声明的服务拿不到就不执行 apply：没有报错、
		 * 没有日志，面板安安静静地不存在。`slots` 属于前端 runtime，版本差异下未必有；
		 * 而它不在时我们本来就该只是「不注册面板」，而不是整段代码不跑。
		 * 所以改成 ctx.inject 动态订阅：服务在就挂，不在就跳过。
		 */
		const inject = [];

		function apply(ctx) {
			const mount = (slotCtx) => {
				const slots = slotCtx?.slots;
				if (slots === void 0 || typeof slots.inject !== "function") return;
				slots.inject("settings.section", () => slots.register({
					name: "settings.section",
					id: "better-debug",
					order: 40,
					label: "better-debug"
				}, BetterDebugPanel));
			};
			if (typeof ctx?.inject === "function") ctx.inject(["slots"], mount);
			else mount(ctx);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
