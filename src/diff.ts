// diff.ts — 计算本地与 GitHub 之间的差异(仅对比变化的文件)

import type { GitHubFile } from "./github";

export type ChangeType = "added" | "modified" | "deleted" | "unchanged";
export type SyncDirection = "upload" | "download" | "delete" | "merge";

export interface FileDiff {
	path: string;
	changeType: ChangeType;
	localMtime?: number;   // 本地文件修改时间
	remoteMtime?: number;  // GitHub 文件最后修改时间
	remoteSha?: string;    // GitHub 文件 SHA
	direction?: SyncDirection; // 智能同步时用于展示/执行方向
}

export interface DiffResult {
	toUpload: FileDiff[];   // Push 时：需要上传（新增 + 修改）
	toDelete: FileDiff[];   // Push 时：需要删除（本地不存在）
	toDownload: FileDiff[]; // Pull 时：需要下载（新增 + 修改）
	toRemove: FileDiff[];   // Pull 时：本地需要删除（远端不存在）
	unchanged: FileDiff[];
}

/**
 * 计算本地文件与 GitHub 文件树的差异
 * 使用 GitHub blob SHA（实为 git hash）与本地文件内容 hash 对比
 *
 * @param localFiles  本地文件列表： path -> 内容（未变化的文件内容可为 null，
 *                    此时其 sha 必须已存在于 localShas 中）
 * @param localShas   本地文件 git blob sha（读取阶段预计算/缓存，避免二次哈希）
 * @param remoteFiles GitHub 文件列表
 * @param ignorePaths 忽略的路径前缀（如 .obsidian）
 * @param extraIgnore 额外的忽略判定（如 .obsidian 中未被选中同步的子项，
 *                    对本地与远端同时生效，避免被当作差异）
 */
export async function computeDiff(
	localFiles: Map<string, ArrayBuffer | null>,
	localShas: Map<string, string>,
	remoteFiles: GitHubFile[],
	ignorePaths: string[],
	extraIgnore?: (path: string) => boolean
): Promise<DiffResult> {
	const result: DiffResult = {
		toUpload: [],
		toDelete: [],
		toDownload: [],
		toRemove: [],
		unchanged: [],
	};

	const skip = (path: string): boolean =>
		shouldIgnore(path, ignorePaths) || (extraIgnore ? extraIgnore(path) : false);

	// 过滤远端文件
	const remoteMap = new Map<string, GitHubFile>();
	for (const f of remoteFiles) {
		if (!skip(f.path)) {
			remoteMap.set(f.path, f);
		}
	}

	// 过滤本地文件
	const localFiltered: Array<[string, ArrayBuffer | null]> = [];
	for (const [path, buf] of localFiles) {
		if (!skip(path)) {
			localFiltered.push([path, buf]);
		}
	}

	// 先处理仅本地存在的文件：不需要计算 hash
	for (const [path] of localFiltered) {
		if (!remoteMap.has(path)) {
			result.toUpload.push({ path, changeType: "added" });
			result.toRemove.push({ path, changeType: "deleted" });
		}
	}

	// 双方都存在的文件：对比 git blob sha
	for (const [path, buf] of localFiltered) {
		const remote = remoteMap.get(path);
		if (!remote) continue; // 上面已按"仅本地存在"处理

		let localSha = localShas.get(path);
		if (localSha === undefined && buf) {
			// git blob sha 前缀包含 size：尺寸不同内容必不同，免掉哈希
			if (remote.size > 0 && buf.byteLength !== remote.size) {
				localSha = "";
			} else {
				localSha = await computeGitBlobSha(buf);
			}
		}

		if (localSha !== undefined && localSha === remote.sha) {
			result.unchanged.push({
				path,
				changeType: "unchanged",
				remoteSha: remote.sha,
				remoteMtime: remote.remoteMtime,
			});
		} else {
			result.toUpload.push({
				path,
				changeType: "modified",
				remoteSha: remote.sha,
				remoteMtime: remote.remoteMtime,
			});
			result.toDownload.push({
				path,
				changeType: "modified",
				remoteSha: remote.sha,
				remoteMtime: remote.remoteMtime,
			});
		}
		remoteMap.delete(path); // 标记为已处理
	}

	// 剩余远端文件（本地没有的）
	for (const [path, remote] of remoteMap) {
		// Push：本地删了 → 远端也删
		result.toDelete.push({
			path,
			changeType: "deleted",
			remoteSha: remote.sha,
			remoteMtime: remote.remoteMtime,
		});
		// Pull：远端有，本地没有 → 需要下载
		result.toDownload.push({
			path,
			changeType: "added",
			remoteSha: remote.sha,
			remoteMtime: remote.remoteMtime,
		});
	}

	return result;
}

/**
 * 计算 git blob SHA（与 GitHub 的 SHA 完全一致）
 * git blob SHA = SHA1("blob {size}\0{content}")
 */
export async function computeGitBlobSha(content: ArrayBuffer): Promise<string> {
	const size = content.byteLength;
	const prefix = `blob ${size}\0`;
	const prefixBytes = new TextEncoder().encode(prefix);

	const combined = new Uint8Array(prefixBytes.length + size);
	combined.set(prefixBytes, 0);
	combined.set(new Uint8Array(content), prefixBytes.length);

	const hashBuffer = await crypto.subtle.digest("SHA-1", combined);
	return bufToHex(hashBuffer);
}

function bufToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function shouldIgnore(path: string, ignorePaths: string[]): boolean {
	for (const prefix of ignorePaths) {
		if (path === prefix || path.startsWith(prefix + "/")) return true;
	}
	return false;
}

// ──────────────────────────────────────────────
// 文本 Diff 与合并（使用 Google diff-match-patch）
// 对比渲染由 @codemirror/merge 处理，此处仅负责合并计算
// ──────────────────────────────────────────────

import { diff_match_patch, DIFF_EQUAL, DIFF_DELETE, DIFF_INSERT } from "diff-match-patch";

const TEXT_EXTENSIONS = new Set([
	".md", ".txt", ".json", ".yaml", ".yml", ".xml",
	".html", ".css", ".js", ".ts", ".mjs", ".cjs",
	".py", ".sh", ".toml", ".ini", ".cfg", ".env", ".log",
	".csv", ".tsv", ".svg",
]);

export function isTextFile(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	const ext = path.slice(dot).toLowerCase();
	return TEXT_EXTENSIONS.has(ext);
}

const dmp = new diff_match_patch();

/**
 * 使用 Google diff-match-patch 进行 union merge。
 * 两端字符级差异均保留，不丢失任何修改。
 *
 * 限制：无共同祖先时无法做 3-way merge，
 * 同一位置双方都修改会产生冗余内容，需人工清理。
 */
export function mergeTexts(localText: string, remoteText: string): string {
	const diffs = dmp.diff_main(localText, remoteText);
	dmp.diff_cleanupSemantic(diffs);

	let result = "";
	for (const [op, text] of diffs) {
		if (op === DIFF_EQUAL || op === DIFF_INSERT || op === DIFF_DELETE) {
			result += text;
		}
	}
	return result;
}
