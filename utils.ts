// utils.ts — 通用工具函数

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 受控并发的 map。
 *
 * 任一任务失败后不再派发新任务：调用方一旦抛出"系统性错误"
 * （Token 失效 / 限流 / 网络），剩余几百个请求就不该继续打出去，
 * 否则只会把限流越踩越深、控制台堆满噪声。
 * （单个文件的数据类错误由调用方自行捕获跳过，不会走到这里。）
 */
export async function pMap<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	concurrency: number
): Promise<R[]> {
	if (items.length === 0) return [];
	const results: R[] = new Array(items.length);
	let idx = 0;
	let failed = false;
	async function worker(): Promise<void> {
		while (idx < items.length) {
			if (failed) return;
			const i = idx++;
			try {
				results[i] = await fn(items[i]);
			} catch (err) {
				// 中断派发；已经在飞的请求无法取消，但不会再新增
				failed = true;
				throw err;
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, worker)
	);
	return results;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	const chunks: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
	}
	return btoa(chunks.join(""));
}

export function strToArrayBuffer(s: string): ArrayBuffer {
	const uint8 = new TextEncoder().encode(s);
	return uint8.buffer.slice(
		uint8.byteOffset,
		uint8.byteOffset + uint8.byteLength
	);
}

export function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "未知错误";
}

export function arrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const ua = new Uint8Array(a);
	const ub = new Uint8Array(b);
	for (let i = 0; i < ua.length; i++) {
		if (ua[i] !== ub[i]) return false;
	}
	return true;
}
