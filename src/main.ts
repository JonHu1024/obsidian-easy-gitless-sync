// main.ts — GitHub Sync 插件入口

import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { GitHubClient, GitHubFile } from "./github";
import { computeDiff, DiffResult, FileDiff, isTextFile, mergeTexts } from "./diff";
import {
	ConfirmSyncModal,
	DiffViewerModal,
	ProgressModal,
	SyncMode,
	RollbackModal,
	SyncModeModal,
	UnsyncedWarningModal,
} from "./modals";
import {
	DEFAULT_SETTINGS,
	GitHubSyncSettings,
	GitHubSyncSettingTab,
} from "./settings";
import { CSS } from "./styles";
import { pMap, strToArrayBuffer, getErrorMessage } from "./utils";
import { RollbackManager } from "./rollback";

interface LocalFileSnapshot {
	files: Map<string, ArrayBuffer>;
	mtimes: Map<string, number>;
}

interface SmartSyncPlan {
	uploads: FileDiff[];
	downloads: FileDiff[];
	deletions: FileDiff[];
	merges: FileDiff[];
	previewItems: FileDiff[];
	unchanged: number;
}

export default class GitHubSyncPlugin extends Plugin {
	settings!: GitHubSyncSettings;
	private isSyncing = false;
	private isPreparing = false;
	private isDirty = false; // 最终是否有未同步的修改
	private statusBarEl!: HTMLElement; // 状态栏元素
	// 新增：用于记录未同步文件和防抖保存
	private unsyncedPaths = new Set<string>();
	private saveStateTimer: number | null = null;
	private recentlySyncedPaths = new Set<string>();// 冷却池：防止同步写入触发的 modify 被误判
	private rollbackManager: RollbackManager;

	async onload() {
		await this.loadSettings();

		this.rollbackManager = new RollbackManager(this.app);

		// 首次运行：默认提交信息自动填入设备名
		if (this.settings.commitMessage === DEFAULT_SETTINGS.commitMessage) {
			let hostname = "Device";
			try { hostname = require("os").hostname() || "Device"; } catch {}
			this.settings.commitMessage = `${hostname} sync {date}`;
			await this.saveSettings();
		}

		// 正常用户不可能一次退出前手动改了 10 个以上的文件还没同步。如果超过 10 个，绝对是之前启动风暴导致的脏数据，直接清空！
		if (this.settings.lastUnsyncedPaths && this.settings.lastUnsyncedPaths.length > 10) {
			this.settings.lastUnsyncedPaths = [];
			this.settings.hasUnsyncedChanges = false;
			await this.saveSettings();
		}

		// 恢复内存中的未同步集合（过滤已配置的忽略路径）
		if (this.settings.hasUnsyncedChanges) {
			this.isDirty = true;
			this.settings.lastUnsyncedPaths
				.filter(p => !this.shouldIgnoreBySettings(p))
				.forEach(p => this.unsyncedPaths.add(p));
		}

		//初始化状态栏
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		// 左侧边栏图标
		this.addRibbonIcon("github", "GitHub Sync", () => {
			this.openSyncModal();
		});

		// 命令面板
		this.addCommand({
			id: "open-sync-modal",
			name: "打开同步对话框",
			callback: () => this.openSyncModal(),
		});

		this.addCommand({
			id: "quick-push",
			name: "Quick Push(直接显示差异确认)",
			callback: () => this.startSync("push"),
		});

		this.addCommand({
			id: "quick-pull",
			name: "Quick Pull(直接显示差异确认)",
			callback: () => this.startSync("pull"),
		});

		this.addCommand({
			id: "quick-time",
			name: "按时间同步(按修改时间自动决定方向)",
			callback: () => this.startSync("time"),
		});

		this.addCommand({
			id: "quick-merge",
			name: "智能合并(自动合并冲突文件)",
			callback: () => this.startSync("merge"),
		});

		// 设置选项卡
		this.addSettingTab(new GitHubSyncSettingTab(this.app, this));

		// 注入样式
		this.injectStyles();

		//等待 Obsidian 完全启动、UI 渲染完毕后，再注册监听
		this.app.workspace.onLayoutReady(() => {
			let isBooting = true;
			// 5秒免疫期：防止其他插件在启动后异步写入配置文件
			setTimeout(() => { isBooting = false; }, 5000);

			const markDirty = (file: TAbstractFile) => {
				if (isBooting) return; // 免疫期内无视一切
				if (this.isSyncing) return;
				if (!(file instanceof TFile)) return;
				
				// 先硬编码无视 .obsidian 目录
				if (file.path.startsWith('.obsidian/') || file.path === '.obsidian') return;
				// 再检查用户配置的忽略路径
				if (this.shouldIgnoreBySettings(file.path)) return;
				
				if (this.recentlySyncedPaths.has(file.path)) return;

				this.unsyncedPaths.add(file.path);
				this.setDirty(true);
				this.debounceSaveState();
			};
			this.registerEvent(this.app.vault.on("modify", markDirty));
			this.registerEvent(this.app.vault.on("create", markDirty));
			this.registerEvent(this.app.vault.on("delete", markDirty));
			this.registerEvent(this.app.vault.on("rename", (file) => {
				if (file instanceof TFile) markDirty(file);
			}));
			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFile) {
						menu.addSeparator();
						menu.addItem((item) => {
							item
								.setTitle("GitHub Sync")
								.setIcon("github")
								.onClick(() => {
new SyncModeModal(
	this.app,
	(mode) => this.startSync(mode, file.path),
	() => this.openRollback()
).open();
								});
						});
					}
				})
			);
		});

		// 新增：启动时检查并弹出警告
		if (this.settings.showUnsyncedWarningOnStartup && this.settings.hasUnsyncedChanges) {
			setTimeout(() => {
				new UnsyncedWarningModal(
					this.app,
					this.settings.lastUnsyncedPaths || [],
					() => this.openSyncModal(),
					this
				).open();
			}, 800);//延迟0.8s防止与启动动画冲突
		}
	}

	onunload() {
		if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
		this.recentlySyncedPaths.clear();
		const style = document.getElementById("github-sync-styles");
		if (style) style.remove();
	}

	// 新增：防抖保存状态到 data.json (5秒内无新修改才写入，避免卡顿)
	private debounceSaveState() {
		if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
		this.saveStateTimer = window.setTimeout(async () => {
			this.settings.hasUnsyncedChanges = this.isDirty;
			this.settings.lastUnsyncedPaths = Array.from(this.unsyncedPaths);
			await this.saveSettings().catch(err => console.error("防抖保存状态失败:", err));
		}, 5*1000);
	}

	// 新增：彻底清理未同步状态（同步成功后调用）
	private async clearDirtyState() {
		try {
			await this.saveSettings();
		} catch (err) {
			console.error("清除脏状态时保存设置失败:", err);
			return;
		}
		this.isDirty = false;
		this.unsyncedPaths.clear();
		this.settings.hasUnsyncedChanges = false;
		this.settings.lastUnsyncedPaths = [];
		if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
		this.updateStatusBar();
	}

	// 对比发现内容一致的路径，从未同步列表中移除
	onCompareIdentical(paths: string[]) {
		let changed = false;
		for (const p of paths) {
			if (this.unsyncedPaths.delete(p)) changed = true;
		}
		if (!changed) return;

		if (this.unsyncedPaths.size === 0) {
			this.clearDirtyState();
		} else {
			this.debounceSaveState();
		}
	}

	// 修改原有的 setDirty，使其与持久化状态同步
	private setDirty(dirty: boolean) {
		if (this.isDirty !== dirty) {
			this.isDirty = dirty;
			this.updateStatusBar();
			// 如果变为 false，也触发一次保存（清理记录）
			if (!dirty) this.debounceSaveState();
		}
	}

	// 新增：更新状态栏 UI
	private updateStatusBar() {
		if (this.isDirty) {
			this.statusBarEl.setText("⚠️GitHub未同步");
			this.statusBarEl.style.color = "var(--text-warning, #e6922a)";
			this.statusBarEl.style.cursor = "pointer";
			this.statusBarEl.title = "点击对比未同步文件";
			this.statusBarEl.onclick = () => {
				if (this.unsyncedPaths.size > 0) {
					new DiffViewerModal(
						this.app,
						Array.from(this.unsyncedPaths),
						this,
						() => this.openSyncModal(),
						true,
						(paths) => this.onCompareIdentical(paths)
					).open();
				} else {
					this.openSyncModal();
				}
			};
		} else {
			this.statusBarEl.setText("✅GitHub已同步");
			this.statusBarEl.style.color = "var(--text-success, #28a745)";
			this.statusBarEl.style.cursor = "default";
			this.statusBarEl.title = "";
			this.statusBarEl.onclick = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		// 解密 token（base64 → 原文）
		if (this.settings.token) {
			try { this.settings.token = atob(this.settings.token); } catch {}
		}
	}

	async saveSettings() {
		const data = { ...this.settings };
		// 加密存储 token（原文 → base64）
		if (data.token) data.token = btoa(data.token);
		await this.saveData(data);
	}

	// ──────────────────────────────────────────────
	// 回滚快照
	// ──────────────────────────────────────────────

	/** 收集受影响的文件当前内容，供同步前快照使用 */
	private async collectPreSyncFiles(
		paths: string[]
	): Promise<Map<string, ArrayBuffer>> {
		const result = new Map<string, ArrayBuffer>();
		await pMap(
			paths,
			async (path) => {
				try {
					const file = this.app.vault.getAbstractFileByPath(
						normalizePath(path)
					);
					if (file instanceof TFile) {
						const content = await this.app.vault.readBinary(file);
						result.set(path, content);
					}
				} catch {}
			},
			8
		);
		return result;
	}

	// ──────────────────────────────────────────────
	// 同步入口
	// ──────────────────────────────────────────────

	private openSyncModal() {
		if (!this.checkConfig()) return;
		new SyncModeModal(
			this.app,
			(mode) => this.startSync(mode),
			() => this.openRollback()
		).open();
	}

	async startSync(mode: SyncMode, targetPath?: string) {
		if (!this.checkConfig()) return;

		if (this.isSyncing || this.isPreparing) {
			new Notice("正在同步...(点击屏幕空白区域可以后台运行同步)");
			return;
		}

		this.isPreparing = true;
		const progress = new ProgressModal(this.app);
		progress.open();

		try {
			const { token, repository, branch, ignorePaths } = this.settings;
			const ignore = ignorePaths
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);

			const client = new GitHubClient(token, repository, branch);

			// 1. 读取本地文件
			progress.setMessage(targetPath ? `读取 ${targetPath}...` : "读取本地 Vault 文件...");
			const local = await this.readLocalFiles(ignore);

			// 2. 读取远端文件列表
			progress.setMessage("获取 GitHub 文件列表...");
			const remote = await client.listAllFiles();

			// 3. 计算差异
			progress.setMessage("计算差异...");
			let diff = await computeDiff(local.files, remote.files, ignore);

			if (targetPath) {
				diff = {
					toUpload: diff.toUpload.filter((f) => f.path === targetPath),
					toDelete: diff.toDelete.filter((f) => f.path === targetPath),
					toDownload: diff.toDownload.filter((f) => f.path === targetPath),
					toRemove: diff.toRemove.filter((f) => f.path === targetPath),
					unchanged: diff.unchanged.filter((f) => f.path === targetPath),
				};
			}

			// 4. 生成同步计划(如需要)
			let smartPlan: SmartSyncPlan | null = null;
			if (mode === "time") {
				progress.setMessage("分析修改时间并生成同步计划...");
				smartPlan = await this.buildTimeSyncPlan(client, local, remote.files, diff);
			} else if (mode === "merge") {
				progress.setMessage("分析冲突并生成合并计划...");
				smartPlan = await this.buildMergePlan(client, local, remote.files, diff);
			}

			progress.close();

			// 5. 弹出确认框
			const onCompare = (path: string) => {
				new DiffViewerModal(
					this.app, [path], this, () => {}, false,
					(p) => this.onCompareIdentical(p)
				).open();
			};

			if (mode === "push") {
				const toProcess = diff.toUpload;
				const toRemove = diff.toDelete;
				new ConfirmSyncModal(this.app, {
					mode: "push",
					toProcess,
					toRemove,
					unchanged: diff.unchanged.length,
					onCompare,
					onConfirm: (selectedProcess, selectedRemove) =>
						this.executePush(
							client,
							local.files,
							remote.commitSha,
							remote.treeSha,
							selectedProcess,
							selectedRemove
						),
				}).open();
			} else if (mode === "pull") {
				const toProcess = diff.toDownload;
				const toRemove = diff.toRemove;
				new ConfirmSyncModal(this.app, {
					mode: "pull",
					toProcess,
					toRemove,
					unchanged: diff.unchanged.length,
					onCompare,
					onConfirm: (selectedProcess, selectedRemove) =>
						this.executePull(client, selectedProcess, selectedRemove),
				}).open();
			} else if (mode === "time") {
				if (!smartPlan) throw new Error("按时间同步计划生成失败");
				new ConfirmSyncModal(this.app, {
					mode: "time",
					toProcess: smartPlan.previewItems,
					toRemove: [],
					unchanged: smartPlan.unchanged,
					onCompare,
					onConfirm: (selectedProcess, selectedRemove) => {
						const uploads = selectedProcess.filter((f) => f.direction === "upload");
						const downloads = selectedProcess.filter((f) => f.direction === "download");
						const deletions = selectedProcess.filter((f) => f.direction === "delete");
						return this.executeSmartSync(
							client,
							local.files,
							remote.commitSha,
							remote.treeSha,
							uploads,
							downloads,
							deletions
						);
					},
				}).open();
			} else {
				if (!smartPlan) throw new Error("智能合并计划生成失败");
				new ConfirmSyncModal(this.app, {
					mode: "merge",
					toProcess: smartPlan.previewItems,
					toRemove: [],
					unchanged: smartPlan.unchanged,
					onCompare,
					onConfirm: async (selectedProcess, selectedRemove) => {
						const uploads = selectedProcess.filter((f) => f.direction === "upload");
						const downloads = selectedProcess.filter((f) => f.direction === "download");
						const merges = selectedProcess.filter((f) => f.direction === "merge");
						await this.executeMergeSync(
							client,
							local.files,
							remote.commitSha,
							remote.treeSha,
							uploads,
							downloads,
							merges
						);
					},
				}).open();
			}
		} catch (err) {
			progress.close();
			console.error("GitHub Sync error:", err);
			new Notice(`❌ 同步出错: ${getErrorMessage(err)}`);
		} finally {
			this.isPreparing = false;
		}
	}

	// ──────────────────────────────────────────────
	// 回滚
	// ──────────────────────────────────────────────

	private async openRollback() {
		if (!this.checkConfig()) return;
		try {
			const snapshots = await this.rollbackManager.getSnapshots();
			new RollbackModal(
				this.app,
				snapshots,
				async (id: string) => {
					await this.rollbackManager.applySnapshot(id);
					await this.clearDirtyState();
					this.rollbackManager.deleteSnapshot(id).catch(err => console.warn("删除已回滚的快照失败:", err));
				}
			).open();
		} catch (err) {
			new Notice(`❌ 获取历史版本失败: ${getErrorMessage(err)}`);
		}
	}

	// ──────────────────────────────────────────────
	// 智能同步计划
	// ──────────────────────────────────────────────

	private async buildTimeSyncPlan(
		client: GitHubClient,
		local: LocalFileSnapshot,
		remoteFiles: GitHubFile[],
		diff: DiffResult
	): Promise<SmartSyncPlan> {
		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f] as const));

		const uploads: FileDiff[] = [];
		const downloads: FileDiff[] = [];
		const deletions: FileDiff[] = [];

		// 先处理本地独有文件：必然上传
		for (const item of diff.toUpload) {
			if (item.changeType === "added") {
				uploads.push({ ...item, direction: "upload" });
			}
		}

		// 远端独有文件：从远端删除（反映本地删除状态）
		for (const item of diff.toDelete) {
			deletions.push({ ...item, direction: "delete" });
		}

		// 双方都存在但内容不同的文件：按修改时间决定方向
		const modifiedPaths = diff.toUpload
			.filter((item) => item.changeType === "modified")
			.map((item) => item.path);

		const remoteModTimes =
			modifiedPaths.length > 0
				? await client.getFileModTimes(modifiedPaths)
				: new Map<string, number>();

		for (const item of diff.toUpload) {
			if (item.changeType !== "modified") continue;

			const path = item.path;
			const localMtime = local.mtimes.get(path) ?? 0;
			const remoteMtime =
				remoteModTimes.get(path) ??
				remoteMap.get(path)?.remoteMtime ??
				0;

			const target = localMtime >= remoteMtime ? "upload" : "download";

			const enrichedItem: FileDiff = {
				...item,
				localMtime,
				remoteMtime,
				direction: target,
			};

			if (target === "upload") uploads.push(enrichedItem);
			else downloads.push(enrichedItem);
		}

		const previewItems = [...uploads, ...downloads, ...deletions].sort((a, b) =>
			a.path.localeCompare(b.path)
		);

		return {
			uploads,
			downloads,
			deletions,
			merges: [],
			previewItems,
			unchanged: diff.unchanged.length,
		};
	}

	// ──────────────────────────────────────────────
	// 智能合并计划
	// ──────────────────────────────────────────────

	private async buildMergePlan(
		client: GitHubClient,
		local: LocalFileSnapshot,
		remoteFiles: GitHubFile[],
		diff: DiffResult
	): Promise<SmartSyncPlan> {
		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f] as const));

		const uploads: FileDiff[] = [];
		const downloads: FileDiff[] = [];
		const merges: FileDiff[] = [];

		// 本地独有文件：上传
		for (const item of diff.toUpload) {
			if (item.changeType === "added") {
				uploads.push({ ...item, direction: "upload" });
			}
		}

		// 远端独有文件：下载
		for (const item of diff.toDownload) {
			if (item.changeType === "added") {
				downloads.push({ ...item, direction: "download" });
			}
		}

		// 双方都存在但内容不同的文件：自动合并（文本）或按时间（二进制）
		const modifiedPaths = diff.toUpload
			.filter((item) => item.changeType === "modified")
			.map((item) => item.path);

		const remoteModTimes =
			modifiedPaths.length > 0
				? await client.getFileModTimes(modifiedPaths)
				: new Map<string, number>();

		for (const item of diff.toUpload) {
			if (item.changeType !== "modified") continue;

			const path = item.path;
			const localMtime = local.mtimes.get(path) ?? 0;
			const remoteMtime =
				remoteModTimes.get(path) ??
				remoteMap.get(path)?.remoteMtime ??
				0;

			if (isTextFile(path)) {
				merges.push({
					...item,
					localMtime,
					remoteMtime,
					direction: "merge",
				});
			} else {
				// 二进制文件按时间决定方向
				const target = localMtime >= remoteMtime ? "upload" : "download";
				const enrichedItem: FileDiff = { ...item, localMtime, remoteMtime, direction: target };
				if (target === "upload") uploads.push(enrichedItem);
				else downloads.push(enrichedItem);
			}
		}

		const previewItems = [...uploads, ...downloads, ...merges].sort((a, b) =>
			a.path.localeCompare(b.path)
		);

		return {
			uploads,
			downloads,
			merges,
			previewItems,
			unchanged: diff.unchanged.length,
		};
	}

	// ──────────────────────────────────────────────
	// 执行 Push
	// ──────────────────────────────────────────────

	private async executePush(
		client: GitHubClient,
		localFiles: Map<string, ArrayBuffer>,
		currentCommitSha: string | null,
		currentTreeSha: string | null,
		toUpload: FileDiff[],
		toDelete: FileDiff[]
	) {
		this.isSyncing = true;
		const startNotice = new Notice(
			`⬆️ 开始 Push，上传 ${toUpload.length}，删除 ${toDelete.length}...`,
			0
		);
		try {
			// 快照 I/O 与网络 I/O 并行（Push 不改本地文件，无顺序约束）
			const preSyncPaths = [
				...toUpload.map((f) => f.path),
				...toDelete.map((f) => f.path),
			].filter((p) => p);
			const snapshotPromise = preSyncPaths.length > 0
				? this.collectPreSyncFiles(preSyncPaths).then(c => this.rollbackManager.saveSnapshot(c))
				: Promise.resolve();

			const message = this.buildCommitMessage();

			if (toUpload.length > 0) {
				const filesToUpload = toUpload
					.map((f) => {
						const content = localFiles.get(f.path);
						if (!content) return null;
						return { path: f.path, content };
					})
					.filter(Boolean) as { path: string; content: ArrayBuffer }[];

				const uploadResult = await client.batchUpload(
					filesToUpload,
					message,
					currentCommitSha,
					currentTreeSha
				);

				currentCommitSha = uploadResult.newCommitSha;
				currentTreeSha = uploadResult.newTreeSha;
			}

			if (toDelete.length > 0 && currentCommitSha && currentTreeSha) {
				await client.batchDelete(
					toDelete.map((f) => ({ path: f.path })),
					message,
					currentCommitSha,
					currentTreeSha
				);
			}

			await snapshotPromise;

			startNotice.hide();
			new Notice(`✅ Push 完成：上传 ${toUpload.length}，删除 ${toDelete.length}`);
			await this.clearDirtyState();
		} catch (err) {
			startNotice.hide();
			console.error("Push error:", err);
			new Notice(`❌ Push 出错: ${getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
		}
	}

	// ──────────────────────────────────────────────
	// 执行 Pull
	// ──────────────────────────────────────────────
	private async executePull(
		client: GitHubClient,
		toDownload: FileDiff[],
		toRemove: FileDiff[]
	) {
		this.isSyncing = true;
		toDownload.forEach(f => this.recentlySyncedPaths.add(f.path));
		const startNotice = new Notice(
			`⬇️ 开始 Pull，下载 ${toDownload.length}，删除 ${toRemove.length}...`,
			0
		);
		try {
			// 快照 I/O 与网络下载并行
			const preSyncPaths = [
				...toDownload.map((f) => f.path),
				...toRemove.map((f) => f.path),
			].filter((p) => p);
			const snapshotPromise = preSyncPaths.length > 0
				? this.collectPreSyncFiles(preSyncPaths).then(c => this.rollbackManager.saveSnapshot(c))
				: Promise.resolve();

			// 网络下载（与快照 I/O 并行）
			let downloaded = new Map<string, ArrayBuffer>();
			if (toDownload.length > 0) {
				const filesToDownload = toDownload.map((f) => ({ path: f.path, sha: f.remoteSha }));
				downloaded = await client.downloadFiles(filesToDownload);
			}

			// 等待快照完成后再写本地
			await snapshotPromise;

			if (toDownload.length > 0) {
				for (const { path } of toDownload) {
					const content = downloaded.get(path);
					if (!content) continue;
					await this.writeLocalFile(path, content);
				}
			}

			for (const f of toRemove) {
				await this.deleteLocalFile(f.path);
			}

			startNotice.hide();
			new Notice(
				`✅ Pull 完成：下载 ${toDownload.length}，删除 ${toRemove.length}`
			);
			await this.clearDirtyState();
		} catch (err) {
			startNotice.hide();
			console.error("Pull error:", err);
			new Notice(`❌ Pull 出错: ${getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
			setTimeout(() => {
				toDownload.forEach(f => this.recentlySyncedPaths.delete(f.path));
			}, 2000);
		}
	}

	// ──────────────────────────────────────────────
	// 执行智能同步
	// ──────────────────────────────────────────────

	private async executeSmartSync(
		client: GitHubClient,
		localFiles: Map<string, ArrayBuffer>,
		currentCommitSha: string | null,
		currentTreeSha: string | null,
		uploads: FileDiff[],
		downloads: FileDiff[],
		toDeleteFromRemote: FileDiff[] = []
	) {
		this.isSyncing = true;
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = new Notice(
			`🔀 开始智能同步，上传 ${uploads.length}，下载 ${downloads.length}...`,
			0
		);
		try {
			// 快照 I/O 与网络 I/O 并行
			const preSyncPaths = [
				...uploads.map((f) => f.path),
				...downloads.map((f) => f.path),
				...toDeleteFromRemote.map((f) => f.path),
			].filter((p) => p);
			const snapshotPromise = preSyncPaths.length > 0
				? this.collectPreSyncFiles(preSyncPaths).then(c => this.rollbackManager.saveSnapshot(c))
				: Promise.resolve();

			const message = this.buildCommitMessage();

			const uploadPromise = uploads.length > 0
				? client.batchUpload(
					uploads
						.map((f) => {
							const content = localFiles.get(f.path);
							if (!content) return null;
							return { path: f.path, content };
						})
						.filter(Boolean) as { path: string; content: ArrayBuffer }[],
					message,
					currentCommitSha,
					currentTreeSha
				  ).then(r => ({ commitSha: r.newCommitSha, treeSha: r.newTreeSha }))
				: Promise.resolve(null);

			const downloadPromise = downloads.length > 0
				? client.downloadFiles(
					downloads.map((f) => ({ path: f.path, sha: f.remoteSha }))
				  )
				: Promise.resolve(new Map<string, ArrayBuffer>());

			const [uploadResult, downloaded] = await Promise.all([uploadPromise, downloadPromise]);

			// 等待快照完成后再写本地
			await snapshotPromise;

			// 删除远端文件（需要 upload 之后的 sha）
			if (toDeleteFromRemote.length > 0) {
				const delCommitSha = uploadResult?.commitSha ?? currentCommitSha;
				const delTreeSha = uploadResult?.treeSha ?? currentTreeSha;
				if (delCommitSha && delTreeSha) {
					const delMessage = this.buildCommitMessage();
					await client.batchDelete(
						toDeleteFromRemote.map((f) => ({ path: f.path })),
						delMessage,
						delCommitSha,
						delTreeSha
					);
				}
			}

			for (const f of downloads) {
				const content = downloaded.get(f.path);
				if (!content) continue;
				await this.writeLocalFile(f.path, content);
			}

			startNotice.hide();
			new Notice(
				`✅ 智能同步完成：上传 ${uploads.length}，下载 ${downloads.length}，删除 ${toDeleteFromRemote.length}`
			);
			await this.clearDirtyState();
		} catch (err) {
			startNotice.hide();
			console.error("Smart sync error:", err);
			new Notice(`❌ 智能同步出错: ${getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
			setTimeout(() => {
				downloads.forEach(f => this.recentlySyncedPaths.delete(f.path));
			}, 2000);
		}
	}

	// ──────────────────────────────────────────────
	// 执行智能合并
	// ──────────────────────────────────────────────

	private async executeMergeSync(
		client: GitHubClient,
		localFiles: Map<string, ArrayBuffer>,
		currentCommitSha: string | null,
		currentTreeSha: string | null,
		uploads: FileDiff[],
		downloads: FileDiff[],
		merges: FileDiff[]
	) {
		this.isSyncing = true;
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));
		merges.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = new Notice(
			`🔀 开始合并同步，上传 ${uploads.length}，下载 ${downloads.length}，合并 ${merges.length}...`,
			0
		);
		try {
			// Phase 1：快照 I/O + 所有网络请求并行
			const preSyncPaths = [
				...uploads.map((f) => f.path),
				...downloads.map((f) => f.path),
				...merges.map((f) => f.path),
			].filter((p) => p);
			const snapshotPromise = preSyncPaths.length > 0
				? this.collectPreSyncFiles(preSyncPaths).then(c => this.rollbackManager.saveSnapshot(c))
				: Promise.resolve();

			const message = this.buildCommitMessage();

			// 并行获取 merge 远程内容 + 下载文件
			const mergeDownloadsPromise = Promise.all(
				merges.map(async (item) => {
					const rc = await client.downloadFile(item.path, item.remoteSha).catch(() => null);
					return { item, remoteContent: rc };
				})
			);

			const downloadPromise = downloads.length > 0
				? client.downloadFiles(
					downloads.map((f) => ({ path: f.path, sha: f.remoteSha }))
				  )
				: Promise.resolve(new Map<string, ArrayBuffer>());

			const [mergeDownloads, downloaded] = await Promise.all([mergeDownloadsPromise, downloadPromise]);
			await snapshotPromise;

			// Phase 2：合并写入（顺序），然后上传
			for (const { item, remoteContent } of mergeDownloads) {
				if (!remoteContent) continue;
				const localBuf = localFiles.get(item.path);
				if (!localBuf) continue;
				const localText = new TextDecoder().decode(localBuf);
				const remoteText = new TextDecoder().decode(remoteContent);
				const mergedText = mergeTexts(localText, remoteText);
				const mergedBuf = strToArrayBuffer(mergedText);
				await this.writeLocalFile(item.path, mergedBuf);
				localFiles.set(item.path, mergedBuf);
			}

			if (uploads.length > 0 || merges.length > 0) {
				const filesToUpload = [...uploads, ...merges]
					.map((f) => {
						const content = localFiles.get(f.path);
						if (!content) return null;
						return { path: f.path, content };
					})
					.filter(Boolean) as { path: string; content: ArrayBuffer }[];

				if (filesToUpload.length > 0) {
					await client.batchUpload(
						filesToUpload, message, currentCommitSha, currentTreeSha
					);
				}
			}

			// Phase 3：下载写入本地
			for (const f of downloads) {
				const content = downloaded.get(f.path);
				if (!content) continue;
				await this.writeLocalFile(f.path, content);
			}

			startNotice.hide();
			new Notice(`✅ 合并同步完成：上传 ${uploads.length}，下载 ${downloads.length}，合并 ${merges.length}`);
			await this.clearDirtyState();
		} catch (err) {
			startNotice.hide();
			console.error("Merge sync error:", err);
			new Notice(`❌ 合并同步出错: ${getErrorMessage(err)}`);
		} finally {
			this.isSyncing = false;
			setTimeout(() => {
				[...downloads, ...merges].forEach(f => this.recentlySyncedPaths.delete(f.path));
			}, 2000);
		}
	}

	// ──────────────────────────────────────────────
	// 本地文件操作
	// ──────────────────────────────────────────────

	private async readLocalFiles(ignore: string[]): Promise<LocalFileSnapshot> {
		const files = this.app.vault.getFiles();
		const filtered = files.filter((file) => !this.shouldIgnoreLocal(file.path, ignore));

		const items = await pMap(
			filtered,
			async (file) => {
				try {
					const content = await this.app.vault.readBinary(file);
					const mtime = file.stat?.mtime ?? file.stat?.ctime ?? 0;
					return { path: file.path, content, mtime };
				} catch (err) {
					console.warn(`读取本地文件失败: ${file.path}`, err);
					return null;
				}
			},
			8
		);

		const result: LocalFileSnapshot = {
			files: new Map<string, ArrayBuffer>(),
			mtimes: new Map<string, number>(),
		};

		for (const item of items) {
			if (!item) continue;
			result.files.set(item.path, item.content);
			result.mtimes.set(item.path, item.mtime);
		}

		return result;
	}

	private async writeLocalFile(
		path: string,
		content: ArrayBuffer
	): Promise<void> {
		const normalPath = normalizePath(path);
		// 确保父目录存在
		const dir = normalPath.substring(0, normalPath.lastIndexOf("/"));
		if (dir) {
			await this.ensureFolder(dir);
		}

		const existing = this.app.vault.getAbstractFileByPath(normalPath);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, content);
		} else {
			await this.app.vault.createBinary(normalPath, content);
		}
	}

	private async deleteLocalFile(path: string): Promise<void> {
		const normalPath = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalPath);
		if (file) {
			await this.app.vault.trash(file, true);
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const norm = normalizePath(current);
			const existing = this.app.vault.getAbstractFileByPath(norm);
			if (!existing) {
				try {
					await this.app.vault.createFolder(norm);
				} catch (err) {
					// 并发创建文件夹时可能冲突，忽略
				}
			}
		}
	}

	// ──────────────────────────────────────────────
	// 辅助函数
	// ──────────────────────────────────────────────

	private checkConfig(): boolean {
		const { token, repository } = this.settings;
		if (!token || !repository) {
			new Notice(
				"⚠️ 请先在插件设置中填写 GitHub Token 和仓库名称"
			);
			// 打开设置
			(this.app as any).setting?.open?.();
			(this.app as any).setting?.openTabById?.("github-sync");
			return false;
		}
		return true;
	}

	private shouldIgnoreLocal(path: string, ignore: string[]): boolean {
		const normalized = path.replace(/\\/g, "/");
		for (const prefix of ignore) {
			const p = prefix.replace(/\\/g, "/");
			if (normalized === p || normalized.startsWith(p + "/")) return true;
		}
		return false;
	}

	private shouldIgnoreBySettings(path: string): boolean {
		const ignores = this.settings.ignorePaths
			.split("\n")
			.map(s => s.trim())
			.filter(Boolean);
		return this.shouldIgnoreLocal(path, ignores);
	}

	private buildCommitMessage(): string {
		const now = new Date().toISOString().replace("T", " ").substring(0, 19);
		return this.settings.commitMessage.replace("{date}", now);
	}

	// ──────────────────────────────────────────────
	// 样式注入
	// ──────────────────────────────────────────────

	private injectStyles() {
		if (document.getElementById("github-sync-styles")) return;
		const style = document.createElement("style");
		style.id = "github-sync-styles";
		style.textContent = CSS;
		document.head.appendChild(style);
	}
}


