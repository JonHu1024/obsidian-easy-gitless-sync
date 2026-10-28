// main.ts — GitHub Sync 插件入口

import { Notice, Plugin, TFile, TAbstractFile, Menu, normalizePath } from "obsidian";
import { GitHubClient, GitHubFile, PartialUploadError } from "./github";
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

/** 按时间同步时远端文件精确 mtime 的缓存(同一 HEAD 内复用,避免重复请求 /commits?path=) */
const REMOTE_MTIME_CACHE_PATH =
	".obsidian/plugins/easy-gitless-sync/remote-mtime-cache.json";

/** syncedPaths 持久化上限(超出裁剪旧记录) */
const SYNCED_PATHS_CAP = 5000;

/**
 * 插件自身状态文件永远不参与同步。
 *
 * · data.json 里的 token 只是 base64，同步到 GitHub 等于泄露凭据；
 * · savings / *-cache.json 是本地产物，同步它们既浪费流量又可能自我递归。
 *
 * 即使 `.obsidian` 选择器里选了"全部"，这些路径也会被两端同时隐藏。
 */
const PLUGIN_STATE_PREFIXES = [
	".obsidian/plugins/easy-gitless-sync/data.json",
	".obsidian/plugins/easy-gitless-sync/savings",
	".obsidian/plugins/easy-gitless-sync/hash-cache.json",
	".obsidian/plugins/easy-gitless-sync/remote-mtime-cache.json",
	".obsidian/plugins/easy-gitless-sync/remote-cache.json",
];

/** 远端文件列表快照（启动时静默预取，点击同步时按 HEAD 复用） */
interface RemoteSnapshot {
	files: GitHubFile[];
	commitSha: string | null;
	treeSha: string | null;
	commitDate: string;
	isEmpty: boolean;
	fetchedAt: number;
}

interface RemoteMtimeEntry {
	sha: string;
	mtime: number;
}

/** 只在同一 headCommitSha 下可信：commit 变化后一律重新查询，避免把旧时间当成新时间 */
interface RemoteMtimeCache {
	headCommitSha: string | null;
	entries: Record<string, RemoteMtimeEntry>;
}

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
	/** 本次同步新建过的文件夹（避免每个文件都 adapter.exists） */
	private knownFolders = new Set<string>();

	// ── 远端列表缓存 / 静默预取 ──
	private remoteCache: RemoteSnapshot | null = null;
	private remoteCacheKey = "";
	private remoteFetchPromise: Promise<RemoteSnapshot> | null = null;
	private remoteFetchKey = "";
	private remoteFetchEpoch = 0;
	private remoteCacheEpoch = 0;
	private prefetchTimer: number | null = null;
	private startupWarningTimer: number | null = null;
	/** 本会话已确认过写权限的 token+repo，避免每次同步都多打一次 /repos */
	private writePermissionKey = "";

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

		// 恢复内存中的未同步集合（过滤已配置的忽略路径）。
		// 旧版本这里有一条"超过 10 个就整批清空"的启发式规则，会在用户真的
		// 批量改了十几个文件时把状态误清成"已同步"，已移除；只在读取时做上限裁剪。
		if (this.settings.lastUnsyncedPaths && this.settings.lastUnsyncedPaths.length > SYNCED_PATHS_CAP) {
			this.settings.lastUnsyncedPaths = this.settings.lastUnsyncedPaths.slice(-SYNCED_PATHS_CAP);
		}
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
				if (this.shouldIgnoreBySettings(file.path)) return;
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
				this.unsyncedPaths.delete(oldPath); // 旧路径不再用原名跟踪
				// 之前同步过的文件被改名：旧路径需要在下次同步时从远端删除，
				// 因此把它也记为 pending，避免 startup 提醒漏掉这次删除。
				const oldTracked =
					!this.isObsidianPath(oldPath) ||
					(this.settings.syncObsidianFolder &&
						this.isObsidianEntrySelected(oldPath));
				if (
					oldTracked &&
					!this.shouldIgnoreBySettings(oldPath) &&
					this.settings.syncedPaths.includes(oldPath)
				) {
					this.unsyncedPaths.add(oldPath);
					this.setDirty(true);
					this.debounceSaveState();
				}
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
										() => this.openRollback(),
										() => this.describeRemoteCache()
									).open();
								});
						});
					}
				})
			);

			// 启动提醒 + 静默预取：如果弹出未同步提醒，等用户关掉它再预取；
			// 否则在布局就绪后稍等片刻直接静默拉取 GitHub 文件列表。
			this.scheduleStartupPrefetch();
		});
	}

	onunload() {
		if (this.prefetchTimer) {
			window.clearTimeout(this.prefetchTimer);
			this.prefetchTimer = null;
		}
		if (this.startupWarningTimer) {
			window.clearTimeout(this.startupWarningTimer);
			this.startupWarningTimer = null;
		}
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

	// 同步成功后更新 syncedPaths，并只清除"本次真正处理过"的未同步标记。
	// 用户在确认框里取消勾选的其它文件必须继续保持 ⚠️，否则状态栏会骗人。
	private async finalizeSync(
		uploadedPaths: string[],
		downloadedPaths: string[],
		deletedPaths: string[]
	) {
		await this.recordSyncedPaths(uploadedPaths, downloadedPaths, deletedPaths);

		const touched = new Set<string>([
			...uploadedPaths,
			...downloadedPaths,
			...deletedPaths,
		]);
		for (const p of touched) this.unsyncedPaths.delete(p);

		if (this.unsyncedPaths.size === 0) {
			await this.clearDirtyState();
		} else {
			this.isDirty = true;
			this.updateStatusBar();
			await this.flushPendingState();
		}

		// 每次同步结束后都像启动时一样静默刷新一次远端列表：
		// · 若远端被本次同步改写，markRemoteChanged 已清缓存，这里会重新拉 tree；
		// · 若只改了本地（Pull/下载），这里只做一次 HEAD 校验并复用缓存。
		// 延迟到 isSyncing=false 之后再真正发请求，避免和同步收尾抢网络。
		this.scheduleRemotePrefetch(1200);
	}

	/**
	 * 只更新 syncedPaths（用于区分"本地新建后删除"和"同步过的文件被删除"），
	 * 不动"未同步"标记。Push 中途失败时用它记录已经真的传上去的部分。
	 */
	private async recordSyncedPaths(
		uploadedPaths: string[],
		downloadedPaths: string[] = [],
		deletedPaths: string[] = []
	) {
		const set = new Set(this.settings.syncedPaths || []);
		for (const p of uploadedPaths) if (p) set.add(p);
		for (const p of downloadedPaths) if (p) set.add(p);
		for (const p of deletedPaths) if (p) set.delete(p);
		// 上限保护：syncedPaths 只用于"未同步提醒"的删除判定，不影响 diff 正确性，
		// 超出时保留最新记录，防止 data.json 无限膨胀
		const list = Array.from(set);
		this.settings.syncedPaths =
			list.length > SYNCED_PATHS_CAP ? list.slice(-SYNCED_PATHS_CAP) : list;
		await this.saveSettings().catch(err =>
			console.error("保存同步记录失败:", err)
		);
	}

	/**
	 * 统一的失败提示。分块上传中断时 err 会带出"已成功上传"的部分：
	 * 这些文件已经写进远端 commit，不能当作失败回滚，
	 * 但也绝不能顺手把"未同步"状态清掉（否则没传上去的文件会被误标成已同步）。
	 */
	private async notifyPartialFailure(err: unknown, action: string) {
		if (err instanceof PartialUploadError) {
			if (err.uploadedPaths.length > 0) {
				await this.recordSyncedPaths(err.uploadedPaths).catch(() => {});
				// 这些文件确实已经进了远端 commit：只清掉它们的未同步标记，
				// 失败/未上传的其它文件必须继续保持 ⚠️。
				for (const p of err.uploadedPaths) this.unsyncedPaths.delete(p);
				if (this.unsyncedPaths.size === 0) {
					await this.clearDirtyState();
				} else {
					this.isDirty = true;
					this.updateStatusBar();
					await this.flushPendingState();
				}
				// 部分文件已经进了远端 commit，缓存必须作废
				this.markRemoteChanged();
			}
			const failedPart =
				err.failedPaths.length > 0
					? `\n其中 ${err.failedPaths.length} 个文件上传失败，已跳过（其余文件不受影响）：` +
						`${this.formatFailedPaths(err.failedPaths)}`
					: "";
			new Notice(
				`⚠️ ${action} 未全部完成：已成功上传 ${err.uploadedCount}/${err.totalCount} 个文件。` +
					failedPart +
					`\n已上传的会被下次同步自动跳过，只需重试剩余文件。\n原因：${getErrorMessage(err)}`,
				20000
			);
			return;
		}
		new Notice(`❌ ${action} 出错: ${getErrorMessage(err)}`, 15000);
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
		if (this.isSyncing || this.isPreparing) {
			this.statusBarEl.setText("🔄GitHub同步中...");
			this.statusBarEl.style.color = "var(--text-accent, #7c8cff)";
			this.statusBarEl.style.cursor = "default";
			this.statusBarEl.title = "同步进行中";
			this.statusBarEl.onclick = null;
			return;
		}
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
		const beforeKey = this.remoteCacheKeyForSettings();
		const beforeToken = this.settings.token;
		const data = { ...this.settings };
		// 加密存储 token（原文 → base64）
		if (data.token) data.token = btoa(data.token);
		this.ignoreListCache = null; // 忽略路径可能已变化
		await this.saveData(data);
		// 仓库/分支/token 变了：旧缓存和写权限结论都作废
		const afterKey = this.remoteCacheKeyForSettings();
		if (beforeKey !== afterKey) this.invalidateRemoteCache();
		if (beforeToken !== this.settings.token) this.writePermissionKey = "";
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
			() => this.openRollback(),
			() => this.describeRemoteCache()
		).open();
	}

	// ──────────────────────────────────────────────
	// 远端列表缓存 / 静默预取
	// ──────────────────────────────────────────────

	private remoteCacheKeyForSettings(): string {
		const repo = (this.settings.repository || "").trim().toLowerCase();
		const branch = (this.settings.branch || "main").trim();
		return `${repo}@${branch}`;
	}

	/** 仓库/分支变化时丢弃旧缓存与旧的在途请求 */
	private ensureRemoteCacheKey(): void {
		const key = this.remoteCacheKeyForSettings();
		if (key === this.remoteCacheKey) return;
		this.remoteCacheKey = key;
		this.remoteCache = null;
		this.remoteFetchKey = "";
		this.remoteFetchPromise = null;
		this.remoteCacheEpoch++;
		this.remoteFetchEpoch = this.remoteCacheEpoch;
	}

	/** 远端被本次同步改写后调用：作废缓存，并在后台重新预取 */
	private markRemoteChanged(): void {
		this.invalidateRemoteCache();
		this.scheduleRemotePrefetch(1500);
	}

	private invalidateRemoteCache(): void {
		this.remoteCache = null;
		this.remoteCacheKey = this.remoteCacheKeyForSettings();
		this.remoteFetchKey = "";
		this.remoteFetchPromise = null;
		this.remoteCacheEpoch++;
		this.remoteFetchEpoch = this.remoteCacheEpoch;
	}

	private async fetchRemoteSnapshot(
		client: GitHubClient,
		onProgress?: (message: string) => void
	): Promise<RemoteSnapshot> {
		onProgress?.("获取 GitHub 文件列表...");
		const data = await client.listAllFiles();
		onProgress?.(
			data.isEmpty
				? "远端仓库为空"
				: `已获取 GitHub 文件列表（${data.files.length} 个文件）`
		);
		return { ...data, fetchedAt: Date.now() };
	}

	/**
	 * 取远端列表：能复用就复用，不能复用才真正拉 tree。
	 *
	 * 优先级：
	 * ① 启动静默预取还在飞 → 直接 await 同一个 Promise（"继续原先的对比"）；
	 * ② 已有缓存 → 只用 1 个请求校验 HEAD，commit/tree 未变就复用；
	 * ③ 否则拉完整列表。
	 */
	private async getRemoteSnapshot(
		client: GitHubClient,
		onProgress?: (message: string) => void,
		opts: { force?: boolean } = {}
	): Promise<{ snapshot: RemoteSnapshot; reused: boolean }> {
		this.ensureRemoteCacheKey();
		const key = this.remoteCacheKeyForSettings();

		if (
			!opts.force &&
			this.remoteFetchPromise &&
			this.remoteFetchKey === key &&
			this.remoteFetchEpoch === this.remoteCacheEpoch
		) {
			onProgress?.("等待启动时的 GitHub 对比完成...");
			try {
				const snapshot = await this.remoteFetchPromise;
				return { snapshot, reused: true };
			} catch (err) {
				// 静默预取失败不应让手动同步直接失败；继续走下面的正常拉取流程
				console.debug(
					"[Easy Gitless Sync] 启动预取失败，改为手动同步时重新拉取:",
					getErrorMessage(err)
				);
			}
		}

		const cached =
			this.remoteCache && this.remoteCacheKey === key ? this.remoteCache : null;
		if (cached && !opts.force) {
			onProgress?.("检查 GitHub 远端是否有更新...");
			const head = await client.getBranchHeadLight();
			const sameHead = head
				? head.commitSha === cached.commitSha &&
				  head.treeSha === cached.treeSha
				: cached.commitSha === null;
			if (sameHead) {
				return { snapshot: cached, reused: true };
			}
		}

		return {
			snapshot: await this.runRemoteFetch(client, onProgress),
			reused: false,
		};
	}

	/** 真正发起一次远端列表请求；同一时刻只保留一个可复用请求 */
	private async runRemoteFetch(
		client: GitHubClient,
		onProgress?: (message: string) => void
	): Promise<RemoteSnapshot> {
		const key = this.remoteCacheKeyForSettings();
		const epoch = this.remoteCacheEpoch;
		const promise = this.fetchRemoteSnapshot(client, onProgress);
		this.remoteFetchPromise = promise;
		this.remoteFetchKey = key;
		this.remoteFetchEpoch = epoch;
		try {
			const snapshot = await promise;
			if (
				this.remoteCacheEpoch === epoch &&
				this.remoteCacheKeyForSettings() === key
			) {
				this.remoteCache = snapshot;
				this.remoteCacheKey = key;
			}
			return snapshot;
		} finally {
			if (this.remoteFetchPromise === promise) {
				this.remoteFetchPromise = null;
				this.remoteFetchKey = "";
			}
		}
	}

	/** 启动时：先处理未同步提醒，用户关掉后再静默预取（没有提醒则直接预取） */
	private scheduleStartupPrefetch(): void {
		const validPaths = (this.settings.lastUnsyncedPaths || [])
			.filter((p) => !this.shouldIgnoreBySettings(p));
		const shouldWarn =
			this.settings.showUnsyncedWarningOnStartup &&
			this.settings.hasUnsyncedChanges &&
			validPaths.length > 0;

		// 提醒与预取是两个独立开关：关闭预取不应导致提醒不弹。
		if (shouldWarn) {
			this.startupWarningTimer = window.setTimeout(() => {
				this.startupWarningTimer = null;
				new UnsyncedWarningModal(
					this.app,
					validPaths,
					() => this.openSyncModal(),
					this,
					// 用户关掉提醒（无论点"我知道了"、右上角还是"去同步"）后再预取
					() => this.scheduleRemotePrefetch(600)
				).open();
			}, 800);
		} else if (this.settings.prefetchRemoteOnStartup) {
			this.scheduleRemotePrefetch(1800);
		}
	}

	/** 供设置页在重新启用预取时立即触发一次 */
	requestRemotePrefetch(delayMs = 800): void {
		this.scheduleRemotePrefetch(delayMs);
	}

	private scheduleRemotePrefetch(delayMs = 1200): void {
		if (!this.settings.prefetchRemoteOnStartup) return;
		if (this.prefetchTimer) window.clearTimeout(this.prefetchTimer);
		this.prefetchTimer = window.setTimeout(() => {
			this.prefetchTimer = null;
			void this.maybePrefetchRemote();
		}, delayMs);
	}

	/** 静默预取：不弹窗、不打扰；失败只写 console.debug */
	private async maybePrefetchRemote(): Promise<void> {
		if (!this.settings.prefetchRemoteOnStartup) return;
		const token = (this.settings.token || "").trim();
		const repository = (this.settings.repository || "").trim();
		const branch = (this.settings.branch || "main").trim() || "main";
		if (!token || !repository) return;
		if (this.isPreparing || this.isSyncing) {
			// 同步正在进行时不要重复拉列表；等它结束后再找机会补一次
			this.scheduleRemotePrefetch(3000);
			return;
		}

		try {
			this.ensureRemoteCacheKey();
			if (
				this.remoteFetchPromise &&
				this.remoteFetchEpoch === this.remoteCacheEpoch
			) {
				await this.remoteFetchPromise;
				return;
			}
			const client = new GitHubClient(token, repository, branch, {
				uploadConcurrency: this.settings.uploadConcurrency,
			});
			const result = await this.getRemoteSnapshot(client);
			console.debug(
				`[Easy Gitless Sync] 静默预取完成：${result.snapshot.files.length} 个文件` +
					`${result.reused ? "（缓存命中）" : ""}`
			);
		} catch (err) {
			console.debug(
				"[Easy Gitless Sync] 静默预取失败（不影响手动同步）:",
				getErrorMessage(err)
			);
		}
	}

	/** 供对比弹窗复用远端列表缓存 / 在途请求，避免重复拉 tree */
	async getRemoteFilesForCompare(client: GitHubClient): Promise<GitHubFile[]> {
		const result = await this.getRemoteSnapshot(client);
		return result.snapshot.files;
	}

	/** 给模式选择弹窗显示的一行缓存状态 */
	describeRemoteCache(): string {
		const key = this.remoteCacheKeyForSettings();
		if (this.remoteFetchPromise && this.remoteFetchKey === key) {
			return "GitHub 列表：正在后台预取，点击同步会等待它完成（不会重复请求）";
		}
		if (!this.remoteCache || this.remoteCacheKey !== key) {
			return "GitHub 列表：尚未预取，首次同步会读取";
		}
		const snap = this.remoteCache;
		const when = new Date(snap.fetchedAt);
		const hh = String(when.getHours()).padStart(2, "0");
		const mm = String(when.getMinutes()).padStart(2, "0");
		return (
			`GitHub 列表：已预取 ${snap.files.length} 个文件（${hh}:${mm}）` +
			(snap.commitDate
				? ` · HEAD ${new Date(snap.commitDate).toLocaleString()}`
				: " · 空仓库")
		);
	}

	async startSync(mode: SyncMode, targetPath?: string) {
		if (!this.checkConfig()) return;

		if (this.isSyncing || this.isPreparing) {
			new Notice("正在同步...(点击屏幕空白区域可以后台运行同步)");
			return;
		}

		this.isPreparing = true;
		this.knownFolders.clear();
		// 还没开始的静默预取就取消；已经在飞的请求会通过 getRemoteSnapshot 复用
		if (this.prefetchTimer) {
			window.clearTimeout(this.prefetchTimer);
			this.prefetchTimer = null;
		}
		this.updateStatusBar();
		const progress = new ProgressModal(this.app);
		progress.open();

		try {
			const token = (this.settings.token || "").trim();
			const repository = (this.settings.repository || "").trim();
			const branch = (this.settings.branch || "main").trim() || "main";
			const ignore = this.buildIgnoreList();

			const client = new GitHubClient(token, repository, branch, {
				uploadConcurrency: this.settings.uploadConcurrency,
			});

			// 0. 会上传的模式先确认 Token 有写权限。
			// 同一会话里相同 token+repo 只确认一次，避免每次同步都多打一次 /repos。
			if (mode !== "pull") {
				const permissionKey = `${token}\u0000${repository}\u0000${branch}`;
				if (this.writePermissionKey !== permissionKey) {
					progress.setMessage("检查 Token 写权限...");
					await client.assertWritePermission();
					this.writePermissionKey = permissionKey;
				} else {
					progress.setMessage("Token 写权限已确认");
				}
			}

			// 1. 获取远端文件列表：优先复用启动时静默预取的结果。
			// 只有远端 HEAD 真的变了才会重新拉 tree；静默预取尚未结束时则共用同一个 Promise。
			progress.setProgress(-1); // 总数未知,显示流动条
			const remoteResult = await this.getRemoteSnapshot(client, (msg) =>
				progress.setMessage(msg)
			);
			const remote = remoteResult.snapshot;
			if (remoteResult.reused) {
				progress.setMessage("远端列表无变化，已复用启动时的缓存");
			}
			if (remote.isEmpty && !remoteResult.reused) {
				// 只有确认远端一个 commit 都没有才会走到这里：读取分支失败
				// (限流/Token/网络)现在会直接抛错，不会再被误判成"空仓库"。
				new Notice(
					`ℹ️ 远端仓库 ${repository} 还是空的，本次会把本地文件作为首次上传提交（分批提交，可断点续传）。`,
					8000
				);
			}

			const onlyPaths = targetPath ? new Set([targetPath]) : undefined;

			// 2. 读取本地文件(未变化的文件不读内容；单文件同步只扫目标文件)
			progress.setMessage(targetPath ? `读取 ${targetPath}...` : "读取本地 Vault 文件...");
			progress.setProgress(0);
			const local = await this.readLocalFiles(
				ignore,
				remote.files,
				(done, total) => {
					// 节流:每 25 个文件或最后一个时才刷新 UI
					if (done === total || done % 25 === 0) {
						progress.setMessage(`读取本地文件 ${done}/${total}...`);
						progress.setProgress((done / Math.max(total, 1)) * 95);
					}
				},
				onlyPaths
			);

			// 3. 计算差异
			progress.setMessage("计算差异...");
			progress.setProgress(97);
			// .obsidian 中未被选中同步的子项对两端同时"不可见",
			// 否则远端存在但本地未选中的文件会被当作差异,Push 时被删除
			const extraIgnore = (p: string) => this.isObsidianPath(p) && !this.isObsidianEntrySelected(p);
			let diff = await computeDiff(
				local.files,
				local.shas,
				remote.files,
				ignore,
				extraIgnore,
				onlyPaths
			);

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
				smartPlan = await this.buildTimeSyncPlan(client, local, remote, diff);
			} else if (mode === "merge") {
				progress.setMessage("分析冲突并生成合并计划...");
				progress.setProgress(-1);
				smartPlan = await this.buildMergePlan(client, local, remote, diff);
			}

			progress.close();

			// 5. 弹出确认框。
			// 每个 FileDiff 都带一个明确的 direction；确认框里用户可以逐行改，
			// onConfirm 之后统一按 direction 重新分派，而不是继续按"模式"猜。
			const onCompare = (path: string) => {
				new DiffViewerModal(
					this.app, [path], this, () => {}, false,
					(p) => this.onCompareIdentical(p)
				).open();
			};

			let toProcess: FileDiff[] = [];
			let toRemove: FileDiff[] = [];
			let unchanged = diff.unchanged.length;

			if (mode === "push") {
				toProcess = diff.toUpload.map((f): FileDiff => ({
					...f,
					direction: f.direction ?? "upload",
				}));
				// push 模式下 toDelete 是"远端有、本地无"：默认从远端删除
				toRemove = diff.toDelete.map((f): FileDiff => ({
					...f,
					direction: "delete",
				}));
			} else if (mode === "pull") {
				toProcess = diff.toDownload.map((f): FileDiff => ({
					...f,
					direction: f.direction ?? "download",
				}));
				// pull 模式下 toRemove 是"本地有、远端无"：默认删除本地
				toRemove = diff.toRemove.map((f): FileDiff => ({
					...f,
					direction: "delete-local",
				}));
			} else if (mode === "time") {
				if (!smartPlan) throw new Error("按时间同步计划生成失败");
				toProcess = smartPlan.previewItems;
				unchanged = smartPlan.unchanged;
			} else {
				if (!smartPlan) throw new Error("智能合并计划生成失败");
				toProcess = smartPlan.previewItems;
				unchanged = smartPlan.unchanged;
			}

			if (toProcess.length === 0 && toRemove.length === 0) {
				await this.finishWithNoChanges(targetPath, local.failedPaths);
				return;
			}

			new ConfirmSyncModal(this.app, {
				mode,
				toProcess,
				toRemove,
				unchanged,
				onCompare,
				onConfirm: (selectedProcess, selectedRemove) =>
					this.executeSelected(
						client,
						local.files,
						remote,
						selectedProcess,
						selectedRemove
					),
			}).open();
		} catch (err) {
			progress.close();
			console.error("GitHub Sync error:", err);
			new Notice(`❌ 同步出错: ${getErrorMessage(err)}`);
		} finally {
			this.isPreparing = false;
			this.updateStatusBar();
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
					const restored = await this.rollbackManager.applySnapshot(id);
					// 回滚把本地恢复成旧快照，但远端仍是新内容 —— 这些文件重新变成
					// "未同步"，必须重新标记，不能像旧版那样把整个状态清成已同步。
					let marked = 0;
					for (const path of restored) {
						if (this.shouldIgnoreBySettings(path)) continue;
						if (
							this.isObsidianPath(path) &&
							(!this.settings.syncObsidianFolder ||
								!this.isObsidianEntrySelected(path))
						) {
							continue;
						}
						this.unsyncedPaths.add(path);
						marked++;
					}
					if (marked > 0) {
						this.isDirty = true;
						this.updateStatusBar();
						await this.flushPendingState();
						new Notice(
							`↩️ 已回滚 ${restored.length} 个文件；它们与 GitHub 端不再一致，请重新同步。`
						);
					}
					this.rollbackManager.deleteSnapshot(id).catch(err => console.warn("删除已回滚的快照失败:", err));
				}
			).open();
		} catch (err) {
			new Notice(`❌ 获取历史版本失败: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * 差异为空时的收尾。
	 *
	 * 关键：如果本次有文件读取失败，它们被当成"不可见"过滤掉了，
	 * 此时绝不能调用 clearDirtyState() —— 否则一次瞬时读取失败就会把
	 * 真正未同步的文件标成已同步。单文件同步同理。
	 */
	private async finishWithNoChanges(
		targetPath: string | undefined,
		failedPaths: string[]
	) {
		if (failedPaths.length > 0) {
			new Notice(
				`⚠️ ${failedPaths.length} 个文件读取失败，未执行同步，未同步状态已保留：` +
					`${this.formatFailedPaths(failedPaths)}`,
				8000
			);
			return;
		}
		if (targetPath) this.onCompareIdentical([targetPath]);
		else await this.clearDirtyState();
		new Notice(`✅ 已是最新，无需同步`);
	}

	// ──────────────────────────────────────────────
	// 智能同步计划
	// ──────────────────────────────────────────────

	private async buildTimeSyncPlan(
		client: GitHubClient,
		local: LocalFileSnapshot,
		remote: RemoteSnapshot,
		diff: DiffResult
	): Promise<SmartSyncPlan> {
		const uploads: FileDiff[] = [];
		const downloads: FileDiff[] = [];
		const deletions: FileDiff[] = [];

		// 先处理本地独有文件：必然上传
		for (const item of diff.toUpload) {
			if (item.changeType === "added") {
				uploads.push({ ...item, direction: "upload" });
			}
		}

		// 远端独有文件：
		// · 默认（推荐）—— 视为"远端新增"，下载补齐。绝不因为本地没有就删除远端；
		// · 旧行为（local-mirror）—— 把本地当作唯一真相，从远端删除。
		const oneSidedPolicy = this.settings.timeSyncOneSided;
		for (const item of diff.toDelete) {
			// 这些文件只存在于远端，本来就不需要比较时间；清掉 computeDiff
			// 填入的"HEAD commit 时间"，避免 UI 把它当成精确的远端修改时间。
			const base: FileDiff = {
				...item,
				remoteMtime: undefined,
				remoteMtimeEstimated: undefined,
			};
			if (oneSidedPolicy === "local-mirror") {
				deletions.push({ ...base, direction: "delete" });
			} else {
				downloads.push({
					...base,
					changeType: "added",
					direction: "download",
				});
			}
		}

		// 双方都存在但内容不同的文件：按修改时间决定方向
		const modifiedPaths = diff.toUpload
			.filter((item) => item.changeType === "modified")
			.map((item) => item.path);

		const remoteModTimes = await this.resolveRemoteMtimes(
			client,
			remote,
			modifiedPaths
		);
		const headMtime = remote.commitDate
			? Date.parse(remote.commitDate) || 0
			: 0;

		for (const item of diff.toUpload) {
			if (item.changeType !== "modified") continue;

			const path = item.path;
			const localMtime = local.mtimes.get(path) ?? 0;
			const exactRemoteMtime = remoteModTimes.get(path);
			// 查询失败时用 HEAD commit 时间做上界估算，但标记为"估算值"，
			// 界面会显示 ≈ 并默认不勾选，避免静默覆盖任何一边。
			const remoteMtime = exactRemoteMtime ?? headMtime;
			const estimated = exactRemoteMtime === undefined;

			const target = localMtime >= remoteMtime ? "upload" : "download";

			const enrichedItem: FileDiff = {
				...item,
				localMtime,
				remoteMtime,
				remoteMtimeEstimated: estimated || undefined,
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
		remote: RemoteSnapshot,
		diff: DiffResult
	): Promise<SmartSyncPlan> {
		const uploads: FileDiff[] = [];
		const downloads: FileDiff[] = [];
		const merges: FileDiff[] = [];

		// 本地独有文件：上传
		for (const item of diff.toUpload) {
			if (item.changeType === "added") {
				uploads.push({ ...item, direction: "upload" });
			}
		}

		// 远端独有文件：下载（无需比较时间，清掉 HEAD 时间估算值）
		for (const item of diff.toDownload) {
			if (item.changeType === "added") {
				downloads.push({
					...item,
					remoteMtime: undefined,
					remoteMtimeEstimated: undefined,
					direction: "download",
				});
			}
		}

		// 双方都存在但内容不同的文件：自动合并（文本）或按时间（二进制）
		const modifiedPaths = diff.toUpload
			.filter((item) => item.changeType === "modified")
			.map((item) => item.path);

		const remoteModTimes = await this.resolveRemoteMtimes(
			client,
			remote,
			modifiedPaths
		);
		const headMtime = remote.commitDate
			? Date.parse(remote.commitDate) || 0
			: 0;

		for (const item of diff.toUpload) {
			if (item.changeType !== "modified") continue;

			const path = item.path;
			const localMtime = local.mtimes.get(path) ?? 0;
			const exactRemoteMtime = remoteModTimes.get(path);
			const remoteMtime = exactRemoteMtime ?? headMtime;
			const estimated = exactRemoteMtime === undefined;

			if (isTextFile(path)) {
				merges.push({
					...item,
					localMtime,
					remoteMtime,
					remoteMtimeEstimated: estimated || undefined,
					direction: "merge",
				});
			} else {
				// 二进制文件按时间决定方向
				const target = localMtime >= remoteMtime ? "upload" : "download";
				const enrichedItem: FileDiff = {
					...item,
					localMtime,
					remoteMtime,
					remoteMtimeEstimated: estimated || undefined,
					direction: target,
				};
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

	/**
	 * 解析远端文件的精确最后修改时间。
	 *
	 * 同一 HEAD commit 内缓存复用（remote-mtime-cache.json），只对"新出现或
	 * blob sha 变了"的文件请求 /commits?path=；HEAD 变化则整批重新查询，
	 * 避免把旧提交时间误当成新时间。
	 */
	private async resolveRemoteMtimes(
		client: GitHubClient,
		remote: RemoteSnapshot,
		paths: string[]
	): Promise<Map<string, number>> {
		const result = new Map<string, number>();
		if (paths.length === 0) return result;

		const remoteMap = new Map(remote.files.map((f) => [f.path, f] as const));
		const headSha = remote.commitSha;
		const cache = await this.loadRemoteMtimeCache();
		const sameHead = (cache?.headCommitSha ?? null) === (headSha ?? null);
		const entries = sameHead ? cache!.entries : {};
		const missing: string[] = [];

		for (const path of paths) {
			const remoteSha = remoteMap.get(path)?.sha;
			const cached = entries[path];
			if (cached && remoteSha && cached.sha === remoteSha) {
				result.set(path, cached.mtime);
			} else {
				missing.push(path);
			}
		}

		if (missing.length === 0) return result;

		const fetched = await client.getFileModTimes(
			missing,
			remote.commitSha ?? undefined
		);
		const nextEntries: Record<string, RemoteMtimeEntry> = sameHead
			? { ...entries }
			: {};
		for (const [path, mtime] of fetched) {
			const remoteSha = remoteMap.get(path)?.sha;
			if (remoteSha) nextEntries[path] = { sha: remoteSha, mtime };
			result.set(path, mtime);
		}
		// 清理已经不在远端树里的旧条目，避免缓存随历史文件无限增长
		for (const path of Object.keys(nextEntries)) {
			if (!remoteMap.has(path)) delete nextEntries[path];
		}
		await this.saveRemoteMtimeCache({
			headCommitSha: headSha ?? null,
			entries: nextEntries,
		});
		return result;
	}

	private async loadRemoteMtimeCache(): Promise<RemoteMtimeCache | null> {
		try {
			const p = normalizePath(REMOTE_MTIME_CACHE_PATH);
			if (await this.app.vault.adapter.exists(p)) {
				const data = JSON.parse(await this.app.vault.adapter.read(p));
				if (data && typeof data === "object" && data.entries) {
					return data as RemoteMtimeCache;
				}
			}
		} catch {}
		return null;
	}

	private async saveRemoteMtimeCache(cache: RemoteMtimeCache): Promise<void> {
		try {
			const p = normalizePath(REMOTE_MTIME_CACHE_PATH);
			await this.ensureAdapterFolder(p.substring(0, p.lastIndexOf("/")));
			await this.app.vault.adapter.write(
				p,
				JSON.stringify({ version: 1, ...cache })
			);
		} catch (err) {
			console.warn("写入远端修改时间缓存失败:", err);
		}
	}

	// ──────────────────────────────────────────────
	// 按逐文件动作分派执行
	// ──────────────────────────────────────────────

	/**
	 * 确认框的每一行都可以改 Push / Pull / Merge / 删除。
	 * 这里按最终 direction 重新分类，再交给合并执行器或普通执行器。
	 */
	private async executeSelected(
		client: GitHubClient,
		localFiles: Map<string, ArrayBuffer | null>,
		remote: RemoteSnapshot,
		selectedProcess: FileDiff[],
		selectedRemove: FileDiff[]
	) {
		// 同一路径理论上只会在一个分组里；用 Map 再兜底一次，避免 UI 改向后重复
		const byPath = new Map<string, FileDiff>();
		for (const item of [...selectedProcess, ...selectedRemove]) {
			byPath.set(item.path, item);
		}
		const selected = Array.from(byPath.values());
		const uploads = selected.filter((f) => f.direction === "upload");
		const downloads = selected.filter((f) => f.direction === "download");
		const merges = selected.filter((f) => f.direction === "merge");
		const remoteDeletes = selected.filter((f) => f.direction === "delete");
		const localDeletes = selected.filter((f) => f.direction === "delete-local");

		if (
			uploads.length === 0 &&
			downloads.length === 0 &&
			merges.length === 0 &&
			remoteDeletes.length === 0 &&
			localDeletes.length === 0
		) {
			new Notice("⚠️ 没有可执行的动作");
			return;
		}

		if (merges.length > 0) {
			await this.executeMergeSync(
				client,
				localFiles,
				remote.commitSha,
				remote.treeSha,
				uploads,
				downloads,
				merges,
				remoteDeletes,
				localDeletes
			);
		} else {
			await this.executeSmartSync(
				client,
				localFiles,
				remote.commitSha,
				remote.treeSha,
				uploads,
				downloads,
				remoteDeletes,
				localDeletes
			);
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
		toDeleteFromRemote: FileDiff[] = [],
		toDeleteLocal: FileDiff[] = []
	) {
		this.isSyncing = true;
		this.updateStatusBar();
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = new Notice(
			`🔀 开始同步，上传 ${uploads.length}，下载 ${downloads.length}` +
				`${toDeleteFromRemote.length ? `，删除远端 ${toDeleteFromRemote.length}` : ""}` +
				`${toDeleteLocal.length ? `，删除本地 ${toDeleteLocal.length}` : ""}...`,
			0
		);
		try {
			// 快照 I/O 与网络 I/O 并行
			const preSyncPaths = [
				...uploads.map((f) => f.path),
				...downloads.map((f) => f.path),
				...toDeleteFromRemote.map((f) => f.path),
				...toDeleteLocal.map((f) => f.path),
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

			// 最后删除本地文件（在快照与下载写入之后，避免先删后发现快照失败）
			for (const f of toDeleteLocal) {
				await this.deleteLocalFile(f.path);
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
				`✅ 同步完成：上传 ${uploadedPaths.length}/${uploads.length}，` +
					`下载 ${writtenPaths.length}/${downloads.length}，` +
					`删除远端 ${toDeleteFromRemote.length}，删除本地 ${toDeleteLocal.length}`
			);
			if (uploadedPaths.length > 0 || toDeleteFromRemote.length > 0) {
				this.markRemoteChanged();
			}
			await this.finalizeSync(
				uploadedPaths,
				writtenPaths,
				[
					...toDeleteFromRemote.map((f) => f.path),
					...toDeleteLocal.map((f) => f.path),
				]
			);
		} catch (err) {
			startNotice.hide();
			console.error("Smart sync error:", err);
			await this.notifyPartialFailure(err, "智能同步");
		} finally {
			this.isSyncing = false;
			this.updateStatusBar();
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
		merges: FileDiff[],
		toDeleteFromRemote: FileDiff[] = [],
		toDeleteLocal: FileDiff[] = []
	) {
		this.isSyncing = true;
		this.updateStatusBar();
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));
		merges.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = new Notice(
			`🔀 开始合并同步，上传 ${uploads.length}，下载 ${downloads.length}，合并 ${merges.length}` +
				`${toDeleteFromRemote.length ? `，删除远端 ${toDeleteFromRemote.length}` : ""}` +
				`${toDeleteLocal.length ? `，删除本地 ${toDeleteLocal.length}` : ""}...`,
			0
		);
		try {
			// Phase 1：快照 I/O + 所有网络请求并行
			const preSyncPaths = [
				...uploads.map((f) => f.path),
				...downloads.map((f) => f.path),
				...merges.map((f) => f.path),
				...toDeleteFromRemote.map((f) => f.path),
				...toDeleteLocal.map((f) => f.path),
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
			let uploadResult: { newCommitSha: string; newTreeSha: string } | null = null;
			const mergedSet = new Set(mergedPaths);
			if (uploads.length > 0 || mergedPaths.length > 0) {
				// 只有真正合并成功的文件才上传。远端内容下载失败时若仍把本地原文
				// 传上去，会静默覆盖远端修改 —— 那正是"无法合并、按原样保留"想避免的。
				const filesToUpload = [
					...uploads,
					...merges.filter((f) => mergedSet.has(f.path)),
				]
					.map((f) => {
						const content = localFiles.get(f.path);
						if (!content) return null;
						return { path: f.path, content };
					})
					.filter(Boolean) as { path: string; content: ArrayBuffer }[];

				if (filesToUpload.length > 0) {
					uploadResult = await client.batchUpload(
						filesToUpload, message, currentCommitSha, currentTreeSha,
						(done, total, path) =>
							this.setNoticeText(startNotice, `⬆️ 上传中 ${done}/${total}：${path}`)
					);
					uploadedPaths = filesToUpload.map((f) => f.path);
				}
			}

			// Phase 3：删除远端 / 下载写入本地 / 删除本地
			if (toDeleteFromRemote.length > 0) {
				const delCommitSha = uploadResult?.newCommitSha ?? currentCommitSha;
				const delTreeSha = uploadResult?.newTreeSha ?? currentTreeSha;
				if (delCommitSha && delTreeSha) {
					this.setNoticeText(
						startNotice,
						`🗑️ 正在从远端删除 ${toDeleteFromRemote.length} 个文件...`
					);
					await client.batchDelete(
						toDeleteFromRemote.map((f) => ({ path: f.path })),
						this.buildCommitMessage(),
						delCommitSha,
						delTreeSha
					);
				}
			}

			const writtenPaths = downloads.filter(f => downloaded.get(f.path)).map(f => f.path);
			for (const f of downloads) {
				const content = downloaded.get(f.path);
				if (!content) continue;
				await this.writeLocalFile(f.path, content);
			}

			for (const f of toDeleteLocal) {
				await this.deleteLocalFile(f.path);
			}

			startNotice.hide();
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
				`✅ 合并同步完成：上传 ${uploadedPaths.length}/${uploads.length + merges.length}，` +
					`下载 ${writtenPaths.length}/${downloads.length}，合并 ${mergedPaths.length}/${merges.length}，` +
					`删除远端 ${toDeleteFromRemote.length}，删除本地 ${toDeleteLocal.length}`
			);
			if (uploadedPaths.length > 0 || toDeleteFromRemote.length > 0) {
				this.markRemoteChanged();
			}
			await this.finalizeSync(
				uploadedPaths,
				writtenPaths,
				[
					...toDeleteFromRemote.map((f) => f.path),
					...toDeleteLocal.map((f) => f.path),
				]
			);
		} catch (err) {
			startNotice.hide();
			console.error("Merge sync error:", err);
			await this.notifyPartialFailure(err, "合并同步");
		} finally {
			this.isSyncing = false;
			this.updateStatusBar();
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
		onProgress?: (done: number, total: number) => void,
		/** 只扫描这些路径（单文件同步）；省略 = 整个 Vault */
		onlyPaths?: Set<string>
	): Promise<LocalFileSnapshot> {
		const remoteMap = new Map(remoteFiles.map((f) => [f.path, f] as const));
		const cache = await this.loadHashCache();
		// 单文件同步时合并旧缓存，避免把其它文件的缓存剪掉
		const nextCache: Record<string, HashCacheEntry> = onlyPaths ? { ...cache } : {};

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
		const filtered = files.filter(
			(file) =>
				(!onlyPaths || onlyPaths.has(file.path)) &&
				!this.shouldIgnoreLocal(file.path, ignore)
		);

		// 先列出 .obsidian 待同步文件,让进度回调从一开始就能拿到完整总数。
		// 单文件同步时没必要递归扫描整个 .obsidian。
		let obsidianPaths: string[] = [];
		if (this.settings.syncObsidianFolder) {
			if (onlyPaths) {
				obsidianPaths = Array.from(onlyPaths).filter((path) =>
					this.isObsidianPath(path)
				);
			} else {
				obsidianPaths = await this.listAdapterPaths(".obsidian");
			}
			obsidianPaths = obsidianPaths
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

	/** 持久化 sha 缓存(全量扫描时仅保留本次扫描到的路径,已删除文件自动清理) */
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
			try {
				await this.app.vault.trash(file, true);
			} catch (err) {
				// 移动端/部分环境没有系统回收站，退回永久删除
				console.warn(`移入回收站失败，改为直接删除: ${normalPath}`, err);
				await this.app.vault.delete(file);
			}
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const normPath = normalizePath(path);
		if (this.knownFolders.has(normPath)) return;
		const parts = normPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const norm = normalizePath(current);
			if (this.knownFolders.has(norm)) continue;
			const existing = this.app.vault.getAbstractFileByPath(norm);
			if (!existing) {
				try {
					await this.app.vault.createFolder(norm);
				} catch (err) {
					// 并发创建文件夹时可能冲突，忽略
				}
			}
			this.knownFolders.add(norm);
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

	/** 递归列出目录下所有文件路径（含 .obsidian）；子目录并行扫描 */
	private async listAdapterPaths(dir: string): Promise<string[]> {
		let listing;
		try {
			listing = await this.app.vault.adapter.list(normalizePath(dir));
		} catch {
			return [];
		}
		const hardIgnored = (path: string) =>
			PLUGIN_STATE_PREFIXES.some(
				(p) => path === p || path.startsWith(p + "/")
			);
		// 不进入插件自身的 savings / 缓存目录，避免"选择全部 .obsidian"时
		// 把成百上千个快照文件也递归列出来（它们最终也会被忽略）。
		const folders = listing.folders.filter((folder) => !hardIgnored(folder));
		const nested = await pMap(
			folders,
			(folder) => this.listAdapterPaths(folder),
			8
		);
		const result = listing.files.filter((file) => !hardIgnored(file));
		for (const paths of nested) result.push(...paths);
		return result;
	}

	/** 确保 adapter 路径下的父目录（含 .obsidian）存在 */
	private async ensureAdapterFolder(path: string): Promise<void> {
		const normPath = normalizePath(path);
		if (this.knownFolders.has(normPath)) return;
		const parts = normPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const norm = normalizePath(current);
			if (norm === "." || this.knownFolders.has(norm)) continue;
			try {
				if (!(await this.app.vault.adapter.exists(norm))) {
					await this.app.vault.adapter.mkdir(norm);
				}
			} catch (err) {
				// 并发创建时可能冲突，忽略
			}
			this.knownFolders.add(norm);
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
		const token = (this.settings.token || "").trim();
		const repository = (this.settings.repository || "").trim();
		let message = "";
		if (!token) {
			message = "⚠️ 请先在插件设置中填写 GitHub Token";
		} else if (!repository) {
			message = "⚠️ 请先在插件设置中填写 GitHub 仓库（owner/repo）";
		} else if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
			message = "⚠️ 仓库格式不正确，应为 owner/repo，例如 JonHu1024/articles";
		} else if (!(this.settings.branch || "").trim()) {
			message = "⚠️ 请填写分支名，例如 main";
		}
		if (message) {
			new Notice(message);
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
		const ignored = new Set(
			(this.settings.ignorePaths || "")
				.split("\n")
				.map((s) => s.trim().replace(/\\/g, "/"))
				.filter(Boolean)
		);
		if (!this.settings.syncObsidianFolder) ignored.add(".obsidian");
		// 插件自身的 token/cache/savings 永远不参与同步（本地与远端同时隐藏）
		for (const p of PLUGIN_STATE_PREFIXES) ignored.add(p);
		this.ignoreListCache = Array.from(ignored);
		return this.ignoreListCache;
	}

	private buildCommitMessage(): string {
		const now = new Date().toISOString().replace("T", " ").substring(0, 19);
		const template =
			(this.settings.commitMessage || "").trim() || "obsidian sync {date}";
		return template.replace(/{date}/g, now);
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


