// sync/provider.ts — SyncProvider 抽象接口
// 未来新增同步商时，实现此接口即可

export interface UploadFile {
	path: string;
	content: ArrayBuffer;
}

export interface DownloadRequest {
	path: string;
	sha?: string;
}

export interface DeleteRequest {
	path: string;
}

export interface FileWithCommitInfo {
	content: ArrayBuffer | null;
	commitMessage: string;
	commitDate: string;
	size: number;
}

export interface RemoteFile {
	path: string;
	sha: string;
	size: number;
	type: "blob" | "tree";
	remoteMtime?: number;
}

export interface ListResult {
	files: RemoteFile[];
	commitSha: string | null;
	treeSha: string | null;
	commitDate: string;
	/** true = 已确认远端仓库为空（还没有任何 commit） */
	isEmpty?: boolean;
}

export interface CommitResult {
	newCommitSha: string;
	newTreeSha: string;
}

export interface SyncProvider {
	validate(): Promise<{ ok: boolean; message: string }>;

	listFiles(): Promise<ListResult>;

	downloadFile(path: string, sha?: string): Promise<ArrayBuffer>;

	downloadFiles(
		files: DownloadRequest[],
		onProgress?: (done: number, total: number, currentPath: string) => void
	): Promise<Map<string, ArrayBuffer>>;

	uploadFiles(
		files: UploadFile[],
		message: string,
		currentCommitSha: string | null,
		currentTreeSha: string | null
	): Promise<CommitResult>;

	deleteFiles(
		files: DeleteRequest[],
		message: string,
		currentCommitSha: string,
		currentTreeSha: string
	): Promise<CommitResult>;

	getFileModTimes(paths: string[]): Promise<Map<string, number>>;

	getFilesWithCommits(paths: string[]): Promise<Map<string, FileWithCommitInfo>>;
}
