// styles.ts — CSS 样式（从 main.ts 抽出）
// 设计原则：只用 Obsidian 主题变量 + 少量带 fallback 的语义色，保证明暗主题、
// PC / 平板 / 手机都能用；触摸设备上的可点击区域不小于 ~32px。

export const CSS = `
/* ===== Easy Gitless Sync Styles ===== */

.github-sync-modal {
  --gs-green: var(--color-green, #34c26b);
  --gs-blue: var(--color-blue, #3b82f6);
  --gs-orange: var(--color-orange, #e6922a);
  --gs-purple: var(--color-purple, #a15cd1);
  --gs-red: var(--color-red, #e5534b);
  --gs-radius: 10px;
  padding: 4px 0;
  color: var(--text-normal);
}

.github-sync-modal h2 {
  margin: 0 0 6px;
  font-size: 1.15em;
  line-height: 1.3;
}

.github-sync-modal button {
  font-family: inherit;
}

.github-sync-modal button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.github-sync-modal button:focus-visible,
.github-sync-modal input:focus-visible,
.github-sync-modal .github-sync-tree-caret:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 1px;
}

.github-sync-subtitle {
  color: var(--text-muted);
  font-size: 0.82em;
  margin: 0 0 10px;
  line-height: 1.45;
}

/* 模式选择弹窗：桌面 440px，手机全宽。
   Obsidian 的 .modal 宽度走 --modal-width 变量，所以直接给 host 类设置变量，
   避免仅靠 :has() 在某些版本/主题下失效。 */
.modal.github-sync-mode-host {
  --modal-width: 440px;
  --modal-max-width: 92vw;
  width: min(92vw, 440px) !important;
  max-width: min(92vw, 440px) !important;
}

.modal:has(.github-sync-mode-modal) {
  --modal-width: 440px;
  --modal-max-width: 92vw;
}

.github-sync-mode-modal h2 {
  font-size: 1.1em;
}

.github-sync-cache-info {
  margin: 0 0 12px;
  padding: 6px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: 0.76em;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* ── 模式选择（自适应卡片，各模式带强调色） ── */
.github-sync-mode-buttons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 10px;
  margin: 8px 0 10px;
}

/* 必须显式改成纵向 flex：Obsidian 的 modal button 默认是横向 flex，
   否则 icon / label / desc 会挤成一行并从卡片两端溢出。 */
.github-sync-modal .github-sync-mode-btn {
  --gs-accent: var(--interactive-accent);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  height: auto;
  min-height: 118px;
  padding: 14px 12px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--gs-radius);
  background: var(--background-primary);
  cursor: pointer;
  text-align: center;
  white-space: normal;
  overflow: hidden;
  transition: border-color 0.15s ease, background 0.15s ease,
    transform 0.15s ease, box-shadow 0.15s ease;
}

.github-sync-modal .github-sync-mode-btn > * {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.github-sync-mode-btn.mode-push  { --gs-accent: var(--gs-blue); }
.github-sync-mode-btn.mode-pull  { --gs-accent: var(--gs-green); }
.github-sync-mode-btn.mode-time  { --gs-accent: var(--gs-orange); }
.github-sync-mode-btn.mode-merge { --gs-accent: var(--gs-purple); }

.github-sync-mode-btn:hover {
  border-color: var(--gs-accent);
  background: var(--background-modifier-hover);
  transform: translateY(-2px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
}

.github-sync-mode-btn:active {
  transform: translateY(0);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

.github-sync-mode-icon {
  flex: 0 0 auto;
  font-size: 1.5em;
  margin: 0;
  line-height: 1;
  transition: transform 0.18s ease;
}

.github-sync-mode-btn:hover .github-sync-mode-icon {
  transform: scale(1.12);
}

.github-sync-mode-label {
  font-size: 0.86em;
  font-weight: 600;
  color: var(--text-normal);
  margin: 0;
  line-height: 1.25;
  overflow-wrap: anywhere;
  word-break: normal;
}

.github-sync-mode-desc {
  font-size: 0.72em;
  color: var(--text-muted);
  line-height: 1.35;
  margin: 0;
  overflow-wrap: anywhere;
  word-break: normal;
}

/* ── 确认弹窗 ── */
.modal.github-sync-confirm-host {
  --modal-width: 760px;
  --modal-max-width: 94vw;
  width: min(94vw, 760px) !important;
  max-width: min(94vw, 760px) !important;
}

.modal:has(.github-sync-confirm-modal) {
  --modal-width: 760px;
  --modal-max-width: 94vw;
}

.modal.github-sync-rollback-host {
  --modal-width: 620px;
  --modal-max-width: 92vw;
  width: min(92vw, 620px) !important;
  max-width: min(92vw, 620px) !important;
}

.github-sync-confirm-modal {
  display: flex;
  flex-direction: column;
  max-height: min(84vh, 820px);
  max-height: min(84dvh, 820px);
  overflow: hidden;
}

.github-sync-confirm-modal h2 {
  margin-bottom: 8px;
  flex-shrink: 0;
}

/* 工具栏：全选 / 展开 / 已选计数 / 搜索过滤 */
.github-sync-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 4px;
  flex-shrink: 0;
}

.github-sync-select-all-btn {
  flex-shrink: 0;
  margin: 0;
  min-height: 26px;
  font-size: 0.78em;
  padding: 3px 10px;
  cursor: pointer;
  border-radius: 6px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  transition: all 0.12s ease;
}

.github-sync-select-all-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

.github-sync-selected-count {
  flex-shrink: 0;
  font-size: 0.78em;
  color: var(--text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.github-sync-search {
  flex: 1 1 150px;
  min-width: 120px;
  margin: 0;
  font-size: 0.85em;
  background: var(--background-primary);
}

/* 统计摘要徽章 */
.github-sync-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
  flex-shrink: 0;
}

.github-sync-badge {
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 0.78em;
  font-weight: 500;
  white-space: nowrap;
}

.badge-added    { background: rgba(40, 167, 69, 0.13); color: var(--text-success, #28a745); }
.badge-modified { background: rgba(230, 146, 42, 0.14); color: var(--text-warning, #e6922a); }
.badge-deleted  { background: rgba(220, 53, 69, 0.13); color: var(--text-error, #dc3545); }
.badge-upload   { background: rgba(59, 130, 246, 0.14); color: var(--gs-blue); }
.badge-download { background: rgba(40, 167, 69, 0.13); color: var(--text-success, #28a745); }
.badge-unchanged{ background: var(--background-modifier-border); color: var(--text-muted); }

.github-sync-hint-warning {
  margin: 6px 0;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(230, 146, 42, 0.35);
  background: rgba(230, 146, 42, 0.09);
  color: var(--text-warning, #b06f12);
  font-size: 0.78em;
  line-height: 1.4;
  flex-shrink: 0;
}

/* ── 文件列表 / 文件夹树 ── */
.github-sync-file-list {
  max-height: 280px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 4px;
  margin: 6px 0;
  background: var(--background-primary-alt);
  font-family: var(--font-monospace);
  font-size: 0.8em;
  scrollbar-gutter: stable;
}

.github-sync-confirm-modal .github-sync-file-list {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: none;
}

.github-sync-file-list::-webkit-scrollbar {
  width: 8px;
}

.github-sync-file-list::-webkit-scrollbar-thumb {
  background: var(--background-modifier-border);
  border-radius: 4px;
}

.github-sync-file-list::-webkit-scrollbar-thumb:hover {
  background: var(--text-faint);
}

.github-sync-file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 3px 6px;
  border-radius: 5px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s ease;
}

.github-sync-file-row:hover {
  background: var(--background-modifier-hover);
}

/* 已勾选的行淡染色，一眼看清哪些会执行 */
.github-sync-file-row:has(input[type="checkbox"]:checked) {
  background: var(--background-modifier-active-hover, rgba(0, 0, 0, 0.04));
}

.github-sync-file-row input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}

.github-sync-tree-row {
  border-radius: 5px;
}

.github-sync-tree-folder {
  background: var(--background-secondary);
  font-weight: 600;
  margin: 1px 0;
}

.github-sync-tree-folder:hover {
  background: var(--background-modifier-hover);
}

.github-sync-tree-caret {
  flex-shrink: 0;
  width: 1.2em;
  text-align: center;
  color: var(--text-muted);
  user-select: none;
  font-size: 0.9em;
  line-height: 1;
  cursor: pointer;
}

.github-sync-folder-name {
  font-weight: 600;
  color: var(--text-normal);
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
}

.github-sync-folder-count {
  margin-left: auto;
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--background-primary);
  color: var(--text-faint);
  font-size: 0.82em;
  font-variant-numeric: tabular-nums;
}

.file-icon { flex-shrink: 0; font-size: 0.9em; }

/* 右侧 meta（时间/估算）与动作区 */
.github-sync-row-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.github-sync-row-meta .file-times {
  margin-left: 0;
}

.github-sync-row-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.github-sync-row-meta + .github-sync-row-actions {
  margin-left: 0;
}

/* 逐文件同步方式选择 */
.github-sync-modal .github-sync-action-select {
  height: 24px;
  max-width: 112px;
  padding: 0 4px;
  margin: 0;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: 0.72em;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease,
    background 0.12s ease;
}

.github-sync-modal .github-sync-action-select:hover,
.github-sync-modal .github-sync-action-select:focus {
  border-color: var(--interactive-accent);
  color: var(--text-normal);
}

.github-sync-action-badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: 0.70em;
  white-space: nowrap;
}

.github-sync-action-badge.action-upload { color: var(--gs-blue, #3b82f6); }
.github-sync-action-badge.action-download { color: var(--text-success, #28a745); }
.github-sync-action-badge.action-merge { color: var(--text-warning, #e6922a); }
.github-sync-action-badge.action-delete,
.github-sync-action-badge.action-delete-local { color: var(--text-error, #dc3545); }

/* 回滚行 */
.github-sync-snapshot-row {
  gap: 8px;
  min-height: 38px;
  cursor: default;
}

/* 标题必须可收缩（flex-basis: 0 + min-width: 0），否则长路径/长日期
   会把右侧的动作按钮挤出可视区域。 */
.github-sync-modal .github-sync-snapshot-title {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.github-sync-modal .github-sync-snapshot-date {
  color: var(--text-normal);
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.github-sync-snapshot-count {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--background-secondary);
  color: var(--text-faint);
  font-size: 0.82em;
}

.github-sync-modal .github-sync-restore-btn {
  height: 26px;
  min-height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--background-modifier-border-hover, var(--background-modifier-border));
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: 0.75em;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s ease;
}

.github-sync-modal .github-sync-restore-btn:hover {
  border-color: var(--text-warning, #e6922a);
  color: var(--text-warning, #e6922a);
  background: rgba(230, 146, 42, 0.08);
}

.github-sync-modal .github-sync-restore-btn.github-sync-armed {
  border-color: var(--text-error, #dc3545) !important;
  color: var(--text-error, #dc3545) !important;
  background: rgba(220, 53, 69, 0.1) !important;
  font-weight: 600;
}

.github-sync-rollback-modal .github-sync-file-list {
  max-height: min(46vh, 420px);
  max-height: min(46dvh, 420px);
}

/* 文字版「对比」按钮：浅色描边胶囊 + 正常文字色，保证任何主题下都清晰可见。
   注意：不要用纯图标按钮 —— Obsidian 的 setIcon 遇到无效图标名会静默不渲染，
   结果就是一个看不见的空盒子。 */
.github-sync-modal .github-sync-compare-btn {
  flex-shrink: 0;
  height: 26px;
  min-height: 26px;
  padding: 0 11px;
  margin: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--background-modifier-border-hover, var(--background-modifier-border));
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-normal);
  font-size: 0.76em;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease,
    border-color 0.12s ease;
}

.github-sync-modal .github-sync-compare-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}

.github-sync-modal .github-sync-compare-btn:active {
  background: var(--background-modifier-active-hover, var(--background-modifier-hover));
}

.file-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-normal);
}

.file-added,
.file-download { color: var(--text-success, #28a745); }
.file-modified { color: var(--text-warning, #e6922a); }
.file-upload   { color: var(--gs-blue, #0366d6); }
.file-deleted  { color: var(--text-error, #dc3545); text-decoration: line-through; }

/* 时间判定依据（按时间/合并模式的确认列表） */
.file-times {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 0.88em;
  padding: 0 4px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.github-sync-uncertain-mark {
  flex-shrink: 0;
  color: var(--text-warning, #e6922a);
  cursor: help;
}

/* .obsidian 子项选择器中的敏感条目提示 */
.github-sync-entry-hint {
  margin-left: auto;
  flex-shrink: 0;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
  font-size: 0.72em;
}

/* ── .obsidian 子项树状选择器 ── */
.github-sync-master-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 8px;
}

.github-sync-master-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 0.9em;
  color: var(--text-normal);
  user-select: none;
}

.github-sync-tree .github-sync-tree-row input[type="checkbox"]:disabled {
  cursor: not-allowed;
}

.github-sync-more {
  color: var(--text-muted);
  font-size: 0.8em;
  text-align: center;
  margin: 6px 0;
}

.github-sync-warning {
  color: var(--text-muted);
  font-size: 0.8em;
  margin: 8px 0 2px;
  line-height: 1.45;
  flex-shrink: 0;
}

.github-sync-no-changes {
  color: var(--text-success, #28a745);
  font-size: 0.9em;
  margin: 10px 0;
}

/* ── 进度条（支持确定/不确定两种状态） ── */
.github-sync-progress-modal {
  text-align: center;
  padding: 20px 16px;
}
.github-sync-progress-modal h2 { font-size: 1em; }
.github-sync-progress-msg {
  color: var(--text-muted);
  font-size: 0.85em;
  margin: 8px 0 16px;
  min-height: 1.3em;
  overflow-wrap: anywhere;
}
.github-sync-progress-bar-wrap {
  width: 100%;
  height: 6px;
  background: var(--background-modifier-border);
  border-radius: 3px;
  overflow: hidden;
}
.github-sync-progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--interactive-accent), var(--gs-blue, #4a9eff));
  border-radius: 3px;
  width: 0%;
  transition: width 0.25s ease;
}
.github-sync-progress-bar-fill.github-sync-indeterminate {
  width: 35% !important;
  animation: github-sync-slide 1.15s ease-in-out infinite;
}
@keyframes github-sync-slide {
  0%   { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.github-sync-progress-pct {
  font-size: 0.75em;
  color: var(--text-muted);
  margin-top: 6px;
  min-height: 1em;
}

/* ── 差异对比弹窗 ── */
.modal.github-sync-diff-modal {
  --modal-width: 980px;
  --modal-max-width: 94vw;
  width: min(94vw, 980px) !important;
  max-width: min(94vw, 980px) !important;
}

.diff-legend {
  display: flex;
  gap: 8px;
  margin: 2px 0 10px;
  flex-wrap: wrap;
}
.diff-legend-item {
  font-size: 0.74em;
  color: var(--text-muted);
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--background-primary-alt);
  border: 1px solid var(--background-modifier-border);
}

.diff-scroll-area {
  max-height: min(64vh, 620px);
  max-height: min(64dvh, 620px);
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-bottom: 6px;
  padding-right: 2px;
  scrollbar-gutter: stable;
}

.diff-file-section {
  margin-bottom: 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  overflow: hidden;
}

.diff-file-identical {
  border-style: dashed;
  opacity: 0.9;
}

.diff-file-section summary {
  padding: 7px 10px;
  background: var(--background-secondary);
  cursor: pointer;
  font-weight: 500;
  font-size: 0.85em;
  transition: background 0.1s ease;
  overflow-wrap: anywhere;
}
.diff-file-section summary:hover {
  background: var(--background-modifier-hover);
}
.diff-file-body { padding: 4px 8px; }

.diff-meta-table {
  margin: 4px 0 6px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  overflow: hidden;
  font-size: 0.8em;
}
.diff-meta-row {
  display: flex;
  gap: 10px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}
.diff-meta-row:last-child { border-bottom: none; }
.diff-meta-row > span:first-child {
  flex: 0 0 88px;
  color: var(--text-muted);
}
.diff-meta-row > span:last-child {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.github-sync-diff-modal .cm-merge-view {
  height: 320px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  overflow: hidden;
  margin: 4px 0;
}
.github-sync-diff-modal .cm-editor {
  background: var(--background-primary);
  color: var(--text-normal);
  height: 100%;
}
.github-sync-diff-modal .cm-editor.cm-focused { outline: none; }
.github-sync-diff-modal .cm-scroller {
  font-family: var(--font-monospace);
  font-size: 0.82em;
  line-height: 1.5;
}
.github-sync-diff-modal .cm-gutters {
  background: var(--background-secondary);
  border-right: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
}
.github-sync-diff-modal .cm-activeLine { background: transparent; }
.github-sync-diff-modal .cm-selectionBackground,
.github-sync-diff-modal .cm-focused .cm-selectionBackground {
  background: var(--text-selection, rgba(66, 133, 244, 0.15)) !important;
}
.github-sync-diff-modal .cm-cursor { border-color: var(--text-normal); }
.github-sync-diff-modal .cm-merge-gap {
  background: var(--background-secondary-alt, var(--background-secondary));
}

.diff-binary-table {
  width: 100%;
  font-size: 0.82em;
  border-collapse: collapse;
}
.diff-binary-table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}
.diff-binary-table td:first-child {
  color: var(--text-muted);
  width: 90px;
  vertical-align: top;
}

/* ── 设置页 ── */
.github-sync-settings .setting-item-description a {
  color: var(--link-color);
  text-decoration: underline;
}

.github-sync-settings .setting-item-control {
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 4px;
}

.github-sync-settings-heading {
  margin: 18px 0 2px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--background-modifier-border);
  font-size: 0.95em;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}
.github-sync-settings-heading:first-child { margin-top: 0; }

.github-sync-token-input {
  min-width: 220px;
}

/* ── 回滚 ── */
.github-sync-rollback-btn {
  margin: 8px 0 2px;
  padding: 7px 12px;
  min-height: 34px;
  font-size: 0.82em;
  border-radius: 8px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: all 0.15s ease;
  width: 100%;
  text-align: center;
}
.github-sync-rollback-btn:hover {
  border-color: var(--text-error, #dc3545);
  color: var(--text-error, #dc3545);
  background: rgba(220, 53, 69, 0.06);
}

/* ── 手机 / 窄屏 ── */
@media (max-width: 600px) {
  .modal:has(.github-sync-modal),
  .modal.github-sync-mode-host,
  .modal.github-sync-confirm-host,
  .modal.github-sync-diff-modal {
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh;
    height: 100dvh;
    margin: 0;
    border-radius: 0;
  }

  .modal:has(.github-sync-modal) .modal-content,
  .modal.github-sync-mode-host .modal-content,
  .modal.github-sync-confirm-host .modal-content,
  .modal.github-sync-diff-modal .modal-content {
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    padding: 14px 14px max(14px, env(safe-area-inset-bottom));
  }

  .github-sync-token-input {
    min-width: 0;
    width: 100%;
  }

  .github-sync-confirm-modal {
    max-height: calc(100dvh - 40px);
  }

  .github-sync-confirm-modal .github-sync-file-list {
    min-height: 160px;
  }

  .github-sync-toolbar {
    gap: 6px;
  }

  .github-sync-search {
    flex-basis: 100%;
    order: 10;
  }

  .github-sync-mode-buttons {
    grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
    gap: 8px;
  }

  .github-sync-modal .github-sync-mode-btn {
    min-height: 104px;
    padding: 12px 10px 10px;
  }

  .github-sync-file-row {
    flex-wrap: wrap;
  }

  .github-sync-row-meta {
    order: 5;
    flex-basis: 100%;
    margin-left: 28px;
  }

  .file-times {
    flex-basis: auto;
    margin-left: 0;
    white-space: normal;
  }

  .github-sync-row-actions {
    margin-left: auto;
  }

  .github-sync-diff-modal .cm-merge-view {
    height: 240px;
  }

  .diff-scroll-area {
    max-height: 56dvh;
  }

  .github-sync-progress-modal {
    padding: 14px 8px;
  }
}

@media (max-width: 380px) {
  .github-sync-mode-buttons {
    grid-template-columns: 1fr;
  }
}

/* 触摸设备：加大可点击区域 */
@media (pointer: coarse) {
  .github-sync-file-row {
    min-height: 38px;
    padding: 6px 8px;
  }

  .github-sync-file-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
  }

  .github-sync-modal .github-sync-compare-btn,
  .github-sync-modal .github-sync-restore-btn {
    min-height: 30px;
    height: 30px;
    padding: 0 12px;
  }

  .github-sync-modal .github-sync-action-select {
    height: 30px;
    max-width: 124px;
  }

  .github-sync-select-all-btn {
    min-height: 32px;
  }
}

@media (hover: none) {
  .github-sync-mode-btn:hover {
    transform: none;
    box-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .github-sync-modal *,
  .github-sync-modal *::before,
  .github-sync-modal *::after {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }
}

/* ===== 统一同步工作台 ===== */

.modal.egs-workspace-host {
  --modal-width: 760px;
  --modal-max-width: 86vw;
  width: min(86vw, 760px) !important;
  max-width: min(86vw, 760px) !important;
  transition: width 0.18s ease, max-width 0.18s ease;
}

/* 文件较少时进一步收窄，避免小列表喧宾夺主 */
.modal.egs-workspace-host.egs-small-list {
  --modal-width: 600px;
  --modal-max-width: 80vw;
  width: min(80vw, 600px) !important;
  max-width: min(80vw, 600px) !important;
}

/* 打开右栏对比：整体放宽，但左树占比更小、右栏占比更大 */
.modal.egs-workspace-host.has-right {
  --modal-width: 1280px;
  --modal-max-width: 94vw;
  width: min(94vw, 1280px) !important;
  max-width: min(94vw, 1280px) !important;
}

.modal.egs-workspace-host.has-right.egs-small-list {
  --modal-width: 1120px;
  --modal-max-width: 92vw;
  width: min(92vw, 1120px) !important;
  max-width: min(92vw, 1120px) !important;
}

.egs-workspace-modal {
  display: flex;
  flex-direction: column;
  height: min(72vh, 660px);
  height: min(72dvh, 660px);
  max-height: min(72vh, 660px);
  max-height: min(72dvh, 660px);
  overflow: hidden;
  font-family: var(--font-interface, inherit);
  color: var(--text-normal);
  transition: height 0.18s ease, max-height 0.18s ease;
}

.modal.egs-workspace-host.egs-small-list .egs-workspace-modal {
  height: min(62vh, 520px);
  height: min(62dvh, 520px);
  max-height: min(62vh, 520px);
  max-height: min(62dvh, 520px);
}

/* 只有打开右栏对比时才把工作台放大，给 diff 足够空间 */
.modal.egs-workspace-host.has-right .egs-workspace-modal {
  height: min(84vh, 800px);
  height: min(84dvh, 800px);
  max-height: min(84vh, 800px);
  max-height: min(84dvh, 800px);
}

.modal.egs-workspace-host.has-right.egs-small-list .egs-workspace-modal {
  height: min(78vh, 720px);
  height: min(78dvh, 720px);
  max-height: min(78vh, 720px);
  max-height: min(78dvh, 720px);
}

.egs-header {
  flex-shrink: 0;
  padding-bottom: 4px;
}

.egs-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.egs-title-row h2 {
  margin: 0;
  font-size: 1.15em;
  line-height: 1.3;
}

.egs-repo-pill {
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: 0.74em;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.egs-target-chip {
  padding: 2px 9px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--color-blue, #3b82f6);
  font-size: 0.72em;
  max-width: 44%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.egs-header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 文字“对比”按钮（工作台 / 回滚） */
.egs-workspace-modal .egs-compare-btn,
.egs-rollback-modal .egs-compare-btn {
  height: 24px;
  min-height: 24px;
  padding: 0 9px;
  margin: 0;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: 0.72em;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.12s ease, color 0.12s ease,
    border-color 0.12s ease;
}

.egs-workspace-modal .egs-compare-btn:hover,
.egs-rollback-modal .egs-compare-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}

.egs-icon-btn,
.egs-text-btn {
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease,
    border-color 0.12s ease;
}

.egs-workspace-modal .egs-icon-btn {
  width: 28px;
  height: 28px;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.egs-workspace-modal .egs-icon-btn svg {
  width: 15px;
  height: 15px;
}

.egs-workspace-modal .egs-text-btn {
  height: 32px;
  min-height: 32px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.8em;
}

.egs-workspace-modal .egs-text-btn svg {
  width: 15px;
  height: 15px;
}

.egs-text-btn-label {
  line-height: 1;
}

.egs-rollback-modal .github-sync-restore-btn,
.egs-restore-btn {
  height: 30px;
  min-height: 30px;
  padding: 0 11px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78em;
}

.egs-rollback-modal .github-sync-restore-btn svg,
.egs-restore-btn svg {
  width: 14px;
  height: 14px;
}

.egs-icon-btn:hover,
.egs-text-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--background-modifier-border);
}

/* 顶部模式选项卡 */
.egs-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  margin: 0 0 6px;
  padding: 3px;
  border-radius: 10px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  overflow: visible;
  scrollbar-width: none;
}

.egs-tabs::-webkit-scrollbar { display: none; }

.egs-workspace-modal .egs-tab {
  --egs-accent: var(--interactive-accent);
  position: relative;
  flex: 1 1 0;
  min-width: 108px;
  height: 36px;
  min-height: 36px;
  margin: 0;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.82em;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease,
    border-color 0.15s ease;
}

.egs-tab-push  { --egs-accent: var(--color-blue, #3b82f6); }
.egs-tab-pull  { --egs-accent: var(--color-green, #34c26b); }
.egs-tab-time  { --egs-accent: var(--color-orange, #e6922a); }
.egs-tab-merge { --egs-accent: var(--color-purple, #a15cd1); }

.egs-workspace-modal .egs-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

.egs-workspace-modal .egs-tab.is-active {
  background: var(--background-primary);
  color: var(--egs-accent);
  border-color: var(--egs-accent);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.08);
}

.egs-tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.egs-tab-icon svg {
  width: 15px;
  height: 15px;
}

.egs-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 选项卡已有文字标签与下方说明，不再额外显示 tooltip */

.egs-mode-desc {
  margin: 2px 2px 6px;
  color: var(--text-muted);
  font-size: 0.76em;
  line-height: 1.45;
  min-height: 1.4em;
}

.egs-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  border-top: 1px solid var(--background-modifier-border);
  padding-top: 8px;
  gap: 10px;
}

.egs-left {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.egs-toolbar {
  flex-shrink: 0;
  margin: 0 0 6px;
}

.egs-summary {
  flex-shrink: 0;
  margin: 0 0 6px;
}

.egs-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none !important;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  font-family: var(--font-interface, inherit);
  font-size: 0.82em;
  border-radius: 8px;
  background: var(--background-primary-alt);
}

.egs-list .github-sync-file-row {
  min-height: 30px;
}

.egs-row-active {
  background: var(--background-modifier-active-hover, rgba(59, 130, 246, 0.1)) !important;
  box-shadow: inset 2px 0 0 var(--interactive-accent);
}

.egs-folder-row {
  background: var(--background-secondary);
}

.egs-warnings {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
}

.egs-warning {
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid rgba(230, 146, 42, 0.3);
  background: rgba(230, 146, 42, 0.08);
  color: var(--text-warning, #b06f12);
  font-size: 0.76em;
  line-height: 1.4;
}

/* 右栏：对比区占更大比例，左侧文档树相应变窄 */
.egs-right {
  display: none;
  flex: 0 0 58%;
  max-width: 58%;
  min-width: 0;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--background-modifier-border);
  padding-left: 10px;
}

.egs-workspace-modal.has-right .egs-right {
  display: flex;
}

.egs-right-header {
  flex-shrink: 0;
  padding-bottom: 6px;
}

.egs-right-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.egs-right-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 0.86em;
  color: var(--text-normal);
}

.egs-right-actions {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}

.egs-right-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
  color: var(--text-faint);
  font-size: 0.74em;
}

.egs-right-meta-item {
  white-space: nowrap;
}

.egs-right-commit {
  flex: 1 1 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.egs-right-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  background: var(--background-primary);
  padding: 6px;
}

.egs-diff-sides {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 0 2px 5px;
  font-size: 0.72em;
  color: var(--text-muted);
}

.egs-diff-side-label {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.egs-rollback-compare-legend {
  margin: 0 0 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
}

.egs-diff-side-label.is-missing {
  color: var(--text-faint);
  font-style: italic;
}

.egs-diff-editor {
  flex: 1 1 auto;
  min-height: 260px;
  height: 100%;
  margin: 0;
  overflow: hidden;
  border-radius: 6px;
}

.egs-right-body .cm-merge-view,
.egs-diff-modal-body .cm-merge-view {
  height: 100%;
  min-height: 260px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  overflow: hidden;
}

.egs-right-body .cm-editor,
.egs-diff-modal .cm-editor {
  height: 100%;
  background: var(--background-primary);
  color: var(--text-normal);
}

.egs-right-body .cm-editor.cm-focused,
.egs-diff-modal .cm-editor.cm-focused {
  outline: none;
}

.egs-right-body .cm-scroller,
.egs-diff-modal .cm-scroller {
  font-family: var(--font-monospace);
  font-size: 0.8em;
  line-height: 1.5;
}

.egs-right-body .cm-gutters,
.egs-diff-modal .cm-gutters {
  background: var(--background-secondary);
  border-right: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
}

.egs-right-body .cm-activeLine,
.egs-diff-modal .cm-activeLine {
  background: transparent;
}

.egs-right-body .cm-selectionBackground,
.egs-diff-modal .cm-selectionBackground {
  background: var(--text-selection, rgba(66, 133, 244, 0.15)) !important;
}

.egs-right-body .cm-merge-gap,
.egs-diff-modal .cm-merge-gap {
  background: var(--background-secondary-alt, var(--background-secondary));
}

.egs-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 180px;
  padding: 24px 12px;
  text-align: center;
}

.egs-empty-icon {
  color: var(--text-faint);
  margin-bottom: 4px;
}

.egs-empty-icon svg {
  width: 30px;
  height: 30px;
}

.egs-empty-title {
  margin: 0;
  font-weight: 600;
  color: var(--text-normal);
}

.egs-empty-desc,
.egs-empty-note {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8em;
  line-height: 1.45;
}

/* 页脚 */
.egs-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--background-modifier-border);
}

.egs-footer-status {
  flex: 1 1 180px;
  min-width: 0;
}

.egs-status {
  font-size: 0.78em;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.egs-status-idle { color: var(--text-muted); }
.egs-status-busy { color: var(--color-blue, #3b82f6); }
.egs-status-ok { color: var(--text-success, #28a745); }
.egs-status-error { color: var(--text-error, #dc3545); }

.egs-cache-status {
  margin-top: 2px;
  color: var(--text-faint);
  font-size: 0.72em;
  min-height: 1em;
}

.egs-footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}

.egs-workspace-modal .egs-btn,
.egs-rollback-modal .egs-btn,
.egs-diff-modal .egs-btn {
  height: 32px;
  min-height: 32px;
  padding: 0 13px;
  border-radius: 7px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-muted);
  font-size: 0.8em;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s ease;
}

.egs-workspace-modal .egs-btn:hover,
.egs-rollback-modal .egs-btn:hover,
.egs-diff-modal .egs-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

.egs-workspace-modal .egs-btn-primary {
  border-color: var(--interactive-accent);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

.egs-workspace-modal .egs-btn-primary:hover {
  background: var(--interactive-accent-hover);
  color: var(--text-on-accent);
}

.egs-workspace-modal .egs-btn:disabled,
.egs-rollback-modal .egs-btn:disabled,
.egs-diff-modal .egs-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 加载遮罩 */
.egs-loading {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--background-primary) 82%, transparent);
  backdrop-filter: blur(1.5px);
  text-align: center;
}

.egs-loading.is-visible { display: flex; }

.egs-loading.is-inline {
  position: static;
  display: flex;
  flex: 1 1 auto;
  min-height: 160px;
  background: transparent;
  backdrop-filter: none;
}

.egs-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--background-modifier-border);
  border-top-color: var(--interactive-accent);
  animation: egs-spin 0.8s linear infinite;
}

@keyframes egs-spin {
  to { transform: rotate(360deg); }
}

.egs-loading-text {
  color: var(--text-muted);
  font-size: 0.8em;
  line-height: 1.4;
  max-width: 92%;
  overflow-wrap: anywhere;
}

.egs-loading-bar {
  width: min(240px, 70%);
  height: 4px;
  border-radius: 2px;
  background: var(--background-modifier-border);
  overflow: hidden;
}

.egs-loading-bar-fill {
  height: 100%;
  width: 0%;
  border-radius: 2px;
  background: var(--interactive-accent);
  transition: width 0.2s ease;
}

.egs-loading.is-indeterminate .egs-loading-bar-fill {
  width: 35% !important;
  animation: egs-indeterminate 1.1s ease-in-out infinite;
}

@keyframes egs-indeterminate {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}

.egs-workspace-modal.is-syncing .egs-left,
.egs-workspace-modal.is-syncing .egs-right {
  opacity: 0.72;
  pointer-events: none;
}

/* 独立对比弹窗 */
.modal.egs-diff-modal-host {
  --modal-width: 1100px;
  --modal-max-width: 94vw;
  width: min(94vw, 1100px) !important;
  max-width: min(94vw, 1100px) !important;
}

.egs-diff-modal {
  display: flex;
  flex-direction: column;
  height: min(80vh, 820px);
  height: min(80dvh, 820px);
  font-family: var(--font-interface, inherit);
}

.egs-diff-modal-header {
  flex-shrink: 0;
  padding-bottom: 6px;
}

.egs-diff-modal-header h2 {
  margin: 0 0 4px;
  font-size: 1.05em;
}

.egs-diff-modal-path {
  color: var(--text-muted);
  font-size: 0.8em;
  overflow-wrap: anywhere;
}

.egs-diff-modal-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  padding: 6px;
  background: var(--background-primary);
}

.egs-diff-modal-body .cm-merge-view {
  height: 100%;
  min-height: 300px;
}

.egs-diff-modal-footer {
  margin-top: 8px;
}

@media (max-width: 759px) {
  .modal.egs-workspace-host,
  .modal.egs-workspace-host.egs-small-list,
  .modal.egs-workspace-host.has-right,
  .modal.egs-workspace-host.has-right.egs-small-list {
    --modal-max-width: 100vw;
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh;
    height: 100dvh;
    margin: 0;
    border-radius: 0;
    transition: none;
  }

  .modal.egs-workspace-host .modal-content {
    height: 100%;
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
  }

  .egs-workspace-modal,
  .modal.egs-workspace-host.egs-small-list .egs-workspace-modal,
  .modal.egs-workspace-host.has-right .egs-workspace-modal,
  .modal.egs-workspace-host.has-right.egs-small-list .egs-workspace-modal {
    height: 100%;
    max-height: 100%;
  }

  .egs-right {
    display: none !important;
  }

  .egs-workspace-modal.has-right .egs-right {
    display: none !important;
  }

  .egs-title-row h2 {
    font-size: 1.05em;
  }

  .egs-repo-pill,
  .egs-target-chip {
    max-width: 100%;
  }

  .egs-tabs {
    gap: 3px;
    padding: 2px;
    overflow-x: auto;
  }

  .egs-workspace-modal .egs-tab {
    flex: 1 0 auto;
    min-width: 92px;
    height: 34px;
    min-height: 34px;
    padding: 0 8px;
    font-size: 0.78em;
  }

  .egs-mode-desc {
    font-size: 0.74em;
    margin: 6px 2px 4px;
  }

  .egs-body {
    padding-top: 6px;
  }

  .egs-toolbar .github-sync-search {
    flex-basis: 100%;
    order: 10;
  }

  .egs-footer {
    gap: 6px;
  }

  .egs-footer-actions {
    width: 100%;
    justify-content: stretch;
  }

  .egs-workspace-modal .egs-btn {
    flex: 1 1 auto;
    height: 34px;
    min-height: 34px;
    padding: 0 9px;
  }

  .egs-list .github-sync-file-row {
    min-height: 36px;
  }

  .egs-workspace-modal .github-sync-icon-btn {
    width: 30px;
    height: 30px;
    min-height: 30px;
  }

  .egs-workspace-modal .egs-compare-btn,
  .egs-rollback-modal .egs-compare-btn {
    height: 30px;
    min-height: 30px;
    padding: 0 10px;
  }

  .egs-workspace-modal .github-sync-action-select {
    height: 30px;
    max-width: 118px;
  }

  .modal.egs-rollback-host {
    --modal-max-width: 100vw;
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh;
    height: 100dvh;
    margin: 0;
    border-radius: 0;
  }

  .modal.egs-rollback-host .modal-content {
    height: 100%;
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
  }

  .modal.egs-diff-modal-host {
    --modal-max-width: 100vw;
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh;
    height: 100dvh;
    margin: 0;
    border-radius: 0;
  }

  .modal.egs-diff-modal-host .modal-content {
    height: 100%;
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
  }

  .egs-diff-modal {
    height: 100%;
    max-height: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .egs-spinner,
  .egs-loading-bar-fill {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }
}

/* 回滚：使用与工作台一致的外壳/列表/页脚 */
.modal.egs-rollback-host {
  --modal-width: 720px;
  --modal-max-width: 92vw;
  width: min(92vw, 720px) !important;
  max-width: min(92vw, 720px) !important;
}

.egs-rollback-modal {
  display: flex;
  flex-direction: column;
  max-height: min(84vh, 760px);
  max-height: min(84dvh, 760px);
  font-family: var(--font-interface, inherit);
}

.egs-rollback-modal .egs-list {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: min(46vh, 420px) !important;
}

.egs-rollback-modal .egs-footer {
  margin-top: 10px;
}

.egs-snapshot-row .egs-icon-btn {
  width: 26px;
  height: 26px;
  min-height: 26px;
}

/* ===== 状态栏 ===== */
.egs-bar-icon {
  display: inline-flex;
  align-items: center;
  margin-right: 4px;
}

.egs-bar-icon svg {
  width: 12px;
  height: 12px;
}

.egs-bar-label {
  font-size: 0.9em;
  font-weight: 500;
  white-space: nowrap;
}

.egs-bar-sync { color: var(--text-success, #28a745); }
.egs-bar-not-sync { color: var(--text-warning, #e6922a); }
.egs-bar-syncing { color: var(--text-accent, #7c8cff); }

/* ===== 右上角同步卡片（单行） ===== */
.egs-toast {
  position: fixed;
  top: calc(12px + env(safe-area-inset-top));
  right: calc(12px + env(safe-area-inset-right));
  z-index: 60;
  max-width: min(420px, calc(100vw - 24px));
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
  color: var(--text-normal);
  font-family: var(--font-interface, inherit);
  font-size: 0.85em;
  line-height: 1.5;
  opacity: 0;
  transform: translateY(-8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: auto;
}

.egs-toast.is-visible {
  opacity: 1;
  transform: translateY(0);
}

.egs-toast-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.egs-toast-icon {
  flex-shrink: 0;
}

.egs-toast-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.egs-toast.is-error .egs-toast-text {
  color: var(--text-error, #dc3545);
}

/* 同步中的小转圈（只在右上角卡片里，状态栏不做动画） */
.egs-toast-spinner {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--background-modifier-border);
  border-top-color: var(--text-accent, #7c8cff);
  animation: egs-toast-spin 0.9s linear infinite;
}

@keyframes egs-toast-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .egs-toast-spinner {
    animation: none;
  }
}

/* 窄屏：右上角浮层占满宽度，避免被挤成一条 */
@media (max-width: 600px) {
  .egs-toast {
    left: calc(10px + env(safe-area-inset-left));
    right: calc(10px + env(safe-area-inset-right));
    max-width: none;
    padding-top: calc(10px + env(safe-area-inset-top));
  }
}

/* 移动端：回滚弹窗最终覆盖（必须放在桌面回滚规则之后） */
@media (max-width: 759px) {
  .modal.egs-rollback-host {
    --modal-max-width: 100vw;
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh;
    height: 100dvh;
    margin: 0;
    border-radius: 0;
  }

  .modal.egs-rollback-host .modal-content {
    height: 100%;
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
  }

  .egs-rollback-modal {
    max-height: 100%;
  }
}

/* ==========================================================
   多端适配（放在最后，确保覆盖上面的桌面/移动规则）
   ========================================================== */

/* ① 触摸设备（平板 / 手机横屏）：加大可点区域 */
@media (pointer: coarse) {
  .egs-workspace-modal .egs-tab {
    height: 40px;
    min-height: 40px;
  }

  .egs-workspace-modal .egs-compare-btn,
  .egs-rollback-modal .egs-compare-btn,
  .egs-diff-modal .egs-btn {
    height: 32px;
    min-height: 32px;
    padding: 0 12px;
  }

  .egs-workspace-modal .github-sync-action-select {
    height: 32px;
  }

  .egs-workspace-modal .egs-icon-btn,
  .egs-workspace-modal .egs-text-btn {
    height: 34px;
    min-height: 34px;
  }

  .egs-list .github-sync-file-row {
    min-height: 40px;
  }

  .egs-toast {
    font-size: 0.92em;
  }
}

/* ② 中等宽度（平板 / 分屏 / 窄桌面）：内嵌对比改用独立窗口，强制隐藏右栏 */
@media (max-width: 999px) {
  .egs-right,
  .egs-workspace-modal.has-right .egs-right {
    display: none !important;
  }
}

/* ③ 矮窗口（横屏手机 / 上下分屏）：压缩工作台的纵向占用 */
@media (max-height: 560px) {
  .egs-mode-desc {
    display: none;
  }

  .egs-workspace-modal .egs-tab {
    height: 30px;
    min-height: 30px;
    padding: 0 8px;
  }

  .egs-title-row h2 {
    font-size: 1em;
  }

  .egs-header {
    padding-bottom: 2px;
  }

  .egs-summary {
    margin-bottom: 4px;
  }

  .egs-body {
    padding-top: 5px;
  }

  .egs-diff-modal {
    height: min(94vh, 560px);
    height: min(94dvh, 560px);
  }
}

/* ④ 窄屏状态栏：缩短标签，避免被挤出屏幕 */
@media (max-width: 480px) {
  .egs-bar-label {
    font-size: 0.8em;
  }
}
`;
