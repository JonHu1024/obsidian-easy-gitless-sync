// workspace.ts — 统一同步工作台
// 顶部模式选项卡 + 左侧文件树 + 右侧内嵌对比；手机端对比仍用独立弹窗。

import { App, Modal, Notice, setIcon } from "obsidian";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import type GitHubSyncPlugin from "./main";
import type { GitHubFile } from "./github";
import { FileDiff, SyncDirection, isTextFile } from "./diff";
import type { ModePlan, SyncBase, SyncMode } from "./types";
import { getErrorMessage } from "./utils";

export interface SyncWorkspaceOptions {
	mode?: SyncMode;
	targetPath?: string;
}

const MODE_ORDER: SyncMode[] = ["push", "pull", "time", "merge"];

const MODE_META: Record<
	SyncMode,
	{ label: string; short: string; icon: string; desc: string }
> = {
	push: {
		label: "Push",
		short: "Push",
		icon: "arrow-up",
		desc: "以本地结构和内容为准上传到 GitHub；远端独有文件会被删除。",
	},
	pull: {
		label: "Pull",
		short: "Pull",
		icon: "arrow-down",
		desc: "以 GitHub 为准下载到本地；本地独有文件会被删除。",
	},
	time: {
		label: "By Time",
		short: "Time",
		icon: "clock",
		desc: "按最后修改时间决定每个文件的上传/下载；单边文件默认补齐。",
	},
	merge: {
		label: "Merge",
		short: "Merge",
		icon: "git-merge",
		desc: "文本文件自动合并双方修改；二进制文件按修改时间决定方向。",
	},
};

/** 两端只有尾部空行差异 → 视为相同 */
function onlyTrailingBlankLinesDiffer(a: string, b: string): boolean {
	if (a === b) return false;
	const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const strip = (s: string) => norm(s).replace(/\n+$/, "");
	return strip(a) === strip(b);
}

function fmtTime(t: number): string {
	const d = new Date(t);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ──────────────────────────────────────────────
// 对比数据缓存
// ──────────────────────────────────────────────

const MAX_PRELOAD_CONTENT_BYTES = 10 * 1024 * 1024;
const PRELOAD_BUDGET_BYTES = 60 * 1024 * 1024;
const PRELOAD_CONCURRENCY = 2;
/** 列表渲染后延迟多久才开始预取：用户很可能马上点同步，预取别去抢带宽 */
const PRELOAD_DELAY_MS = 1500;
/**
 * "本地要推上去"的文件，远端内容用不到（大文件更没必要提前拉）。
 * 只有小于这个大小的才顺手预取，省得同步时白白再下一遍。
 */
const PRELOAD_SMALL_FILE_BYTES = 256 * 1024;

interface DiffData {
	path: string;
	local: ArrayBuffer | null;
	remote: ArrayBuffer | null;
	remoteFile?: GitHubFile;
	remoteSize: number;
	commitMessage: string;
	commitDate: string;
	/** 超过单文件内容上限（仅保留元数据） */
	tooLarge: boolean;
	/** 预加载预算用尽，内容尚未缓存；打开时再按需取 */
	deferred: boolean;
}

class DiffCache {
	private map = new Map<string, Promise<DiffData>>();
	/** 按需补取的提交信息（预取阶段不批量拉，避免请求量翻倍） */
	private metaMap = new Map<string, { message: string; date: string } | null>();
	private queue: string[] = [];
	private running = 0;
	private closed = false;
	private preloadBytes = 0;
	private preloadDone = 0;
	private preloadTotal = 0;
	private remoteMap: Map<string, GitHubFile>;
	/** 同步期间暂停预取的定时器 */
	private pauseTimer: number | null = null;
	/** 预取延迟启动的定时器 */
	private preloadTimer: number | null = null;

	constructor(
		private plugin: GitHubSyncPlugin,
		private base: SyncBase,
		private onProgress?: (done: number, total: number) => void
	) {
		this.remoteMap = new Map(
			base.remote.files.map((f) => [f.path, f] as const)
		);
	}

	/**
	 * 开始后台预取；不阻塞列表显示。
	 *
	 * 延迟一小会儿再真正发请求：用户点开工作台后多半马上就要同步，
	 * 这时候预取只会和上传/下载抢带宽。
	 */
	preload(paths: string[]) {
		const unique = Array.from(new Set(paths));
		this.preloadTotal = unique.length;
		this.preloadDone = 0;
		this.queue.push(...unique);
		this.onProgress?.(0, this.preloadTotal);
		this.preloadTimer = window.setTimeout(() => {
			this.preloadTimer = null;
			this.pump();
		}, PRELOAD_DELAY_MS);
	}

	private pump() {
		if (this.closed) return;
		if (this.plugin.isSyncingNow) {
			// 同步期间让出网络，避免和上传/下载抢带宽与限流额度
			if (!this.pauseTimer) {
				this.pauseTimer = window.setTimeout(() => {
					this.pauseTimer = null;
					this.pump();
				}, 2000);
			}
			return;
		}
		while (this.running < PRELOAD_CONCURRENCY && this.queue.length > 0) {
			const path = this.queue.shift()!;
			this.running++;
			let promise = this.map.get(path);
			if (!promise) {
				promise = this.load(path, true);
				this.map.set(path, promise);
			}
			void promise
				.catch(() => null)
				.finally(() => {
					this.running--;
					this.preloadDone++;
					if (!this.closed) {
						this.onProgress?.(this.preloadDone, this.preloadTotal);
					}
					this.pump();
				});
		}
	}

	async get(path: string): Promise<DiffData | null> {
		if (this.closed) return null;
		let promise = this.map.get(path);
		if (!promise) {
			promise = this.load(path, false);
			this.map.set(path, promise);
		}
		let data = await promise;
		// 预取时因总预算跳过内容 / 下载失败：用户真正点开时再按需补一次
		if (
			(data.deferred ||
				(!data.remote && data.remoteFile && !data.tooLarge)) &&
			data.remoteFile &&
			!data.tooLarge
		) {
			const fresh = await this.load(path, false);
			this.map.set(path, Promise.resolve(fresh));
			data = fresh;
		}
		return data;
	}

	/**
	 * 按需补取提交信息（最后一次 commit 的说明与时间）。
	 *
	 * 预取阶段**不**批量拉这个：每个文件多一个请求，预取量直接翻倍，
	 * 会和真正的同步抢限流额度。只有用户真的打开某个文件的对比时才取。
	 */
	async fetchMeta(
		path: string
	): Promise<{ commitMessage: string; commitDate: string }> {
		const empty = { commitMessage: "", commitDate: "" };
		if (this.closed) return empty;
		if (this.metaMap.has(path)) {
			const v = this.metaMap.get(path);
			return { commitMessage: v?.message ?? "", commitDate: v?.date ?? "" };
		}
		const remoteFile = this.remoteMap.get(path);
		if (!remoteFile) return empty;
		const info = await this.base.client
			.getFileCommitInfo(path)
			.catch(() => null);
		this.metaMap.set(path, info);
		return { commitMessage: info?.message ?? "", commitDate: info?.date ?? "" };
	}

	private async load(path: string, prefetch: boolean): Promise<DiffData> {
		const remoteFile = this.remoteMap.get(path);
		const local = this.base.local.files.get(path) ?? null;
		if (this.closed) {
			return {
				path,
				local,
				remote: null,
				remoteFile,
				remoteSize: remoteFile?.size ?? 0,
				commitMessage: "",
				commitDate: "",
				tooLarge: false,
				deferred: false,
			};
		}
		let remote: ArrayBuffer | null = null;
		let tooLarge = false;
		let deferred = false;
		let commitMessage = "";
		let commitDate = "";

		if (remoteFile) {
			// 预取阶段只拉内容；提交信息等用户真的打开对比时再按需取
			const content = await (remoteFile.size > MAX_PRELOAD_CONTENT_BYTES
				? Promise.resolve(null)
				: prefetch &&
				  this.preloadBytes + remoteFile.size > PRELOAD_BUDGET_BYTES
					? Promise.resolve(null)
					: this.base.client
							.downloadFile(path, remoteFile.sha)
							.catch(() => null));
			if (remoteFile.size > MAX_PRELOAD_CONTENT_BYTES) tooLarge = true;
			else if (!content && prefetch) deferred = true;
			remote = content;
			if (content && prefetch) this.preloadBytes += content.byteLength;
		}

		return {
			path,
			local,
			remote,
			remoteFile,
			remoteSize: remoteFile?.size ?? 0,
			commitMessage,
			commitDate,
			tooLarge,
			deferred,
		};
	}

	kill() {
		this.closed = true;
		this.queue = [];
		this.map.clear();
		this.metaMap.clear();
		if (this.pauseTimer) {
			window.clearTimeout(this.pauseTimer);
			this.pauseTimer = null;
		}
		if (this.preloadTimer) {
			window.clearTimeout(this.preloadTimer);
			this.preloadTimer = null;
		}
	}
}

// ──────────────────────────────────────────────
// 单个文件的对比渲染（内嵌右栏 / 独立弹窗共用）
// ──────────────────────────────────────────────

function renderDiffContent(
	container: HTMLElement,
	data: DiffData,
	mergeViews: { mv: MergeView; path: string }[],
	onIdentical?: (path: string) => void
) {
	container.empty();
	const localA = data.local;
	const remoteA = data.remote;
	const text = isTextFile(data.path);

	if (!localA && !remoteA) {
		container.createEl("p", {
			text: "⚠️ 两端都没有可读取的内容",
			cls: "egs-empty-note",
		});
		return;
	}

	if (!text) {
		const table = container.createEl("table", { cls: "diff-binary-table" });
		const localRow = table.insertRow();
		localRow.insertCell().textContent = "本地大小";
		localRow.insertCell().textContent = localA
			? formatSize(localA.byteLength)
			: "（本地不存在）";
		const remoteRow = table.insertRow();
		remoteRow.insertCell().textContent = "GitHub 大小";
		remoteRow.insertCell().textContent = data.remoteFile
			? formatSize(data.remoteSize)
			: "（远端不存在）";
		return;
	}

	const localText = localA ? new TextDecoder().decode(localA) : "";
	const remoteText = remoteA ? new TextDecoder().decode(remoteA) : "";

	if (localA && remoteA) {
		if (localText === remoteText || onlyTrailingBlankLinesDiffer(localText, remoteText)) {
			container.createEl("p", {
				text: "✅ 文件内容相同（仅尾部空行不同）",
				cls: "github-sync-no-changes",
			});
			onIdentical?.(data.path);
			return;
		}
	} else if (data.remoteFile && !data.remote) {
		container.createEl("p", {
			text: data.tooLarge
				? `⚠️ 远端文件 ${formatSize(data.remoteSize)}，超过 10MB，仅显示元数据（可在独立窗口中查看大小/提交信息）。`
				: "⚠️ 远端内容暂不可用，无法对比；请稍后重试。",
			cls: "github-sync-warning",
		});
		return;
	}

	const sides = container.createDiv("egs-diff-sides");
	if (localA) sides.createEl("span", { text: "本地", cls: "egs-diff-side-label" });
	else sides.createEl("span", { text: "本地（不存在）", cls: "egs-diff-side-label is-missing" });
	if (remoteA) sides.createEl("span", { text: "GitHub", cls: "egs-diff-side-label" });
	else sides.createEl("span", { text: "GitHub（不存在）", cls: "egs-diff-side-label is-missing" });

	const editorWrap = container.createDiv("cm-merge-view egs-diff-editor");
	const readOnlyExt = [
		EditorView.lineWrapping,
		lineNumbers(),
		EditorView.editable.of(false),
	];
	const aState = EditorState.create({ doc: localText, extensions: readOnlyExt });
	const bState = EditorState.create({ doc: remoteText, extensions: readOnlyExt });
	const mv = new MergeView({
		a: aState,
		b: bState,
		parent: editorWrap,
		collapseUnchanged: { margin: 2, minSize: 3 },
	});
	mergeViews.push({ mv, path: data.path });
}

// ──────────────────────────────────────────────
// 独立对比弹窗（单文件，复用预加载缓存）
// ──────────────────────────────────────────────

class DiffPaneModal extends Modal {
	private mergeViews: { mv: MergeView; path: string }[] = [];
	onClosed?: () => void;

	constructor(
		app: App,
		private plugin: GitHubSyncPlugin,
		private cache: DiffCache,
		private path: string,
		private onIdentical?: (path: string) => void
	) {
		super(app);
	}

	async onOpen() {
		this.modalEl.addClass("egs-diff-modal-host");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("egs-diff-modal");

		const header = contentEl.createDiv("egs-diff-modal-header");
		header.createEl("h2", { text: "文件对比" });
		header.createEl("div", { text: this.path, cls: "egs-diff-modal-path" });
		const body = contentEl.createDiv("egs-diff-modal-body");
		const status = body.createDiv("egs-loading is-inline");
		status.createDiv("egs-spinner");
		status.createDiv({ text: "读取对比内容...", cls: "egs-loading-text" });

		const data = await this.cache.get(this.path).catch(() => null);
		if (!data) {
			body.empty();
			body.createEl("p", { text: "对比缓存已失效，请重新打开工作台。", cls: "github-sync-warning" });
			return;
		}
		body.empty();
		renderDiffContent(body, data, this.mergeViews, this.onIdentical);

		const footer = contentEl.createDiv("egs-footer egs-diff-modal-footer");
		const actions = footer.createDiv("egs-footer-actions");
		const closeBtn = actions.createEl("button", { text: "关闭", cls: "egs-btn" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose() {
		for (const entry of this.mergeViews) {
			entry.mv.a.destroy();
			entry.mv.b.destroy();
		}
		this.mergeViews = [];
		this.contentEl.empty();
		this.onClosed?.();
	}
}

// ──────────────────────────────────────────────
// 主工作台
// ──────────────────────────────────────────────

interface WorkspaceEntry {
	path: string;
	isRemove: boolean;
	diff: FileDiff;
}

interface FolderNode {
	type: "folder";
	path: string;
	name: string;
	depth: number;
	children: TreeNode[];
	files: WorkspaceEntry[];
}

interface FileNode {
	type: "file";
	depth: number;
	entry: WorkspaceEntry;
	/** 由“只含一个文件”的文件夹链提升而来：显示相对路径 */
	promoted?: boolean;
}

type TreeNode = FolderNode | FileNode;

export class SyncWorkspaceModal extends Modal {
	onClosed?: () => void;

	private mode: SyncMode;
	private base: SyncBase | null = null;
	private plan: ModePlan | null = null;
	private entries: WorkspaceEntry[] = [];
	private actions = new Map<string, SyncDirection>();
	private selectedProcess = new Set<string>();
	private selectedRemove = new Set<string>();

	private folderMap = new Map<string, FolderNode>();
	private fileRows = new Map<
		string,
		{
			checkbox: HTMLInputElement;
			entry: WorkspaceEntry;
			iconEl: HTMLElement;
			pathEl: HTMLElement;
			rowEl: HTMLElement;
		}
	>();
	private folderRows = new Map<
		string,
		{ checkbox: HTMLInputElement; countEl: HTMLElement; node: FolderNode }
	>();
	private expandedFolders = new Set<string>();
	private expandAllMode = true;
	private query = "";

	private loading = false;
	private syncing = false;
	private completed = false;
	private closed = false;
	private modeSeq = 0;
	private activePath: string | null = null;
	private rightVisible = false;

	private diffCache: DiffCache | null = null;
	private mergeViews: { mv: MergeView; path: string }[] = [];
	private separateModal: DiffPaneModal | null = null;
	private resizeHandler: (() => void) | null = null;

	private tabsEl!: HTMLElement;
	private tabButtons = new Map<SyncMode, HTMLButtonElement>();
	private modeDescEl!: HTMLElement;
	private leftEl!: HTMLElement;
	private rightEl!: HTMLElement;
	private rightHeaderEl!: HTMLElement;
	private rightBodyEl!: HTMLElement;
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private warningsEl!: HTMLElement;
	private loadingEl!: HTMLElement;
	private loadingText!: HTMLElement;
	private loadingBarFill!: HTMLElement;
	private countEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private cacheStatusEl!: HTMLElement;
	private selectAllBtn!: HTMLButtonElement;
	private expandAllBtn!: HTMLButtonElement;
	private searchInput!: HTMLInputElement;
	private refreshBtn!: HTMLButtonElement;
	private rollbackBtn!: HTMLButtonElement;
	private separateBtn!: HTMLButtonElement;
	private syncBtn!: HTMLButtonElement;
	private contentWrap!: HTMLElement;

	constructor(
		app: App,
		private plugin: GitHubSyncPlugin,
		private options: SyncWorkspaceOptions
	) {
		super(app);
		const fallback = plugin.getLastSyncMode();
		this.mode = this.isValidMode(options.mode) ? options.mode! : fallback;
	}

	private isValidMode(mode: unknown): mode is SyncMode {
		return mode === "push" || mode === "pull" || mode === "time" || mode === "merge";
	}

	onOpen() {
		this.modalEl.addClass("egs-workspace-host");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "egs-workspace-modal");
		this.contentWrap = contentEl;

		this.buildShell();
		this.resizeHandler = () => {
			if (!this.inlineDiffEnabled() && this.rightVisible) {
				// 保留 activePath，方便手机上继续用“单独显示”打开
				this.hideRightPane(false);
			}
		};
		window.addEventListener("resize", this.resizeHandler);
		void this.loadBase();
	}

	private buildShell() {
		const root = this.contentEl;
		root.empty();

		const header = root.createDiv("egs-header");
		const titleRow = header.createDiv("egs-title-row");
		titleRow.createEl("h2", { text: "Easy Gitless Sync" });
		const repo =
			`${(this.plugin.settings.repository || "").trim() || "(未配置)"}` +
			` · ${(this.plugin.settings.branch || "main").trim() || "main"}`;
		titleRow.createEl("span", { text: repo, cls: "egs-repo-pill" });
		if (this.options.targetPath) {
			titleRow.createEl("span", {
				text: `仅此文件 · ${this.options.targetPath}`,
				cls: "egs-target-chip",
				attr: { title: this.options.targetPath },
			});
		}
		const headerActions = titleRow.createDiv("egs-header-actions");
		this.refreshBtn = headerActions.createEl("button", {
			cls: "egs-icon-btn",
			attr: { title: "重新读取本地与 GitHub 列表", "aria-label": "刷新" },
		});
		setIcon(this.refreshBtn, "refresh-cw");
		if (this.refreshBtn.childElementCount === 0) this.refreshBtn.setText("刷新");
		this.refreshBtn.addEventListener("click", () => void this.reloadBase());

		this.rollbackBtn = headerActions.createEl("button", {
			cls: "egs-text-btn",
			attr: { title: "打开历史快照" },
		});
		setIcon(this.rollbackBtn, "history");
		this.rollbackBtn.createSpan({
			text: "回滚",
			cls: "egs-text-btn-label",
		});
		this.rollbackBtn.addEventListener("click", () => {
			this.close();
			void this.plugin.openRollback();
		});



		const body = root.createDiv("egs-body");
		this.leftEl = body.createDiv("egs-left");
		// 选项卡只属于左栏；右栏是可选对比区
		this.buildTabs(this.leftEl);
		const toolbar = this.leftEl.createDiv("egs-toolbar github-sync-toolbar");
		this.selectAllBtn = toolbar.createEl("button", {
			text: "全选",
			cls: "github-sync-select-all-btn",
		});
		this.expandAllBtn = toolbar.createEl("button", {
			text: "折叠全部",
			cls: "github-sync-select-all-btn",
		});
		this.countEl = toolbar.createEl("span", { cls: "github-sync-selected-count" });
		this.searchInput = toolbar.createEl("input", {
			type: "search",
			cls: "github-sync-search",
			attr: { placeholder: "搜索文件/文件夹过滤…" },
		});
		this.selectAllBtn.addEventListener("click", () => {
			if (this.areAllSelected()) {
				this.selectedProcess.clear();
				this.selectedRemove.clear();
			} else {
				for (const entry of this.entries) this.setSelected(entry, true);
			}
			this.syncUI();
		});
		this.expandAllBtn.addEventListener("click", () => {
			this.expandAllMode = !this.expandAllMode;
			this.expandedFolders.clear();
			this.expandAllBtn.setText(this.expandAllMode ? "折叠全部" : "展开全部");
			this.renderList();
		});
		this.searchInput.addEventListener("input", () => {
			this.query = this.searchInput.value.trim().toLowerCase();
			this.renderList();
		});

		this.summaryEl = this.leftEl.createDiv("github-sync-summary egs-summary");
		this.listEl = this.leftEl.createDiv(
			"egs-list github-sync-file-list github-sync-tree"
		);
		this.warningsEl = this.leftEl.createDiv("egs-warnings");
		this.warningsEl.style.display = "none";

		this.loadingEl = this.leftEl.createDiv("egs-loading");
		const spinner = this.loadingEl.createDiv("egs-spinner");
		spinner.setAttribute("aria-hidden", "true");
		this.loadingText = this.loadingEl.createDiv("egs-loading-text");
		const bar = this.loadingEl.createDiv("egs-loading-bar");
		this.loadingBarFill = bar.createDiv("egs-loading-bar-fill");
		this.loadingEl.removeClass("is-visible");

		this.rightEl = body.createDiv("egs-right");
		this.rightHeaderEl = this.rightEl.createDiv("egs-right-header");
		this.rightBodyEl = this.rightEl.createDiv("egs-right-body");

		const footer = root.createDiv("egs-footer");
		const statusWrap = footer.createDiv("egs-footer-status");
		this.statusEl = statusWrap.createDiv("egs-status");
		this.cacheStatusEl = statusWrap.createDiv("egs-cache-status");
		const footerActions = footer.createDiv("egs-footer-actions");
		this.separateBtn = footerActions.createEl("button", {
			text: "对比窗口单独显示",
			cls: "egs-btn",
			attr: { title: "在独立窗口中打开当前文件的对比" },
		});
		this.separateBtn.disabled = true;
		this.separateBtn.addEventListener("click", () => {
			if (this.activePath) this.openSeparateDiff(this.activePath);
		});
		const cancelBtn = footerActions.createEl("button", {
			text: "取消",
			cls: "egs-btn",
		});
		cancelBtn.addEventListener("click", () => this.close());
		this.syncBtn = footerActions.createEl("button", {
			text: "开始同步",
			cls: "egs-btn egs-btn-primary",
		});
		this.syncBtn.addEventListener("click", () => void this.syncNow());

		this.updateTabs();
		this.updateModeDesc();
		this.updateFooter();
		this.setStatus("准备同步数据...", "busy");
	}

	private buildTabs(parent: HTMLElement) {
		this.tabsEl = parent.createDiv("egs-tabs");
		this.tabsEl.setAttribute("role", "tablist");
		for (const mode of MODE_ORDER) {
			const meta = MODE_META[mode];
			const tab = this.tabsEl.createEl("button", {
				cls: `egs-tab egs-tab-${mode}`,
				attr: {
					role: "tab",
					"aria-selected": "false",
					"aria-label": `${meta.label}：${meta.desc}`,
				},
			});
			const icon = tab.createSpan("egs-tab-icon");
			setIcon(icon, meta.icon);
			tab.createSpan({ text: meta.label, cls: "egs-tab-label" });
			tab.addEventListener("click", () => void this.switchMode(mode));
			tab.addEventListener("mouseenter", () => this.updateModeDesc(mode));
			tab.addEventListener("focus", () => this.updateModeDesc(mode));
			tab.addEventListener("mouseleave", () => this.updateModeDesc());
			tab.addEventListener("blur", () => this.updateModeDesc());
			this.tabButtons.set(mode, tab);
		}
		this.modeDescEl = parent.createDiv("egs-mode-desc");
	}

	private updateTabs() {
		for (const [mode, tab] of this.tabButtons) {
			const active = mode === this.mode;
			tab.toggleClass("is-active", active);
			tab.setAttribute("aria-selected", active ? "true" : "false");
			tab.disabled = this.loading || this.syncing || !this.base;
		}
	}

	private updateModeDesc(hover?: SyncMode) {
		if (!this.modeDescEl) return;
		const meta = MODE_META[hover ?? this.mode];
		this.modeDescEl.setText(`${meta.label}：${meta.desc}`);
	}

	/** 供外部入口（quick command）切换选项卡 */
	focusMode(mode?: SyncMode) {
		if (mode && mode !== this.mode) {
			if (this.syncing) return;
			if (this.base && !this.loading) {
				void this.switchMode(mode);
			} else {
				this.mode = mode;
				this.updateTabs();
				this.updateModeDesc();
			}
		}
		this.contentEl.focus?.();
	}

	private async switchMode(mode: SyncMode) {
		if (mode === this.mode || this.loading || this.syncing) return;
		this.mode = mode;
		this.plugin.rememberSyncMode(mode);
		this.updateTabs();
		this.updateModeDesc();
		this.expandedFolders.clear();
		if (!this.base) return;
		await this.renderMode(mode, true);
	}

	private async loadBase() {
		if (this.closed) return;
		if (this.separateModal) {
			this.separateModal.close();
			this.separateModal = null;
		}
		this.diffCache?.kill();
		this.diffCache = null;
		this.base = null;
		this.plan = null;
		this.entries = [];
		this.actions.clear();
		this.selectedProcess.clear();
		this.selectedRemove.clear();
		this.updateCompactClass();
		this.hideRightPane(true);
		this.showWarnings([]);
		this.cacheStatusEl.setText("");
		this.setLoading(true, "读取 GitHub 文件列表...", -1);
		this.setStatus("正在读取 GitHub 与本地文件...", "busy");

		try {
			const base = await this.plugin.prepareSyncBase(
				this.options.targetPath,
				(message, percent) => {
					if (!this.closed) this.setLoading(true, message, percent);
				}
			);
			if (this.closed) return;
			this.base = base;
			this.showWarnings(base.warnings);
			// 全量 diff 为空 = 确实没有可同步内容；顺便把状态栏结算成已同步
			if (
				!base.targetPath &&
				base.local.failedPaths.length === 0 &&
				this.isDiffEmpty(base.diff)
			) {
				try {
					void Promise.resolve(this.plugin.markAllSynced()).catch(() => {});
				} catch {
					// 结算状态失败不影响工作台继续显示
				}
			}
			this.diffCache = new DiffCache(
				this.plugin,
				base,
				(done, total) => this.updateCacheStatus(done, total)
			);
			await this.renderMode(this.mode, true);
			if (!this.closed && this.diffCache) {
				// 列表先显示；详细对比在后台低并发预取
				this.diffCache.preload(this.preloadPaths(base));
			}
		} catch (err) {
			if (this.closed) return;
			this.showWarnings([`读取同步数据失败：${getErrorMessage(err)}`]);
			this.setStatus(`❌ ${getErrorMessage(err)}`, "error");
			this.listEl.empty();
			this.listEl.createEl("p", {
				text: "无法读取同步数据；请检查 Token / 仓库 / 网络后点右上角刷新。",
				cls: "github-sync-warning",
			});
		} finally {
			this.setLoading(false);
			this.updateTabs();
			this.updateFooter();
		}
	}

	private async reloadBase() {
		if (this.loading || this.syncing) return;
		this.query = "";
		this.searchInput.value = "";
		await this.loadBase();
	}

	private isDiffEmpty(diff: SyncBase["diff"]): boolean {
		return (
			diff.toUpload.length === 0 &&
			diff.toDelete.length === 0 &&
			diff.toDownload.length === 0 &&
			diff.toRemove.length === 0
		);
	}

	private allDiffPaths(base: SyncBase): string[] {
		const set = new Set<string>();
		for (const list of [
			base.diff.toUpload,
			base.diff.toDelete,
			base.diff.toDownload,
			base.diff.toRemove,
		]) {
			for (const item of list) set.add(item.path);
		}
		return Array.from(set);
	}

	/**
	 * 真正值得预取的文件列表。
	 *
	 * "本地要推上去"的文件，同步时本来就要把本地内容传上去，
	 * 再提前把远端旧版本下一遍纯属浪费带宽（大文件尤其明显）——
	 * 这类文件只在用户点"对比"时才按需拉，小文件除外。
	 */
	private preloadPaths(base: SyncBase): string[] {
		const remoteSize = new Map(
			base.remote.files.map((f) => [f.path, f.size] as const)
		);
		return this.allDiffPaths(base).filter((path) => {
			const action = this.actions.get(path);
			if (action !== "upload") return true;
			const size = remoteSize.get(path) ?? 0;
			return size > 0 && size <= PRELOAD_SMALL_FILE_BYTES;
		});
	}

	private async renderMode(mode: SyncMode, reset: boolean) {
		if (!this.base) return;
		const seq = ++this.modeSeq;
		this.setLoading(true, `计算 ${MODE_META[mode].label} 同步列表...`, -1);
		try {
			const plan = await this.plugin.buildModePlan(this.base, mode);
			if (seq !== this.modeSeq || this.closed) return;
			this.plan = plan;
			this.setEntries(plan, reset);
			if (this.activePath) {
				const exists = this.entries.some((e) => e.path === this.activePath);
				if (!exists) {
					this.hideRightPane();
				} else if (this.rightVisible) {
					this.updateActiveRows();
					// 切换模式后动作徽章会变，轻量重绘右栏头（内容来自缓存）
					void this.showRightPane(this.activePath);
				}
			}
			this.setStatus(
				this.entries.length === 0
					? "当前模式没有需要同步的文件"
					: `已准备 ${this.entries.length} 个文件；每行可单独改 Push / Pull / Merge`,
				"idle"
			);
		} catch (err) {
			if (seq === this.modeSeq && !this.closed) {
				this.showWarnings([`生成同步列表失败：${getErrorMessage(err)}`]);
				this.setStatus(`❌ ${getErrorMessage(err)}`, "error");
			}
		} finally {
			if (seq === this.modeSeq) {
				this.setLoading(false);
				this.updateTabs();
				this.updateFooter();
			}
		}
	}

	private updateCacheStatus(done: number, total: number) {
		if (this.closed || !this.cacheStatusEl) return;
		if (total <= 0) {
			this.cacheStatusEl.setText("");
			return;
		}
		this.cacheStatusEl.setText(
			done >= total ? "对比缓存已就绪" : `对比缓存 ${done}/${total}`
		);
	}

	private setLoading(visible: boolean, message?: string, percent?: number) {
		this.loading = visible;
		if (message && this.loadingText) this.loadingText.setText(message);
		if (!this.loadingEl) return;
		if (visible) {
			this.loadingEl.addClass("is-visible");
			if (percent !== undefined && percent >= 0) {
				this.loadingEl.removeClass("is-indeterminate");
				this.loadingBarFill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
			} else {
				this.loadingEl.addClass("is-indeterminate");
				this.loadingBarFill.style.width = "35%";
			}
		} else {
			this.loadingEl.removeClass("is-visible", "is-indeterminate");
		}
		if (this.tabButtons.size > 0) this.updateTabs();
		if (this.syncBtn) this.updateFooter();
	}

	private setStatus(text: string, tone: "idle" | "busy" | "ok" | "error") {
		if (!this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.className = `egs-status egs-status-${tone}`;
	}

	private showWarnings(warnings: string[]) {
		if (!this.warningsEl) return;
		this.warningsEl.empty();
		this.warningsEl.style.display = warnings.length > 0 ? "flex" : "none";
		for (const warning of warnings) {
			this.warningsEl.createDiv({ text: warning, cls: "egs-warning" });
		}
	}

	// ──────────────────────────────────────────────
	// 列表与动作
	// ──────────────────────────────────────────────

	private setEntries(plan: ModePlan, reset: boolean) {
		const entries: WorkspaceEntry[] = [
			...plan.toProcess.map((f) => ({ path: f.path, isRemove: false, diff: f })),
			...plan.toRemove.map((f) => ({ path: f.path, isRemove: true, diff: f })),
		].sort((a, b) => a.path.localeCompare(b.path));
		this.entries = entries;

		if (reset) {
			this.selectedProcess.clear();
			this.selectedRemove.clear();
			this.actions.clear();
			this.expandedFolders.clear();
		}

		for (const entry of entries) {
			const available = this.availableActions(entry);
			const preferred = entry.diff.direction;
			const action =
				preferred && available.includes(preferred)
					? preferred
					: available[0] ?? "upload";
			this.actions.set(entry.path, action);
			if (reset) {
				const defaultSelected =
					!entry.diff.remoteMtimeEstimated ||
					entry.diff.direction === "merge";
				this.setSelected(entry, defaultSelected);
			}
		}

		this.expandAllMode = entries.length <= 250;
		this.expandAllBtn.setText(this.expandAllMode ? "折叠全部" : "展开全部");
		this.updateCompactClass();
		this.renderList();
		this.renderSummary();
		this.updateFooter();
		if (this.activePath && !entries.some((e) => e.path === this.activePath)) {
			this.hideRightPane();
		}
	}

	private renderList() {
		if (!this.listEl) return;
		this.listEl.empty();
		this.fileRows.clear();
		this.folderRows.clear();
		this.folderMap.clear();

		if (!this.plan) return;
		const filtered = this.query
			? this.entries.filter((e) => e.path.toLowerCase().includes(this.query))
			: this.entries;

		if (filtered.length === 0) {
			const empty = this.listEl.createDiv("egs-empty-state");
			const icon = empty.createDiv("egs-empty-icon");
			setIcon(icon, this.query ? "search-x" : "check-circle");
			empty.createEl("p", {
				text: this.query
					? "没有匹配的文件"
					: "当前模式没有需要同步的文件",
				cls: "egs-empty-title",
			});
			if (!this.query) {
				empty.createEl("p", {
					text: "可以切换其它选项卡，或点右上角刷新重新对比。",
					cls: "egs-empty-desc",
				});
			}
			this.syncUI();
			return;
		}

		const root = this.buildTree(filtered);
		for (const child of root.children) {
			this.renderNode(child, this.listEl, 0, "");
		}
		this.syncUI();
	}

	private buildTree(entries: WorkspaceEntry[]): FolderNode {
		this.folderMap.clear();
		const root: FolderNode = {
			type: "folder",
			path: "",
			name: "",
			depth: -1,
			children: [],
			files: [],
		};
		for (const entry of entries) {
			const parts = entry.path.split("/");
			let parent = root;
			let prefix = "";
			for (let i = 0; i < parts.length - 1; i++) {
				prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
				let folder = this.folderMap.get(prefix);
				if (!folder) {
					folder = {
						type: "folder",
						path: prefix,
						name: parts[i],
						depth: i,
						children: [],
						files: [],
					};
					this.folderMap.set(prefix, folder);
					parent.children.push(folder);
				}
				parent = folder;
			}
			parent.children.push({
				type: "file",
				depth: parts.length - 1,
				entry,
			});
		}

		const sortNode = (node: FolderNode) => {
			node.children.sort((a, b) => {
				if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
				return this.nodeName(a).localeCompare(this.nodeName(b));
			});
			for (const child of node.children) {
				if (child.type === "folder") sortNode(child);
			}
			node.files = [];
			for (const child of node.children) {
				if (child.type === "file") node.files.push(child.entry);
				else node.files.push(...child.files);
			}
		};
		sortNode(root);

		// 路径压缩：D -> E -> F 合并为一行；只含一个文件的文件夹提升为文件行
		const compact = (node: FolderNode): TreeNode => {
			node.children = node.children.map((child) =>
				child.type === "folder" ? compact(child) : child
			);
			while (
				node.children.length === 1 &&
				node.children[0].type === "folder"
			) {
				const child = node.children[0];
				node.path = child.path;
				node.name = `${node.name}/${child.name}`;
				node.children = child.children;
				node.files = child.files;
			}
			if (node.children.length === 1 && node.children[0].type === "file") {
				const file = node.children[0];
				file.promoted = true;
				return file;
			}
			return node;
		};
		root.children = root.children.map((child) =>
			child.type === "folder" ? compact(child) : child
		);
		sortNode(root);

		this.folderMap.clear();
		const registerFolders = (node: FolderNode) => {
			for (const child of node.children) {
				if (child.type === "folder") {
					this.folderMap.set(child.path, child);
					registerFolders(child);
				}
			}
		};
		registerFolders(root);
		return root;
	}

	private nodeName(node: TreeNode): string {
		if (node.type === "file") {
			const parts = node.entry.path.split("/");
			return parts[parts.length - 1];
		}
		return node.name;
	}

	private renderNode(
		node: TreeNode,
		parentEl: HTMLElement,
		depth: number,
		parentPath: string
	) {
		if (node.type === "file") {
			this.renderFileRow(node, parentEl, depth, parentPath);
			return;
		}
		const isExpanded =
			this.query.length > 0 ||
			this.expandAllMode ||
			this.expandedFolders.has(node.path);

		const row = parentEl.createDiv(
			"github-sync-file-row github-sync-tree-row github-sync-tree-folder egs-folder-row"
		);
		row.style.paddingLeft = `${6 + depth * 16}px`;

		const caret = row.createEl("span", {
			cls: "github-sync-tree-caret",
			text: isExpanded ? "▾" : "▸",
			attr: { role: "button", tabindex: "0", "aria-label": "展开/折叠" },
		});
		const checkbox = row.createEl("input", { type: "checkbox" });
		row.createEl("span", { text: "📁", cls: "file-icon" });
		row.createEl("span", {
			text: node.name,
			cls: "file-path github-sync-folder-name",
		});
		const countEl = row.createEl("span", {
			text: "",
			cls: "github-sync-folder-count",
		});

		const toggle = () => {
			if (this.query) return;
			if (this.expandAllMode) {
				this.expandAllMode = false;
				this.expandedFolders = new Set(
					Array.from(this.folderMap.keys()).filter((p) => p !== node.path)
				);
				this.expandAllBtn.setText("展开全部");
			} else if (this.expandedFolders.has(node.path)) {
				this.expandedFolders.delete(node.path);
			} else {
				this.expandedFolders.add(node.path);
			}
			this.renderList();
		};

		caret.addEventListener("click", (e) => {
			e.stopPropagation();
			toggle();
		});
		caret.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
		row.addEventListener("click", (e) => {
			if (e.target === checkbox || e.target === caret) return;
			toggle();
		});
		checkbox.addEventListener("change", () => {
			const state = this.folderSelectionState(node);
			this.setFolderSelected(node, state.selected < state.total);
			this.syncUI();
		});

		this.folderRows.set(node.path, { checkbox, countEl, node });
		if (isExpanded) {
			for (const child of node.children) {
				this.renderNode(child, parentEl, depth + 1, node.path);
			}
		}
	}

	private renderFileRow(
		node: FileNode,
		parentEl: HTMLElement,
		depth: number,
		parentPath: string
	) {
		const { entry } = node;
		const row = parentEl.createDiv("github-sync-file-row egs-file-row");
		row.dataset.path = entry.path;
		row.style.paddingLeft = `${6 + depth * 16}px`;
		if (this.activePath === entry.path) row.addClass("egs-row-active");

		const checkbox = row.createEl("input", { type: "checkbox" });
		checkbox.dataset.path = entry.path;
		checkbox.dataset.isRemove = String(entry.isRemove);
		checkbox.checked = this.isSelected(entry);
		checkbox.addEventListener("change", () => {
			this.setSelected(entry, checkbox.checked);
			this.syncUI();
			this.renderSummary();
		});

		const iconEl = row.createEl("span", { cls: "file-icon" });
		const fullPath = entry.path;
		const relativePath =
			parentPath && fullPath.startsWith(parentPath + "/")
				? fullPath.slice(parentPath.length + 1)
				: fullPath;
		const label = node.promoted
			? relativePath
			: fullPath.split("/").pop() ?? fullPath;
		const pathEl = row.createEl("span", {
			text: label,
			cls: "file-path",
			attr: { title: fullPath },
		});

		const metaEl = row.createDiv("github-sync-row-meta");
		const f = entry.diff;
		if (
			(this.mode === "time" || this.mode === "merge") &&
			(f.localMtime || f.remoteMtime)
		) {
			const parts: string[] = [];
			if (f.localMtime) parts.push(`本地 ${fmtTime(f.localMtime)}`);
			if (f.remoteMtime) {
				parts.push(
					`远端${f.remoteMtimeEstimated ? "≈" : ""} ${fmtTime(f.remoteMtime)}`
				);
			}
			metaEl.createEl("span", { text: parts.join(" · "), cls: "file-times" });
		}
		if (
			f.remoteMtimeEstimated &&
			this.actions.get(entry.path) !== "merge"
		) {
			metaEl.createEl("span", {
				text: "⚠️",
				cls: "github-sync-uncertain-mark",
				attr: {
					title:
						"远端精确修改时间获取失败，使用 HEAD 时间估算；默认未勾选",
				},
			});
		}
		if (metaEl.childElementCount === 0) metaEl.remove();

		const actionsEl = row.createDiv("github-sync-row-actions");
		const available = this.availableActions(entry);
		const current = this.actions.get(entry.path) ?? available[0] ?? "upload";
		if (available.length > 1) {
			const select = actionsEl.createEl("select", {
				cls: "github-sync-action-select",
				attr: {
					title: "选择该文件的同步方式（Push / Pull / Merge）",
					"aria-label": "同步方式",
				},
			});
			for (const action of available) {
				const option = select.createEl("option", {
					text: this.actionLabel(action),
					value: action,
				});
				if (action === current) option.selected = true;
			}
			select.addEventListener("change", () => {
				this.setAction(entry, select.value as SyncDirection);
			});
		} else {
			actionsEl.createEl("span", {
				text: this.actionLabel(current),
				cls: `github-sync-action-badge action-${current}`,
				attr: { title: "该文件只有这一种可选动作" },
			});
		}

		const compareBtn = actionsEl.createEl("button", {
			text: "对比",
			cls: "egs-compare-btn",
			attr: { title: "对比本地与 GitHub 内容", "aria-label": "对比" },
		});
		compareBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.comparePath(entry.path);
		});

		row.addEventListener("click", (e) => {
			if (
				e.target !== checkbox &&
				!(e.target as HTMLElement).closest?.(
					".github-sync-compare-btn, .egs-compare-btn, .github-sync-icon-btn, .github-sync-action-select"
				)
			) {
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event("change"));
			}
		});

		const record = { checkbox, entry, iconEl, pathEl, rowEl: row };
		this.fileRows.set(entry.path, record);
		this.applyRowVisual(record);
	}

	private applyRowVisual(row: {
		iconEl: HTMLElement;
		pathEl: HTMLElement;
		entry: WorkspaceEntry;
	}) {
		const action = this.actions.get(row.entry.path) ?? "upload";
		const [icon, cls] = this.actionIcon(action);
		row.iconEl.setText(icon);
		row.pathEl.className = `file-path ${cls}`;
	}

	private actionIcon(action: SyncDirection): [string, string] {
		switch (action) {
			case "upload":
				return ["⬆️", "file-upload"];
			case "download":
				return ["⬇️", "file-download"];
			case "merge":
				return ["🔀", "file-modified"];
			case "delete":
			case "delete-local":
				return ["🗑️", "file-deleted"];
		}
	}

	private actionLabel(action: SyncDirection): string {
		switch (action) {
			case "upload":
				return "Push";
			case "download":
				return "Pull";
			case "merge":
				return "Merge";
			case "delete":
				return "删远端";
			case "delete-local":
				return "删本地";
		}
	}

	private availableActions(entry: WorkspaceEntry): SyncDirection[] {
		const f = entry.diff;
		const isModified = f.changeType === "modified";
		const remoteExists =
			isModified ||
			(f.changeType === "added" && !!f.remoteSha) ||
			(f.changeType === "deleted" && !!f.remoteSha);
		const localExists =
			isModified ||
			(f.changeType === "added" && !f.remoteSha) ||
			(f.changeType === "deleted" && !f.remoteSha);

		if (localExists && remoteExists) {
			const actions: SyncDirection[] = ["upload", "download"];
			if (isTextFile(f.path)) actions.push("merge");
			return actions;
		}
		if (localExists) return ["upload", "delete-local"];
		if (remoteExists) return ["download", "delete"];
		return ["upload"];
	}

	private setAction(entry: WorkspaceEntry, action: SyncDirection) {
		const available = this.availableActions(entry);
		if (!available.includes(action)) return;
		this.actions.set(entry.path, action);
		if (!this.isSelected(entry)) this.setSelected(entry, true);
		this.syncUI();
		this.renderSummary();
	}

	private isSelected(entry: WorkspaceEntry): boolean {
		return entry.isRemove
			? this.selectedRemove.has(entry.path)
			: this.selectedProcess.has(entry.path);
	}

	private setSelected(entry: WorkspaceEntry, selected: boolean) {
		if (entry.isRemove) {
			if (selected) this.selectedRemove.add(entry.path);
			else this.selectedRemove.delete(entry.path);
		} else if (selected) {
			this.selectedProcess.add(entry.path);
		} else {
			this.selectedProcess.delete(entry.path);
		}
	}

	private folderSelectionState(node: FolderNode): {
		selected: number;
		total: number;
	} {
		let selected = 0;
		for (const entry of node.files) if (this.isSelected(entry)) selected++;
		return { selected, total: node.files.length };
	}

	private setFolderSelected(node: FolderNode, selected: boolean) {
		for (const entry of node.files) this.setSelected(entry, selected);
	}

	private areAllSelected(): boolean {
		return this.entries.every((e) => this.isSelected(e));
	}

	private syncUI() {
		for (const row of this.fileRows.values()) {
			row.checkbox.checked = this.isSelected(row.entry);
			this.applyRowVisual(row);
		}
		for (const [, row] of this.folderRows) {
			const { selected, total } = this.folderSelectionState(row.node);
			row.checkbox.checked = total > 0 && selected === total;
			row.checkbox.indeterminate = selected > 0 && selected < total;
			row.countEl.setText(`${selected}/${total}`);
		}
		this.updateFooter();
	}

	private renderSummary() {
		if (!this.summaryEl) return;
		this.summaryEl.empty();
		if (!this.plan) return;
		const counts: Record<SyncDirection, number> = {
			upload: 0,
			download: 0,
			merge: 0,
			delete: 0,
			"delete-local": 0,
		};
		for (const entry of this.entries) {
			const action = this.actions.get(entry.path);
			if (action) counts[action]++;
		}
		const badge = (n: number, text: string, cls: string) => {
			if (n > 0) {
				this.summaryEl.createEl("span", {
					text,
					cls: `github-sync-badge ${cls}`,
				});
			}
		};
		badge(counts.upload, `⬆️ ${counts.upload} 个 Push`, "badge-upload");
		badge(counts.download, `⬇️ ${counts.download} 个 Pull`, "badge-download");
		badge(counts.merge, `🔀 ${counts.merge} 个 Merge`, "badge-modified");
		badge(counts.delete, `🗑️ ${counts.delete} 个删除远端`, "badge-deleted");
		badge(
			counts["delete-local"],
			`🗑️ ${counts["delete-local"]} 个删除本地`,
			"badge-deleted"
		);
		if (this.plan.unchanged > 0) {
			badge(
				this.plan.unchanged,
				`＝ ${this.plan.unchanged} 个未变化`,
				"badge-unchanged"
			);
		}
	}

	private selectedItems(): { process: FileDiff[]; remove: FileDiff[] } {
		if (!this.plan) return { process: [], remove: [] };
		const withAction = (f: FileDiff): FileDiff => ({
			...f,
			direction: this.actions.get(f.path) ?? f.direction,
		});
		return {
			process: this.plan.toProcess
				.filter((f) => this.selectedProcess.has(f.path))
				.map(withAction),
			remove: this.plan.toRemove
				.filter((f) => this.selectedRemove.has(f.path))
				.map(withAction),
		};
	}

	/** 文件数较少时进一步收窄左栏窗口，避免小列表占用过宽空间 */
	private updateCompactClass() {
		if (!this.modalEl) return;
		this.modalEl.toggleClass(
			"egs-small-list",
			this.entries.length > 0 && this.entries.length < 20
		);
	}

	private updateFooter() {
		if (!this.countEl || !this.syncBtn) return;
		const selectedCount = this.entries.filter((e) => this.isSelected(e)).length;
		this.countEl.setText(`已选 ${selectedCount} / ${this.entries.length}`);
		this.selectAllBtn.setText(
			this.entries.length > 0 && selectedCount === this.entries.length
				? "取消全选"
				: "全选"
		);
		const disabled = this.loading || this.syncing || !this.base;
		this.syncBtn.disabled = disabled || selectedCount === 0;
		this.syncBtn.setText(
			this.syncing
				? "同步中..."
				: selectedCount > 0
					? `开始同步（${selectedCount}）`
					: "开始同步"
		);
		this.separateBtn.disabled =
			!this.activePath || !this.diffCache || this.loading || this.syncing;
		this.refreshBtn.disabled = this.loading || this.syncing;
		this.rollbackBtn.disabled = this.syncing;
		if (this.tabButtons.size > 0) this.updateTabs();
	}

	private updateActiveRows() {
		for (const row of this.fileRows.values()) {
			row.rowEl.toggleClass("egs-row-active", row.entry.path === this.activePath);
		}
	}

	// ──────────────────────────────────────────────
	// 对比
	// ──────────────────────────────────────────────

	private inlineDiffEnabled(): boolean {
		// 小 Pad / 手机放不下左右分栏时，对比仍走独立弹窗
		return window.innerWidth >= 1000;
	}

	private comparePath(path: string) {
		this.activePath = path;
		this.updateActiveRows();
		this.updateFooter();
		if (this.inlineDiffEnabled()) {
			void this.showRightPane(path);
		} else {
			this.openSeparateDiff(path);
		}
	}

	private async showRightPane(path: string) {
		if (!this.diffCache) return;
		this.rightVisible = true;
		this.contentWrap.addClass("has-right");
		this.modalEl.addClass("has-right");
		this.rightEl.addClass("is-visible");
		this.rightHeaderEl.empty();
		// 先给出路径 + 关闭按钮，避免加载失败时右栏无法关闭
		const top = this.rightHeaderEl.createDiv("egs-right-title-row");
		top.createEl("div", {
			text: path,
			cls: "egs-right-path",
			attr: { title: path },
		});
		const topActions = top.createDiv("egs-right-actions");
		const closeTop = topActions.createEl("button", {
			cls: "egs-icon-btn",
			attr: { title: "关闭对比栏", "aria-label": "关闭对比栏" },
		});
		setIcon(closeTop, "x");
		if (closeTop.childElementCount === 0) closeTop.setText("×");
		closeTop.addEventListener("click", () => this.hideRightPane());
		this.destroyMergeViews();
		this.rightBodyEl.empty();
		const loading = this.rightBodyEl.createDiv("egs-loading is-inline");
		loading.createDiv("egs-spinner");
		loading.createDiv({ text: "读取对比内容...", cls: "egs-loading-text" });

		const data = await this.diffCache.get(path).catch(() => null);
		if (this.closed || this.activePath !== path) return;
		if (!data) {
			this.rightBodyEl.empty();
			this.rightBodyEl.createEl("p", {
				text: "对比缓存已失效，请重新打开工作台。",
				cls: "github-sync-warning",
			});
			return;
		}
		this.destroyMergeViews();
		this.rightBodyEl.empty();
		this.renderRightHeader(data);
		renderDiffContent(
			this.rightBodyEl,
			data,
			this.mergeViews,
			(p) => this.plugin.onCompareIdentical([p])
		);
		this.updateFooter();

		// 提交信息按需取：先让对比内容出来，标题栏信息随后补上
		void this.diffCache.fetchMeta(path).then((meta) => {
			if (this.closed || this.activePath !== path) return;
			if (!meta.commitMessage && !meta.commitDate) return;
			this.renderRightHeader({ ...data, ...meta });
		});
	}

	private renderRightHeader(data: DiffData) {
		this.rightHeaderEl.empty();
		const top = this.rightHeaderEl.createDiv("egs-right-title-row");
		top.createEl("div", {
			text: data.path,
			cls: "egs-right-path",
			attr: { title: data.path },
		});
		const actions = top.createDiv("egs-right-actions");
		const separate = actions.createEl("button", {
			cls: "egs-icon-btn",
			attr: { title: "在独立窗口打开", "aria-label": "独立窗口" },
		});
		setIcon(separate, "external-link");
		if (separate.childElementCount === 0) separate.setText("↗");
		separate.addEventListener("click", () => this.openSeparateDiff(data.path));
		const close = actions.createEl("button", {
			cls: "egs-icon-btn",
			attr: { title: "关闭对比栏", "aria-label": "关闭对比栏" },
		});
		setIcon(close, "x");
		if (close.childElementCount === 0) close.setText("×");
		close.addEventListener("click", () => this.hideRightPane());

		const meta = this.rightHeaderEl.createDiv("egs-right-meta");
		const entry = this.entries.find((e) => e.path === data.path);
		const action = this.actions.get(data.path);
		if (entry && action) {
			const [icon] = this.actionIcon(action);
			meta.createEl("span", {
				text: `${icon} ${this.actionLabel(action)}`,
				cls: `github-sync-action-badge action-${action}`,
			});
		}
		if (data.remoteFile) {
			meta.createEl("span", {
				text: `${formatSize(data.remoteSize)}`,
				cls: "egs-right-meta-item",
			});
		}
		if (data.commitDate) {
			meta.createEl("span", {
				text: new Date(data.commitDate).toLocaleString(),
				cls: "egs-right-meta-item",
			});
		}
		if (data.commitMessage) {
			meta.createEl("span", {
				text: data.commitMessage.slice(0, 120),
				cls: "egs-right-commit",
				attr: { title: data.commitMessage },
			});
		}
	}

	private hideRightPane(clearActive = true) {
		this.rightVisible = false;
		this.contentWrap.removeClass("has-right");
		this.modalEl.removeClass("has-right");
		this.rightEl?.removeClass("is-visible");
		this.destroyMergeViews();
		this.rightHeaderEl?.empty();
		this.rightBodyEl?.empty();
		if (clearActive) this.activePath = null;
		this.updateActiveRows();
		this.updateFooter();
	}

	private destroyMergeViews() {
		for (const entry of this.mergeViews) {
			entry.mv.a.destroy();
			entry.mv.b.destroy();
		}
		this.mergeViews = [];
	}

	private openSeparateDiff(path: string) {
		if (!this.diffCache) return;
		if (this.separateModal) {
			this.separateModal.close();
			this.separateModal = null;
		}
		const modal = new DiffPaneModal(
			this.app,
			this.plugin,
			this.diffCache,
			path,
			(p) => this.plugin.onCompareIdentical([p])
		);
		modal.onClosed = () => {
			if (this.separateModal === modal) this.separateModal = null;
		};
		this.separateModal = modal;
		modal.open();
	}

	// ──────────────────────────────────────────────
	// 执行
	// ──────────────────────────────────────────────

	private async syncNow() {
		if (this.loading || this.syncing || !this.base || !this.plan) return;
		const { process, remove } = this.selectedItems();
		if (process.length === 0 && remove.length === 0) {
			new Notice("⚠️ 未选择任何文件");
			return;
		}

		// 交给后台执行：窗口立刻关闭，同步继续跑，进度显示在状态栏。
		this.syncing = true;
		this.completed = false;
		this.contentWrap.addClass("is-syncing");
		this.setStatus("开始同步...", "busy");
		this.updateFooter();
		this.updateTabs();

		try {
			this.plugin.startBackgroundSync(this.base, process, remove, this.mode);
		} catch (err) {
			this.syncing = false;
			this.completed = false;
			this.contentWrap.removeClass("is-syncing");
			this.setStatus(`❌ ${getErrorMessage(err)}`, "error");
			this.updateFooter();
			this.updateTabs();
			return;
		}

		// 同步在后台继续，这里直接关窗，不阻塞用户。
		this.close();
	}

	// ──────────────────────────────────────────────
	// 生命周期
	// ──────────────────────────────────────────────

	onClose() {
		this.closed = true;
		if (this.separateModal) {
			this.separateModal.close();
			this.separateModal = null;
		}
		this.diffCache?.kill();
		this.diffCache = null;
		this.destroyMergeViews();
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
			this.resizeHandler = null;
		}
		// 释放工作台持有的快照/对比缓存
		this.base = null;
		this.plan = null;
		this.entries = [];
		this.actions.clear();
		this.selectedProcess.clear();
		this.selectedRemove.clear();
		this.fileRows.clear();
		this.folderRows.clear();
		this.folderMap.clear();
		this.contentEl.empty();
		this.onClosed?.();
	}
}
