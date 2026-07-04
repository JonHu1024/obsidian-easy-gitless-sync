// styles.ts — CSS 样式（从 main.ts 抽出）

export const CSS = `
/* ===== GitHub Sync Plugin Styles ===== */
/* Compact, card-style design */

/* ── Modal sizing ── */
.github-sync-modal {
  padding: 4px 0;
}

.github-sync-modal h2 {
  margin: 0 0 4px;
  font-size: 1.15em;
}

.github-sync-mode-modal {
  --dialog-width: 350px;
}

.github-sync-mode-modal h2 {
  font-size: 1.05em;
}

.github-sync-confirm-modal {
  --dialog-width: 520px;
}

.github-sync-subtitle {
  color: var(--text-muted);
  font-size: 0.82em;
  margin: 0 0 12px;
}

/* ── Mode selection (2×2 grid) ── */
.github-sync-mode-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 0 0 4px;
}

.github-sync-mode-btn {
  padding: 12px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  background: var(--background-primary);
  cursor: pointer;
  text-align: center;
  transition: all 0.12s ease;
}

.github-sync-mode-btn:hover {
  border-color: var(--interactive-accent);
  background: var(--background-modifier-hover);
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
}

.github-sync-mode-icon {
  font-size: 1.4em;
  margin-bottom: 4px;
  line-height: 1;
}

.github-sync-mode-label {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: 2px;
  line-height: 1.2;
}

.github-sync-mode-desc {
  font-size: 0.72em;
  color: var(--text-muted);
  line-height: 1.2;
}

/* ── Confirm modal ── */
.github-sync-confirm-modal h2 {
  margin-bottom: 8px;
}

.github-sync-select-all-btn {
  margin-bottom: 6px;
  font-size: 0.78em;
  padding: 2px 10px;
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
.badge-unchanged{ background: var(--background-modifier-border); color: var(--text-muted); }

.github-sync-file-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--background-modifier-border);
  border-radius: 5px;
  padding: 4px;
  margin: 6px 0;
  background: var(--background-primary-alt);
  font-family: var(--font-monospace);
  font-size: 0.8em;
}

.github-sync-file-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 5px;
  border-radius: 3px;
  cursor: pointer;
  user-select: none;
}

.github-sync-file-row:hover {
  background: var(--background-modifier-hover);
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
  background: var(--interactive-accent);
  border-radius: 3px;
  width: 0%;
  transition: width 0.3s ease;
}

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
  max-height: 480px;
  overflow-y: auto;
  margin-bottom: 6px;
}

.diff-file-section {
  margin-bottom: 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 5px;
  overflow: hidden;
}
.diff-file-section summary {
  padding: 6px 10px;
  background: var(--background-secondary);
  cursor: pointer;
  font-weight: 500;
  font-size: 0.85em;
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

/* ── Rollback ── */
/* ── Diff apply button ── */
.github-sync-apply-btn {
  margin: 4px 0;
  padding: 3px 10px;
  font-size: 0.78em;
  border-radius: 4px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: all 0.12s ease;
}
.github-sync-apply-btn:hover {
  border-color: var(--interactive-accent);
  background: var(--background-modifier-hover);
}
.github-sync-apply-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.github-sync-rollback-btn {
  margin: 6px 0;
  padding: 6px 12px;
  font-size: 0.82em;
  border-radius: 6px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: all 0.12s ease;
  width: 100%;
  text-align: center;
}
.github-sync-rollback-btn:hover {
  border-color: var(--interactive-accent);
  background: var(--background-modifier-hover);
}
`;
