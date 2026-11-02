// types.ts — 共享类型定义

import type { GitHubClient, GitHubFile } from "./github";
import type { DiffResult, FileDiff } from "./diff";

export interface RollbackSnapshot {
	id: string;
	date: string;
	files: string[];
}

/** 四种同步模式（工作台顶部选项卡） */
export type SyncMode = "push" | "pull" | "time" | "merge";

/** 远端文件列表快照（启动/同步后静默预取，按 HEAD 复用） */
export interface RemoteSnapshot {
	files: GitHubFile[];
	commitSha: string | null;
	treeSha: string | null;
	commitDate: string;
	isEmpty: boolean;
	fetchedAt: number;
}

/** 一次本地扫描的结果 */
export interface LocalFileSnapshot {
	/** path -> 内容；未变化或两端一致的文件为 null（后续流程用不到内容） */
	files: Map<string, ArrayBuffer | null>;
	mtimes: Map<string, number>;
	/** 本地 git blob sha（读取阶段预计算/缓存） */
	shas: Map<string, string>;
	/** 读取失败的文件：本次同步对其“不可见”，避免误判为删除/新增 */
	failedPaths: string[];
}

/** 智能同步计划（time / merge 模式） */
export interface SmartSyncPlan {
	uploads: FileDiff[];
	downloads: FileDiff[];
	deletions: FileDiff[];
	merges: FileDiff[];
	previewItems: FileDiff[];
	unchanged: number;
}

/**
 * 工作台一次“准备”的结果：远端索引 + 本地快照 + 基础 diff。
 *
 * 切换顶部选项卡时不再重新扫描本地/远端，只在这个基础上重新生成
 * 当前模式的文件列表，保证切换足够快。
 */
export interface SyncBase {
	client: GitHubClient;
	local: LocalFileSnapshot;
	remote: RemoteSnapshot;
	diff: DiffResult;
	/** 单文件同步时只包含该路径 */
	targetPath?: string;
	/** 本次准备阶段产生的提示（读取失败、空仓库等） */
	warnings: string[];
}

/** 当前模式生成的待确认列表 */
export interface ModePlan {
	toProcess: FileDiff[];
	toRemove: FileDiff[];
	unchanged: number;
}

/** 同步执行阶段的进度回调（工作台底部状态栏使用） */
export interface SyncProgressReporter {
	message(text: string): void;
	done?(message: string): void;
	error?(err: unknown): void;
}
