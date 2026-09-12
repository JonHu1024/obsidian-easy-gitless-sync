// styles.ts — CSS 样式（从 main.ts 抽出）

export const CSS = `
/* ===== GitHub Sync Plugin Styles ===== */
/* 卡片式设计，全部使用 Obsidian 主题变量保证明暗主题兼容 */

/* ── Modal 基础 ── */
.github-sync-modal {
  padding: 4px 0;
}

.github-sync-modal h2 {
  margin: 0 0 4px;
  font-size: 1.15em;
}

.github-sync-modal button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.github-sync-mode-modal {
  --dialog-width: 380px;
}

.github-sync-mode-modal h2 {
  font-size: 1.05em;
}

.github-sync-confirm-modal {
  --dialog-width: 560px;
}

.github-sync-subtitle {
  color: var(--text-muted);
  font-size: 0.82em;
  margin: 0 0 12px;
}

/* ── 模式选择（2×2 卡片，各模式带强调色） ── */
.github-sync-mode-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 8px 0 4px;
}

.github-sync-mode-btn {
  --gs-accent: var(--interactive-accent);
  padding: 14px 10px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 10px;
  background: var(--background-primary);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s ease, background 0.15s ease,
    transform 0.15s ease, box-shadow 0.15s ease;
}

.github-sync-mode-btn.mode-push  { --gs-accent: var(--color-blue, #3b82f6); }
.github-sync-mode-btn.mode-pull  { --gs-accent: var(--color-green, #34c26b); }
.github-sync-mode-btn.mode-time  { --gs-accent: var(--color-orange, #e6922a); }
.github-sync-mode-btn.mode-merge { --gs-accent: var(--color-purple, #a15cd1); }

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

.github-sync-mode-btn:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: 2px;
}

.github-sync-mode-icon {
  font-size: 1.5em;
  margin-bottom: 6px;
  line-height: 1;
  transition: transform 0.18s ease;
}

.github-sync-mode-btn:hover .github-sync-mode-icon {
  transform: scale(1.18);
}

.github-sync-mode-label {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: 3px;
  line-height: 1.2;
}

.github-sync-mode-desc {
  font-size: 0.72em;
  color: var(--text-muted);
  line-height: 1.25;
}

/* ── 确认弹窗 ── */
.github-sync-confirm-modal h2 {
  margin-bottom: 8px;
}

/* 工具栏：全选 / 已选计数 / 搜索过滤 */
.github-sync-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 2px;
}

.github-sync-select-all-btn {
  flex-shrink: 0;
  margin: 0;
  font-size: 0.78em;
  padding: 3px 10px;
  cursor: pointer;
  border-radius: 4px;
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
}

.github-sync-search {
  flex: 1;
  min-width: 0;
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
}

.github-sync-badge {
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 0.78em;
  font-weight: 500;
}

.badge-added    { background: rgba(40, 167, 69, 0.12); color: #28a745; }
.badge-modified { background: rgba(255, 165, 0, 0.12); color: #e6922a; }
.badge-deleted  { background: rgba(220, 53, 69, 0.12); color: #dc3545; }
.badge-upload   { background: rgba(3, 102, 214, 0.12); color: #0366d6; }
.badge-download { background: rgba(40, 167, 69, 0.12); color: #28a745; }
.badge-unchanged{ background: var(--background-modifier-border); color: var(--text-muted); }

/* ── 文件列表 ── */
.github-sync-file-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  padding: 4px;
  margin: 6px 0;
  background: var(--background-primary-alt);
  font-family: var(--font-monospace);
  font-size: 0.8em;
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
  gap: 5px;
  padding: 3px 5px;
  border-radius: 4px;
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
}

.file-icon { flex-shrink: 0; font-size: 0.9em; }

.github-sync-compare-btn {
  margin-left: auto;
  flex-shrink: 0;
  padding: 0 7px;
  font-size: 0.75em;
  border-radius: 3px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s ease;
  line-height: 1.6;
}

.github-sync-compare-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

/* 回滚按钮的两段式确认态 */
.github-sync-compare-btn.github-sync-armed {
  border-color: var(--text-error, #dc3545) !important;
  color: var(--text-error, #dc3545) !important;
  background: rgba(220, 53, 69, 0.1) !important;
  font-weight: 600;
}

.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-normal);
}

.file-added    { color: #28a745; }
.file-download { color: #28a745; }
.file-modified { color: #e6922a; }
.file-upload   { color: #0366d6; }
.file-deleted  { color: #dc3545; text-decoration: line-through; }

/* 时间判定依据（按时间/合并模式的确认列表） */
.file-times {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 0.9em;
  padding: 0 4px;
}
.github-sync-file-row:has(.file-times) .github-sync-compare-btn {
  margin-left: 4px;
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

.github-sync-tree-row .github-sync-tree-caret {
  flex-shrink: 0;
  width: 1.1em;
  text-align: center;
  color: var(--text-muted);
  user-select: none;
  font-size: 0.85em;
  line-height: 1;
}

.github-sync-tree .github-sync-tree-row input[type="checkbox"]:disabled {
  cursor: not-allowed;
}

.github-sync-more {
  color: var(--text-muted);
  font-size: 0.8em;
  text-align: center;
  margin: 2px 0;
}

.github-sync-warning {
  color: var(--text-muted);
  font-size: 0.8em;
  margin: 8px 0 2px;
}

.github-sync-no-changes {
  color: var(--text-success, #28a745);
  font-size: 0.9em;
  margin: 12px 0;
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
  background: linear-gradient(90deg, var(--interactive-accent), var(--color-blue, #4a9eff));
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
.github-sync-diff-modal {
  --dialog-width: min(90vw, 780px);
}

.diff-legend {
  display: flex;
  gap: 10px;
  margin: 2px 0 10px;
  flex-wrap: wrap;
}
.diff-legend-item {
  font-size: 0.75em;
  color: var(--text-muted);
  padding: 1px 8px;
  border-radius: 3px;
  background: var(--background-primary-alt);
  border: 1px solid var(--background-modifier-border);
}

.diff-scroll-area {
  max-height: min(62vh, 560px);
  overflow-y: auto;
  margin-bottom: 6px;
  padding-right: 2px;
}

.diff-file-section {
  margin-bottom: 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  overflow: hidden;
}
.diff-file-section summary {
  padding: 6px 10px;
  background: var(--background-secondary);
  cursor: pointer;
  font-weight: 500;
  font-size: 0.85em;
  transition: background 0.1s ease;
  list-style: none;
}
.diff-file-section summary:hover {
  background: var(--background-modifier-hover);
}
.diff-file-body { padding: 4px 8px; }

.github-sync-diff-modal .cm-merge-view {
  height: 300px;
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
  background: var(--text-selection, rgba(66,133,244,0.15)) !important;
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
  width: 80px;
  vertical-align: top;
}

.github-sync-settings .setting-item-description a {
  color: var(--link-color);
  text-decoration: underline;
}

/* ── 回滚 ── */
.github-sync-rollback-btn {
  margin: 6px 0;
  padding: 6px 12px;
  font-size: 0.82em;
  border-radius: 6px;
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
`;
