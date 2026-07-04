// utils.ts — 通用工具函数

export async function pMap<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	concurrency: number
): Promise<R[]> {
	if (items.length === 0) return [];
	const results: R[] = new Array(items.length);
	let idx = 0;
	async function worker() {
		while (idx < items.length) {
			const i = idx++;
			results[i] = await fn(items[i]);
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
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
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
