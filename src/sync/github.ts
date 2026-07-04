// sync/github.ts — GitHub SyncProvider 实现
// 基于 GitHubClient（src/github.ts）实现 SyncProvider 接口

import { GitHubClient as RawClient } from "../github";
import type {
	SyncProvider,
	ListResult,
	UploadFile,
	DownloadRequest,
	DeleteRequest,
	CommitResult,
	FileWithCommitInfo,
} from "./provider";

export class GitHubSyncProvider implements SyncProvider {
	private client: RawClient;

	constructor(token: string, repository: string, branch: string) {
		this.client = new RawClient(token, repository, branch);
	}

	async validate(): Promise<{ ok: boolean; message: string }> {
		return this.client.validate();
	}

	async listFiles(): Promise<ListResult> {
		return this.client.listAllFiles();
	}

	async downloadFile(path: string, sha?: string): Promise<ArrayBuffer> {
		return this.client.downloadFile(path, sha);
	}

	async downloadFiles(
		files: DownloadRequest[],
		onProgress?: (done: number, total: number, currentPath: string) => void
	): Promise<Map<string, ArrayBuffer>> {
		return this.client.downloadFiles(files, onProgress);
	}

	async uploadFiles(
		files: UploadFile[],
		message: string,
		currentCommitSha: string | null,
		currentTreeSha: string | null
	): Promise<CommitResult> {
		return this.client.batchUpload(
			files,
			message,
			currentCommitSha,
			currentTreeSha
		);
	}

	async deleteFiles(
		files: DeleteRequest[],
		message: string,
		currentCommitSha: string,
		currentTreeSha: string
	): Promise<CommitResult> {
		return this.client.batchDelete(
			files,
			message,
			currentCommitSha,
			currentTreeSha
		);
	}

	async getFileModTimes(
		paths: string[]
	): Promise<Map<string, number>> {
		return this.client.getFileModTimes(paths);
	}

	async getFilesWithCommits(
		paths: string[]
	): Promise<Map<string, FileWithCommitInfo>> {
		const raw = await this.client.getFilesWithCommits(paths);
		return raw as Map<string, FileWithCommitInfo>;
	}
}
