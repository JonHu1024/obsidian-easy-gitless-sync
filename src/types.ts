// types.ts — 共享类型定义

export type ChangeType = "added" | "modified" | "deleted" | "unchanged";
export type SyncDirection = "upload" | "download" | "delete" | "merge";

export interface FileDiff {
	path: string;
	changeType: ChangeType;
	localMtime?: number;
	remoteMtime?: number;
	remoteSha?: string;
	direction?: SyncDirection;
}

export interface DiffResult {
	toUpload: FileDiff[];
	toDelete: FileDiff[];
	toDownload: FileDiff[];
	toRemove: FileDiff[];
	unchanged: FileDiff[];
}

export interface RemoteFile {
	path: string;
	sha: string;
	size: number;
	type: "blob" | "tree";
	remoteMtime?: number;
}

export interface FileWithContent {
	content: ArrayBuffer | null;
	commitMessage: string;
	commitDate: string;
	size: number;
}

export interface CommitResult {
	newCommitSha: string;
	newTreeSha: string;
}

export interface RemoteListResult {
	files: RemoteFile[];
	commitSha: string | null;
	treeSha: string | null;
	commitDate: string;
}

export interface RollbackSnapshot {
	id: string;
	date: string;
	files: string[];
}
