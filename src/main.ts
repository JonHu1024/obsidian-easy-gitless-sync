// main.ts — GitHub Sync 插件入口

import {
	Notice,
	Plugin,
	TFile,
	TAbstractFile,
	Menu,
	normalizePath,
	setIcon,
} from "obsidian";
import { GitHubClient, GitHubFile, PartialUploadError } from "./github";
import { computeDiff, computeGitBlobSha, DiffResult, FileDiff, isTextFile, mergeTexts } from "./diff";
import {
	DiffViewerModal,
	RollbackModal,
	UnsyncedWarningModal,
} from "./modals";
import { SyncWorkspaceModal } from "./workspace";
import {
	DEFAULT_SETTINGS,
	GitHubSyncSettings,
	GitHubSyncSettingTab,
} from "./settings";
import { CSS } from "./styles";
import { pMap, strToArrayBuffer, getErrorMessage } from "./utils";
import { RollbackManager } from "./rollback";
import {
	LocalFileSnapshot,
	ModePlan,
	RemoteSnapshot,
	SmartSyncPlan,
	SyncBase,
	SyncMode,
	SyncProgressReporter,
} from "./types";

/** sha 缓存条目:mtime+size 未变即复用 sha,跳过读取与哈希 */
interface HashCacheEntry {
	mtime: number;
	size: number;
	sha: string;
}

interface RemoteMtimeEntry {
	sha: string;
	mtime: number;
}

/**
 * 远端文件 mtime 缓存。
 *
 * 命中条件是"文件的 blob sha 没变"，而不是 HEAD 没变：
 * HEAD 变了通常只是个别文件被改，其它文件的时间依然有效，
 * 这样能避免每次同步后整批重新查询 /commits?path=。
 */
interface RemoteMtimeCache {
	/** 仅作记录：写缓存时的 HEAD（不参与命中判断） */
	headCommitSha: string | null;
	entries: Record<string, RemoteMtimeEntry>;
}

/** 本地 sha 缓存文件(adapter 读写,不进 vault 索引) */
const HASH_CACHE_PATH = ".obsidian/plugins/easy-gitless-sync/hash-cache.json";

/** 按时间同步时远端文件精确 mtime 的缓存(同一 HEAD 内复用,避免重复请求 /commits?path=) */
const REMOTE_MTIME_CACHE_PATH =
	".obsidian/plugins/easy-gitless-sync/remote-mtime-cache.json";

/** syncedPaths 持久化上限(超出裁剪旧记录) */
const SYNCED_PATHS_CAP = 5000;

/**
 * 把执行器的详细进度压成状态栏能放下的短文本。
 *
 * 例："⬆️ 上传中 3/12：notes/a.md" → "⬆️ 3/12"
 */
function compactSyncProgress(text: string): string {
	const m =
		/^(⬆️|⬇️|🔀|🗑️|⚠️|✅)?\s*[^0-9]*?(\d+)\s*\/\s*(\d+)/.exec(text);
	if (m) return `${m[1] ? m[1] + " " : ""}${m[2]}/${m[3]}`;
	const trimmed = text.trim();
	if (!trimmed) return "同步中";
	return trimmed.length > 16 ? `${trimmed.slice(0, 16)}…` : trimmed;
}

/** 两份本地指纹是否完全一致（文件集合 + 每个文件的 mtime:size） */
function stampsEqual(
	a: Map<string, string>,
	b: Map<string, string>
): boolean {
	if (a.size !== b.size) return false;
	for (const [path, value] of a) {
		if (b.get(path) !== value) return false;
	}
	return true;
}

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
	/** 当前打开的工作台（只允许一个，避免并发准备/执行） */
	activeWorkspace: SyncWorkspaceModal | null = null;
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

	// ── 静默对比（启动时把远端列表 + 本地扫描 + diff 一次算完） ──
	/** 已完成的对比结果；远端 HEAD 与本地文件都没变时可直接复用 */
	private preparedBase: SyncBase | null = null;
	/** 上面那次对比时本地文件的 "mtime:size" 快照，用来判断本地是否变过 */
	private preparedBaseStamp: Map<string, string> | null = null;
	/** 上面那次对比使用的忽略列表；忽略规则变了就不能复用 */
	private preparedBaseIgnore = "";
	/** 静默对比在途 Promise：用户中途点同步时等它，不重复请求 */
	private preparedBasePromise: Promise<SyncBase> | null = null;

	// ── 后台同步（窗口关闭后继续跑，状态显示在右上角） ──
	/** 后台同步任务是否在跑 */
	private backgroundSyncRunning = false;
	/** 同步进度文案（状态栏提示 + 右上角卡片用） */
	private syncProgressText = "";
	/** 右上角同步卡片 */
	private syncToast: HTMLElement | null = null;
	/** 右上角卡片自动收起的定时器 */
	private toastTimer: number | null = null;

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
			this.openSyncWorkspace();
		});

		// 命令面板
		this.addCommand({
			id: "open-sync-modal",
			name: "打开同步工作台",
			callback: () => this.openSyncWorkspace(),
		});

		this.addCommand({
			id: "quick-push",
			name: "Quick Push（打开工作台并选中 Push）",
			callback: () => this.openSyncWorkspace("push"),
		});

		this.addCommand({
			id: "quick-pull",
			name: "Quick Pull（打开工作台并选中 Pull）",
			callback: () => this.openSyncWorkspace("pull"),
		});

		this.addCommand({
			id: "quick-time",
			name: "按时间同步（打开工作台并选中 By Time）",
			callback: () => this.openSyncWorkspace("time"),
		});

		this.addCommand({
			id: "quick-merge",
			name: "智能合并（打开工作台并选中 Merge）",
			callback: () => this.openSyncWorkspace("merge"),
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
									this.openSyncWorkspace(undefined, file.path);
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
		this.activeWorkspace?.close();
		this.activeWorkspace = null;
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
		if (!this.statusBarEl) return;
		const syncing = this.isSyncing || this.isPreparing;
		const tone = syncing ? "syncing" : this.isDirty ? "not-sync" : "sync";
		// 右下角状态栏只在 PC 端存在，只做"是否在同步"的提示，不做实时进度
		const label = syncing ? "Sync..." : this.isDirty ? "NOT Sync" : "Sync";

		this.statusBarEl.empty();
		this.statusBarEl.style.color = "";
		this.statusBarEl.style.cursor = syncing ? "default" : "pointer";
		const icon = this.statusBarEl.createSpan({
			cls: `egs-bar-icon egs-bar-${tone}`,
		});
		setIcon(icon, "github");
		if (icon.childElementCount === 0) icon.setText("◉");
		this.statusBarEl.createSpan({
			text: label,
			cls: `egs-bar-label egs-bar-${tone}`,
		});

		if (syncing) {
			this.statusBarEl.title = "同步进行中（右上角查看详情）";
			this.statusBarEl.onclick = null;
			return;
		}

		this.statusBarEl.title = this.isDirty
			? "有未同步的修改；点击打开同步工作台"
			: "已同步；点击打开同步工作台";
		this.statusBarEl.onclick = (event: MouseEvent) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("打开同步工作台").onClick(() => this.openSyncWorkspace())
			);
			if (this.isDirty) {
				menu.addItem((item) =>
					item.setTitle("对比未同步文件").onClick(() => {
						if (this.unsyncedPaths.size > 0) {
							new DiffViewerModal(
								this.app,
								Array.from(this.unsyncedPaths),
								this,
								() => this.openSyncWorkspace(),
								true,
								(paths) => this.onCompareIdentical(paths)
							).open();
						} else {
							this.openSyncWorkspace();
						}
					})
				);
				menu.addItem((item) =>
					item.setTitle("本次状态设为已同步").onClick(async () => {
						await this.clearDirtyState();
						new Notice("✅ 已标记为已同步状态");
					})
				);
			} else {
				menu.addItem((item) =>
					item.setTitle("查看历史版本").onClick(() => {
						void this.openRollback();
					})
				);
			}
			menu.showAtMouseEvent(event);
		};
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

	/**
	 * 所有同步入口都走这里：打开统一工作台。
	 * mode 为空时使用此设备上次选择的模式（默认 By Time）。
	 */
	openSyncWorkspace(mode?: SyncMode, targetPath?: string): void {
		if (!this.checkConfig()) return;
		if (this.isSyncing) {
			new Notice("正在同步，请等待当前任务结束");
			return;
		}
		if (this.activeWorkspace) {
			this.activeWorkspace.focusMode(mode);
			return;
		}
		if (this.isPreparing) {
			new Notice("正在准备同步数据，请稍候");
			return;
		}
		const modal = new SyncWorkspaceModal(this.app, this, {
			mode,
			targetPath,
		});
		modal.onClosed = () => {
			if (this.activeWorkspace === modal) this.activeWorkspace = null;
		};
		this.activeWorkspace = modal;
		modal.open();
	}

	/** 兼容旧调用点（quick commands / 旧代码） */
	startSync(mode?: SyncMode, targetPath?: string): void {
		this.openSyncWorkspace(mode, targetPath);
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
		// 换了仓库，之前那份"远端 vs 本地"的对比结果也不能用了
		this.preparedBase = null;
		this.preparedBaseStamp = null;
		this.preparedBaseIgnore = "";
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
		// 远端被改写 → 上次的对比结果作废（HEAD 已经变了）
		this.preparedBase = null;
		this.preparedBaseStamp = null;
		this.preparedBaseIgnore = "";
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
					() => this.openSyncWorkspace(),
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

	/**
	 * 静默预取：**把完整的"远端 vs 本地"对比一次算完**。
	 *
	 * · 启动后（或用户关掉未同步提醒后）自动执行，不弹窗、不打扰；
	 * · 用户中途点"同步"时，prepareSyncBase 会等这个在途 Promise，
	 *   不会重复拉列表、也不会重复扫本地；
	 * · 算完后缓存在 preparedBase 里；下次点"同步"只要远端 HEAD 没变、
	 *   本地文件没变，就直接复用这份结果（只多 1 个 HEAD 请求做校验）。
	 */
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
			// 共享同一个 Promise：用户中途点同步会 await 它，不重复请求
			const promise = this.buildSyncBase(client, undefined);
			this.preparedBasePromise = promise;
			try {
				const base = await promise;
				console.debug(
					`[Easy Gitless Sync] 静默对比完成：远端 ${base.remote.files.length} 个文件，` +
						`本地待同步 ${base.diff.toUpload.length + base.diff.toDownload.length} 个`
				);
			} finally {
				if (this.preparedBasePromise === promise) {
					this.preparedBasePromise = null;
				}
			}
		} catch (err) {
			console.debug(
				"[Easy Gitless Sync] 静默对比失败（不影响手动同步）:",
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

	/**
	 * 工作台准备阶段：远端索引 + 本地快照 + 基础 diff。
	 *
	 * 切换顶部选项卡时复用这份结果，只重新生成当前模式的列表。
	 */
	async prepareSyncBase(
		targetPath?: string,
		onProgress?: (message: string, percent?: number) => void
	): Promise<SyncBase> {
		if (!this.checkConfig()) throw new Error("插件尚未配置");
		if (this.isSyncing) throw new Error("正在同步，请等待当前任务结束");
		if (this.isPreparing) throw new Error("正在准备同步数据，请稍候");

		this.isPreparing = true;
		this.knownFolders.clear();
		// 还没开始的静默预取就取消；已经在飞的请求会被 getRemoteSnapshot 复用
		if (this.prefetchTimer) {
			window.clearTimeout(this.prefetchTimer);
			this.prefetchTimer = null;
		}
		this.updateStatusBar();

		try {
			const token = (this.settings.token || "").trim();
			const repository = (this.settings.repository || "").trim();
			const branch = (this.settings.branch || "main").trim() || "main";

			const client = new GitHubClient(token, repository, branch, {
				uploadConcurrency: this.settings.uploadConcurrency,
			});

			// 准备阶段也把进度显示在状态栏（窗口还没准备好，用户看得到）
			const report = (message: string, percent?: number) => {
				onProgress?.(message, percent);
				if (this.isPreparing) {
					this.syncProgressText = compactSyncProgress(message);
					this.updateStatusBar();
				}
			};

			// 启动时的静默对比还在跑 → 直接等它，不重复拉列表、不重复扫本地
			if (!targetPath && this.preparedBasePromise) {
				report("等待启动时的静默对比完成...", -1);
				await this.preparedBasePromise.catch(() => null);
			}

			return await this.buildSyncBase(client, targetPath, report);
		} finally {
			this.isPreparing = false;
			this.syncProgressText = "";
			this.updateStatusBar();
		}
	}

	/**
	 * 真正做一次"远端 + 本地"的对比。
	 *
	 * 命中缓存时直接返回上次的对比结果：
	 * · 远端 HEAD（commit sha + tree sha）没变；
	 * · 本地参与同步的文件指纹（mtime:size）没变；
	 * · 忽略规则没变。
	 * 这样用户点"同步"时只需 1 个 HEAD 请求就能拿到完整列表。
	 */
	private async buildSyncBase(
		client: GitHubClient,
		targetPath: string | undefined,
		onProgress?: (message: string, percent?: number) => void
	): Promise<SyncBase> {
		const repository = (this.settings.repository || "").trim();
		const ignore = this.buildIgnoreList();
		const warnings: string[] = [];
		// 记录本次使用的仓库/分支：期间若被改掉，就不缓存这份结果
		const cacheKeyAtStart = this.remoteCacheKeyForSettings();

		onProgress?.("获取 GitHub 文件列表...", -1);
		const remoteResult = await this.getRemoteSnapshot(client, (msg) =>
			onProgress?.(msg, -1)
		);
		const remote = remoteResult.snapshot;
		if (remote.isEmpty) {
			warnings.push(
				`远端仓库 ${repository} 还是空的；首次同步会把本地文件作为初始提交。`
			);
		}

		const onlyPaths = targetPath ? new Set([targetPath]) : undefined;

		// 本地文件指纹（参与同步的文件集合 + 各自的 mtime:size）
		const stamp = onlyPaths ? null : await this.computeLocalStamp(ignore);

		// 复用条件全部满足 → 直接用上次的对比结果
		if (!onlyPaths && stamp && this.preparedBase && this.preparedBaseStamp) {
			const sameRemote =
				(this.preparedBase.remote.commitSha ?? null) ===
					(remote.commitSha ?? null) &&
				(this.preparedBase.remote.treeSha ?? null) ===
					(remote.treeSha ?? null);
			const sameIgnore = this.preparedBaseIgnore === ignore.join("\n");
			if (sameRemote && sameIgnore && stampsEqual(stamp, this.preparedBaseStamp)) {
				onProgress?.("复用上次的对比结果（远端与本地都没有变化）", 100);
				return this.preparedBase;
			}
		}

		onProgress?.(
			targetPath ? `读取 ${targetPath}...` : "读取本地 Vault 文件...",
			0
		);
		const local = await this.readLocalFiles(
			ignore,
			remote.files,
			(done, total) => {
				if (done === total || done % 25 === 0) {
					onProgress?.(
						`读取本地文件 ${done}/${total}...`,
						(done / Math.max(total, 1)) * 95
					);
				}
			},
			onlyPaths
		);

		onProgress?.("计算差异...", 97);
		const extraIgnore = (p: string) =>
			this.isObsidianPath(p) && !this.isObsidianEntrySelected(p);
		let diff = await computeDiff(
			local.files,
			local.shas,
			remote.files,
			ignore,
			extraIgnore,
			onlyPaths
		);

		if (local.failedPaths.length > 0) {
			const failed = new Set(local.failedPaths);
			diff = {
				toUpload: diff.toUpload.filter((f) => !failed.has(f.path)),
				toDelete: diff.toDelete.filter((f) => !failed.has(f.path)),
				toDownload: diff.toDownload.filter((f) => !failed.has(f.path)),
				toRemove: diff.toRemove.filter((f) => !failed.has(f.path)),
				unchanged: diff.unchanged,
			};
			warnings.push(
				`${local.failedPaths.length} 个文件读取失败，本次已跳过：` +
					this.formatFailedPaths(local.failedPaths)
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

		onProgress?.("准备完成", 100);
		const base: SyncBase = {
			client,
			local,
			remote,
			diff,
			targetPath,
			warnings,
		};

		// 存下来给下一次"点同步"复用（单文件同步不缓存）
		if (
			!onlyPaths &&
			stamp &&
			this.remoteCacheKeyForSettings() === cacheKeyAtStart
		) {
			this.preparedBase = base;
			this.preparedBaseStamp = stamp;
			this.preparedBaseIgnore = ignore.join("\n");
		}

		return base;
	}

	/**
	 * 本地"参与同步的文件"的指纹：path -> "mtime:size"。
	 *
	 * 用来判断上次的对比结果还能不能复用：只要有一个文件变了就得重算。
	 */
	private async computeLocalStamp(
		ignore: string[]
	): Promise<Map<string, string>> {
		const stamp = new Map<string, string>();
		for (const file of this.app.vault.getFiles()) {
			if (this.shouldIgnoreLocal(file.path, ignore)) continue;
			stamp.set(file.path, `${file.stat?.mtime ?? 0}:${file.stat?.size ?? 0}`);
		}
		if (this.settings.syncObsidianFolder) {
			try {
				const paths = await this.collectObsidianPaths(ignore);
				await pMap(
					paths,
					async (p) => {
						try {
							const stat = await this.app.vault.adapter.stat(
								normalizePath(p)
							);
							stamp.set(
								p,
								`${stat?.mtime ?? 0}:${stat?.size ?? 0}`
							);
						} catch {
							// 读不到就当没纳入指纹
						}
					},
					8
				);
			} catch {}
		}
		return stamp;
	}

	/** 在已准备的数据上生成某个模式的待确认列表（不重新扫盘/拉列表） */
	async buildModePlan(base: SyncBase, mode: SyncMode): Promise<ModePlan> {
		if (mode === "time") {
			const smart = await this.buildTimeSyncPlan(
				base.client,
				base.local,
				base.remote,
				base.diff
			);
			return {
				toProcess: smart.previewItems,
				toRemove: [],
				unchanged: smart.unchanged,
			};
		}
		if (mode === "merge") {
			const smart = await this.buildMergePlan(
				base.client,
				base.local,
				base.remote,
				base.diff
			);
			return {
				toProcess: smart.previewItems,
				toRemove: [],
				unchanged: smart.unchanged,
			};
		}
		if (mode === "push") {
			return {
				toProcess: base.diff.toUpload.map((f): FileDiff => ({
					...f,
					direction: f.direction ?? "upload",
				})),
				toRemove: base.diff.toDelete.map((f): FileDiff => ({
					...f,
					direction: "delete",
				})),
				unchanged: base.diff.unchanged.length,
			};
		}
		return {
			toProcess: base.diff.toDownload.map((f): FileDiff => ({
				...f,
				direction: f.direction ?? "download",
			})),
			toRemove: base.diff.toRemove.map((f): FileDiff => ({
				...f,
				direction: "delete-local",
			})),
			unchanged: base.diff.unchanged.length,
		};
	}

	/**
	 * 工作台点击“开始同步”后调用。
	 * 只有真正需要写远端时才检查写权限（纯 Pull / 删本地不需要）。
	 */
	async executeWorkspaceSelection(
		base: SyncBase,
		selectedProcess: FileDiff[],
		selectedRemove: FileDiff[],
		reporter?: SyncProgressReporter
	): Promise<void> {
		const selected = [...selectedProcess, ...selectedRemove];
		if (selected.length === 0) {
			reporter?.error?.(new Error("未选择任何文件"));
			return;
		}

		const needsWrite = selected.some(
			(f) =>
				f.direction === "upload" ||
				f.direction === "merge" ||
				f.direction === "delete"
		);
		if (needsWrite) {
			const token = (this.settings.token || "").trim();
			const repository = (this.settings.repository || "").trim();
			const branch = (this.settings.branch || "main").trim() || "main";
			const permissionKey = `${token}\u0000${repository}\u0000${branch}`;
			if (this.writePermissionKey !== permissionKey) {
				reporter?.message("检查 Token 写权限...");
				await base.client.assertWritePermission();
				this.writePermissionKey = permissionKey;
			}
		}

		this.knownFolders.clear();
		await this.executeSelected(
			base.client,
			base.local.files,
			base.remote,
			selectedProcess,
			selectedRemove,
			reporter
		);
	}

	/**
	 * 工作台点击“开始同步”后调用：**立即返回**，同步在后台继续跑。
	 *
	 * · 工作台窗口由调用方立刻关闭，用户不用等；
	 * · 同步状态统一显示在**右上角**的卡片里（进度实时刷新，完成后变总结）；
	 * · 右下角状态栏只在 PC 端存在，只显示 "Sync..."，不做实时进度。
	 */
	startBackgroundSync(
		base: SyncBase,
		selectedProcess: FileDiff[],
		selectedRemove: FileDiff[],
		mode: SyncMode
	): void {
		const total = selectedProcess.length + selectedRemove.length;
		if (total === 0) {
			new Notice("⚠️ 未选择任何文件");
			return;
		}
		if (this.backgroundSyncRunning || this.isSyncing) {
			new Notice("⚠️ 正在同步，请等待当前任务结束");
			return;
		}

		this.rememberSyncMode(mode);
		this.backgroundSyncRunning = true;
		this.isSyncing = true;
		this.syncProgressText = "准备中";
		this.updateStatusBar();
		this.showSyncToast(`同步中… ${total} 个文件`, true);

		const reporter: SyncProgressReporter = {
			message: (text: string) => {
				this.syncProgressText = compactSyncProgress(text);
				// 右下角状态栏只作"是否在同步"的提示，不做实时进度
				if (this.statusBarEl) {
					this.statusBarEl.title = `同步进行中：${this.syncProgressText}`;
				}
				this.showSyncToast(`同步中… ${this.syncProgressText}`, true);
			},
			done: (text: string) => {
				this.backgroundSyncRunning = false;
				this.isSyncing = false;
				this.syncProgressText = "";
				this.updateStatusBar();
				this.showSyncSummary(text, true);
			},
			error: (err: unknown) => {
				this.backgroundSyncRunning = false;
				this.isSyncing = false;
				this.syncProgressText = "";
				this.updateStatusBar();
				this.showSyncSummary(`同步失败：${getErrorMessage(err)}`, false);
			},
		};

		void this.executeWorkspaceSelection(
			base,
			selectedProcess,
			selectedRemove,
			reporter
		)
			.catch((err) => reporter.error?.(err))
			.finally(() => {
				this.backgroundSyncRunning = false;
				this.isSyncing = false;
				this.syncProgressText = "";
				this.updateStatusBar();
			});
	}

	/**
	 * 同步结束后的总结：右上角卡片切换成最终结果。
	 */
	private showSyncSummary(text: string, ok: boolean): void {
		try {
			const oneLine = text
				.replace(/^✅\s*/, "")
				.replace(/[，,]\s*/g, " · ")
				.trim();
			this.showSyncToast(oneLine, false, ok);
		} catch (err) {
			console.warn("显示同步总结失败:", err);
			new Notice(text);
		}
	}

	/**
	 * 右上角同步卡片：**单行**，简单直接。
	 *
	 * · 进行中：带小转圈，显示当前进度；长时间没动静会自动收起；
	 * · 完成后：变成一行总结，6 秒后自动收起。
	 */
	private showSyncToast(text: string, live: boolean, ok = true): void {
		try {
			const body = document.body;
			if (!body) return;
			if (this.toastTimer) {
				window.clearTimeout(this.toastTimer);
				this.toastTimer = null;
			}

			let toast = this.syncToast;
			if (!toast || toast.parentElement == null) {
				const created = body.createDiv({ cls: "egs-toast" });
				this.syncToast = created;
				window.requestAnimationFrame(() =>
					created.addClass("is-visible")
				);
				toast = created;
			}

			toast.empty();
			toast.toggleClass("is-error", !ok);
			toast.toggleClass("is-live", live);

			const row = toast.createDiv("egs-toast-row");
			if (live) {
				row.createDiv({
					cls: "egs-toast-spinner",
					attr: { "aria-hidden": "true" },
				});
			} else {
				row.createSpan({ text: ok ? "✅" : "⚠️", cls: "egs-toast-icon" });
			}
			row.createSpan({ text, cls: "egs-toast-text" });

			// 进行中：长时间没有新进度就自动收起（下次有进度会再冒出来）
			this.toastTimer = window.setTimeout(
				() => this.hideToast(toast),
				live ? 15000 : 6000
			);
		} catch (err) {
			console.warn("显示右上角同步卡片失败:", err);
		}
	}

	private hideToast(toast: HTMLElement): void {
		if (!toast || toast.parentElement == null) return;
		if (this.toastTimer) {
			window.clearTimeout(this.toastTimer);
			this.toastTimer = null;
		}
		if (this.syncToast === toast) this.syncToast = null;
		toast.removeClass("is-visible");
		window.setTimeout(() => {
			try {
				toast.remove();
			} catch {}
		}, 400);
	}

	/** 现在是否正在同步（工作台的对比预取要避让） */
	get isSyncingNow(): boolean {
		return this.isSyncing || this.backgroundSyncRunning;
	}

	/** 此设备上次选择的同步模式 */
	getLastSyncMode(): SyncMode {
		const mode = this.settings.lastSyncMode;
		return mode === "push" || mode === "pull" || mode === "time" || mode === "merge"
			? mode
			: "time";
	}

	rememberSyncMode(mode: SyncMode): void {
		if (this.settings.lastSyncMode === mode) return;
		this.settings.lastSyncMode = mode;
		void this.saveSettings().catch((err) =>
			console.warn("保存上次同步模式失败:", err)
		);
	}

	/** 工作台确认“全量 diff 为空”时，把状态栏结算为已同步 */
	async markAllSynced(): Promise<void> {
		await this.clearDirtyState();
	}

	// ──────────────────────────────────────────────
	// 回滚
	// ──────────────────────────────────────────────

	async openRollback(): Promise<void> {
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
		// 按"文件的 blob sha"命中，而不是要求 HEAD 完全一致：
		// HEAD 变了通常只是某个文件被改，其它文件的时间没变，
		// 这样就只用重新查真正变化的那几个文件（而不是整批重查）。
		const entries = cache?.entries ?? {};
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
		const nextEntries: Record<string, RemoteMtimeEntry> = { ...entries };
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
		selectedRemove: FileDiff[],
		reporter?: SyncProgressReporter
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
			if (reporter) reporter.error?.(new Error("没有可执行的动作"));
			else new Notice("⚠️ 没有可执行的动作");
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
				localDeletes,
				reporter
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
				localDeletes,
				reporter
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
		toDeleteLocal: FileDiff[] = [],
		reporter?: SyncProgressReporter
	) {
		this.isSyncing = true;
		this.updateStatusBar();
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = reporter
			? null
			: new Notice(
					`🔀 开始同步，上传 ${uploads.length}，下载 ${downloads.length}` +
						`${toDeleteFromRemote.length ? `，删除远端 ${toDeleteFromRemote.length}` : ""}` +
						`${toDeleteLocal.length ? `，删除本地 ${toDeleteLocal.length}` : ""}...`,
					0
			  );
		const report = (text: string) => {
			if (reporter) reporter.message(text);
			else if (startNotice) this.setNoticeText(startNotice, text);
		};
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
						report(`⬆️ 上传中 ${done}/${total}：${path}`)
				  ).then(r => ({ commitSha: r.newCommitSha, treeSha: r.newTreeSha }))
				: Promise.resolve(null);

			const downloadPromise = downloads.length > 0
				? client.downloadFiles(
					downloads.map((f) => ({ path: f.path, sha: f.remoteSha })),
					(done, total, path) =>
						report(`⬇️ 下载中 ${done}/${total}：${path}`)
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

			startNotice?.hide();
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
			const doneMessage =
				`✅ 同步完成：上传 ${uploadedPaths.length}/${uploads.length}，` +
				`下载 ${writtenPaths.length}/${downloads.length}，` +
				`删除远端 ${toDeleteFromRemote.length}，删除本地 ${toDeleteLocal.length}`;
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
			if (reporter) reporter.done?.(doneMessage);
			else new Notice(doneMessage);
		} catch (err) {
			startNotice?.hide();
			console.error("Smart sync error:", err);
			reporter?.error?.(err);
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
		toDeleteLocal: FileDiff[] = [],
		reporter?: SyncProgressReporter
	) {
		this.isSyncing = true;
		this.updateStatusBar();
		downloads.forEach(f => this.recentlySyncedPaths.add(f.path));
		merges.forEach(f => this.recentlySyncedPaths.add(f.path));

		const startNotice = reporter
			? null
			: new Notice(
					`🔀 开始合并同步，上传 ${uploads.length}，下载 ${downloads.length}，合并 ${merges.length}` +
						`${toDeleteFromRemote.length ? `，删除远端 ${toDeleteFromRemote.length}` : ""}` +
						`${toDeleteLocal.length ? `，删除本地 ${toDeleteLocal.length}` : ""}...`,
					0
			  );
		const report = (text: string) => {
			if (reporter) reporter.message(text);
			else if (startNotice) this.setNoticeText(startNotice, text);
		};
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
					report(`🔀 拉取冲突文件 ${mergeDone}/${merges.length}：${item.path}`);
					return { item, remoteContent: rc };
				})
			);

			const downloadPromise = downloads.length > 0
				? client.downloadFiles(
					downloads.map((f) => ({ path: f.path, sha: f.remoteSha })),
					(done, total, path) =>
						report(`⬇️ 下载中 ${done}/${total}：${path}`)
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
							report(`⬆️ 上传中 ${done}/${total}：${path}`)
					);
					uploadedPaths = filesToUpload.map((f) => f.path);
				}
			}

			// Phase 3：删除远端 / 下载写入本地 / 删除本地
			if (toDeleteFromRemote.length > 0) {
				const delCommitSha = uploadResult?.newCommitSha ?? currentCommitSha;
				const delTreeSha = uploadResult?.newTreeSha ?? currentTreeSha;
				if (delCommitSha && delTreeSha) {
					report(
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

			startNotice?.hide();
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
			const doneMessage =
				`✅ 合并同步完成：上传 ${uploadedPaths.length}/${uploads.length + merges.length}，` +
				`下载 ${writtenPaths.length}/${downloads.length}，合并 ${mergedPaths.length}/${merges.length}，` +
				`删除远端 ${toDeleteFromRemote.length}，删除本地 ${toDeleteLocal.length}`;
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
			if (reporter) reporter.done?.(doneMessage);
			else new Notice(doneMessage);
		} catch (err) {
			startNotice?.hide();
			console.error("Merge sync error:", err);
			reporter?.error?.(err);
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
				obsidianPaths = await this.collectObsidianPaths(ignore);
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

	/**
	 * 收集"参与同步的 .obsidian 文件"路径。
	 *
	 * 用户在设置里选了具体子项时，只走选中的那些路径（不用遍历整个 .obsidian）；
	 * 没选（=全部）时才递归遍历整个目录。
	 */
	private async collectObsidianPaths(ignore: string[]): Promise<string[]> {
		const sel = (this.settings.obsidianSyncSelection || []).filter(Boolean);
		let candidates: string[] = [];
		if (sel.length === 0) {
			candidates = await this.listAdapterPaths(".obsidian");
		} else {
			for (const entry of sel) {
				const full = normalizePath(".obsidian/" + entry);
				try {
					const stat = await this.app.vault.adapter.stat(full);
					if (!stat) continue;
					if (stat.type === "folder") {
						candidates.push(...(await this.listAdapterPaths(full)));
					} else {
						candidates.push(full);
					}
				} catch {
					// 选中的条目可能已经被删除
				}
			}
		}
		return candidates
			.filter((path) => this.isObsidianEntrySelected(path))
			.filter((path) => !this.shouldIgnoreLocal(path, ignore));
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


