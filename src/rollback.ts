// rollback.ts — 同步前快照与回滚功能

import { App, TFile, Notice, normalizePath } from "obsidian";
import { pMap } from "./utils";
import type { RollbackSnapshot } from "./types";

export const SAVINGS_DIR = ".obsidian/plugins/github-sync-simple/savings";
const MANIFEST_PATH = `${SAVINGS_DIR}/manifest.json`;
const MAX_VERSIONS = 2;

interface ManifestData {
	versions: SnapshotMeta[];
}

interface SnapshotMeta {
	id: string;
	date: string;
	files: string[];
}

export class RollbackManager {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	// ── 路径工具 ──

	private savingsPath(sub: string): string {
		return normalizePath(`${SAVINGS_DIR}/${sub}`);
	}

	private async exists(path: string): Promise<boolean> {
		try {
			return await this.app.vault.adapter.exists(path);
		} catch {
			return false;
		}
	}

	// ── 目录管理（使用 adapter 绕过 vault 元数据缓存）──

	private async ensureSavingsDir(): Promise<void> {
		const dir = normalizePath(SAVINGS_DIR);
		if (!(await this.exists(dir))) {
			try {
				await this.app.vault.adapter.mkdir(dir);
			} catch {}
		}
	}

	private async deleteSnapshotDir(id: string): Promise<void> {
		const dir = normalizePath(this.savingsPath(id));
		if (await this.exists(dir)) {
			try {
				await this.app.vault.adapter.rmdir(dir, true);
			} catch {}
		}
	}

	// ── 清单读写 ──

	private async readManifest(): Promise<ManifestData> {
		try {
			const path = normalizePath(MANIFEST_PATH);
			if (await this.exists(path)) {
				const content = await this.app.vault.adapter.read(path);
				return JSON.parse(content) as ManifestData;
			}
		} catch {}
		return { versions: [] };
	}

	private async writeManifest(data: ManifestData): Promise<void> {
		try {
			const path = normalizePath(MANIFEST_PATH);
			const content = JSON.stringify(data, null, 2);
			await this.app.vault.adapter.write(path, content);
		} catch (err) {
			console.warn("写入 manifest 失败:", err);
		}
	}

	// ── 保存快照（全部用 adapter，不走 vault 元数据）──

	async saveSnapshot(files: Map<string, ArrayBuffer>): Promise<string> {
		if (files.size === 0) return "";

		await this.ensureSavingsDir();

		const now = new Date();
		const id =
			now.getFullYear().toString() +
			String(now.getMonth() + 1).padStart(2, "0") +
			String(now.getDate()).padStart(2, "0") +
			"_" +
			String(now.getHours()).padStart(2, "0") +
			String(now.getMinutes()).padStart(2, "0") +
			String(now.getSeconds()).padStart(2, "0");
		const date = now.toISOString();
		const dir = this.savingsPath(id);

		// 创建快照目录
		if (!(await this.exists(dir))) {
			try {
				await this.app.vault.adapter.mkdir(dir);
			} catch {}
		}

		// 保存文件（并发写，adapter.writeBinary 直接覆写，无冲突）
		const filePaths: string[] = [];
		const entries = Array.from(files.entries());
		await pMap(
			entries,
			async ([path, content]) => {
				try {
					const targetPath = normalizePath(`${dir}/${path}`);
					const parentDir = normalizePath(targetPath.substring(0, targetPath.lastIndexOf("/")));
					if (parentDir && parentDir !== dir && !(await this.exists(parentDir))) {
						await this.app.vault.adapter.mkdir(parentDir);
					}
					await this.app.vault.adapter.writeBinary(targetPath, content);
					filePaths.push(path);
				} catch (err) {
					console.warn(`保存快照文件失败: ${path}`, err);
				}
			},
			4
		);

		// 更新 manifest（排序保证可预测顺序）
		filePaths.sort();
		const manifest = await this.readManifest();
		manifest.versions.push({ id, date, files: filePaths });
		await this.writeManifest(manifest);

		// 删除旧版本
		await this.trimVersions();

		return id;
	}

	// ── 获取快照列表 ──

	async getSnapshots(): Promise<RollbackSnapshot[]> {
		const manifest = await this.readManifest();
		return manifest.versions
			.map((v) => ({
				id: v.id,
				date: v.date,
				files: v.files,
			}))
			.reverse();
	}

	// ── 回滚（源文件从 savings 读，目标写回 vault）──

	async applySnapshot(id: string): Promise<void> {
		const manifest = await this.readManifest();
		const meta = manifest.versions.find((v) => v.id === id);
		if (!meta) {
			throw new Error(`快照 ${id} 不存在`);
		}

		const dir = this.savingsPath(id);
		let restored = 0;
		let failed = 0;

		await pMap(
			meta.files,
			async (filePath) => {
				try {
					const srcPath = normalizePath(`${dir}/${filePath}`);
					if (!(await this.exists(srcPath))) {
						failed++;
						return;
					}
					const content = await this.app.vault.adapter.readBinary(srcPath);

					// 确保目标父目录在 vault 中存在
					const targetParent = filePath.substring(0, filePath.lastIndexOf("/"));
					if (targetParent) {
						await this.ensureVaultFolder(targetParent);
					}

					const targetPath = normalizePath(filePath);
					const existing = this.app.vault.getAbstractFileByPath(targetPath);
					if (existing instanceof TFile) {
						await this.app.vault.modifyBinary(existing, content);
					} else {
						await this.app.vault.createBinary(targetPath, content);
					}
					restored++;
				} catch (err) {
					console.warn(`回滚文件失败: ${filePath}`, err);
					failed++;
				}
			},
			4
		);

		new Notice(
			`↩️ 回滚完成：恢复 ${restored} 个文件${failed > 0 ? `，${failed} 个失败` : ""}`
		);
	}

	// ── 删除指定快照（回滚完成后清理用）──

	async deleteSnapshot(id: string): Promise<void> {
		const manifest = await this.readManifest();
		manifest.versions = manifest.versions.filter(v => v.id !== id);
		await this.writeManifest(manifest);
		await this.deleteSnapshotDir(id);
	}

	// ── 删除旧版本 ──

	private async trimVersions(): Promise<void> {
		const manifest = await this.readManifest();
		if (manifest.versions.length <= MAX_VERSIONS) return;

		const toRemove = manifest.versions.slice(0, manifest.versions.length - MAX_VERSIONS);
		manifest.versions = manifest.versions.slice(-MAX_VERSIONS);
		await this.writeManifest(manifest);

		for (const v of toRemove) {
			await this.deleteSnapshotDir(v.id);
		}
	}

	// ── 确保 vault 内文件夹存在（回滚目标用）──

	private async ensureVaultFolder(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const norm = normalizePath(current);
			if (!this.app.vault.getAbstractFileByPath(norm)) {
				try {
					await this.app.vault.createFolder(norm);
				} catch {}
			}
		}
	}
}
