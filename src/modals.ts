// modals.ts — 同步确认对话框

import { App, Modal, Setting, TFile, normalizePath } from "obsidian";
import { FileDiff, isTextFile } from "./diff";
import type { RollbackSnapshot } from "./types";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { GitHubClient, FileWithCommitInfo } from "./github";
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

export class SyncModeModal extends Modal {
	private onChoose: (mode: SyncMode) => void;
	private onRollback?: () => void;

	constructor(
		app: App,
		onChoose: (mode: SyncMode) => void,
		onRollback?: () => void
	) {
		super(app);
		this.onChoose = onChoose;
		this.onRollback = onRollback;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-mode-modal");

		contentEl.createEl("h2", { text: "GitHub 同步" });
		contentEl.createEl("p", {
			text: "选择同步模式",
			cls: "github-sync-subtitle",
		});

		const btnContainer = contentEl.createDiv("github-sync-mode-buttons");

		const pushBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn" });
		pushBtn.createEl("div", { text: "⬆️", cls: "github-sync-mode-icon" });
		pushBtn.createEl("div", { text: "Push", cls: "github-sync-mode-label" });
		pushBtn.createEl("div", { text: "将本地更改上传到 GitHub", cls: "github-sync-mode-desc" });
		pushBtn.addEventListener("click", () => { this.close(); this.onChoose("push"); });

		const pullBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn" });
		pullBtn.createEl("div", { text: "⬇️", cls: "github-sync-mode-icon" });
		pullBtn.createEl("div", { text: "Pull", cls: "github-sync-mode-label" });
		pullBtn.createEl("div", { text: "从 GitHub 下载最新内容到本地", cls: "github-sync-mode-desc" });
		pullBtn.addEventListener("click", () => { this.close(); this.onChoose("pull"); });

		const timeBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn" });
		timeBtn.createEl("div", { text: "⏱️", cls: "github-sync-mode-icon" });
		timeBtn.createEl("div", { text: "Push/Pull by Time", cls: "github-sync-mode-label" });
		timeBtn.createEl("div", { text: "按修改时间自动决定方向", cls: "github-sync-mode-desc" });
		timeBtn.addEventListener("click", () => { this.close(); this.onChoose("time"); });

		const mergeBtn = btnContainer.createEl("button", { cls: "github-sync-mode-btn" });
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
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal");
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
			const row = listContainer.createDiv("github-sync-file-row");

			const dateStr = new Date(snap.date).toLocaleString();
			row.createEl("span", {
				text: "📸",
				cls: "file-icon",
			});
			row.createEl("span", {
				text: `${dateStr}（${snap.files.length} 个文件）`,
				cls: "file-path",
			});

			const compareBtn = row.createEl("button", {
				text: "对比",
				cls: "github-sync-compare-btn",
			});
			compareBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				new RollbackDiffModal(this.app, snap).open();
			});

			const btn = row.createEl("button", {
				text: "回滚到此版本",
				cls: "github-sync-compare-btn",
			});
			allBtns.push(btn);
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				allBtns.forEach(b => { b.disabled = true; b.textContent = "回滚中..."; });
				try {
					await this.onRollback(snap.id);
					this.close();
				} catch (err) {
					allBtns.forEach(b => { b.disabled = false; b.textContent = "回滚到此版本"; });
					btn.textContent = "回滚失败";
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

					const localFile = this.app.vault.getAbstractFileByPath(path);
					const section = scrollArea.createDiv({ cls: "diff-file-section" });

					if (!(localFile instanceof TFile)) {
						const summary = section.createEl("details", { attr: { open: "" } });
						summary.createEl("summary", { text: `➕ ${path}` });
						const body = summary.createDiv({ cls: "diff-file-body" });
						body.createEl("p", {
							text: "本地文件已删除，快照中存在此文件",
							cls: "github-sync-warning",
						});
					} else if (isTextFile(path)) {
						await this.renderTextDiff(section, path, localFile, snapContent);
					} else {
						await this.renderBinaryDiff(section, path, localFile, snapContent);
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

	private async renderTextDiff(
		section: HTMLElement,
		path: string,
		localFile: TFile,
		snapshotContent: ArrayBuffer
	) {
		let localText = "";
		try { localText = await this.app.vault.read(localFile); } catch {}

		let snapText = "";
		try { snapText = new TextDecoder().decode(snapshotContent); } catch {}

		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: `📝 ${path}` });

		const body = summary.createDiv({ cls: "diff-file-body" });

		if (localText === snapText || onlyTrailingBlankLinesDiffer(localText, snapText)) {
			body.createEl("p", { text: "文件内容相同", cls: "github-sync-no-changes" });
			return;
		}

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
		localFile: TFile,
		snapshotContent: ArrayBuffer
	) {
		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: `📎 ${path}` });

		const body = summary.createDiv({ cls: "diff-file-body" });

		let localContent: ArrayBuffer | null = null;
		try { localContent = await this.app.vault.readBinary(localFile); } catch {}

		if (localContent && arrayBuffersEqual(localContent, snapshotContent)) {
			body.createEl("p", { text: "文件内容相同", cls: "github-sync-no-changes" });
			return;
		}

		const table = body.createEl("table", { cls: "diff-binary-table" });
		const localRow = table.insertRow();
		localRow.insertCell().textContent = "本地大小";
		localRow.insertCell().textContent = `${localContent ? localContent.byteLength : 0} bytes`;

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

export class ConfirmSyncModal extends Modal {
	private opts: ConfirmSyncOptions;
	private selectedProcess: Set<string>;
	private selectedRemove: Set<string>;

	constructor(app: App, opts: ConfirmSyncOptions) {
		super(app);
		this.opts = opts;
		// 默认全部勾选
		this.selectedProcess = new Set(opts.toProcess.map((f) => f.path));
		this.selectedRemove = new Set(opts.toRemove.map((f) => f.path));
	}

	onOpen() {
		const { contentEl, opts } = this;
		contentEl.empty();
		contentEl.addClass("github-sync-modal", "github-sync-confirm-modal");

		const isSmart = opts.mode === "time";
		const modeLabel =
			opts.mode === "push" ? "Push ⬆️"
			: opts.mode === "pull" ? "Pull ⬇️"
			: opts.mode === "time" ? "按时间同步 ⏱️"
			: "智能合并 🔀";
		contentEl.createEl("h2", { text: `确认${modeLabel}` });

		const total = opts.toProcess.length + opts.toRemove.length;
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

		// 统计摘要
		const summary = contentEl.createDiv("github-sync-summary");
		if (isSmart || opts.mode === "merge") {
			const uploadCount = opts.toProcess.filter((f) => f.direction === "upload").length;
			const downloadCount = opts.toProcess.filter((f) => f.direction === "download").length;
			const mergeCount = opts.toProcess.filter((f) => f.direction === "merge").length;
			const deleteCount = opts.toRemove.length + opts.toProcess.filter((f) => f.direction === "delete").length;

			if (uploadCount > 0) summary.createEl("span", { text: `⬆️ ${uploadCount} 个上传`, cls: "github-sync-badge badge-upload" });
			if (downloadCount > 0) summary.createEl("span", { text: `⬇️ ${downloadCount} 个下载`, cls: "github-sync-badge badge-download" });
			if (mergeCount > 0) summary.createEl("span", { text: `🔀 ${mergeCount} 个合并`, cls: "github-sync-badge badge-modified" });
			if (deleteCount > 0) summary.createEl("span", { text: `🗑️ ${deleteCount} 个删除`, cls: "github-sync-badge badge-deleted" });
		} else {
			const added = opts.toProcess.filter((f) => f.changeType === "added").length;
			const modified = opts.toProcess.filter((f) => f.changeType === "modified").length;
			const deleted = opts.toRemove.length;

			if (added > 0) summary.createEl("span", { text: `➕ ${added} 个新增`, cls: "github-sync-badge badge-added" });
			if (modified > 0) summary.createEl("span", { text: `✏️ ${modified} 个修改`, cls: "github-sync-badge badge-modified" });
			if (deleted > 0) summary.createEl("span", { text: `🗑️ ${deleted} 个删除`, cls: "github-sync-badge badge-deleted" });
		}

		if (opts.unchanged > 0)
			summary.createEl("span", {
				text: `＝ ${opts.unchanged} 个未变化`,
				cls: "github-sync-badge badge-unchanged",
			});

		// 新增：全选/取消全选 按钮
		const selectAllBtn = contentEl.createEl("button", {
			text: "取消全选",
			cls: "github-sync-select-all-btn",
		});
		let isAllSelected = true;
		selectAllBtn.addEventListener("click", () => {
			isAllSelected = !isAllSelected;
			if (isAllSelected) {
				this.selectedProcess = new Set(this.opts.toProcess.map((f) => f.path));
				this.selectedRemove = new Set(this.opts.toRemove.map((f) => f.path));
				selectAllBtn.setText("取消全选");
			} else {
				this.selectedProcess.clear();
				this.selectedRemove.clear();
				selectAllBtn.setText("全部选中");
			}
			this.updateCheckboxes();
		});

		// 文件列表
		const listContainer = contentEl.createDiv("github-sync-file-list");

		// 打上标记，区分是 Process 还是 Remove
		const allFiles = [
			...opts.toProcess.map((f) => ({ ...f, _isRemove: false })),
			...opts.toRemove.map((f) => ({ ...f, _isRemove: true })),
		].sort((a, b) => a.path.localeCompare(b.path));

		// 最多显示 200 行，超出折叠
		const displayFiles = allFiles.slice(0, 200);
		const hasMore = allFiles.length > 200;

		for (const f of displayFiles) {
			const row = listContainer.createDiv("github-sync-file-row");
			
			// 新增：复选框
			const checkbox = row.createEl("input", { type: "checkbox" });
			checkbox.checked = f._isRemove
				? this.selectedRemove.has(f.path)
				: this.selectedProcess.has(f.path);
			checkbox.dataset.path = f.path;
			checkbox.dataset.isRemove = String(f._isRemove);
			
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					f._isRemove ? this.selectedRemove.add(f.path) : this.selectedProcess.add(f.path);
				} else {
					f._isRemove ? this.selectedRemove.delete(f.path) : this.selectedProcess.delete(f.path);
				}
			});

			// 核心重构：根据模式和方向决定图标与颜色
			let icon = " ";
			let cls = " ";
			if (isSmart || opts.mode === "merge") {
				if (f.direction === "upload") {
					icon = "⬆️";
					cls = "file-upload";   // 蓝色：上传
				} else if (f.direction === "download") {
					icon = "⬇️";
					cls = "file-download"; // 绿色：下载
				} else if (f.direction === "merge") {
					icon = "🔀";
					cls = "file-modified";  // 橙色：合并
				} else if (f.direction === "delete") {
					icon = "🗑️";
					cls = "file-deleted";  // 红色：删除
				}
			} else if (opts.mode === "push") {
				if (f.changeType === "added") {
					icon = "➕";
					cls = "file-added";    // 绿色：新增
				} else if (f.changeType === "modified") {
					icon = "✏️";
					cls = "file-modified"; // 橙色：修改
				} else if (f.changeType === "deleted") {
					icon = "🗑️";
					cls = "file-deleted";  // 红色：删除
				}
			} else if (opts.mode === "pull") {
				if (f.changeType === "added") {
					icon = "⬇️";
					cls = "file-download"; // 绿色：下载新文件
				} else if (f.changeType === "modified") {
					icon = "⬇️✏️";
					cls = "file-modified"; // 橙色：下载修改
				} else if (f.changeType === "deleted") {
					icon = "🗑️";
					cls = "file-deleted";  // 红色：本地删除
				}
			}

			row.createEl("span", { text: icon, cls: "file-icon" });
			row.createEl("span", { text: f.path, cls: `file-path ${cls}` });

			if (opts.onCompare) {
				const compareBtn = row.createEl("button", {
					text: "对比",
					cls: "github-sync-compare-btn",
				});
				compareBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					opts.onCompare!(f.path);
				});
			}

			// 点击整行也可以切换选中状态
			row.addEventListener("click", (e) => {
				if (e.target !== checkbox && !(e.target as HTMLElement).closest?.(".github-sync-compare-btn")) {
					checkbox.checked = !checkbox.checked;
					checkbox.dispatchEvent(new Event("change"));
				}
			});
		}

		if (hasMore) {
			listContainer.createEl("p", {
				text: `...以及 ${allFiles.length - 200} 个其他文件`,
				cls: "github-sync-more",
			});
		}

		const actionWord =
			opts.mode === "push" ? "上传到 GitHub"
			: opts.mode === "pull" ? "覆盖本地文件"
			: opts.mode === "time" ? "按最新修改时间同步"
			: "自动合并后同步";
		contentEl.createEl("p", {
			text: `确认后将直接${actionWord}，操作不可撤销。`,
			cls: "github-sync-warning",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("取消").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText(`确认${modeLabel}`)
					.setCta()
					.onClick(() => {
						// 过滤出选中的文件
						const sp = this.opts.toProcess.filter((f) => this.selectedProcess.has(f.path));
						const sr = this.opts.toRemove.filter((f) => this.selectedRemove.has(f.path));

						if (sp.length === 0 && sr.length === 0) {
							new Notice("⚠️ 未选择任何文件");
							return;
						}

						// 关掉对话框，后台执行同步
						this.close();
						this.opts.onConfirm(sp, sr).catch((err) => {
							console.error("后台同步出错:", err);
						});
					})
			);
	}

	private updateCheckboxes() {
		const checkboxes = this.contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		checkboxes.forEach((cb) => {
			const path = cb.dataset.path;
			const isRemove = cb.dataset.isRemove === "true";
			if (path) {
				cb.checked = isRemove ? this.selectedRemove.has(path) : this.selectedProcess.has(path);
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class ProgressModal extends Modal {
	private titleEl!: HTMLElement;
	private messageEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private progressBarEl!: HTMLElement;

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

		this.titleEl = contentEl.createEl("h2", { text: "同步中..." });
		this.messageEl = contentEl.createEl("p", {
			text: "正在准备...",
			cls: "github-sync-progress-msg",
		});
		this.progressEl = contentEl.createDiv("github-sync-progress-bar-wrap");
		this.progressBarEl = this.progressEl.createDiv(
			"github-sync-progress-bar-fill"
		);
	}

	setTitle(text: string) {
		if (this.titleEl) this.titleEl.setText(text);
	}

	setMessage(text: string) {
		if (this.messageEl) this.messageEl.setText(text);
	}

	setProgress(pct: number) {
		if (this.progressBarEl)
			this.progressBarEl.style.width = `${Math.min(100, pct)}%`;
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
		legendEl.createEl("span", { text: "⬜ 两端相同", cls: "diff-legend-item" });

		const statusEl = contentEl.createDiv({ cls: "github-sync-progress-modal" });
		statusEl.createEl("p", { text: "正在获取 GitHub 文件...", cls: "github-sync-progress-msg" });

		try {
			const { token, repository, branch } = this.plugin.settings;
			const client = new GitHubClient(token, repository, branch);

			const remoteFiles = await client.getFilesWithCommits(this.paths);

			statusEl.empty();

			if (remoteFiles.size === 0) {
				statusEl.createEl("p", { text: "⚠️ 无法获取远程文件信息", cls: "github-sync-warning" });
			} else {
				const scrollArea = contentEl.createDiv({ cls: "diff-scroll-area" });
				const sortedPaths = [...this.paths].sort((a, b) => a.localeCompare(b));
				this.identicalPaths = [];
				for (const path of sortedPaths) {
					const remoteInfo = remoteFiles.get(path);
					if (!remoteInfo) continue;

					const localFile = this.app.vault.getAbstractFileByPath(path);
					const section = scrollArea.createDiv({ cls: "diff-file-section" });

					if (!(localFile instanceof TFile)) {
						this.renderDeletedFile(section, path, remoteInfo);
					} else if (isTextFile(path)) {
						if (await this.renderTextDiff(section, path, localFile, remoteInfo)) {
							this.identicalPaths.push(path);
						}
					} else {
						if (await this.renderBinaryInfo(section, path, localFile, remoteInfo)) {
							this.identicalPaths.push(path);
						}
					}
				}

				if (this.onIdenticalFiles && this.identicalPaths.length > 0) {
					this.onIdenticalFiles(this.identicalPaths);
				}
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

	private renderDeletedFile(
		section: HTMLElement,
		path: string,
		remoteInfo: FileWithCommitInfo
	) {
		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: `🗑️ ${path}` });

		const body = summary.createDiv({ cls: "diff-file-body" });
		body.createEl("p", { text: "本地文件已删除", cls: "github-sync-warning" });

		if (remoteInfo.commitMessage || remoteInfo.commitDate) {
			const table = body.createEl("table", { cls: "diff-binary-table" });
			if (remoteInfo.commitMessage) {
				const row = table.insertRow();
				row.insertCell().textContent = "提交信息";
				row.insertCell().textContent = remoteInfo.commitMessage;
			}
			if (remoteInfo.commitDate) {
				const row = table.insertRow();
				row.insertCell().textContent = "提交时间";
				row.insertCell().textContent = new Date(remoteInfo.commitDate).toLocaleString();
			}
		}
	}

	private async renderTextDiff(
		section: HTMLElement,
		path: string,
		localFile: TFile,
		remoteInfo: FileWithCommitInfo
	): Promise<boolean> {
		let remoteText = "";
		if (remoteInfo.content) {
			remoteText = new TextDecoder().decode(remoteInfo.content);
		}

		let localText = "";
		try {
			localText = await this.app.vault.read(localFile);
		} catch {
			localText = "";
		}

		const headerParts = [`📝 ${path}`];
		if (remoteInfo.commitMessage) {
			headerParts.push(`— ${remoteInfo.commitMessage.slice(0, 60)}`);
		}
		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: headerParts.join(" ") });

		const body = summary.createDiv({ cls: "diff-file-body" });

		if (localText === remoteText || onlyTrailingBlankLinesDiffer(localText, remoteText)) {
			body.createEl("p", { text: "文件内容相同", cls: "github-sync-no-changes" });
			return true;
		}

		const container = body.createDiv({ cls: "cm-merge-view" });

		// 两侧均为只读（可复制，不可编辑）
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
			doc: remoteText,
			extensions: readOnlyExt,
		});

		const mv = new MergeView({
			a: aState,
			b: bState,
			parent: container,
			collapseUnchanged: { margin: 2, minSize: 3 },
		});

		this.mergeViews.push({ mv, path });

		return false;
	}

	private async renderBinaryInfo(
		section: HTMLElement,
		path: string,
		localFile: TFile,
		remoteInfo: FileWithCommitInfo
	): Promise<boolean> {
		const summary = section.createEl("details", { attr: { open: "" } });
		summary.createEl("summary", { text: `📎 ${path}` });

		const body = summary.createDiv({ cls: "diff-file-body" });

		// 二进制文件原始内容完全一致 → 标记为可清除
		if (remoteInfo.content) {
			let localContent: ArrayBuffer | null = null;
			try {
				localContent = await this.app.vault.readBinary(localFile);
			} catch {}

			if (localContent && arrayBuffersEqual(localContent, remoteInfo.content)) {
				body.createEl("p", { text: "文件内容相同", cls: "github-sync-no-changes" });
				return true;
			}
		}

		const table = body.createEl("table", { cls: "diff-binary-table" });

		const localSize = localFile.stat?.size ?? 0;

		const localRow = table.insertRow();
		localRow.insertCell().textContent = "本地大小";
		localRow.insertCell().textContent = this.formatSize(localSize);

		const remoteRow = table.insertRow();
		remoteRow.insertCell().textContent = "GitHub 大小";
		remoteRow.insertCell().textContent = this.formatSize(remoteInfo.size);

		if (remoteInfo.commitMessage) {
			const msgRow = table.insertRow();
			msgRow.insertCell().textContent = "提交信息";
			msgRow.insertCell().textContent = remoteInfo.commitMessage;
		}

		if (remoteInfo.commitDate) {
			const dateRow = table.insertRow();
			dateRow.insertCell().textContent = "提交时间";
			dateRow.insertCell().textContent = new Date(remoteInfo.commitDate).toLocaleString();
		}

		return false;
	}

	private formatSize(bytes: number): string {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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

// 新增：未同步警告弹窗
export class UnsyncedWarningModal extends Modal {
	private paths: string[];
	private onSync: () => void;
	private plugin: GitHubSyncPlugin;

	constructor(app: App, paths: string[], onSync: () => void, plugin: GitHubSyncPlugin) {
		super(app);
		this.paths = paths;
		this.onSync = onSync;
		this.plugin = plugin;
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
	}
}