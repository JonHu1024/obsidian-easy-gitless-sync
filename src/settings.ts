import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type GitHubSyncPlugin from "./main";
import { ObsidianSyncPickerModal } from "./modals";

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
            new Setting(containerEl)
                .setName('选择要同步的子项')
                .setDesc('留空 = 同步 .obsidian 下全部内容；选择后可展开文件夹逐级细分勾选（勾选文件夹 = 含其全部内容）。')
                .addButton(btn => btn
                    .setButtonText('选择子项')
                    .onClick(() => {
                        new ObsidianSyncPickerModal(this.app, this.plugin, () => this.display()).open();
                    }));
        }

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