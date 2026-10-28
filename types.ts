// types.ts — 共享类型定义
// （FileDiff / DiffResult 等同步相关类型统一定义在 diff.ts，
//   SyncProvider 相关类型定义在 sync/provider.ts，此处不再重复）

export interface RollbackSnapshot {
	id: string;
	date: string;
	files: string[];
}
