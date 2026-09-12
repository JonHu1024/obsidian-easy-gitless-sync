// main.ts — GitHub Sync 插件入口

import { Notice, Plugin, TFile, TAbstractFile, Menu, normalizePath } from "obsidian";
import { GitHubClient, GitHubFile } from "./github";
import { computeDiff, computeGitBlobSha, DiffResult, FileDiff, isTextFile, mergeTexts } from "./diff";
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

/** sha 缓存条目:mtime+size 未变即复用 sha,跳过读取与哈希 */
interface HashCacheEntry {
	mtime: number;
	size: number;
	sha: string;
}

/** 本地 sha 缓存文件(adapter 读写,不进 vault 索引) */
const HASH_CACHE_PATH = ".obsidian/plugins/easy-gitless-sync/hash-cache.json";

/** syncedPaths 持久化上限(超出裁剪旧记录) */
const SYNCED_PATHS_CAP = 5000;

interface LocalFileSnapshot {
	/** path -> 内容;未变化的文件为 null(sha 已与远端一致,后续流程用不到内容) */
	files: Map<string, ArrayBuffer | null>;
	mtimes: Map<string, number>;
	/** 本地 git blob sha(读取阶段预计算/缓存) */
	shas: Map<string, string>;
	/** 读取失败的文件:本次同步对其"不可见",避免被误判为删除/新增 */
	failedPaths: string[];
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
	private settingsSaveTimer: number | null = null; // 设置页防抖保存
	private ignoreListCache: string[] | null = null; // 忽略路径解析缓存
	private recentlySyncedPaths = new Set<string>();// 冷却池：防止同步写入触发的 modify 被误判
	private rollbackManager!: RollbackManager;

	async onload() {
		await this.loadSettings();

		this.rollbackManager = new RollbackManager(this.app);

		// 首次运行：默认提交信息自动填入设备名
		if (this.settings.commitMessage === DEFAULT_SETTINGS.commitMessage) {
			let hostname = "Device";
			try {
				// Electron 渲染进程(nodeIntegration)下可用 require;移动端没有,回退默认名
				const req = (globalThis as { require?: (id: string) => { hostname(): string } }).require;
				hostname = req?.("os")?.hostname() || "Device";
			} catch {}
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
		this.addRibbonIcon("github", "Easy Gitless Sync", () => {
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
				
				// .obsidian 目录：未开启同步、或该子项未被选中同步时忽略
				if (this.isObsidianPath(file.path)) {
					if (!this.settings.syncObsidianFolder || !this.isObsidianEntrySelected(file.path)) return;
				}
				// 再检查用户配置的忽略路径
				if (this.shouldIgnoreBySettings(file.path)) return;

				if (this.recentlySyncedPaths.has(file.path)) return;

				this.unsyncedPaths.add(file.path);
				this.setDirty(true);
				this.debounceSaveState();
			};
			const markDeleted = (file: TAbstractFile) => {
				if (isBooting) return;
				if (this.isSyncing) return;
				if (!(file instanceof TFile)) return;
				// .obsidian 目录：未开启同步、或该子项未被选中同步时忽略
				if (this.isObsidianPath(file.path)) {
					if (!this.settings.syncObsidianFolder || !this.isObsidianEntrySelected(file.path)) return;
				}
				if (this.recentlySyncedPaths.has(file.path)) return;
				if (this.settings.syncedPaths.includes(file.path)) {
					// 之前同步过的文件被删除 → pending delete
					this.unsyncedPaths.add(file.path);
					this.setDirty(true);
					this.debounceSaveState();
				} else {
					// 本地新建又删除 → 移除跟踪
					if (this.unsyncedPaths.delete(file.path)) {
						if (this.unsyncedPaths.size === 0) {
							this.clearDirtyState();
						} else {
							this.debounceSaveState();
						}
					}
				}
			};
			this.registerEvent(this.app.vault.on("modify", markDirty));
			this.registerEvent(this.app.vault.on("create", markDirty));
			this.registerEvent(this.app.vault.on("delete", markDeleted));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				this.unsyncedPaths.delete(oldPath); // 旧路径不再跟踪,避免残留
				markDirty(file);
			}));
			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (file instanceof TFile) {
						menu.addSeparator();
						menu.addItem((item) => {
							item
								.setTitle("Easy Gitless Sync")
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
				const validPaths = (this.settings.lastUnsyncedPaths || [])
					.filter(p => !this.shouldIgnoreBySettings(p));
				if (validPaths.length > 0) {
					new UnsyncedWarningModal(
						this.app,
						validPaths,
						() => this.openSyncModal(),
						this
					).open();
				}
			}, 800);//延迟0.8s防止与启动动画冲突
		}
	}

	onunload() {
		// 有未落盘的防抖状态时立即保存(best-effort:异步写盘不保证在退出前完成)
		if (this.saveStateTimer) {
			window.clearTimeout(this.saveStateTimer);
			this.saveStateTimer = null;
			void this.flushPendingState();
		}
		if (this.settingsSaveTimer) {
			window.clearTimeout(this.settingsSaveTimer);
			this.settingsSaveTimer = null;
			void this.saveSettings().catch(() => {});
		}
		this.recentlySyncedPaths.clear();
		const style = document.getElementById("github-sync-styles");
		if (style) style.remove();
	}

	// 新增：防抖保存状态到 data.json (5秒内无新修改才写入，避免卡顿)
	private debounceSaveState() {
		if (this.saveStateTimer) window.clearTimeout(this.saveStateTimer);
		this.saveStateTimer = window.setTimeout(() => {
			this.saveStateTimer = null;
			void this.flushPendingState();
		}, 5*1000);
	}

	/** 立即把当前未同步状态写入 data.json(防抖到期或退出时调用) */
	private async flushPendingState(): Promise<void> {
		this.settings.hasUnsyncedChanges = this.isDirty;
		this.settings.lastUnsyncedPaths = Array.from(this.unsyncedPaths);
		await this.saveSettings().catch(err => console.error("保存未同步状态失败:", err));
	}

	/** 设置页输入防抖保存,避免每个按键都写一次盘 */
	debounceSaveSettings(): void {
		if (this.settingsSaveTimer) window.clearTimeout(this.settingsSaveTimer);
		this.settingsSaveTimer = window.setTimeout(() => {
			this.settingsSaveTimer = null;
			void this.saveSettings().catch(err => console.error("保存设置失败:", err));
		}, 300);
	}

	// 新增：彻底清理未同步状态（同步成功后调用）
	private async clearDirtyState() {
		this.isDirty = false;
		this.unsyncedPaths.clear();
		this.settings.hasUnsyncedChanges = false;
		this.settings.lastUnsyncedPaths = [];
		if (this.saveStateTimer) {
			window.clearTimeout(this.saveStateTimer);
			this.saveStateTimer = null;
		}
		try {
			await this.saveSettings();
		} catch (err) {
			console.error("清除脏状态时保存设置失败:", err);
		}
		this.updateStatusBar();
	}

	// 同步成功后更新 syncedPaths 并清理脏状态
	private async finalizeSync(
		uploadedPaths: string[],
		downloadedPaths: string[],
		deletedPaths: string[]
	) {
		const set = new Set(this.settings.syncedPaths);
		for (const p of uploadedPaths) if (p) set.add(p);
		for (const p of downloadedPaths) if (p) set.add(p);
		for (const p of deletedPaths) if (p) set.delete(p);
		// 上限保护：syncedPaths 只用于"未同步提醒"的删除判定，不影响 diff 正确性，
		// 超出时保留最新记录，防止 data.json 无限膨胀
		const list = Array.from(set);
		this.settings.syncedPaths =
			list.length > SYNCED_PATHS_CAP ? list.slice(-SYNCED_PATHS_CAP) : list;
		await this.clearDirtyState();
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
			this.statusBarEl.title = "为强迫症用户设计。如有新的文件修改，仍将切换为未同步的状态";
			this.statusBarEl.onclick = (event: MouseEvent) => {
				const menu = new Menu();
				menu.addItem((item) =>
					item.setTitle("对比未同步文件").onClick(() => {
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
					})
				);
				menu.addItem((item) =>
					item.setTitle("本次状态设为已同步").onClick(async () => {
						await this.clearDirtyState();
						new Notice("✅ 已标记为已同步状态");
					})
				);
				menu.showAtMouseEvent(event);
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
		this.ignoreListCache = null; // 忽略路径可能已变化
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
					if (this.isObsidianPath(path)) {
						const normalPath = normalizePath(path);
						if (await this.app.vault.adapter.exists(normalPath)) {
							result.set(
								path,
								await this.app.vault.adapter.readBinary(normalPath)
							);
						}
					} else {
						const file = this.app.vault.getAbstractFileByPath(
							normalizePath(path)
						);
						if (file instanceof TFile) {
							const content = await this.app.vault.readBinary(file);
							result.set(path, content);
						}
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
			const { token, repository, branch } = this.settings;
			const ignore = this.buildIgnoreList();

			const client = new GitHubClient(token, repository, branch);

			// 1. 先获取远端文件列表:本地读取可借助 sha 缓存跳过未变化文件
			progress.setMessage("获取 GitHub 文件列表...");
			progress.setProgress(-1); // 总数未知,显示流动条
			const remote = await client.listAllFiles();

			// 2. 读取本地文件(未变化的文件不读内容)
			progress.setMessage(targetPath ? `读取 ${targetPath}...` : "读取本地 Vault 文件...");
			progress.setProgress(0);
			const local = await this.readLocalFiles(ignore, remote.files, (done, total) => {
				// 节流:每 25 个文件或最后一个时才刷新 UI
				if (done === total || done % 25 === 0) {
					progress.setMessage(`读取本地文件 ${done}/${total}...`);
					progress.setProgress((done / Math.max(total, 1)) * 95);
				}
			});

			// 3. 计算差异
			progress.setMessage("计算差异...");
			progress.setProgress(97);
			// .obsidian 中未被选中同步的子项对两端同时"不可见",
			// 否则远端存在但本地未选中的文件会被当作差异,Push 时被删除
			const extraIgnore = (p: string) => this.isObsidianPath(p) && !this.isObsidianEntrySelected(p);
			let diff = await computeDiff(local.files, local.shas, remote.files, ignore, extraIgnore);

			// 读取失败的文件本次"不可见":既不上传/删除,也不下载/覆盖,
			// 否则瞬时读取失败(如文件被占用)会被误判成"本地已删除"而误删远端
			if (local.failedPaths.length > 0) {
				const failed = new Set(local.failedPaths);
				diff = {
					toUpload: diff.toUpload.filter((f) => !failed.has(f.path)),
					toDelete: diff.toDelete.filter((f) => !failed.has(f.path)),
					toDownload: diff.toDownload.filter((f) => !failed.has(f.path)),
					toRemove: diff.toRemove.filter((f) => !failed.has(f.path)),
					unchanged: diff.unchanged,
				};
				new Notice(
					`⚠️ ${local.failedPaths.length} 个文件读取失败，本次同步已跳过：${this.formatFailedPaths(local.failedPaths)}`,
					8000
				);
			}

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
				progress.setProgress(-1); // 需要按文件查询远端,总数即文件数但耗时未知
				smartPlan = await this.buildTimeSyncPlan(client, local, remote.files, diff);
			} else if (mode === "merge") {
				progress.setMessage("分析冲突并生成合并计划...");
				progress.setProgress(-1);
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
				if (toProcess.length === 0 && toRemove.length === 0) {
					// 单文件同步时只清理该文件的跟踪,避免误清其他未同步记录
					if (targetPath) this.onCompareIdentical([targetPath]);
					else await this.clearDirtyState();
					new Notice(`✅ 已是最新，无需同步`);
					return;
				}
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
				if (toProcess.length === 0 && toRemove.length === 0) {
					// 单文件同步时只清理该文件的跟踪,避免误清其他未同步记录
					if (targetPath) this.onCompareIdentical([targetPath]);
					else await this.clearDirtyState();
					new Notice(`✅ 已是最新，无需同步`);
					return;
				}
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
				if (smartPlan.previewItems.length === 0) {
					// 单文件同步时只清理该文件的跟踪,避免误清其他未同步记录
					if (targetPath) this.onCompareIdentical([targetPath]);
					else await this.clearDirtyState();
					new Notice(`✅ 已是最新，无需同步`);
					return;
				}
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
				if (smartPlan.previewItems.length === 0) {
					// 单文件同步时只清理该文件的跟踪,避免误清其他未同步记录
					if (targetPath) this.onCompareIdentical([targetPath]);
					else await this.clearDirtyState();
					new Notice(`✅ 已是最新，无需同步`);
					return;
				}
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
			deletions: [],
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
		localFiles: Map<string, ArrayBuffer | null>,
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
			let uploadedPaths: string[] = [];

			if (toUpload.length > 0) {
				const filesToUpload = toUpload
					.map((f) => {
						const content = localFiles.get(f.path);
						if (!content) return null;
						return { path: f.path, content };
					})
					.filter(Boolean) as { path: string; content: ArrayBuffer }[];

				if (filesToUpload.length > 0) {
					const uploadResult = await client.batchUpload(
						filesToUpload,
						message,
						currentCommitSha,
						currentTreeSha,
						(done, total, path) =>
							this.setNoticeText(startNotice, `⬆️ 上传中 ${done}/${total}：${path}`)
					);

					currentCommitSha = uploadResult.newCommitSha;
					currentTreeSha = uploadResult.newTreeSha;
					// 以实际上传的文件为准(读取失败的会被跳过)
					uploadedPaths = filesToUpload.map((f) => f.path);
				}
			}

			if (toDelete.length > 0 && currentCommitSha && currentTreeSha) {
				this.setNoticeText(startNotice, `🗑️ 正在从远端删除 ${toDelete.length} 个文件...`);
				await client.batchDelete(
					toDelete.map((f) => ({ path: f.path })),
					message,
					currentCommitSha,
					currentTreeSha
				);
			}

			await snapshotPromise;

			startNotice.hide();
			new Notice(`✅ Push 完成：上传 ${uploadedPaths.length}，删除 ${toDelete.length}`);
			await this.finalizeSync(
				uploadedPaths,
				[],
				toDelete.map(f => f.path)
			);
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
				downloaded = await client.downloadFiles(filesToDownload, (done, total, path) =>
					this.setNoticeText(startNotice, `⬇️ 下载中 ${done}/${total}：${path}`)
				);
			}

			// 等待快照完成后再写本地
			await snapshotPromise;

			// 只把真正拿到内容的文件算作成功
			const writtenPaths = toDownload.filter(f => downloaded.get(f.path)).map(f => f.path);
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
			const failedDownloads = toDownload.filter(f => !downloaded.get(f.path)).map(f => f.path);
			if (failedDownloads.length > 0) {
				new Notice(
					`⚠️ ${failedDownloads.length} 个文件下载失败，未写入：${this.formatFailedPaths(failedDownloads)}`,
					8000
				);
			}
			new Notice(
				`✅ Pull 完成：下载 ${writtenPaths.length}/${toDownload.length}，删除 ${toRemove.length}`
			);
			await this.finalizeSync(
				[],
				writtenPaths,
				toRemove.map(f => f.path)
			);
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
		localFiles: Map<string, ArrayBuffer | null>,
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

			// 内容缺失的文件跳过上传(在本地快照里就是 null)
			const filesToUpload = uploads
				.map((f) => {
					const content = localFiles.get(f.path);
					if (!content) return null;
					return { path: f.path, content };
				})
				.filter(Boolean) as { path: string; content: ArrayBuffer }[];

			const uploadPromise = filesToUpload.length > 0
				? client.batchUpload(
					filesToUpload,
					message,
					currentCommitSha,
					currentTreeSha,
					(done, total, path) =>
						this.setNoticeText(startNotice, `⬆️ 上传中 ${done}/${total}：${path}`)
				  ).then(r => ({ commitSha: r.newCommitSha, treeSha: r.newTreeSha }))
				: Promise.resolve(null);

			const downloadPromise = downloads.length > 0
				? client.downloadFiles(
					downloads.map((f) => ({ path: f.path, sha: f.remoteSha })),
					(done, total, path) =>
						this.setNoticeText(startNotice, `⬇️ 下载中 ${done}/${total}：${path}`)
				  )
				: Promise.resolve(new Map<string, ArrayBuffer>());

			const [uploadResult, downloaded] = await Promise.all([uploadPromise, downloadPromise]);
			// 以实际成功为准:上传了才算上传,拿到内容并写入才算下载
			const uploadedPaths = uploadResult ? filesToUpload.map((f) => f.path) : [];
			const writtenPaths = downloads.filter(f => downloaded.get(f.path)).map(f => f.path);

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
			const failedUploads = uploads.filter(f => !localFiles.get(f.path)).map(f => f.path);
			const failedDownloads = downloads.filter(f => !downloaded.get(f.path)).map(f => f.path);
			if (failedUploads.length > 0) {
				new Notice(
					`⚠️ ${failedUploads.length} 个文件内容不可用，未上传：${this.formatFailedPaths(failedUploads)}`,
					8000
				);
			}
			if (failedDownloads.length > 0) {
				new Notice(
					`⚠️ ${failedDownloads.length} 个文件下载失败，未写入：${this.formatFailedPaths(failedDownloads)}`,
					8000
				);
			}
			new Notice(
				`✅ 智能同步完成：上传 ${uploadedPaths.length}/${uploads.length}，下载 ${writtenPaths.length}/${downloads.length}，删除 ${toDeleteFromRemote.length}`
			);
			await this.finalizeSync(
				uploadedPaths,
				writtenPaths,
				toDeleteFromRemote.map(f => f.path)
			);
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
		localFiles: Map<string, ArrayBuffer | null>,
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
			let mergeDone = 0;
			const mergeDownloadsPromise = Promise.all(
				merges.map(async (item) => {
					const rc = await client.downloadFile(item.path, item.remoteSha).catch(() => null);
					mergeDone++;
					this.setNoticeText(startNotice, `🔀 拉取冲突文件 ${mergeDone}/${merges.length}：${item.path}`);
					return { item, remoteContent: rc };
				})
			);

			const downloadPromise = downloads.length > 0
				? client.downloadFiles(
					downloads.map((f) => ({ path: f.path, sha: f.remoteSha })),
					(done, total, path) =>
						this.setNoticeText(startNotice, `⬇️ 下载中 ${done}/${total}：${path}`)
				  )
				: Promise.resolve(new Map<string, ArrayBuffer>());

			const [mergeDownloads, downloaded] = await Promise.all([mergeDownloadsPromise, downloadPromise]);
			await snapshotPromise;

			// Phase 2：合并写入（顺序），然后上传
			const mergedPaths: string[] = [];
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
				mergedPaths.push(item.path);
			}

			let uploadedPaths: string[] = [];
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
						filesToUpload, message, currentCommitSha, currentTreeSha,
						(done, total, path) =>
							this.setNoticeText(startNotice, `⬆️ 上传中 ${done}/${total}：${path}`)
					);
					uploadedPaths = filesToUpload.map((f) => f.path);
				}
			}

			// Phase 3：下载写入本地
			const writtenPaths = downloads.filter(f => downloaded.get(f.path)).map(f => f.path);
			for (const f of downloads) {
				const content = downloaded.get(f.path);
				if (!content) continue;
				await this.writeLocalFile(f.path, content);
			}

			startNotice.hide();
			const mergedSet = new Set(mergedPaths);
			const failedMerges = merges.filter(f => !mergedSet.has(f.path)).map(f => f.path);
			if (failedMerges.length > 0) {
				new Notice(
					`⚠️ ${failedMerges.length} 个文件无法合并（远端内容不可用），已按原样保留：${this.formatFailedPaths(failedMerges)}`,
					8000
				);
			}
			const failedDownloads = downloads.filter(f => !downloaded.get(f.path)).map(f => f.path);
			if (failedDownloads.length > 0) {
				new Notice(
					`⚠️ ${failedDownloads.length} 个文件下载失败，未写入：${this.formatFailedPaths(failedDownloads)}`,
					8000
				);
			}
			new Notice(
				`✅ 合并同步完成：上传 ${uploadedPaths.length}/${uploads.length + merges.length}，下载 ${writtenPaths.length}/${downloads.length}，合并 ${mergedPaths.length}/${merges.length}`
			);
			await this.finalizeSync(
				uploadedPaths,
				writtenPaths,
				[]
			);
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

	private async readLocalFiles(
		ignore: string[],
		remoteFiles: GitHubFile[],
		onProgress?: (done: number, total: number) => void
	): Promise<LocalFileSnapshot> {
		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f] as const));
		const cache = await this.loadHashCache();
		const nextCache: Record<string, HashCacheEntry> = {};

		const result: LocalFileSnapshot = {
			files: new Map<string, ArrayBuffer | null>(),
			mtimes: new Map<string, number>(),
			shas: new Map<string, string>(),
			failedPaths: [],
		};

		// 单文件统一处理:mtime+size 命中缓存则复用 sha;
		// sha 与远端一致时连内容都不读(后续流程用不到未变化文件的内容)
		const processOne = async (
			path: string,
			mtime: number,
			size: number,
			read: () => Promise<ArrayBuffer>
		): Promise<void> => {
			const cached = cache[path];
			if (cached && cached.mtime === mtime && cached.size === size) {
				nextCache[path] = cached;
				result.mtimes.set(path, mtime);
				result.shas.set(path, cached.sha);
				const remote = remoteMap.get(path);
				if (remote && remote.sha === cached.sha) {
					result.files.set(path, null);
				} else {
					result.files.set(path, await read());
				}
				return;
			}
			const content = await read();
			const sha = await computeGitBlobSha(content);
			nextCache[path] = { mtime, size, sha };
			result.mtimes.set(path, mtime);
			result.shas.set(path, sha);
			result.files.set(path, content);
		};

		const files = this.app.vault.getFiles();
		const filtered = files.filter((file) => !this.shouldIgnoreLocal(file.path, ignore));

		// 先列出 .obsidian 待同步文件,让进度回调从一开始就能拿到完整总数
		let obsidianPaths: string[] = [];
		if (this.settings.syncObsidianFolder) {
			obsidianPaths = (await this.listAdapterPaths(".obsidian"))
				.filter((path) => this.isObsidianEntrySelected(path))
				.filter((path) => !this.shouldIgnoreLocal(path, ignore));
		}

		const total = filtered.length + obsidianPaths.length;
		let done = 0;
		const tick = () => {
			done++;
			onProgress?.(done, total);
		};

		await pMap(
			filtered,
			async (file) => {
				try {
					const mtime = file.stat?.mtime ?? file.stat?.ctime ?? 0;
					await processOne(
						file.path,
						mtime,
						file.stat?.size ?? 0,
						() => this.app.vault.readBinary(file)
					);
				} catch (err) {
					console.warn(`读取本地文件失败: ${file.path}`, err);
					result.failedPaths.push(file.path);
				}
				tick();
			},
			8
		);

		// vault API 不会返回 .obsidian 目录下的文件，需通过 adapter 读取
		if (obsidianPaths.length > 0) {
			await pMap(
				obsidianPaths,
				async (path) => {
					try {
						const normalPath = normalizePath(path);
						const stat = await this.app.vault.adapter.stat(normalPath);
						// adapter.stat 与 TFile.stat 同为 Stat 接口，毫秒时间戳
						await processOne(
							path,
							stat?.mtime ?? 0,
							stat?.size ?? 0,
							() => this.app.vault.adapter.readBinary(normalPath)
						);
					} catch (err) {
						console.warn(`读取 .obsidian 文件失败: ${path}`, err);
						result.failedPaths.push(path);
					}
					tick();
				},
				8
			);
		}

		await this.saveHashCache(nextCache);
		return result;
	}

	/** 读取本地 sha 缓存(path -> {mtime,size,sha}),缺失/损坏时返回空 */
	private async loadHashCache(): Promise<Record<string, HashCacheEntry>> {
		try {
			const p = normalizePath(HASH_CACHE_PATH);
			if (await this.app.vault.adapter.exists(p)) {
				const data = JSON.parse(await this.app.vault.adapter.read(p));
				if (data && typeof data === "object" && data.entries) {
					return data.entries as Record<string, HashCacheEntry>;
				}
			}
		} catch {}
		return {};
	}

	/** 持久化 sha 缓存(仅保留本次扫描到的路径,已删除文件自动清理) */
	private async saveHashCache(entries: Record<string, HashCacheEntry>): Promise<void> {
		try {
			const p = normalizePath(HASH_CACHE_PATH);
			await this.ensureAdapterFolder(p.substring(0, p.lastIndexOf("/")));
			await this.app.vault.adapter.write(p, JSON.stringify({ version: 1, entries }));
		} catch (err) {
			console.warn("写入 sha 缓存失败:", err);
		}
	}

	private async writeLocalFile(
		path: string,
		content: ArrayBuffer
	): Promise<void> {
		const normalPath = normalizePath(path);
		if (this.isObsidianPath(normalPath)) {
			await this.writeAdapterFile(normalPath, content);
			return;
		}

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
		if (this.isObsidianPath(normalPath)) {
			try {
				await this.app.vault.adapter.remove(normalPath);
			} catch (err) {
				console.warn(`删除 .obsidian 文件失败: ${normalPath}`, err);
			}
			return;
		}
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

	/** 是否为 .obsidian 配置目录下的路径（vault API 不可见，需走 adapter） */
	private isObsidianPath(path: string): boolean {
		return path === ".obsidian" || path.startsWith(".obsidian/");
	}

	/** .obsidian 下的条目是否被选中同步；未选择 = 全部同步。
	 *  命中规则：自身或任一祖先被显式选中（如选中 plugins 则其下全部内容同步）。 */
	private isObsidianEntrySelected(path: string): boolean {
		const sel = this.settings.obsidianSyncSelection;
		if (!sel || sel.length === 0) return true;
		if (!this.isObsidianPath(path)) return true;
		const rest = path.slice(".obsidian/".length);
		if (!rest) return false;
		if (sel.includes(rest)) return true;
		return sel.some((s) => rest.startsWith(s + "/"));
	}

	/** 递归列出目录下所有文件路径（含 .obsidian） */
	private async listAdapterPaths(dir: string): Promise<string[]> {
		const result: string[] = [];
		let listing;
		try {
			listing = await this.app.vault.adapter.list(normalizePath(dir));
		} catch {
			return result;
		}
		for (const file of listing.files) {
			result.push(file);
		}
		for (const folder of listing.folders) {
			result.push(...(await this.listAdapterPaths(folder)));
		}
		return result;
	}

	/** 确保 adapter 路径下的父目录（含 .obsidian）存在 */
	private async ensureAdapterFolder(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const norm = normalizePath(current);
			if (norm === ".") {
				continue;
			}
			try {
				if (!(await this.app.vault.adapter.exists(norm))) {
					await this.app.vault.adapter.mkdir(norm);
				}
			} catch (err) {
				// 并发创建时可能冲突，忽略
			}
		}
	}

	private async writeAdapterFile(path: string, content: ArrayBuffer): Promise<void> {
		const normalPath = normalizePath(path);
		const dir = normalPath.substring(0, normalPath.lastIndexOf("/"));
		if (dir) {
			await this.ensureAdapterFolder(dir);
		}
		try {
			await this.app.vault.adapter.writeBinary(normalPath, content);
		} catch (err) {
			console.warn(`写入 .obsidian 文件失败: ${normalPath}`, err);
			throw err;
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
			(this.app as any).setting?.openTabById?.(this.manifest.id);
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
		return this.shouldIgnoreLocal(path, this.buildIgnoreList());
	}

	// 构建忽略路径列表（不含 .obsidian 时自动追加，由设置控制；解析结果缓存，设置保存时失效）
	private buildIgnoreList(): string[] {
		if (this.ignoreListCache) return this.ignoreListCache;
		const ignores = this.settings.ignorePaths
			.split("\n")
			.map(s => s.trim())
			.filter(Boolean);
		if (!this.settings.syncObsidianFolder) ignores.push(".obsidian");
		this.ignoreListCache = ignores;
		return ignores;
	}

	private buildCommitMessage(): string {
		const now = new Date().toISOString().replace("T", " ").substring(0, 19);
		return this.settings.commitMessage.replace("{date}", now);
	}

	/** 更新常驻通知的文本（执行阶段的实时进度；messageEl 于 1.8.7 引入，旧版回退 noticeEl） */
	private setNoticeText(notice: Notice, text: string): void {
		const el = (notice as unknown as { messageEl?: HTMLElement }).messageEl ?? notice.noticeEl;
		el.setText(text);
	}

	/** 生成失败文件提示文本（最多列 3 个，其余以数量概括） */
	private formatFailedPaths(paths: string[]): string {
		const shown = paths.slice(0, 3).join("、");
		return paths.length > 3 ? `${shown} 等 ${paths.length} 个` : shown;
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


