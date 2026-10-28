// modals.ts — 同步确认对话框

import { App, Modal, Notice, Setting, TFile, normalizePath, setIcon } from "obsidian";
import { FileDiff, isTextFile, computeGitBlobSha, SyncDirection } from "./diff";
import type { RollbackSnapshot } from "./types";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { GitHubClient, GitHubFile } from "./github";
import { arrayBuffersEqual, pMap } from "./utils";
import { SAVINGS_DIR } from "./rollback";
import type GitHubSyncPlugin from "./main";

export type SyncMode = "push" | "pull" | "time" | "merge";

/** 两端只有尾部空行差异 → 视为相同 */
function onlyTrailingBlankLinesDiffer(a: string, b: string): boolean {
	if (a === b) return false;
	const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const strip = (s: string) => norm(s).replace(/\n+$/, "");
	return strip(a) === strip(b);
}

/** 时间戳 → "MM-DD HH:mm" 本地时区短格式（供时间判定依据显示） */
function fmtTime(t: number): string {
	const d = new Date(t);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** .obsidian 子项选择器中的敏感条目提示 */
const OBSIDIAN_ENTRY_HINTS: Record<string, string> = {
	"plugins": "可展开按插件细分勾选；各插件的 data.json 可能含敏感配置",
	"workspace.json": "窗口布局缓存，通常无需同步",
	"workspace-mobile.json": "移动端布局缓存，通常无需同步",
	"plugins/easy-gitless-sync": "本插件目录：main.js/manifest.json 可同步；data.json、缓存、savings 始终排除",
	"plugins/easy-gitless-sync/data.json": "含 GitHub Token，始终不同步",
	"plugins/easy-gitless-sync/savings": "同步快照，始终不同步（避免递归）",
	"plugins/easy-gitless-sync/hash-cache.json": "本地缓存，始终不同步",
	"plugins/easy-gitless-sync/remote-mtime-cache.json": "本地缓存，始终不同步",
};

/** 树状选择器的节点描述(rel 相对 .obsidian 根,如 "plugins/dataview") */
interface PickerNode {
	rel: string;
	name: string;
	isFolder: boolean;
	depth: number;
}

export class SyncModeModal extends Modal {
	private onChoose: (mode: SyncMode) => void;
	private onRollback?: () => void;
	private getCacheInfo?: () => string;

	constructor(
		app: App,
		onChoose: (mode: SyncMode) => void,
		onRollback?: () => void,
		getCacheInfo?: () => string
	) {
		super(app);
		this.onChoose = onChoose;
		this.onRollback = onRollback;
		this.getCacheInfo = getCacheInfo;
	}

	onOpen() {
		this.modalEl.addClass("github-sync-mode-host");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-mode-modal");

		contentEl.createEl("h2", { text: "GitHub 同步" });
		contentEl.createEl("p", {
			text: "选择同步模式",
			cls: "github-sync-subtitle",
		});

		const cacheInfo = this.getCacheInfo?.();
		if (cacheInfo) {
			contentEl.createEl("p", {
				text: cacheInfo,
				cls: "github-sync-cache-info",
			});
		}

		const btnContainer = contentEl.createDiv("github-sync-mode-buttons");

		const pushBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn mode-push" });
		pushBtn.createEl("div", { text: "⬆️", cls: "github-sync-mode-icon" });
		pushBtn.createEl("div", { text: "Push", cls: "github-sync-mode-label" });
		pushBtn.createEl("div", { text: "将本地更改上传到 GitHub", cls: "github-sync-mode-desc" });
		pushBtn.addEventListener("click", () => { this.close(); this.onChoose("push"); });

		const pullBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn mode-pull" });
		pullBtn.createEl("div", { text: "⬇️", cls: "github-sync-mode-icon" });
		pullBtn.createEl("div", { text: "Pull", cls: "github-sync-mode-label" });
		pullBtn.createEl("div", { text: "从 GitHub 下载最新内容到本地", cls: "github-sync-mode-desc" });
		pullBtn.addEventListener("click", () => { this.close(); this.onChoose("pull"); });

		const timeBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn mode-time" });
		timeBtn.createEl("div", { text: "⏱️", cls: "github-sync-mode-icon" });
		timeBtn.createEl("div", { text: "Push/Pull by Time", cls: "github-sync-mode-label" });
		timeBtn.createEl("div", { text: "按修改时间决定方向，单边文件默认补齐", cls: "github-sync-mode-desc" });
		timeBtn.addEventListener("click", () => { this.close(); this.onChoose("time"); });

		const mergeBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn mode-merge" });
		mergeBtn.createEl("div", { text: "🔀", cls: "github-sync-mode-icon" });
		mergeBtn.createEl("div", { text: "Smart Merge (beta)", cls: "github-sync-mode-label" });
		mergeBtn.createEl("div", { text: "自动合并冲突，保留双方修改", cls: "github-sync-mode-desc" });
		mergeBtn.addEventListener("click", () => { this.close(); this.onChoose("merge"); });

		// 回滚按钮
		const rollbackBtn = contentEl.createEl("button", {
			cls: "github-sync-rollback-btn",
			text: "↩️ 回滚到上个版本",
		});
		rollbackBtn.addEventListener("click", () => {
			this.close();
			this.onRollback?.();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ──────────────────────────────────────────────
// 回滚对话框
// ──────────────────────────────────────────────

export class RollbackModal extends Modal {
	private snapshots: RollbackSnapshot[];
	private onRollback: (id: string) => Promise<void>;

	constructor(
		app: App,
		snapshots: RollbackSnapshot[],
		onRollback: (id: string) => Promise<void>
	) {
		super(app);
		this.snapshots = snapshots;
		this.onRollback = onRollback;
	}

	onOpen() {
		this.modalEl.addClass("github-sync-rollback-host");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-rollback-modal");
		contentEl.createEl("h2", { text: "↩️ 回滚到上个版本" });

		if (this.snapshots.length === 0) {
			contentEl.createEl("p", {
				text: "暂无历史版本",
				cls: "github-sync-no-changes",
			});
			new Setting(contentEl)
				.addButton((btn) =>
					btn.setButtonText("关闭").onClick(() => this.close())
				);
			return;
		}

		contentEl.createEl("p", {
			text: `共 ${this.snapshots.length} 个历史版本（每次同步自动生成）`,
			cls: "github-sync-subtitle",
		});

		const listContainer = contentEl.createDiv("github-sync-file-list");
		const allBtns: HTMLButtonElement[] = [];

		for (const snap of this.snapshots) {
			const row = listContainer.createDiv({
				cls: "github-sync-file-row github-sync-snapshot-row",
			});

			const dateStr = new Date(snap.date).toLocaleString();
			row.createEl("span", {
				text: "📸",
				cls: "file-icon",
			});
			const titleEl = row.createEl("span", {
				cls: "file-path github-sync-snapshot-title",
			});
			titleEl.createEl("span", { text: dateStr, cls: "github-sync-snapshot-date" });
			titleEl.createEl("span", {
				text: `${snap.files.length} 个文件`,
				cls: "github-sync-snapshot-count",
			});

			const actionsEl = row.createDiv("github-sync-row-actions");
			const compareBtn = actionsEl.createEl("button", {
				cls: "github-sync-icon-btn",
				attr: { title: "对比此快照", "aria-label": "对比" },
			});
			setIcon(compareBtn, "diff");
			if (compareBtn.childElementCount === 0) compareBtn.setText("⇄");
			compareBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				new RollbackDiffModal(this.app, snap).open();
			});

			const btn = actionsEl.createEl("button", {
				text: "回滚",
				cls: "github-sync-restore-btn",
			});
			allBtns.push(btn);
			// 两段式确认:第一次点击进入待确认态,4 秒内再次点击才真正回滚
			let armed = false;
			let disarmTimer: number | null = null;
			const disarm = () => {
				armed = false;
				if (disarmTimer) { window.clearTimeout(disarmTimer); disarmTimer = null; }
				btn.textContent = "回滚";
				btn.removeClass("github-sync-armed");
				allBtns.forEach(b => { b.disabled = false; });
			};
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				if (!armed) {
					armed = true;
					btn.textContent = "确认回滚？";
					btn.addClass("github-sync-armed");
					allBtns.forEach(b => { if (b !== btn) b.disabled = true; });
					disarmTimer = window.setTimeout(disarm, 4000);
					return;
				}
				if (disarmTimer) { window.clearTimeout(disarmTimer); disarmTimer = null; }
				allBtns.forEach(b => { b.disabled = true; b.textContent = "回滚中..."; });
				try {
					await this.onRollback(snap.id);
					this.close();
				} catch (err) {
					allBtns.forEach(b => { b.disabled = false; b.textContent = "回滚到此版本"; });
					btn.textContent = "回滚失败";
					btn.removeClass("github-sync-armed");
				}
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
	}


// ──────────────────────────────────────────────
// 回滚对比弹窗
// ──────────────────────────────────────────────

export class RollbackDiffModal extends Modal {
	private snapshot: RollbackSnapshot;
	private mergeViews: { mv: MergeView; path: string }[];
	private closed = false;

	constructor(app: App, snapshot: RollbackSnapshot) {
		super(app);
		this.snapshot = snapshot;
		this.mergeViews = [];
	}

	async onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("github-sync-diff-modal");
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		const dateStr = new Date(this.snapshot.date).toLocaleString();
		contentEl.createEl("h2", { text: `对比快照 (${dateStr})` });

		const statusEl = contentEl.createDiv({ cls: "github-sync-progress-modal" });
		statusEl.createEl("p", { text: "正在读取文件...", cls: "github-sync-progress-msg" });

		try {
			// 读取快照文件
			const snapshotFiles = new Map<string, ArrayBuffer>();
			const savingsDir = normalizePath(`${SAVINGS_DIR}/${this.snapshot.id}`);

			await pMap(
				this.snapshot.files,
				async (filePath) => {
					try {
						const srcPath = normalizePath(`${savingsDir}/${filePath}`);
						if (await this.app.vault.adapter.exists(srcPath)) {
							const content = await this.app.vault.adapter.readBinary(srcPath);
							snapshotFiles.set(filePath, content);
						}
					} catch {}
				},
				4
			);

			if (this.closed) return;
			statusEl.empty();

			if (snapshotFiles.size === 0) {
				statusEl.createEl("p", {
					text: "⚠️ 无法读取快照文件",
					cls: "github-sync-warning",
				});
			} else {
				const scrollArea = contentEl.createDiv({ cls: "diff-scroll-area" });
				const sortedFiles = [...this.snapshot.files].sort((a, b) =>
					a.localeCompare(b)
				);

				for (const path of sortedFiles) {
					const snapContent = snapshotFiles.get(path);
					if (!snapContent) continue;

					const localContent = await this.readLocalBinary(path);
					if (this.closed) return;
					const section = scrollArea.createDiv({ cls: "diff-file-section" });

					if (!localContent) {
						const summary = section.createEl("details", { attr: { open: "" } });
						summary.createEl("summary", { text: `➕ ${path}` });
						const body = summary.createDiv({ cls: "diff-file-body" });
						body.createEl("p", {
							text: "本地文件已删除，快照中存在此文件",
							cls: "github-sync-warning",
						});
					} else if (isTextFile(path)) {
						await this.renderTextDiff(section, path, localContent, snapContent);
					} else {
						await this.renderBinaryDiff(section, path, localContent, snapContent);
					}
				}
			}
		} catch (err) {
			statusEl.empty();
			statusEl.createEl("p", {
				text: `❌ 对比失败: ${err instanceof Error ? err.message : String(err)}`,
				cls: "github-sync-warning",
			});
		}

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("关闭").onClick(() => this.close()));
	}

	/** 读取本地文件；.obsidian 目录走 adapter，vault API 看不到 */
	private async readLocalBinary(path: string): Promise<ArrayBuffer | null> {
		const normalPath = normalizePath(path);
		if (normalPath === ".obsidian" || normalPath.startsWith(".obsidian/")) {
			try {
				if (!(await this.app.vault.adapter.exists(normalPath))) return null;
				return await this.app.vault.adapter.readBinary(normalPath);
			} catch {
				return null;
			}
		}
		const file = this.app.vault.getAbstractFileByPath(normalPath);
		if (!(file instanceof TFile)) return null;
		try {
			return await this.app.vault.readBinary(file);
		} catch {
			return null;
		}
	}

	private async renderTextDiff(
		section: HTMLElement,
		path: string,
		localContent: ArrayBuffer,
		snapshotContent: ArrayBuffer
	) {
		const localText = new TextDecoder().decode(localContent);

		let snapText = "";
		try { snapText = new TextDecoder().decode(snapshotContent); } catch {}

		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: `📝 ${path}` });

		const body = summary.createDiv({ cls: "diff-file-body" });

		if (localText === snapText || onlyTrailingBlankLinesDiffer(localText, snapText)) {
			body.createEl("p", { text: "文件内容相同", cls: "github-sync-no-changes" });
			return;
		}

		if (this.closed) return;
		const container = body.createDiv({ cls: "cm-merge-view" });

		const readOnlyExt = [
			EditorView.lineWrapping,
			lineNumbers(),
			EditorView.editable.of(false),
		];

		const aState = EditorState.create({
			doc: localText,
			extensions: readOnlyExt,
		});

		const bState = EditorState.create({
			doc: snapText,
			extensions: readOnlyExt,
		});

		const mv = new MergeView({
			a: aState,
			b: bState,
			parent: container,
			collapseUnchanged: { margin: 2, minSize: 3 },
		});

		this.mergeViews.push({ mv, path });
	}

	private async renderBinaryDiff(
		section: HTMLElement,
		path: string,
		localContent: ArrayBuffer,
		snapshotContent: ArrayBuffer
	) {
		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: `📎 ${path}` });

		const body = summary.createDiv({ cls: "diff-file-body" });

		if (arrayBuffersEqual(localContent, snapshotContent)) {
			body.createEl("p", { text: "文件内容相同", cls: "github-sync-no-changes" });
			return;
		}

		const table = body.createEl("table", { cls: "diff-binary-table" });
		const localRow = table.insertRow();
		localRow.insertCell().textContent = "本地大小";
		localRow.insertCell().textContent = `${localContent.byteLength} bytes`;

		const snapRow = table.insertRow();
		snapRow.insertCell().textContent = "快照大小";
		snapRow.insertCell().textContent = `${snapshotContent.byteLength} bytes`;
	}

	onClose() {
		for (const entry of this.mergeViews) {
			entry.mv.a.destroy();
			entry.mv.b.destroy();
		}
		this.mergeViews = [];
		this.contentEl.empty();
	}
}



export interface ConfirmSyncOptions {
	mode: SyncMode;
	toProcess: FileDiff[];   // 新增/修改（smart 模式下可同时包含上传/下载项）
	toRemove: FileDiff[];    // 删除
	unchanged: number;
	// 修改：接收用户勾选后的文件列表
	onConfirm: (selectedProcess: FileDiff[], selectedRemove: FileDiff[]) => Promise<void>;
	onCompare?: (path: string) => void;
}

interface ConfirmEntry {
	path: string;
	isRemove: boolean;
	diff: FileDiff;
}

interface ConfirmFolderNode {
	type: "folder";
	path: string;
	name: string;
	depth: number;
	children: ConfirmTreeNode[];
	/** 该文件夹下所有文件（含子文件夹）；勾选文件夹时批量操作 */
	files: ConfirmEntry[];
}

interface ConfirmFileNode {
	type: "file";
	depth: number;
	entry: ConfirmEntry;
	/** 由"只含一个文件的文件夹链"折叠而来：显示相对路径而不是 basename */
	promoted?: boolean;
}

type ConfirmTreeNode = ConfirmFolderNode | ConfirmFileNode;

export class ConfirmSyncModal extends Modal {
	private opts: ConfirmSyncOptions;
	private selectedProcess: Set<string>;
	private selectedRemove: Set<string>;

	/** 所有行（process + remove），按 path 排序 */
	private allEntries: ConfirmEntry[] = [];
	private treeRoot: ConfirmFolderNode | null = null;
	private folderMap = new Map<string, ConfirmFolderNode>();
	private fileRows = new Map<
		string,
		{
			checkbox: HTMLInputElement;
			entry: ConfirmEntry;
			iconEl: HTMLElement;
			pathEl: HTMLElement;
		}
	>();
	private folderRows = new Map<
		string,
		{ checkbox: HTMLInputElement; countEl: HTMLElement; node: ConfirmFolderNode }
	>();
	private expandedFolders = new Set<string>();
	private expandAllMode = true;
	private query = "";
	/** path -> 用户最终选择的动作（默认来自 FileDiff.direction） */
	private actions = new Map<string, SyncDirection>();

	private listContainer!: HTMLElement;
	private summaryEl!: HTMLElement;
	private countEl!: HTMLElement;
	private selectAllBtn!: HTMLButtonElement;
	private expandAllBtn!: HTMLButtonElement;
	private confirmBtn: HTMLButtonElement | null = null;

	constructor(app: App, opts: ConfirmSyncOptions) {
		super(app);
		this.opts = opts;
		// 默认勾选全部；但"远端精确修改时间未知"的文件默认不勾选，
		// 避免因为一次 API 失败就静默覆盖本地或远端。
		this.selectedProcess = new Set(
			opts.toProcess
				// 合并本身不需要 mtime；只有按时间决定 upload/download 时才因"时间未知"默认不选
				.filter((f) => !f.remoteMtimeEstimated || f.direction === "merge")
				.map((f) => f.path)
		);
		this.selectedRemove = new Set(opts.toRemove.map((f) => f.path));
	}

	onOpen() {
		this.modalEl.addClass("github-sync-confirm-host");
		const { contentEl, opts } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-confirm-modal");

		const modeLabel =
			opts.mode === "push" ? "Push ⬆️"
			: opts.mode === "pull" ? "Pull ⬇️"
			: opts.mode === "time" ? "按时间同步 ⏱️"
			: "智能合并 🔀";
		contentEl.createEl("h2", { text: `确认${modeLabel}` });

		// 构建所有行；删除项与 process 项分开保存，便于执行时分别处理
		const entries: ConfirmEntry[] = [
			...opts.toProcess.map((f) => ({ path: f.path, isRemove: false, diff: f })),
			...opts.toRemove.map((f) => ({ path: f.path, isRemove: true, diff: f })),
		].sort((a, b) => a.path.localeCompare(b.path));
		this.allEntries = entries;

		const total = entries.length;
		if (total === 0) {
			contentEl.createEl("p", {
				text: `✅ 已是最新，无需同步（${opts.unchanged} 个文件未更改）`,
				cls: "github-sync-no-changes",
			});
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText("关闭").onClick(() => this.close())
			);
			return;
		}

		// 逐文件动作：默认来自 FileDiff.direction；用户在行内 select 里改
		this.actions.clear();
		for (const entry of entries) {
			const available = this.availableActions(entry);
			const preferred = entry.diff.direction;
			const action =
				preferred && available.includes(preferred)
					? preferred
					: available[0] ?? "upload";
			this.actions.set(entry.path, action);
		}

		this.summaryEl = contentEl.createDiv("github-sync-summary");
		this.renderSummary();

		const estimatedCount = entries.filter(
			(e) =>
				e.diff.remoteMtimeEstimated &&
				e.diff.direction !== "merge"
		).length;
		if (estimatedCount > 0) {
			contentEl.createEl("p", {
				text: `⚠️ ${estimatedCount} 个文件无法获取远端精确修改时间，已默认不勾选（显示 ≈）。请先"对比"再决定。`,
				cls: "github-sync-hint-warning",
			});
		}

		// 工具栏：全选 / 展开折叠 / 已选计数 / 搜索过滤
		const toolbar = contentEl.createDiv("github-sync-toolbar");
		this.selectAllBtn = toolbar.createEl("button", {
			text: "取消全选",
			cls: "github-sync-select-all-btn",
		});
		this.expandAllBtn = toolbar.createEl("button", {
			text: "折叠全部",
			cls: "github-sync-select-all-btn",
		});
		this.countEl = toolbar.createEl("span", { cls: "github-sync-selected-count" });
		const searchInput = toolbar.createEl("input", {
			type: "search",
			cls: "github-sync-search",
			attr: { placeholder: "搜索文件/文件夹过滤…" },
		});

		this.listContainer = contentEl.createDiv(
			"github-sync-file-list github-sync-tree"
		);

		// 文件较少时默认全展开；文件很多时默认只展示顶层文件夹，避免一次创建上万行
		this.expandAllMode = entries.length <= 250;
		this.expandAllBtn.setText(this.expandAllMode ? "折叠全部" : "展开全部");
		this.expandedFolders.clear();

		this.selectAllBtn.addEventListener("click", () => {
			if (this.areAllSelected()) {
				this.selectedProcess.clear();
				this.selectedRemove.clear();
			} else {
				this.selectedProcess = new Set(
					this.opts.toProcess.map((f) => f.path)
				);
				this.selectedRemove = new Set(this.opts.toRemove.map((f) => f.path));
			}
			this.syncUI();
		});

		this.expandAllBtn.addEventListener("click", () => {
			this.expandAllMode = !this.expandAllMode;
			this.expandedFolders.clear();
			this.expandAllBtn.setText(this.expandAllMode ? "折叠全部" : "展开全部");
			this.renderList();
		});

		searchInput.addEventListener("input", () => {
			this.query = searchInput.value.trim().toLowerCase();
			this.renderList();
		});

		this.renderList();

		contentEl.createEl("p", {
			text: "确认后将按每一行选择的动作执行（Push / Pull / Merge / 删除），操作不可撤销。",
			cls: "github-sync-warning",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("取消").onClick(() => this.close())
			)
			.addButton((btn) => {
				btn
					.setButtonText(`确认${modeLabel}`)
					.setCta()
					.onClick(() => {
						// 把行内最终选择的动作写回 FileDiff.direction；执行层只看 direction，
						// 不再假设"push 模式就一定是上传"。
						const withAction = (f: FileDiff): FileDiff => ({
							...f,
							direction: this.actions.get(f.path) ?? f.direction,
						});
						const sp = this.opts.toProcess
							.filter((f) => this.selectedProcess.has(f.path))
							.map(withAction);
						const sr = this.opts.toRemove
							.filter((f) => this.selectedRemove.has(f.path))
							.map(withAction);

						if (sp.length === 0 && sr.length === 0) {
							new Notice("⚠️ 未选择任何文件");
							return;
						}

						this.close();
						this.opts.onConfirm(sp, sr).catch((err) => {
							console.error("后台同步出错:", err);
						});
					});
				this.confirmBtn = btn.buttonEl;
			});
		this.syncUI();
	}

	/** 当前筛选条件下重建文件夹树（只影响显示，不改变勾选状态） */
	private renderList() {
		if (!this.listContainer) return;
		this.listContainer.empty();
		this.fileRows.clear();
		this.folderRows.clear();
		this.folderMap.clear();

		const filtered = this.query
			? this.allEntries.filter((e) => e.path.toLowerCase().includes(this.query))
			: this.allEntries;
		const root = this.buildTree(filtered);
		this.treeRoot = root;

		if (filtered.length === 0) {
			this.listContainer.createEl("p", {
				text: "没有匹配的文件",
				cls: "github-sync-more",
			});
			this.syncUI();
			return;
		}
		for (const child of root.children) {
			this.renderNode(child, this.listContainer, 0, "");
		}
		this.syncUI();
	}

	private buildTree(entries: ConfirmEntry[]): ConfirmFolderNode {
		this.folderMap.clear();
		const root: ConfirmFolderNode = {
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
		const sortNode = (node: ConfirmFolderNode) => {
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

		// 路径压缩：把 D -> E -> F 这种"每层只有一个子文件夹"的链合并成一行，
		// 再把"只含一个文件"的文件夹提升为单个文件行（显示 D/E/F/A）。
		const compact = (node: ConfirmFolderNode): ConfirmTreeNode => {
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

		// folderMap 只保留压缩后仍可见的文件夹，供展开全部/半选状态使用
		this.folderMap.clear();
		const registerFolders = (node: ConfirmFolderNode) => {
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

	private nodeName(node: ConfirmTreeNode): string {
		if (node.type === "file") {
			const parts = node.entry.path.split("/");
			return parts[parts.length - 1];
		}
		return node.name;
	}

	private renderNode(
		node: ConfirmTreeNode,
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
			"github-sync-file-row github-sync-tree-row github-sync-tree-folder"
		);
		row.style.paddingLeft = `${6 + depth * 16}px`;

		const caret = row.createEl("span", {
			cls: "github-sync-tree-caret",
			text: isExpanded ? "▾" : "▸",
			attr: { role: "button", tabindex: "0", "aria-label": "展开/折叠" },
		});
		const checkbox = row.createEl("input", { type: "checkbox" });
		row.createEl("span", { text: "📁", cls: "file-icon" });
		row.createEl("span", { text: node.name, cls: "file-path github-sync-folder-name" });
		const countEl = row.createEl("span", {
			text: "",
			cls: "github-sync-folder-count",
		});

		const toggle = () => {
			if (this.query) return;
			if (this.expandAllMode) {
				// 从"全展开"切到手动模式：保留其它文件夹的展开状态
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
			const shouldSelect = state.selected < state.total;
			this.setFolderSelected(node, shouldSelect);
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
		node: ConfirmFileNode,
		parentEl: HTMLElement,
		depth: number,
		parentPath: string
	) {
		const { entry } = node;
		const row = parentEl.createDiv("github-sync-file-row");
		row.dataset.path = entry.path;
		row.style.paddingLeft = `${6 + depth * 16}px`;

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
		// 文件夹链折叠过来的单文件行显示相对路径，普通文件只显示文件名
		const label = node.promoted
			? relativePath
			: fullPath.split("/").pop() ?? fullPath;
		const pathEl = row.createEl("span", {
			text: label,
			cls: "file-path",
			attr: { title: fullPath },
		});

		// 时间证据 / 估算标记统一放右侧 meta 区
		const metaEl = row.createDiv("github-sync-row-meta");
		const f = entry.diff;
		if (
			(this.opts.mode === "time" || this.opts.mode === "merge") &&
			(f.localMtime || f.remoteMtime)
		) {
			const parts: string[] = [];
			if (f.localMtime) parts.push(`本地 ${fmtTime(f.localMtime)}`);
			if (f.remoteMtime) {
				parts.push(`远端${f.remoteMtimeEstimated ? "≈" : ""} ${fmtTime(f.remoteMtime)}`);
			}
			metaEl.createEl("span", { text: parts.join(" · "), cls: "file-times" });
		}
		if (f.remoteMtimeEstimated && this.actions.get(entry.path) !== "merge") {
			metaEl.createEl("span", {
				text: "⚠️",
				cls: "github-sync-uncertain-mark",
				attr: { title: "远端精确修改时间获取失败，使用 HEAD 时间估算；默认未勾选" },
			});
		}
		if (metaEl.childElementCount === 0) metaEl.remove();

		// 动作选择：单选项显示为小徽章，多选项显示为轻量下拉框
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

		if (this.opts.onCompare) {
			const compareBtn = actionsEl.createEl("button", {
				cls: "github-sync-icon-btn",
				attr: { title: "对比本地与 GitHub 内容", "aria-label": "对比" },
			});
			setIcon(compareBtn, "diff");
			if (compareBtn.childElementCount === 0) compareBtn.setText("⇄");
			compareBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.opts.onCompare!(entry.path);
			});
		}

		// 点击整行切换选中状态（动作下拉、对比按钮除外）
		row.addEventListener("click", (e) => {
			if (
				e.target !== checkbox &&
				!(e.target as HTMLElement).closest?.(
					".github-sync-compare-btn, .github-sync-icon-btn, .github-sync-action-select"
				)
			) {
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event("change"));
			}
		});

		const record = { checkbox, entry, iconEl, pathEl };
		this.fileRows.set(entry.path, record);
		this.applyRowVisual(record);
	}

	private applyRowVisual(row: {
		iconEl: HTMLElement;
		pathEl: HTMLElement;
		entry: ConfirmEntry;
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

	/**
	 * 根据文件在两端是否存在，计算可选动作。
	 *
	 * · 两端都有：Push / Pull / Merge（文本）；
	 * · 仅本地：Push / 删本地；
	 * · 仅远端：Pull / 删远端。
	 */
	private availableActions(entry: ConfirmEntry): SyncDirection[] {
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
		// 理论上不会出现；保底提供一个可执行动作
		return ["upload"];
	}

	private setAction(entry: ConfirmEntry, action: SyncDirection) {
		const available = this.availableActions(entry);
		if (!available.includes(action)) return;
		this.actions.set(entry.path, action);
		// 用户主动改动作时自动勾选该行
		if (!this.isSelected(entry)) this.setSelected(entry, true);
		this.syncUI();
		this.renderSummary();
	}

	private renderSummary() {
		if (!this.summaryEl) return;
		this.summaryEl.empty();
		const counts: Record<SyncDirection, number> = {
			upload: 0,
			download: 0,
			merge: 0,
			delete: 0,
			"delete-local": 0,
		};
		for (const entry of this.allEntries) {
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
		badge(counts["delete-local"], `🗑️ ${counts["delete-local"]} 个删除本地`, "badge-deleted");
		if (this.opts.unchanged > 0) {
			badge(this.opts.unchanged, `＝ ${this.opts.unchanged} 个未变化`, "badge-unchanged");
		}
	}

	private isSelected(entry: ConfirmEntry): boolean {
		return entry.isRemove
			? this.selectedRemove.has(entry.path)
			: this.selectedProcess.has(entry.path);
	}

	private setSelected(entry: ConfirmEntry, selected: boolean) {
		if (entry.isRemove) {
			if (selected) this.selectedRemove.add(entry.path);
			else this.selectedRemove.delete(entry.path);
		} else if (selected) {
			this.selectedProcess.add(entry.path);
		} else {
			this.selectedProcess.delete(entry.path);
		}
	}

	private folderSelectionState(node: ConfirmFolderNode): {
		selected: number;
		total: number;
	} {
		let selected = 0;
		for (const entry of node.files) if (this.isSelected(entry)) selected++;
		return { selected, total: node.files.length };
	}

	private setFolderSelected(node: ConfirmFolderNode, selected: boolean) {
		for (const entry of node.files) this.setSelected(entry, selected);
	}

	private areAllSelected(): boolean {
		return this.allEntries.every((e) => this.isSelected(e));
	}

	/** 同步 DOM 勾选状态、文件夹半选、计数与按钮文案 */
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

		const selectedCount = this.allEntries.filter((e) => this.isSelected(e)).length;
		this.countEl.setText(`已选 ${selectedCount} / ${this.allEntries.length}`);
		if (this.selectAllBtn) {
			this.selectAllBtn.setText(
				this.allEntries.length > 0 && selectedCount === this.allEntries.length
					? "取消全选"
					: "全选"
			);
		}
		if (this.confirmBtn) this.confirmBtn.disabled = selectedCount === 0;
	}

	onClose() {
		this.fileRows.clear();
		this.folderRows.clear();
		this.folderMap.clear();
		this.treeRoot = null;
		this.contentEl.empty();
	}
}

export class ProgressModal extends Modal {
	private progressTitleEl!: HTMLElement;
	private messageEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private progressBarEl!: HTMLElement;
	private percentEl!: HTMLElement;

	constructor(app: App) {
		super(app);
		// 防止用户手动关闭
		this.modalEl.addEventListener("keydown", (e) => {
			if (e.key === "Escape") e.stopPropagation();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-progress-modal");

		this.progressTitleEl = contentEl.createEl("h2", { text: "同步中..." });
		this.messageEl = contentEl.createEl("p", {
			text: "正在准备...",
			cls: "github-sync-progress-msg",
		});
		this.progressEl = contentEl.createDiv("github-sync-progress-bar-wrap");
		this.progressBarEl = this.progressEl.createDiv(
			"github-sync-progress-bar-fill"
		);
		this.percentEl = this.progressEl.createDiv("github-sync-progress-pct");
	}

	setTitle(text: string) {
		if (this.progressTitleEl) this.progressTitleEl.setText(text);
		return this;
	}

	setMessage(text: string) {
		if (this.messageEl) this.messageEl.setText(text);
	}

	setProgress(pct: number) {
		if (!this.progressBarEl || !this.percentEl) return;
		if (pct < 0) {
			// 负数 = 总数未知，显示流动的不确定进度条
			this.progressBarEl.addClass("github-sync-indeterminate");
			this.progressBarEl.style.width = "35%";
			this.percentEl.setText("");
			return;
		}
		this.progressBarEl.removeClass("github-sync-indeterminate");
		const clamped = Math.max(0, Math.min(100, pct));
		this.progressBarEl.style.width = `${clamped}%`;
		this.percentEl.setText(`${Math.round(clamped)}%`);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ──────────────────────────────────────────────
// 对比弹窗
// ──────────────────────────────────────────────

export class DiffViewerModal extends Modal {
	private paths: string[];
	private plugin: GitHubSyncPlugin;
	private onSync: () => void;
	private showSyncButton: boolean;
	private onIdenticalFiles: ((paths: string[]) => void) | null;
	private identicalPaths: string[];
	private mergeViews: { mv: MergeView; path: string }[];
	private closed = false;
	private client: GitHubClient | null = null;
	private remoteMap = new Map<string, GitHubFile>();

	constructor(
		app: App,
		paths: string[],
		plugin: GitHubSyncPlugin,
		onSync: () => void,
		showSyncButton = true,
		onIdenticalFiles: ((paths: string[]) => void) | null = null
	) {
		super(app);
		this.paths = paths;
		this.plugin = plugin;
		this.onSync = onSync;
		this.showSyncButton = showSyncButton;
		this.onIdenticalFiles = onIdenticalFiles;
		this.identicalPaths = [];
		this.mergeViews = [];
	}

	async onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("github-sync-diff-modal");
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		contentEl.createEl("h2", { text: `对比未同步文件 (${this.paths.length} 个)` });

		const legendEl = contentEl.createDiv({ cls: "diff-legend" });
		legendEl.createEl("span", { text: "🟢 仅在 GitHub 端", cls: "diff-legend-item" });
		legendEl.createEl("span", { text: "🔴 仅在本地", cls: "diff-legend-item" });
		legendEl.createEl("span", { text: "✅ 两端相同（按 blob SHA 快速判定）", cls: "diff-legend-item" });

		const statusEl = contentEl.createDiv({ cls: "github-sync-progress-modal" });
		statusEl.createEl("p", { text: "正在获取 GitHub 文件列表...", cls: "github-sync-progress-msg" });

		try {
			const token = (this.plugin.settings.token || "").trim();
			const repository = (this.plugin.settings.repository || "").trim();
			const branch = (this.plugin.settings.branch || "main").trim() || "main";
			const client = new GitHubClient(token, repository, branch);
			this.client = client;

			// 只拉一次远端索引（优先复用启动预取 / 在途请求）；文件内容按需加载，
			// 避免几十个文件一打开弹窗就产生 2N 个请求、把界面卡住。
			const remoteFiles = await this.plugin.getRemoteFilesForCompare(client);
			if (this.closed) return;
			this.remoteMap = new Map(remoteFiles.map((f) => [f.path, f] as const));

			statusEl.empty();
			const scrollArea = contentEl.createDiv({ cls: "diff-scroll-area" });
			const sortedPaths = [...this.paths].sort((a, b) => a.localeCompare(b));
			let autoOpen = 0;

			for (const path of sortedPaths) {
				if (this.closed) return;
				const remote = this.remoteMap.get(path);
				const local = await this.readLocalBinary(path);
				if (this.closed) return;
				const section = scrollArea.createDiv({ cls: "diff-file-section" });

				if (!local && !remote) {
					section.createEl("p", {
						text: `❔ ${path}（两端均不存在）`,
						cls: "github-sync-warning",
					});
					continue;
				}

				if (local && remote) {
					// git blob SHA 的前缀包含文件大小：大小不同一定不同，免掉哈希；
					// 大小相同再算本地 blob SHA，与远端 SHA 相同 = 内容完全一致，连下载都省掉。
					if (local.byteLength === remote.size) {
						const localSha = await computeGitBlobSha(local);
						if (localSha === remote.sha) {
							this.markIdentical(path, section);
							continue;
						}
					}
					this.renderChangedSection(
						section,
						path,
						remote,
						local,
						autoOpen < 3
					);
				} else if (remote) {
					this.renderRemoteOnlySection(section, path, remote, autoOpen < 3);
				} else {
					this.renderLocalOnlySection(section, path);
				}
				autoOpen++;
			}

		} catch (err) {
			statusEl.empty();
			statusEl.createEl("p", {
				text: `❌ 获取差异失败: ${err instanceof Error ? err.message : String(err)}`,
				cls: "github-sync-warning",
			});
		}

		const btnSetting = new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("关闭").onClick(() => this.close()));

		if (this.showSyncButton) {
			btnSetting.addButton((btn) =>
				btn.setButtonText("去同步").setCta().onClick(() => {
					this.close();
					this.onSync();
				})
			);
		}
	}

	private markIdentical(path: string, section?: HTMLElement) {
		if (!this.identicalPaths.includes(path)) {
			this.identicalPaths.push(path);
			this.onIdenticalFiles?.([path]);
		}
		if (section) {
			section.empty();
			section.addClass("diff-file-identical");
			section.createEl("p", {
				text: `✅ ${path} — 文件内容相同`,
				cls: "github-sync-no-changes",
			});
		}
	}

	private renderLocalOnlySection(section: HTMLElement, path: string) {
		const details = section.createEl("details");
		details.createEl("summary", { text: `📤 ${path}（仅在本地）` });
		const body = details.createDiv({ cls: "diff-file-body" });
		body.createEl("p", {
			text: "GitHub 端不存在此文件；执行 Push 时会作为新增上传。",
			cls: "github-sync-warning",
		});
	}

	private renderRemoteOnlySection(
		section: HTMLElement,
		path: string,
		remote: GitHubFile,
		open: boolean
	) {
		const details = section.createEl("details", { attr: open ? { open: "" } : {} });
		details.createEl("summary", { text: `🗑️ ${path}（本地已删除 / 仅在 GitHub 端）` });
		const body = details.createDiv({ cls: "diff-file-body" });
		body.createEl("p", {
			text: "本地文件已删除。执行 Pull 时会恢复，Push 时会从远端删除。",
			cls: "github-sync-warning",
		});
		const meta = body.createDiv({ cls: "diff-meta-table" });
		const sizeRow = meta.createDiv("diff-meta-row");
		sizeRow.createEl("span", { text: "GitHub 大小" });
		sizeRow.createEl("span", { text: this.formatSize(remote.size) });

		let loaded = false;
		const load = async () => {
			if (loaded || this.closed || !this.client) return;
			loaded = true;
			const status = body.createEl("p", { text: "正在读取提交信息...", cls: "github-sync-progress-msg" });
			const info = await this.client.getFileCommitInfo(path).catch(() => null);
			status.remove();
			if (!info || this.closed) return;
			this.addCommitMeta(meta, info.message, info.date);
		};
		details.addEventListener("toggle", () => {
			if (details.open) void load();
		});
		if (open) void load();
	}

	private renderChangedSection(
		section: HTMLElement,
		path: string,
		remote: GitHubFile,
		localContent: ArrayBuffer,
		open: boolean
	) {
		const text = isTextFile(path);
		const details = section.createEl("details", { attr: open ? { open: "" } : {} });
		details.createEl("summary", { text: `${text ? "📝" : "📎"} ${path}` });
		const body = details.createDiv({ cls: "diff-file-body" });

		const meta = body.createDiv({ cls: "diff-meta-table" });
		const sizeRow = meta.createDiv("diff-meta-row");
		sizeRow.createEl("span", { text: "本地 / GitHub 大小" });
		sizeRow.createEl("span", {
			text: `${this.formatSize(localContent.byteLength)} / ${this.formatSize(remote.size)}`,
		});

		let loaded = false;
		const load = async () => {
			if (loaded || this.closed || !this.client) return;
			loaded = true;
			const status = body.createEl("p", {
				text: text ? "正在下载远端内容..." : "正在读取提交信息...",
				cls: "github-sync-progress-msg",
			});
			// 二进制文件只需要大小/提交信息，不必把整份内容下载下来
			const needContent = text && remote.size <= 10 * 1024 * 1024;
			const [remoteContent, info] = await Promise.all([
				needContent
					? this.client.downloadFile(path, remote.sha).catch(() => null)
					: Promise.resolve(null),
				this.client.getFileCommitInfo(path).catch(() => null),
			]);
			status.remove();
			if (this.closed) return;
			if (info) this.addCommitMeta(meta, info.message, info.date);

			if (!text) {
				this.renderBinaryInfo(body, path, localContent, remote.size);
				return;
			}
			if (!remoteContent) {
				body.createEl("p", {
					text: "⚠️ 远端内容不可用（文件过大或下载失败），无法对比内容",
					cls: "github-sync-warning",
				});
				return;
			}
			await this.renderTextDiff(body, path, localContent, remoteContent);
		};
		details.addEventListener("toggle", () => {
			if (details.open) void load();
		});
		if (open) void load();
	}

	private addCommitMeta(container: HTMLElement, message: string, date: string) {
		if (message) {
			const row = container.createDiv("diff-meta-row");
			row.createEl("span", { text: "提交信息" });
			row.createEl("span", { text: message.slice(0, 200) });
		}
		if (date) {
			const row = container.createDiv("diff-meta-row");
			row.createEl("span", { text: "提交时间" });
			row.createEl("span", { text: new Date(date).toLocaleString() });
		}
	}

	private async renderTextDiff(
		body: HTMLElement,
		path: string,
		localContent: ArrayBuffer,
		remoteContent: ArrayBuffer
	) {
		const localText = new TextDecoder().decode(localContent);
		const remoteText = new TextDecoder().decode(remoteContent);

		if (localText === remoteText || onlyTrailingBlankLinesDiffer(localText, remoteText)) {
			body.createEl("p", {
				text: "文件内容相同（仅尾部空行不同）",
				cls: "github-sync-no-changes",
			});
			this.markIdentical(path);
			return;
		}

		const container = body.createDiv({ cls: "cm-merge-view" });
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
			parent: container,
			collapseUnchanged: { margin: 2, minSize: 3 },
		});
		this.mergeViews.push({ mv, path });
	}

	private renderBinaryInfo(
		body: HTMLElement,
		path: string,
		localContent: ArrayBuffer | null,
		remoteSize: number
	) {
		const table = body.createEl("table", { cls: "diff-binary-table" });
		const localRow = table.insertRow();
		localRow.insertCell().textContent = "本地大小";
		localRow.insertCell().textContent = this.formatSize(localContent ? localContent.byteLength : 0);
		const remoteRow = table.insertRow();
		remoteRow.insertCell().textContent = "GitHub 大小";
		remoteRow.insertCell().textContent = this.formatSize(remoteSize);
	}

	/** 读取本地文件（.obsidian 走 adapter）；不存在返回 null */
	private async readLocalBinary(path: string): Promise<ArrayBuffer | null> {
		const normalPath = normalizePath(path);
		if (normalPath === ".obsidian" || normalPath.startsWith(".obsidian/")) {
			try {
				if (!(await this.app.vault.adapter.exists(normalPath))) return null;
				return await this.app.vault.adapter.readBinary(normalPath);
			} catch {
				return null;
			}
		}
		const file = this.app.vault.getAbstractFileByPath(normalPath);
		if (!(file instanceof TFile)) return null;
		try {
			return await this.app.vault.readBinary(file);
		} catch {
			return null;
		}
	}

	private formatSize(bytes: number): string {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
	}

	onClose() {
		this.closed = true;
		for (const entry of this.mergeViews) {
			entry.mv.a.destroy();
			entry.mv.b.destroy();
		}
		this.mergeViews = [];
		this.contentEl.empty();
	}
}

// 新增：未同步警告弹窗
export class UnsyncedWarningModal extends Modal {
	private paths: string[];
	private onSync: () => void;
	private plugin: GitHubSyncPlugin;
	private onDismiss?: () => void;
	private dismissed = false;

	constructor(
		app: App,
		paths: string[],
		onSync: () => void,
		plugin: GitHubSyncPlugin,
		onDismiss?: () => void
	) {
		super(app);
		this.paths = paths;
		this.onSync = onSync;
		this.plugin = plugin;
		this.onDismiss = onDismiss;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		contentEl.createEl("h2", { text: "⚠️ 发现未同步的修改" });
		contentEl.createEl("p", {
			text: "上次退出 Obsidian 时没有同步。再次执行包含拉取 (Pull/Smart) 的操作请小心，以免覆盖本地未保存的修改。",
			cls: "github-sync-warning",
		});

		if (this.paths.length > 0) {
			contentEl.createEl("p", { text: "以下文件可能未同步：" });
			const listContainer = contentEl.createDiv("github-sync-file-list");
			// 最多显示 50 个
			const displayPaths = this.paths.slice(0, 50);
			for (const p of displayPaths) {
				const row = listContainer.createDiv("github-sync-file-row");
				row.createEl("span", { text: "📝", cls: "file-icon" });
				row.createEl("span", { text: p, cls: "file-path file-modified" });
			}
			if (this.paths.length > 50) {
				listContainer.createEl("p", {
					text: `...以及 ${this.paths.length - 50} 个其他文件`,
					cls: "github-sync-more",
				});
			}
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("我知道了").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("对比")
					.setCta()
					.onClick(() => {
						this.close();
						new DiffViewerModal(
							this.app,
							this.paths,
							this.plugin,
							() => this.onSync(),
							true,
					(paths) => this.plugin.onCompareIdentical(paths)
				).open();
			})
	);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.dismissed) {
			this.dismissed = true;
			this.onDismiss?.();
		}
	}
}

// ──────────────────────────────────────────────
// .obsidian 子项选择弹窗
// ──────────────────────────────────────────────

export class ObsidianSyncPickerModal extends Modal {
	private plugin: GitHubSyncPlugin;
	private onSaved: () => void;
	/** 显式勾选的相对路径;空集 = 同步全部(与旧版语义一致) */
	private selected = new Set<string>();
	/** 筛选模式:false = 同步全部(树置灰);true = 按勾选筛选。
	 *  独立于 selected 维护,否则"筛选模式+未选择"无法表示,总开关会弹回。 */
	private filterMode: boolean;
	private preAllSelection: Set<string> | null = null;
	private masterEl!: HTMLInputElement;
	private saveBtn: HTMLButtonElement | null = null;
	private treeContainer!: HTMLElement;
	private rows = new Map<string, { checkbox: HTMLInputElement; row: HTMLElement; node: PickerNode }>();
	private expanded = new Set<string>();

	constructor(app: App, plugin: GitHubSyncPlugin, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.onSaved = onSaved;
		this.selected = new Set(plugin.settings.obsidianSyncSelection);
		this.filterMode = this.selected.size > 0;
	}

	/** 空选 = 同步全部(历史语义,保持兼容) */
	private isAllMode(): boolean {
		return this.selected.size === 0;
	}

	/** rel 是否被覆盖:自身或任一祖先被显式选中 */
	private isCovered(rel: string): boolean {
		if (this.selected.has(rel)) return true;
		for (const s of this.selected) {
			if (rel.startsWith(s + "/")) return true;
		}
		return false;
	}

	private hasSelectedDescendant(rel: string): boolean {
		for (const s of this.selected) {
			if (s.startsWith(rel + "/")) return true;
		}
		return false;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal");

		contentEl.createEl("h2", { text: "选择要同步的 .obsidian 子项" });

		// 总开关:同步全部(对应"空选 = 全部"的历史语义)
		const masterRow = contentEl.createDiv("github-sync-master-row");
		const masterLabel = masterRow.createEl("label", { cls: "github-sync-master-label" });
		this.masterEl = masterLabel.createEl("input", { type: "checkbox" });
		this.masterEl.checked = this.isAllMode();
		masterLabel.createEl("span", { text: "同步 .obsidian 下全部内容（不筛选）" });
		masterRow.createEl("span", {
			text: "取消勾选后可展开文件夹逐级选择",
			cls: "github-sync-entry-hint",
		});
		this.masterEl.addEventListener("change", () => {
			this.filterMode = !this.masterEl.checked;
			if (this.filterMode) {
				// 从"全部"切回筛选:恢复上次的选择快照(若有),否则从空开始
				if (this.preAllSelection) {
					this.selected = new Set(this.preAllSelection);
				}
			} else {
				this.preAllSelection = new Set(this.selected);
				this.selected.clear();
			}
			this.refreshAll();
		});

		const statusEl = contentEl.createEl("p", {
			text: "正在读取 .obsidian 目录...",
			cls: "github-sync-subtitle",
		});

		let roots: PickerNode[] = [];
		try {
			roots = await this.listDir(".obsidian", 0);
		} catch {}

		if (roots.length === 0) {
			statusEl.setText("⚠️ 无法读取 .obsidian 目录内容");
			new Setting(contentEl)
				.addButton((btn) => btn.setButtonText("关闭").onClick(() => this.close()));
			return;
		}

		statusEl.setText(
			"勾选文件夹 = 包含其全部内容；文件夹显示半选表示只同步了部分子项。展开 ▸ 可逐级细分。"
		);

		this.treeContainer = contentEl.createDiv("github-sync-file-list github-sync-tree");
		for (const node of roots) this.createRowElement(node);

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("取消").onClick(() => this.close())
			)
			.addButton((btn) => {
				btn
					.setButtonText("保存")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.obsidianSyncSelection = Array.from(this.selected).sort();
						await this.plugin.saveSettings();
						new Notice(
							this.isAllMode()
								? "✅ 已设为同步 .obsidian 下全部内容"
								: `✅ 将同步 ${this.selected.size} 个选定子项（含其子内容）`
						);
						this.onSaved?.();
						this.close();
					});
				this.saveBtn = btn.buttonEl;
			});
		this.refreshAll();
	}

	/** 列出某目录的子节点(rel 相对 .obsidian) */
	private async listDir(absDir: string, depth: number): Promise<PickerNode[]> {
		const listing = await this.app.vault.adapter.list(normalizePath(absDir));
		const relBase = absDir === ".obsidian" ? "" : absDir.slice(".obsidian/".length);
		const toRel = (f: string) => {
			const name = f.split("/").pop() ?? f;
			return relBase ? `${relBase}/${name}` : name;
		};
		const nodes: PickerNode[] = [
			...listing.folders.map((f) => ({ rel: toRel(f), name: toRel(f).split("/").pop() ?? f, isFolder: true, depth })),
			...listing.files.map((f) => ({ rel: toRel(f), name: toRel(f).split("/").pop() ?? f, isFolder: false, depth })),
		];
		nodes.sort((a, b) =>
			a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1
		);
		return nodes;
	}

	/** 创建一行(插入到 ref 之后,保持树的 DOM 顺序) */
	private createRowElement(node: PickerNode, ref?: HTMLElement): HTMLElement {
		const row = document.createElement("div");
		row.className = "github-sync-file-row github-sync-tree-row";
		row.style.marginLeft = `${node.depth * 18}px`;

		const caret = row.createEl("span", {
			cls: "github-sync-tree-caret",
			text: node.isFolder ? "▸" : "",
		});
		const cb = row.createEl("input", { type: "checkbox" });
		row.createEl("span", { text: node.name, cls: "file-path" });
		const hint = OBSIDIAN_ENTRY_HINTS[node.rel];
		if (hint) row.createEl("span", { text: hint, cls: "github-sync-entry-hint" });

		if (ref && ref.parentElement) {
			ref.parentElement.insertBefore(row, ref.nextSibling);
		} else {
			this.treeContainer.appendChild(row);
		}

		cb.addEventListener("change", () => {
			if (cb.checked) {
				this.checkNode(node);
				this.refreshAll();
			} else {
				// 反勾选可能需要展开被选祖先(保留其余子树),完成后统一刷新
				void this.uncheckNode(node).then(() => this.refreshAll());
			}
		});
		row.addEventListener("click", (e) => {
			if (e.target === cb) return;
			if (node.isFolder) {
				void this.toggleExpand(node, caret);
			} else {
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			}
		});

		this.rows.set(node.rel, { checkbox: cb, row, node });
		this.applyRowState(node.rel);
		return row;
	}

	private async toggleExpand(node: PickerNode, caret: HTMLElement) {
		const entry = this.rows.get(node.rel);
		if (!entry) return;
		if (this.expanded.has(node.rel)) {
			this.expanded.delete(node.rel);
			caret.setText("▸");
			for (const [rel, item] of [...this.rows.entries()]) {
				if (rel.startsWith(node.rel + "/")) {
					item.row.remove();
					this.rows.delete(rel);
				}
			}
			return;
		}
		this.expanded.add(node.rel);
		caret.setText("▾");
		let children: PickerNode[] = [];
		try {
			children = await this.listDir(`.obsidian/${node.rel}`, node.depth + 1);
		} catch {}
		let ref: HTMLElement = entry.row;
		for (const child of children) {
			ref = this.createRowElement(child, ref);
		}
	}

	/** 勾选:选中自身;显式选中的后代移除(被自身覆盖) */
	private checkNode(node: PickerNode) {
		this.selected.add(node.rel);
		for (const s of [...this.selected]) {
			if (s.startsWith(node.rel + "/")) this.selected.delete(s);
		}
	}

	/** 反勾选:显式项直接移除;隐式项展开最近的被选祖先,其余子树保持选中 */
	private async uncheckNode(node: PickerNode) {
		const rel = node.rel;
		if (this.selected.has(rel)) {
			this.selected.delete(rel);
			for (const s of [...this.selected]) {
				if (s.startsWith(rel + "/")) this.selected.delete(s);
			}
			return;
		}
		const anc = this.nearestSelectedAncestor(rel);
		if (anc) await this.expandSelection(anc, rel);
	}

	private nearestSelectedAncestor(rel: string): string | null {
		const parts = rel.split("/");
		for (let i = parts.length - 1; i > 0; i--) {
			const anc = parts.slice(0, i).join("/");
			if (this.selected.has(anc)) return anc;
		}
		return null;
	}

	/** 用祖先的各子项替换祖先本身(排除 excludeRel 子树),保留已有的细分选择 */
	private async expandSelection(ancestorRel: string, excludeRel: string) {
		this.selected.delete(ancestorRel);
		let children: PickerNode[] = [];
		try {
			children = await this.listDir(`.obsidian/${ancestorRel}`, 0);
		} catch {
			return;
		}
		for (const c of children) {
			if (c.rel === excludeRel || excludeRel.startsWith(c.rel + "/")) continue;
			if (c.isFolder && this.hasSelectedDescendant(c.rel)) {
				await this.expandSelection(c.rel, excludeRel);
			} else {
				this.selected.add(c.rel);
			}
		}
	}

	private applyRowState(rel: string) {
		const entry = this.rows.get(rel);
		if (!entry) return;
		const { checkbox, node } = entry;
		if (!this.filterMode) {
			// 全部模式:整体置灰勾选,不可交互
			checkbox.checked = true;
			checkbox.indeterminate = false;
			checkbox.disabled = true;
			return;
		}
		checkbox.disabled = false;
		const covered = this.isCovered(rel);
		checkbox.checked = covered;
		checkbox.indeterminate = !covered && node.isFolder && this.hasSelectedDescendant(rel);
	}

	private refreshAll() {
		if (this.masterEl) this.masterEl.checked = !this.filterMode;
		for (const rel of this.rows.keys()) this.applyRowState(rel);
		if (this.saveBtn) {
			// 筛选模式下至少要勾选一项才能保存,防止误把"清空"当成"全部"
			this.saveBtn.disabled = this.filterMode && this.selected.size === 0;
		}
	}

	onClose() {
		this.rows.clear();
		this.expanded.clear();
		this.contentEl.empty();
	}
}