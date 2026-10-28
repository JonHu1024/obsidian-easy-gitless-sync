import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";
import type GitHubSyncPlugin from "./main";
import { ObsidianSyncPickerModal } from "./modals";
import { GitHubClient } from "./github";

export interface GitHubSyncSettings {
    token: string;
    repository: string;   // 格式: owner/repo
    branch: string;
    ignorePaths: string;  // 每行一个路径
    commitMessage: string;
    // 是否同步 .obsidian 文件夹（默认不同步）
    syncObsidianFolder: boolean;
    // 同步 .obsidian 时选中的一级子项（文件/文件夹名）；空数组 = 全部同步
    obsidianSyncSelection: string[];
    // 新增：启动时警告开关
	showUnsyncedWarningOnStartup: boolean;
	// 新增：持久化状态（用于跨会话记录）
	hasUnsyncedChanges: boolean;
	lastUnsyncedPaths: string[];
	// 历史同步过的文件路径（用于区分删除是"本地新建→删除"还是"之前同步过的文件"）
	syncedPaths: string[];
	// 上传（创建 blob）并发数：1~32。上传耗时≈(文件数/并发数)×RTT，是最有效的性能杠杆
	uploadConcurrency: number;
	// 按时间同步时，只存在于一侧的文件如何处理
	// keep-both: 本地独有→上传，远端独有→下载（默认，绝不删除远端）
	// local-mirror: 旧行为，远端独有→删除远端
	timeSyncOneSided: "keep-both" | "local-mirror";
	// 启动后 / 每次同步完成后静默预取 GitHub 文件列表
	prefetchRemoteOnStartup: boolean;
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
    token: '',
	repository: '',
	branch: 'main',
	ignorePaths: '.obsidian/workspace.json',
	commitMessage: 'obsidian sync {date}',
	syncObsidianFolder: false,
	obsidianSyncSelection: [],
	showUnsyncedWarningOnStartup: true,
	hasUnsyncedChanges: false,
	lastUnsyncedPaths: [],
	syncedPaths: [],
	uploadConcurrency: 8,
	timeSyncOneSided: "keep-both",
	prefetchRemoteOnStartup: true,
};

export class GitHubSyncSettingTab extends PluginSettingTab {
    plugin: GitHubSyncPlugin;

    constructor(app: App, plugin: GitHubSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('github-sync-settings');

        let textComponent: TextComponent;

        containerEl.createEl("h3", { text: "GitHub 连接", cls: "github-sync-settings-heading" });
        new Setting(containerEl)
            .setName('GitHub Token')
            .setDesc('你的 GitHub Personal Access Token（本地以 base64 编码存储，非加密；请勿外传 data.json）')
            .addText(text => {
                textComponent = text;
                text
                    .setPlaceholder('ghp_xxxx')
                    .setValue(this.plugin.settings.token)
                    .onChange(async (value) => {
                        this.plugin.settings.token = value;
                        this.plugin.debounceSaveSettings();
                    });
                text.inputEl.type = 'password';
                text.inputEl.addClass('github-sync-token-input');
            })
            .addButton(btn => {
                btn.setIcon('eye')
                    .setTooltip('显示/隐藏 Token')
                    .onClick(() => {
                        const input = textComponent.inputEl;
                        if (input.type === 'password') {
                            input.type = 'text';
                            btn.setIcon('eye-off');
                        } else {
                            input.type = 'password';
                            btn.setIcon('eye');
                        }
                    });
            })
            .addButton(btn => {
                btn.setButtonText('测试连接').onClick(async () => {
                    const token = (this.plugin.settings.token || '').trim();
                    const repo = (this.plugin.settings.repository || '').trim();
                    if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
                        new Notice('⚠️ 请先填写有效的 Token 与仓库（owner/repo）');
                        return;
                    }
                    btn.setDisabled(true);
                    btn.setButtonText('测试中...');
                    try {
                        const client = new GitHubClient(
                            token,
                            repo,
                            (this.plugin.settings.branch || 'main').trim() || 'main'
                        );
                        const result = await client.validate();
                        new Notice(result.ok ? '✅ 连接成功，Token 和仓库可访问' : `❌ 连接失败：${result.message}`, 10000);
                    } catch (err) {
                        new Notice(`❌ 连接失败：${err instanceof Error ? err.message : String(err)}`, 10000);
                    } finally {
                        btn.setDisabled(false);
                        btn.setButtonText('测试连接');
                    }
                });
            });

        new Setting(containerEl)
            .setName('仓库')
            .setDesc('格式: 用户名/仓库名，例如 myname/obsidian-notes')
            .addText(text => text
                .setPlaceholder('your-username/your-repo')
                .setValue(this.plugin.settings.repository)
                .onChange(async (value) => {
                    this.plugin.settings.repository = value;
                    this.plugin.debounceSaveSettings();
                }));

        new Setting(containerEl)
            .setName('分支')
            .setDesc('默认 main')
            .addText(text => text
                .setPlaceholder('main')
                .setValue(this.plugin.settings.branch)
                .onChange(async (value) => {
                    this.plugin.settings.branch = value;
                    this.plugin.debounceSaveSettings();
                }));

        containerEl.createEl("h3", { text: "同步范围", cls: "github-sync-settings-heading" });

        new Setting(containerEl)
            .setName('忽略路径')
            .setDesc('每行一个路径，例如 .obsidian/workspace.json')
            .addTextArea(text => text
                .setPlaceholder('.obsidian/workspace.json')
                .setValue(this.plugin.settings.ignorePaths)
                .onChange(async (value) => {
                    this.plugin.settings.ignorePaths = value;
                    this.plugin.debounceSaveSettings();
                }));

        // 新增：是否同步 .obsidian 文件夹
        new Setting(containerEl)
            .setName('同步 .obsidian 文件夹')
            .setDesc('是否将 .obsidian 配置文件夹同步到 GitHub。默认关闭，避免上传本地个人配置。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncObsidianFolder)
                .onChange(async (value) => {
                    this.plugin.settings.syncObsidianFolder = value;
                    this.plugin.debounceSaveSettings();
                    // 开关变化后重绘，显示/隐藏"选择子项"入口
                    this.display();
                }));

        // 同步 .obsidian 时选择要同步的子项（开关开启时显示）
        if (this.plugin.settings.syncObsidianFolder) {
            const sel = this.plugin.settings.obsidianSyncSelection ?? [];
            const selText = sel.length === 0
                ? '当前：同步 .obsidian 下全部内容（插件自身的 data.json / 缓存 / savings 会被强制排除）。'
                : `当前已选 ${sel.length} 项：${sel.slice(0, 4).join('、')}${sel.length > 4 ? ' 等' : ''}`;
            new Setting(containerEl)
                .setName('选择要同步的子项')
                .setDesc(`留空 = 同步 .obsidian 下全部内容；选择后可展开文件夹逐级细分勾选（勾选文件夹 = 含其全部内容）。${selText}`)
                .addButton(btn => btn
                    .setButtonText('选择子项')
                    .onClick(() => {
                        new ObsidianSyncPickerModal(this.app, this.plugin, () => this.display()).open();
                    }));
        }

        containerEl.createEl("h3", { text: "同步行为", cls: "github-sync-settings-heading" });

        new Setting(containerEl)
            .setName('按时间同步：单边文件')
            .setDesc(
                '「补齐」：只存在于本地→上传，只存在于远端→下载（推荐，绝不会因为本地没有而删除远端）。' +
                '「以本地为准」是 1.2 的旧行为：远端独有文件会被删除，仅在确定本地是唯一真相时使用。'
            )
            .addDropdown(dropdown => dropdown
                .addOption('keep-both', '补齐（推荐）')
                .addOption('local-mirror', '以本地为准（删除远端独有）')
                .setValue(this.plugin.settings.timeSyncOneSided ?? 'keep-both')
                .onChange(async (value) => {
                    this.plugin.settings.timeSyncOneSided = value as "keep-both" | "local-mirror";
                    this.plugin.debounceSaveSettings();
                }));

        new Setting(containerEl)
            .setName('静默预取 GitHub 列表')
            .setDesc('Obsidian 启动后（若弹出未同步提醒，则在你关闭提醒后）以及每次同步完成后，后台刷新一次 GitHub 文件列表。下次同步时若远端 HEAD 未变，直接复用，免去重复拉取。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.prefetchRemoteOnStartup ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.prefetchRemoteOnStartup = value;
                    await this.plugin.saveSettings();
                    if (value) this.plugin.requestRemotePrefetch(500);
                }));

        new Setting(containerEl)
            .setName('上传并发数')
            .setDesc('同时上传的文件数，默认 8。上传耗时≈(文件数 ÷ 并发数) × 网络往返延迟，调大能提速；但 GitHub 对「创建内容」类请求有二次限流，调得过高(16+)会成片出现 403 Forbidden。建议 4~8，网络很好时再试 12。真被限流时插件会自动冷却等待并把并发减半，但等待本身会拖慢整体。')
            .addSlider(slider => slider
                .setLimits(1, 32, 1)
                .setValue(this.plugin.settings.uploadConcurrency ?? 8)
                .setDynamicTooltip()
                .onChange(value => {
                    this.plugin.settings.uploadConcurrency = value;
                    this.plugin.debounceSaveSettings();
                }));

        new Setting(containerEl)
            .setName('提交信息')
            .setDesc('{date} 会被替换为当前时间')
            .addText(text => text
                .setPlaceholder('obsidian sync {date}')
                .setValue(this.plugin.settings.commitMessage)
                .onChange(async (value) => {
                    this.plugin.settings.commitMessage = value;
                    this.plugin.debounceSaveSettings();
                }));

        containerEl.createEl("h3", { text: "提醒", cls: "github-sync-settings-heading" });

        // 新增：启动警告开关
        new Setting(containerEl)
            .setName('启动时提醒未同步状态')
            .setDesc('如果上次退出时有未同步的修改，下次打开时弹窗提醒并列出文件，防止拉取时覆盖。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showUnsyncedWarningOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.showUnsyncedWarningOnStartup = value;
                    await this.plugin.saveSettings();
                }));
    }
}