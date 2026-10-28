// github.ts — GitHub REST API (no local git required)

import { Notice } from "obsidian";
import { pMap, arrayBufferToBase64, sleep } from "./utils";

export interface GitHubFile {
	path: string;
	sha: string;
	size: number;
	type: "blob" | "tree";
	/** 远端文件的最后提交时间（Unix ms），仅智能同步时填充 */
	remoteMtime?: number;
}

export interface FileWithCommitInfo {
	content: ArrayBuffer | null;
	commitMessage: string;
	commitDate: string;
	size: number;
}

export interface TreeItem {
	path: string;
	mode: string;
	type: string;
	sha: string;
	size?: number;
}

/** 分支 HEAD 信息 */
export interface BranchHead {
	commitSha: string;
	treeSha: string;
	commitDate: string;
}

// ─── 错误类型 ──────────────────────────────────────────────────────────────

/**
 * GitHub API 调用失败。
 *
 * `status === 0` 表示网络层失败（CORS 被代理破坏 / 断网 / 超时），
 * 而不是任何"业务语义"——上层必须把它和 404 之类区分开。
 *
 * 引入这个类型是为了修掉一个真实的严重缺陷：旧代码把所有非 2xx 都当成
 * `null` 返回，于是"读取分支失败"被下游理解成"仓库是空的"。
 */
export class GitHubApiError extends Error {
	readonly status: number;
	readonly retryable: boolean;
	/**
	 * 是否为"系统性"故障（Token / 权限 / 限流 / 网络 / 服务端），
	 * 而不是"这个文件本身有问题"。
	 *
	 * 用途：单个文件的数据类错误应该跳过并继续后续文件；
	 * 系统性错误必须立刻中断 —— 否则会把剩下几百个文件挨个失败一遍。
	 */
	readonly systemic: boolean;
	constructor(
		message: string,
		status: number,
		retryable = false,
		systemic = false
	) {
		super(message);
		this.name = "GitHubApiError";
		this.status = status;
		this.retryable = retryable;
		this.systemic = systemic;
	}
}

/**
 * 上传没有全部完成。
 *
 * 两种情况：
 * · 有文件被跳过（`failedPaths` 非空）—— 单个文件失败（例如体积超限、
 *   内容被 GitHub 拒绝）不会终止整批，其余文件照常提交；
 * · 某一块的 tree/commit/引用更新失败（`failedPaths` 为空）—— 属于
 *   仓库/网络层面的问题，此时中断，但此前已提交的块留在远端。
 *
 * 两种情况下重新同步都会自动跳过已成功上传的文件，只需补传剩余部分。
 */
export class PartialUploadError extends Error {
	readonly uploadedPaths: string[];
	readonly failedPaths: string[];
	readonly uploadedCount: number;
	readonly totalCount: number;
	constructor(
		message: string,
		uploadedPaths: string[],
		totalCount: number,
		failedPaths: string[] = []
	) {
		super(message);
		this.name = "PartialUploadError";
		this.uploadedPaths = uploadedPaths;
		this.failedPaths = failedPaths;
		this.uploadedCount = uploadedPaths.length;
		this.totalCount = totalCount;
	}
}

// ─── 并发/超时/重试参数 ────────────────────────────────────────────────────

/**
 * 创建 blob 的默认并发数。
 *
 * 实测（见 test/bench.ts）：1000 个 20KB 文件，SHA-1 合计 61ms、base64 合计
 * 457ms —— 本地 CPU 完全不是瓶颈。上传耗时几乎就等于
 * (文件数 / 并发数) × RTT。
 *
 * 但并发**不能无限调大**：GitHub 对"创建内容"类请求（POST /git/blobs、
 * /git/trees、/git/commits）有二次限流(secondary rate limit)，
 * 官方文档明确要求"串行、并发请求会触发限流"。实测把并发提到 16 时，
 * 首次上传 1000 个文件会成片出现 `POST /git/blobs 403 Forbidden`。
 * 因此默认值保守取 8（设置里可调），并且一旦真的被限流，
 * 客户端会进入全局冷却 + 自动把并发减半（见 enterThrottle）。
 */
const DEFAULT_UPLOAD_CONCURRENCY = 8;
const MAX_UPLOAD_CONCURRENCY = 32;
/**
 * 一次同步的**起始**并发上限。
 *
 * 即使设置里填了更大的值，也从 8 开始，每成功提交一块 +1 慢慢升到设定值
 * （AIMD）。这样"用户填了 16/24"不会一上来就并发猛冲触发 403；
 * 网络真的扛得住时再逐步提速。也顺带兼容旧版本已经持久化过的大数值。
 */
const START_UPLOAD_CONCURRENCY = 8;
const DOWNLOAD_CONCURRENCY = 8;  // 下载文件并发数
const MTIME_CONCURRENCY = 6;     // 查询文件修改时间并发（此接口限速更严）

/** 普通请求超时 */
const REQUEST_TIMEOUT_MS = 30_000;
/** blob 上传（base64 体积约 1.33 倍）需要更宽松的超时 */
const BLOB_TIMEOUT_MS = 180_000;
/** 大文件下载超时 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 可重试状态的最大尝试次数（含首次） */
const MAX_ATTEMPTS = 4;
/** 401 只多试一次：Token 真失效时反复空转没有意义 */
const AUTH_MAX_ATTEMPTS = 2;
/** 重试退避上限 */
const MAX_BACKOFF_MS = 20_000;

/** 被限流时允许的尝试次数（比普通错误更耐心，靠冷却等待恢复） */
const RATE_LIMIT_MAX_ATTEMPTS = 6;
/** GitHub 没给 Retry-After 时的默认冷却时长 */
const THROTTLE_DEFAULT_MS = 20_000;
/** 单次冷却上限，避免把界面挂死太久 */
const THROTTLE_MAX_MS = 120_000;

/**
 * 单个 commit 最多容纳的文件数。
 *
 * 1000+ 文件的首次上传会被拆成多个 commit，原因：
 * ① 一条超长请求链中途失败会让全部工作作废，分块后失败只影响当前块；
 * ② 已提交的块会留在远端，重跑时差异计算直接跳过，天然可续传；
 * ③ 单次 payload 更小，超时/限流风险显著下降。
 */
const UPLOAD_CHUNK_SIZE = 150;

interface RequestOptions {
	timeoutMs?: number;
	maxAttempts?: number;
	/** 出错信息里的动作描述，如 "创建 blob" */
	action?: string;
}

/** 可调参数（来自插件设置）；不传则用默认值 */
export interface GitHubClientOptions {
	/** 上传（创建 blob）并发数，1~32 */
	uploadConcurrency?: number;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 树条目：sha 为 null 表示删除该路径 */
interface TreeEntry {
	path: string;
	mode: string;
	type: string;
	sha: string | null;
}

function isRetryableStatus(status: number): boolean {
	return (
		status === 401 || // Token 偶发被拒（代理/WAF），值得再试一次
		status === 403 || // 限流 / 二次限流 / 权限不足
		status === 408 ||
		status === 429 ||
		status >= 500
	);
}

/** 系统性故障：换个文件重试也没用，必须中断整批 */
function isSystemicStatus(status: number): boolean {
	return (
		status === 0 || // 网络层
		status === 401 ||
		status === 403 ||
		status === 408 ||
		status === 429 ||
		status >= 500
	);
}

function statusHint(status: number, branch: string): string {
	switch (status) {
		case 401:
			return "（Token 无效或已过期，请在插件设置中重新填写 GitHub Token）";
		case 403:
			return "（403 有两种含义：① 触发 GitHub 限流/二次限流 —— 把「上传并发数」调到 4~8、稍等几分钟再试；② Token 权限不足 —— 细粒度 Token 需要 Contents: Read and write，经典 Token 需要勾选 repo）";
		case 404:
			return `（仓库/分支/路径不存在：请确认仓库名与分支名「${branch}」是否正确、Token 是否有该仓库权限）`;
		case 409:
			return "（仓库为空或状态冲突）";
		case 422:
			return "（请求被 GitHub 拒绝：常见原因是缺少 sha、分支不存在或文件过大）";
		default:
			return status >= 500 ? "（GitHub 服务端错误，稍后重试）" : "";
	}
}

function describeNetworkError(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") {
			return "请求超时";
		}
		return err.message || err.name;
	}
	return String(err);
}

function backoffDelay(attempt: number): number {
	// 指数退避 + 抖动，避免多个并发请求同时重试再次触发限流
	const base = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
	return base + Math.floor(Math.random() * 250);
}

// ─── 客户端 ────────────────────────────────────────────────────────────────

export class GitHubClient {
	private token: string;
	private owner: string;
	private repo: string;
	private branch: string;
	private baseUrl: string;
	/** 用户在设置里设定的上传并发上限 */
	private uploadConcurrencyCap: number;
	/** 当前生效的上传并发（被限流时会自动减半，成功后逐步回升） */
	private uploadConcurrency: number;
	/** 全客户端共享的限流冷却截止时刻（Date.now() 毫秒） */
	private throttleUntilMs = 0;

	constructor(
		token: string,
		repository: string,
		branch: string,
		options: GitHubClientOptions = {}
	) {
		this.token = token.trim();
		const [owner, repo] = repository.trim().split("/");
		this.owner = (owner || "").trim();
		this.repo = (repo || "").trim();
		this.branch = (branch || "main").trim() || "main";
		this.baseUrl = `https://api.github.com/repos/${this.owner}/${this.repo}`;
		this.uploadConcurrencyCap = clampInt(
			options.uploadConcurrency,
			1,
			MAX_UPLOAD_CONCURRENCY,
			DEFAULT_UPLOAD_CONCURRENCY
		);
		// 保守起步：先按 8 跑，成功后再逐块升到用户设定值
		this.uploadConcurrency = Math.min(
			this.uploadConcurrencyCap,
			START_UPLOAD_CONCURRENCY
		);
	}

	/** 单次网络发送（含超时） */
	private async send(
		url: string,
		options: RequestInit,
		timeoutMs: number
	): Promise<Response> {
		const timeoutFn = (
			AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
		).timeout;
		const signal =
			typeof AbortSignal !== "undefined" && typeof timeoutFn === "function"
				? timeoutFn.call(AbortSignal, timeoutMs)
				: undefined;

		const hasBody = options.body !== undefined && options.body !== null;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...((options.headers as Record<string, string> | undefined) || {}),
		};
		// 只有带 body 的请求才声明 Content-Type：GET 少一个非简单头，
		// 减少预检(OPTIONS)被中间代理破坏的机会
		if (hasBody && !headers["Content-Type"]) {
			headers["Content-Type"] = "application/json";
		}

		return fetch(url, { ...options, signal, headers });
	}

	/**
	 * 带重试与限流冷却的请求。
	 *
	 * 关键行为约定（上层依赖它来区分"失败"和"空仓库"）：
	 * · 网络失败 / 401 / 403 / 408 / 429 / 5xx —— 重试耗尽后 **抛错**；
	 * · 404 / 409 / 422 等业务状态 —— 原样返回，由调用方判断语义。
	 *
	 * 403 有**两种完全不同的含义**，必须分开处理（否则要么白白失败，
	 * 要么对着没有写权限的 Token 空转几百次）：
	 * · 二次限流(secondary rate limit) —— 全局冷却 + 把上传并发减半后继续；
	 * · 权限不足 —— 立刻抛出可操作的错误，不重试。
	 *
	 * 注意：抛错前会读掉 body，返回时绝不读（调用方还要用）。
	 */
	private async request(
		path: string,
		options: RequestInit = {},
		opts: RequestOptions = {}
	): Promise<Response> {
		const url = path.startsWith("https://") ? path : `${this.baseUrl}${path}`;
		const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
		const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
		const label = opts.action ?? `${options.method ?? "GET"} ${path}`;
		let lastNetworkError = "未知错误";

		// 注意：这里不能用固定次数的 for —— 限流时允许的尝试次数比普通错误更多，
		// 用固定上界会让"限流重试"提前耗尽并落到兜底分支（曾经的 bug）。
		// 因此改为无界循环，每个分支都显式 return / throw。
		for (let attempt = 1; ; attempt++) {
			// 全局冷却：任何一个请求被限流，所有请求一起等，
			// 否则并发的其它请求会不断把限流"续期"
			await this.waitForThrottle();

			let resp: Response;
			try {
				resp = await this.send(url, options, timeoutMs);
			} catch (err) {
				// 网络层失败（CORS/断网/超时）——值得重试
				lastNetworkError = describeNetworkError(err);
				if (attempt >= maxAttempts) {
					throw new GitHubApiError(
						`${label} 失败: 网络请求失败（${lastNetworkError}）。` +
							`若反复出现，请检查代理/VPN 是否改写了 api.github.com 的响应头导致 CORS 被拒，或网络是否稳定。`,
						0,
						true,
						true
					);
				}
				await sleep(backoffDelay(attempt));
				continue;
			}

			if (resp.ok) return resp;

			// 非可重试的业务状态：原样交给调用方（body 不能读）
			if (!isRetryableStatus(resp.status)) return resp;

			// 走到这里一定是可重试状态，body 反正是要丢掉的，读出来做分类
			const bodyText = await resp.text().catch(() => "");
			const rateLimited =
				resp.status === 429 ||
				(resp.status === 403 && this.looksRateLimited(resp, bodyText));

			if (resp.status === 403 && !rateLimited) {
				// 权限不足之类的 403：重试没有任何意义，直接把原因说清楚
				throw this.errorFromText(403, bodyText, label, false);
			}

			if (rateLimited) {
				const needed = this.retryAfterMs(resp);
				if (needed > THROTTLE_MAX_MS) {
					// 主限流配额耗尽、重置还在很远的将来：干等没有意义，
					// 直接告诉用户什么时候能恢复
					throw this.errorFromText(
						resp.status,
						bodyText,
						label,
						true,
						`配额将在约 ${Math.ceil(needed / 60000)} 分钟后重置，请稍后再同步`
					);
				}
				if (attempt >= RATE_LIMIT_MAX_ATTEMPTS) {
					throw this.errorFromText(resp.status, bodyText, label, true);
				}
				this.enterThrottle(needed || THROTTLE_DEFAULT_MS, bodyText);
				continue; // 下一轮的 waitForThrottle() 会等到冷却结束
			}

			const allowed = resp.status === 401 ? AUTH_MAX_ATTEMPTS : maxAttempts;
			if (attempt >= allowed) {
				throw this.errorFromText(resp.status, bodyText, label);
			}
			await sleep(backoffDelay(attempt));
		}
	}

	/**
	 * 全局限流冷却。正在冷却时所有请求一起等。
	 * 用 throttleUntilMs 而不是各自 sleep，是为了让并发请求同步退让。
	 */
	private async waitForThrottle(): Promise<void> {
		const wait = this.throttleUntilMs - Date.now();
		if (wait > 0) await sleep(Math.min(wait, THROTTLE_MAX_MS));
	}

	/**
	 * 进入限流冷却，并把上传并发减半（AIMD 的乘减）。
	 * 恢复是渐进的：每成功提交一块 +1，直到回到用户设定的上限。
	 */
	private enterThrottle(waitMs: number, bodyText: string): void {
		const capped = Math.min(Math.max(waitMs, 1000), THROTTLE_MAX_MS);
		const until = Date.now() + capped;
		if (until > this.throttleUntilMs) this.throttleUntilMs = until;

		const before = this.uploadConcurrency;
		this.uploadConcurrency = Math.max(1, Math.floor(this.uploadConcurrency / 2));
		console.warn(
			`GitHub 限流（403/429）：暂停 ${Math.round(capped / 1000)}s，` +
				`上传并发 ${before} → ${this.uploadConcurrency}。` +
				`建议在设置里把「上传并发数」调小（4~8），等待几分钟再同步。` +
				(bodyText ? `\nGitHub 说明: ${bodyText.slice(0, 300)}` : "")
		);
	}

	/** 判断 403 到底是"二次限流"还是"权限不足" */
	private looksRateLimited(resp: Response, bodyText: string): boolean {
		if (resp.status === 429) return true;
		if (resp.headers.get("retry-after")) return true;
		if (resp.headers.get("x-ratelimit-remaining") === "0") return true;
		const text = bodyText.toLowerCase();
		return (
			text.includes("secondary rate limit") ||
			text.includes("rate limit") ||
			text.includes("abuse") ||
			text.includes("please wait a few minutes") ||
			text.includes("retry your request again later")
		);
	}

	/** GitHub 的 Retry-After / x-ratelimit-reset，单位毫秒（不设上限，由调用方决定能否等） */
	private retryAfterMs(resp: Response): number {
		const retryAfter = Number(resp.headers.get("retry-after"));
		if (Number.isFinite(retryAfter) && retryAfter > 0) {
			return retryAfter * 1000;
		}
		const reset = Number(resp.headers.get("x-ratelimit-reset"));
		if (Number.isFinite(reset) && reset > 0) {
			const wait = reset * 1000 - Date.now();
			if (wait > 0) return wait;
		}
		return 0;
	}

	/** 把"已经读出来的"失败响应 body 转成带上下文的错误 */
	private errorFromText(
		status: number,
		bodyText: string,
		label: string,
		rateLimited = false,
		extraHint = ""
	): GitHubApiError {
		let detail = "";
		if (bodyText) {
			try {
				const json = JSON.parse(bodyText) as {
					message?: string;
					errors?: { message?: string; field?: string; code?: string }[];
				};
				detail = json.message ?? "";
				if (Array.isArray(json.errors) && json.errors.length > 0) {
					const extra = json.errors
						.map((e) =>
							e.message ?? [e.field, e.code].filter(Boolean).join(" ")
						)
						.filter(Boolean)
						.join("; ");
					if (extra) detail = detail ? `${detail} (${extra})` : extra;
				}
			} catch {
				detail = bodyText.slice(0, 300);
			}
		}
		const hint = rateLimited
			? `（触发了 GitHub 限流：请把设置里的「上传并发数」调到 4~8，等待几分钟后再同步）${extraHint ? ` ${extraHint}` : ""}`
			: `${statusHint(status, this.branch)}${extraHint ? `（${extraHint}）` : ""}`;
		return new GitHubApiError(
			`${label} 失败: HTTP ${status}${detail ? `: ${detail}` : ""}${hint}`,
			status,
			isRetryableStatus(status),
			isSystemicStatus(status)
		);
	}

	/**
	 * 把失败响应转成带上下文的错误（会读掉 body，只在抛出前调用）。
	 */
	private async buildError(resp: Response, label: string): Promise<GitHubApiError> {
		const bodyText = await resp.text().catch(() => "");
		return this.errorFromText(resp.status, bodyText, label);
	}

	/**
	 * 提前确认 Token 对该仓库有写权限。
	 *
	 * `GET /repos/{o}/{r}` 在带鉴权时会返回 `permissions.push`。
	 * 如果不检查，一个只读 Token 会让首次上传的 1000 个文件
	 * 全部撞 403（就是用户实际遇到的那种满屏 403）。
	 */
	async assertWritePermission(): Promise<void> {
		const resp = await this.request(
			"",
			{},
			{ maxAttempts: 2, action: "检查仓库写权限" }
		);
		if (!resp.ok) {
			throw await this.buildError(resp, `读取仓库 ${this.owner}/${this.repo}`);
		}
		const repo = (await resp.json()) as { permissions?: { push?: boolean } };
		if (repo.permissions && repo.permissions.push === false) {
			throw new GitHubApiError(
				`Token 对仓库 ${this.owner}/${this.repo} 只有读权限（permissions.push = false），无法上传。` +
					`请改用具备写权限的 Token：细粒度 Token 需要「Contents: Read and write」，` +
					`经典 Token 需要勾选 repo。`,
				403,
				false,
				true
			);
		}
	}

	/** 验证 Token 和仓库是否可访问 */
	async validate(): Promise<{ ok: boolean; message: string }> {
		try {
			const resp = await this.request(
				"",
				{},
				{ maxAttempts: 2, action: "校验 Token/仓库" }
			);
			if (resp.ok) return { ok: true, message: "OK" };
			const json = (await resp.json().catch(() => ({}))) as { message?: string };
			return { ok: false, message: json.message || `HTTP ${resp.status}` };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * 轻量读取分支 HEAD（只发 1 个请求）。
	 *
	 * 用于"远端列表缓存是否失效"的快速校验：`GET /commits/{branch}`
	 * 一次就能拿到 commit sha、tree sha 与提交时间。
	 * 遇到 404/409 等无法确定的状态时，回退到更严谨的 getBranchHead()，
	 * 以保留"空仓库 vs 分支写错"的准确报错。
	 */
	async getBranchHeadLight(): Promise<BranchHead | null> {
		const resp = await this.request(
			`/commits/${encodeURIComponent(this.branch)}`,
			{},
			{ maxAttempts: 2, action: `检查分支 ${this.branch} 是否有更新` }
		);
		if (resp.ok) {
			const commit = (await resp.json()) as {
				sha?: string;
				commit?: {
					tree?: { sha?: string };
					committer?: { date?: string };
					author?: { date?: string };
				};
			};
			const commitSha = commit?.sha;
			const treeSha = commit?.commit?.tree?.sha;
			if (commitSha && treeSha) {
				return {
					commitSha,
					treeSha,
					commitDate:
						commit.commit?.committer?.date ??
						commit.commit?.author?.date ??
						"",
				};
			}
			// 响应不完整：交给严谨路径再读一次，避免把异常响应当缓存命中
			return await this.getBranchHead();
		}

		if (resp.status === 404 || resp.status === 409 || resp.status === 422) {
			return await this.getBranchHead();
		}
		throw await this.buildError(resp, `检查分支 ${this.branch}`);
	}

	/**
	 * 读取分支 HEAD。
	 *
	 * 返回 `null` **仅当** 已经确认"仓库里还没有任何 commit"（空仓库），
	 * 此时调用方应走首次上传（引导建立首个 commit）。
	 * 分支名写错、限流、Token 失效、网络故障一律抛错。
	 *
	 * 旧版对任何失败都返回 null，下游把它当"仓库为空"，于是把整库本地文件
	 * 全判为新增并走初始化上传分支，最终撞上 422 `"sha" wasn't supplied`。
	 */
	async getBranchHead(): Promise<BranchHead | null> {
		const refResp = await this.request(
			`/git/refs/heads/${encodeURIComponent(this.branch)}`,
			{},
			{ action: `读取分支 ${this.branch}` }
		);

		if (refResp.ok) {
			const ref = (await refResp.json()) as { object?: { sha?: string } };
			const commitSha = ref?.object?.sha;
			if (!commitSha) {
				throw new GitHubApiError(
					`读取分支 ${this.branch} 失败: 响应里没有 commit sha`,
					0
				);
			}
			const commitResp = await this.request(
				`/git/commits/${commitSha}`,
				{},
				{ action: "读取 commit" }
			);
			if (!commitResp.ok) {
				throw await this.buildError(commitResp, `读取 commit ${commitSha}`);
			}
			const commit = (await commitResp.json()) as {
				tree?: { sha?: string };
				committer?: { date?: string };
				author?: { date?: string };
			};
			const treeSha = commit?.tree?.sha;
			if (!treeSha) {
				throw new GitHubApiError(`读取 commit ${commitSha} 失败: 响应里没有 tree sha`, 0);
			}
			return {
				commitSha,
				treeSha,
				commitDate: commit.committer?.date ?? commit.author?.date ?? "",
			};
		}

		// 分支 ref 读不到时分两种状态，二者都要走"到底是不是空仓库"的判定：
		// · 409 —— GitHub 对**空仓库**返回 409 "Git Repository is empty."
		//   （实测确认：refs 接口对空仓库回的是 409，不是 404）
		// · 404 —— 分支名写错，或仓库同样是空的
		// 只认 404 会把"首次上传到空仓库"直接判死，所以两个都必须交给
		// resolveEmptyOrMissingBranch() 用 /repos + /commits 做确定性判定。
		if (refResp.status === 404 || refResp.status === 409) {
			return await this.resolveEmptyOrMissingBranch();
		}

		// 400/410/451 等一律显式报错，绝不能当成"仓库为空"
		throw await this.buildError(refResp, `读取分支 ${this.branch}`);
	}

	/**
	 * 分支 ref 读不到时，区分两种情况：
	 * · 仓库真的还没有任何 commit（空仓库）→ 返回 null，允许初始化上传；
	 * · 分支名写错 → 抛出带默认分支名的明确错误。
	 *
	 * 判定依据（不依赖 refs 的状态码猜测）：
	 * · 仓库为空 —— `GET /commits` 返回 409 "Git Repository is empty."、
	 *   或返回空数组、或 404 且仓库 size 为 0；
	 * · 否则说明仓库有 commit 但该分支不存在。
	 */
	private async resolveEmptyOrMissingBranch(): Promise<null> {
		const repoResp = await this.request(
			"",
			{},
			{ maxAttempts: 2, action: `读取仓库 ${this.owner}/${this.repo}` }
		);
		if (!repoResp.ok) {
			throw await this.buildError(
				repoResp,
				`读取仓库 ${this.owner}/${this.repo}`
			);
		}
		const repo = (await repoResp.json()) as {
			default_branch?: string;
			size?: number;
		};

		const commitsResp = await this.request(
			`/commits?per_page=1`,
			{},
			{ action: "检查仓库是否为空" }
		);

		let hasEmptyCommitList = false;
		if (commitsResp.ok) {
			const list = (await commitsResp.json().catch(() => null)) as unknown;
			hasEmptyCommitList = Array.isArray(list) && list.length === 0;
		}

		// 空仓库的几种表现：409 "Git Repository is empty." / 空数组 / 404 且仓库 size 为 0
		const looksEmpty =
			commitsResp.status === 409 ||
			hasEmptyCommitList ||
			(commitsResp.status === 404 && (repo.size ?? 0) === 0);
		if (looksEmpty) return null;

		if (!commitsResp.ok) {
			throw await this.buildError(commitsResp, "检查仓库是否为空");
		}

		const defaultBranch = repo.default_branch ?? "";
		throw new GitHubApiError(
			`分支 "${this.branch}" 不存在。` +
				(defaultBranch
					? `仓库 ${this.owner}/${this.repo} 的默认分支是 "${defaultBranch}"，请把插件设置里的分支改成它；`
					: "") +
				`如果确实要用新分支，请先在 GitHub 网页上创建分支 "${this.branch}"。`,
			404
		);
	}

	/** 获取完整文件树（递归，单次请求） */
	async getFullTree(treeSha: string): Promise<TreeItem[]> {
		const resp = await this.request(
			`/git/trees/${treeSha}?recursive=1`,
			{},
			{ action: "获取文件树" }
		);
		if (!resp.ok) throw await this.buildError(resp, "获取文件树");
		const data = (await resp.json()) as { tree?: TreeItem[]; truncated?: boolean };
		if (!Array.isArray(data.tree)) {
			throw new GitHubApiError("获取文件树失败: 响应里没有 tree 数组", 0);
		}
		if (data.truncated) {
			console.warn("GitHub Sync: 文件树被截断(超过 100,000 个文件)");
			new Notice(
				"⚠️ 仓库文件树过大被 GitHub 截断(超过 10 万个文件),本次同步结果可能不完整",
				8000
			);
		}
		return data.tree;
	}

	/**
	 * 获取仓库所有文件列表
	 * 同时返回 commitSha / treeSha，供后续 batchUpload / batchDelete 复用，避免重复请求
	 */
	async listAllFiles(): Promise<{
		files: GitHubFile[];
		commitSha: string | null;
		treeSha: string | null;
		commitDate: string;
		/** true = 已确认远端仓库为空（还没有任何 commit） */
		isEmpty: boolean;
	}> {
		// 单请求读取 HEAD，比 refs + commit 两次请求更快；
		// 异常状态会自动回退到 getBranchHead() 做确定性判定。
		const head = await this.getBranchHeadLight();
		if (!head) {
			// 只有确认是空仓库才会走到这里
			return {
				files: [],
				commitSha: null,
				treeSha: null,
				commitDate: "",
				isEmpty: true,
			};
		}

		const tree = await this.getFullTree(head.treeSha);
		const commitMs = head.commitDate ? new Date(head.commitDate).getTime() : 0;

		const files: GitHubFile[] = tree
			.filter((item) => item.type === "blob")
			.map((item) => ({
				path: item.path,
				sha: item.sha,
				size: item.size || 0,
				type: "blob",
				// 粗粒度：用分支最新 commit 时间兜底，精确时间在 getFileModTimes 中按需获取
				remoteMtime: commitMs,
			}));

		return {
			files,
			commitSha: head.commitSha,
			treeSha: head.treeSha,
			commitDate: head.commitDate,
			isEmpty: false,
		};
	}

	/**
	 * 批量获取指定文件的精确最后修改时间（智能同步用）
	 * 策略：并发查询每个文件的最近 1 条 commit（MTIME_CONCURRENCY 并发）
	 * 返回 path -> mtime(ms)
	 */
	async getFileModTimes(
		paths: string[],
		/** 固定到某个 commit（推荐），避免查询期间分支被其它设备推进导致时间混用 */
		ref?: string
	): Promise<Map<string, number>> {
		const result = new Map<string, number>();
		const targetRef = ref || this.branch;
		await pMap(
			paths,
			async (path) => {
				try {
					const resp = await this.request(
						`/commits?path=${encodeURIComponent(path)}&per_page=1&sha=${encodeURIComponent(targetRef)}`,
						{},
						// 此接口限速最严：不做长重试，失败就当该文件时间未知
						{ maxAttempts: 2, action: `查询 ${path} 的修改时间` }
					);
					if (!resp.ok) return;
					const commits = (await resp.json()) as {
						commit?: {
							committer?: { date?: string };
							author?: { date?: string };
						};
					}[];
					if (Array.isArray(commits) && commits.length > 0) {
						const dateStr: string =
							commits[0].commit?.committer?.date ??
							commits[0].commit?.author?.date ??
							"";
						if (dateStr) result.set(path, new Date(dateStr).getTime());
					}
				} catch {
					// 忽略单个文件错误，不中断整体流程
				}
			},
			MTIME_CONCURRENCY
		);
		return result;
	}

	// ──────────────────────────────────────────────────────────
	// 获取文件内容 + 提交信息（供对比功能使用）
	// ──────────────────────────────────────────────────────────

	/**
	 * 批量获取指定文件的内容和最近一次提交信息。
	 * 对每个文件并发请求 /contents/{path}（获取内容）和 /commits（获取提交信息）。
	 * 超过 maxContentBytes 的文件丢弃内容只保留大小（对比弹窗降级显示，避免占用过多内存）。
	 * 单个文件失败不中断整体流程。
	 */
	async getFilesWithCommits(
		paths: string[],
		maxContentBytes = 10 * 1024 * 1024
	): Promise<Map<string, FileWithCommitInfo>> {
		const result = new Map<string, FileWithCommitInfo>();

		await pMap(
			paths,
			async (path) => {
				try {
					const [contentBuf, commitMsg] = await Promise.all([
						this.downloadFile(path).catch(() => null as ArrayBuffer | null),
						this.getFileCommitInfo(path),
					]);
					const content =
						contentBuf && contentBuf.byteLength > maxContentBytes
							? null
							: contentBuf;

					result.set(path, {
						content,
						commitMessage: commitMsg?.message ?? "",
						commitDate: commitMsg?.date ?? "",
						size: contentBuf?.byteLength ?? 0,
					});
				} catch {
					result.set(path, {
						content: null,
						commitMessage: "",
						commitDate: "",
						size: 0,
					});
				}
			},
			DOWNLOAD_CONCURRENCY
		);

		return result;
	}

	/**
	 * 获取单个文件在分支上的最后一次提交信息。
	 * 返回 { message, date } 或 null。
	 */
	async getFileCommitInfo(
		path: string
	): Promise<{ message: string; date: string } | null> {
		try {
			const resp = await this.request(
				`/commits?path=${encodeURIComponent(path)}&per_page=1&sha=${this.branch}`,
				{},
				{ maxAttempts: 2, action: `查询 ${path} 的提交信息` }
			);
			if (!resp.ok) return null;
			const commits = (await resp.json()) as {
				commit?: {
					message?: string;
					committer?: { date?: string };
					author?: { date?: string };
				};
			}[];
			if (!Array.isArray(commits) || commits.length === 0) return null;
			const c = commits[0].commit;
			return {
				message: c?.message ?? "",
				date: c?.committer?.date ?? c?.author?.date ?? "",
			};
		} catch {
			return null;
		}
	}

	/** 下载单个文件（使用 API 以支持私有仓库及避免 raw 域名网络问题） */
	async downloadFile(path: string, sha?: string): Promise<ArrayBuffer> {
		// 优先使用 Blob API（无 1MB 大小限制，且支持私有仓库鉴权）
		if (sha) {
			const resp = await this.request(
				`/git/blobs/${sha}`,
				{ headers: { Accept: "application/vnd.github.raw" } },
				{ timeoutMs: DOWNLOAD_TIMEOUT_MS, action: `下载 ${path}` }
			);
			if (resp.ok) return resp.arrayBuffer();
			if (resp.status !== 404) {
				throw await this.buildError(resp, `下载 ${path}`);
			}
		}
		// 回退到 Contents API（兜底，指定分支确保最新）
		const resp = await this.request(
			`/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`,
			{ headers: { Accept: "application/vnd.github.raw" } },
			{ timeoutMs: DOWNLOAD_TIMEOUT_MS, action: `下载 ${path}` }
		);
		if (!resp.ok) throw await this.buildError(resp, `下载 ${path}`);
		return resp.arrayBuffer();
	}

	/** 并发批量下载，带进度回调；单文件失败会跳过，不中断整体同步 */
	async downloadFiles(
		files: { path: string; sha?: string }[],
		onProgress?: (done: number, total: number, currentPath: string) => void
	): Promise<Map<string, ArrayBuffer>> {
		const result = new Map<string, ArrayBuffer>();
		let done = 0;
		await pMap(
			files,
			async (file) => {
				try {
					const buf = await this.downloadFile(file.path, file.sha);
					result.set(file.path, buf);
				} catch (err) {
					console.warn(`下载 ${file.path} 失败:`, err);
				} finally {
					done++;
					onProgress?.(done, files.length, file.path);
				}
			},
			DOWNLOAD_CONCURRENCY
		);
		return result;
	}

	/**
	 * 批量上传（增量 Git Trees API）。
	 *
	 * 流程：
	 * ① 空仓库先用 Contents API 建立首个 commit（GitHub 的硬性要求），
	 *    这一步是幂等的：文件已存在时会带上 sha 覆盖，因此中断后可安全重跑；
	 * ② 其余文件按 UPLOAD_CHUNK_SIZE 分块，每块一个 commit；
	 * ③ 每块内部并发创建 blob（受控并发），再用 base_tree 增量建 tree。
	 *
	 * 中途失败会抛 PartialUploadError，携带"已成功上传"的路径，
	 * 上层据此提示用户并记录进度；重新同步时这些文件会被算作 unchanged。
	 *
	 * @param files            仅传需要新增/修改的文件（不含未变化文件）
	 * @param message          commit 信息
	 * @param currentCommitSha 当前 HEAD commit SHA（null 表示空仓库）
	 * @param currentTreeSha   当前 tree SHA（null 表示空仓库）
	 */
	async batchUpload(
		files: { path: string; content: ArrayBuffer }[],
		message: string,
		currentCommitSha: string | null,
		currentTreeSha: string | null,
		onProgress?: (done: number, total: number, path: string) => void
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		if (files.length === 0) {
			return {
				newCommitSha: currentCommitSha ?? "",
				newTreeSha: currentTreeSha ?? "",
			};
		}

		const total = files.length;
		let commitSha: string;
		let treeSha: string;
		let pending = files;
		const uploaded: string[] = [];
		const failed: string[] = [];
		let done = 0;

		if (currentCommitSha && currentTreeSha) {
			commitSha = currentCommitSha;
			treeSha = currentTreeSha;
		} else {
			// 空仓库引导：必须先用 Contents API 建立首个 commit。
			// 若某个文件本身有问题，就换下一个继续尝试，而不是整批失败。
			const BOOTSTRAP_ATTEMPTS = 5;
			let booted: { newCommitSha: string; newTreeSha: string } | null = null;
			let index = 0;
			const limit = Math.min(files.length, BOOTSTRAP_ATTEMPTS);
			for (; index < limit; index++) {
				try {
					booted = await this.bootstrapEmptyRepo(files[index], message);
					uploaded.push(files[index].path);
					onProgress?.(index + 1, total, files[index].path);
					index++;
					break;
				} catch (err) {
					// 系统性错误（Token/权限/限流/网络）换文件也没用，直接抛
					if (err instanceof GitHubApiError && err.systemic) throw err;
					failed.push(files[index].path);
					console.warn(
						`初始化上传 ${files[index].path} 失败，改试下一个文件:`,
						err
					);
					onProgress?.(index + 1, total, files[index].path);
				}
			}
			if (!booted) {
				throw new GitHubApiError(
					`空仓库初始化失败：连续 ${limit} 个文件都无法上传，无法建立首个 commit。`,
					0
				);
			}
			commitSha = booted.newCommitSha;
			treeSha = booted.newTreeSha;
			pending = files.slice(index);
			done = index;
		}

		try {
			for (let offset = 0; offset < pending.length; offset += UPLOAD_CHUNK_SIZE) {
				const chunk = pending.slice(offset, offset + UPLOAD_CHUNK_SIZE);
				const result = await this.commitFiles(
					chunk,
					message,
					commitSha,
					treeSha,
					(n, _t, path) => onProgress?.(done + n, total, path),
					failed
				);
				commitSha = result.newCommitSha;
				treeSha = result.newTreeSha;
				done += chunk.length;
				uploaded.push(...result.committedPaths);
				onProgress?.(done, total, chunk[chunk.length - 1].path);
			}
		} catch (err) {
			// 块级失败（建 tree/commit/移动引用）属于仓库或网络层面的问题，
			// 继续往下走反而可能基于过期的 base_tree 提交，所以这里中断；
			// 已提交的块留在远端，重新同步会自动跳过。
			if (uploaded.length > 0 || failed.length > 0) {
				throw new PartialUploadError(
					err instanceof Error ? err.message : String(err),
					uploaded,
					total,
					failed
				);
			}
			throw err;
		}

		// 所有块都处理完了，但有文件被跳过：明确报出来（不静默吞掉）
		if (failed.length > 0) {
			throw new PartialUploadError(
				`${failed.length} 个文件上传失败，已跳过；其余 ${uploaded.length} 个已成功提交`,
				uploaded,
				total,
				failed
			);
		}

		return { newCommitSha: commitSha, newTreeSha: treeSha };
	}

	/**
	 * 空仓库引导：GitHub 要求仓库至少有一个 commit 之后才能使用 Git Trees API。
	 * 用 Contents API 上传一个文件来建立首个 commit。
	 * 幂等：文件已存在时带上其 sha 覆盖（否则会得到 422 `"sha" wasn't supplied`）。
	 */
	private async bootstrapEmptyRepo(
		file: { path: string; content: ArrayBuffer },
		message: string
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		const existingSha = await this.getExistingContentSha(file.path);
		const body: Record<string, unknown> = {
			message,
			content: arrayBufferToBase64(file.content),
			branch: this.branch,
		};
		if (existingSha) body.sha = existingSha;

		const resp = await this.request(
			`/contents/${encodePath(file.path)}`,
			{ method: "PUT", body: JSON.stringify(body) },
			{ timeoutMs: BLOB_TIMEOUT_MS, action: `初始化上传 ${file.path}` }
		);
		if (!resp.ok) {
			throw await this.buildError(resp, `初始化上传 ${file.path}`);
		}
		const data = (await resp.json()) as {
			commit?: { sha?: string; tree?: { sha?: string } };
		};
		const commitSha = data?.commit?.sha;
		const treeSha = data?.commit?.tree?.sha;
		if (!commitSha || !treeSha) {
			throw new GitHubApiError(
				`初始化上传 ${file.path} 已成功，但响应里没有 commit/tree sha`,
				0
			);
		}
		return { newCommitSha: commitSha, newTreeSha: treeSha };
	}

	/**
	 * 读取远端已存在文件的 sha（不存在 / 仓库为空 / 查询失败都返回 null）。
	 * 用于把 PUT /contents 变成幂等的 upsert。
	 *
	 * 用 `application/vnd.github.object` 元数据类型：默认的 JSON 类型对
	 * 超过 1 MB 的文件会返回 403「This API returns blobs up to 1 MB in size」，
	 * 换成元数据类型后不传输内容、也不受该限制，能稳定拿到 sha。
	 * 万一该类型不被支持(415)，也只是退化成"当成不存在"，不会更糟。
	 */
	private async getExistingContentSha(path: string): Promise<string | null> {
		try {
			const resp = await this.request(
				`/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`,
				{ headers: { Accept: "application/vnd.github.object+json" } },
				{ maxAttempts: 2, action: `查询 ${path} 是否已存在` }
			);
			if (!resp.ok) return null; // 404 不存在 / 409 仓库为空 / 403 无法判断
			const data = (await resp.json().catch(() => null)) as
				| { sha?: string }
				| unknown[]
				| null;
			if (!data || Array.isArray(data)) return null;
			const sha = (data as { sha?: string }).sha;
			return typeof sha === "string" ? sha : null;
		} catch {
			return null;
		}
	}

	/** 创建一批 blob 并提交为一个 commit */
	private async commitFiles(
		files: { path: string; content: ArrayBuffer }[],
		message: string,
		currentCommitSha: string,
		currentTreeSha: string,
		onProgress?: (done: number, total: number, path: string) => void,
		failedPaths: string[] = []
	): Promise<{
		newCommitSha: string;
		newTreeSha: string;
		committedPaths: string[];
	}> {
		// 单个文件失败（体积超限 / 内容被拒）时【只跳过它】，
		// 不中断同批其他文件 —— 这类失败与该文件本身有关，没理由连坐。
		// 但系统性错误（Token 失效 / 限流 / 网络）必须中断：
		// 否则会把剩下几百个文件挨个重试一遍，既慢又把限流越踩越深。
		let blobDone = 0;
		const treeItems: TreeEntry[] = [];
		await pMap(
			files,
			async (file) => {
				try {
					const sha = await this.createBlob(file.content);
					treeItems.push({
						path: file.path,
						mode: "100644",
						type: "blob",
						sha,
					});
				} catch (err) {
					if (err instanceof GitHubApiError && err.systemic) throw err;
					failedPaths.push(file.path);
					console.warn(`上传 ${file.path} 失败，已跳过该文件:`, err);
				} finally {
					blobDone++;
					onProgress?.(blobDone, files.length, file.path);
				}
			},
			this.uploadConcurrency
		);

		if (treeItems.length === 0) {
			// 整批都失败：没有任何内容可提交，保持 HEAD 不动
			return {
				newCommitSha: currentCommitSha,
				newTreeSha: currentTreeSha,
				committedPaths: [],
			};
		}

		const result = await this.commitTree(
			treeItems,
			message,
			currentCommitSha,
			currentTreeSha,
			failedPaths.length > 0
				? `提交 ${treeItems.length} 个文件(跳过 ${failedPaths.length} 个失败文件)`
				: `提交 ${treeItems.length} 个文件`
		);
		// 成功提交一块 → 把被限流压下去的并发慢慢加回来（上限是用户设定值）
		if (this.uploadConcurrency < this.uploadConcurrencyCap) {
			this.uploadConcurrency++;
		}
		return { ...result, committedPaths: treeItems.map((t) => t.path) };
	}

	/** 建 tree → 建 commit → 移动分支引用 */
	private async commitTree(
		treeItems: TreeEntry[],
		message: string,
		currentCommitSha: string,
		currentTreeSha: string,
		label: string
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		const treeResp = await this.request(
			`/git/trees`,
			{
				method: "POST",
				body: JSON.stringify({ base_tree: currentTreeSha, tree: treeItems }),
			},
			{ timeoutMs: BLOB_TIMEOUT_MS, action: `创建 tree(${label})` }
		);
		if (!treeResp.ok) {
			throw await this.buildError(treeResp, `创建 tree(${label})`);
		}
		const newTree = (await treeResp.json()) as { sha?: string };
		if (!newTree?.sha) {
			throw new GitHubApiError(`创建 tree(${label}) 失败: 响应里没有 sha`, 0);
		}

		const commitResp = await this.request(
			`/git/commits`,
			{
				method: "POST",
				body: JSON.stringify({
					message,
					tree: newTree.sha,
					parents: [currentCommitSha],
				}),
			},
			{ action: "创建 commit" }
		);
		if (!commitResp.ok) {
			throw await this.buildError(commitResp, "创建 commit");
		}
		const newCommit = (await commitResp.json()) as { sha?: string };
		if (!newCommit?.sha) {
			throw new GitHubApiError("创建 commit 失败: 响应里没有 sha", 0);
		}

		// 注意：这里**故意不用 force**。
		// 我们的新 commit 以"同步开始时读到的 HEAD"为父提交，所以正常情况下
		// 这是一次 fast-forward，不需要 force 也能成功。
		// force 唯一会起作用的情况是：推送期间远端引用被别的写入方动过
		// （另一台设备 / 网页上直接编辑 / obsidian-git 同时在推）。
		// 那种情况下 force 会把对方的 commit 从分支上直接冲掉（数据丢失），
		// 而不加 force 只会让本次推送明确失败一次，重新同步即可收敛 ——
		// 这正是本插件"先读 HEAD 再增量提交"的设计所要的语义。
		const updateResp = await this.request(
			`/git/refs/heads/${encodeURIComponent(this.branch)}`,
			{
				method: "PATCH",
				body: JSON.stringify({ sha: newCommit.sha }),
			},
			{ action: `更新分支 ${this.branch}` }
		);
		if (!updateResp.ok) {
			const err = await this.buildError(updateResp, `更新分支 ${this.branch}`);
			if (updateResp.status === 422) {
				// GitHub 对非快进更新返回 422 "Update is not a fast forward"
				throw new GitHubApiError(
					`推送期间远端分支 ${this.branch} 被更新了（可能是另一台设备、网页上的改动，` +
						`或 obsidian-git 同时在推）。为避免覆盖对方的提交，本次没有强制覆盖：` +
						`请重新同步一次（会自动跳过已上传的部分）。\n原始错误: ${err.message}`,
					422
				);
			}
			throw err;
		}

		return { newCommitSha: newCommit.sha, newTreeSha: newTree.sha };
	}

	/**
	 * 批量删除远端文件（利用 Git Trees API，sha=null 表示删除）
	 * 单次 commit 删除所有文件，比逐文件 DELETE /contents/... 快得多
	 *
	 * @param files            要删除的文件列表
	 * @param message          commit 信息
	 * @param currentCommitSha 当前 HEAD commit SHA
	 * @param currentTreeSha   当前 tree SHA
	 */
	async batchDelete(
		files: { path: string }[],
		message: string,
		currentCommitSha: string,
		currentTreeSha: string
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		if (files.length === 0) {
			return { newCommitSha: currentCommitSha, newTreeSha: currentTreeSha };
		}

		// sha: null 告诉 GitHub 删除此路径
		const treeItems: TreeEntry[] = files.map((f) => ({
			path: f.path,
			mode: "100644",
			type: "blob",
			sha: null,
		}));

		return await this.commitTree(
			treeItems,
			message,
			currentCommitSha,
			currentTreeSha,
			`删除 ${files.length} 个文件`
		);
	}

	/** 兼容旧接口：单文件删除会直接走批量删除逻辑 */
	async deleteFile(
		path: string,
		message: string,
		currentCommitSha: string,
		currentTreeSha: string
	): Promise<{ newCommitSha: string; newTreeSha: string }> {
		return this.batchDelete([{ path }], message, currentCommitSha, currentTreeSha);
	}

	private async createBlob(content: ArrayBuffer): Promise<string> {
		const sizeMb = content.byteLength / 1024 / 1024;
		const label = `创建 blob(${sizeMb.toFixed(1)} MB)`;
		const resp = await this.request(
			`/git/blobs`,
			{
				method: "POST",
				body: JSON.stringify({
					content: arrayBufferToBase64(content),
					encoding: "base64",
				}),
			},
			{ timeoutMs: BLOB_TIMEOUT_MS, action: label }
		);
		if (!resp.ok) {
			throw await this.buildError(resp, label);
		}
		const data = (await resp.json()) as { sha?: string };
		if (!data?.sha) {
			throw new GitHubApiError(`${label} 失败: 响应里没有 sha`, 0);
		}
		return data.sha;
	}
}

function encodePath(path: string): string {
	return encodeURIComponent(path).replace(/%2F/g, "/");
}
