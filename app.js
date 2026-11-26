/* ==========================================================================
   MarkItDown Web — Main Thread UI Controller
   Manages Web Worker lifecycle, drag-and-drop, sequential batch conversion
   queue, split-pane Markdown viewer, JSZip export, and Vision LLM settings.
   ========================================================================== */

const STORAGE_KEYS = {
  theme: "markitdown_theme",
  apiKey: "markitdown_llm_api_key",
  baseUrl: "markitdown_llm_base_url",
  model: "markitdown_llm_model",
};

const DEFAULT_LLM_SETTINGS = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

// Application State
const state = {
  worker: null,
  workerReady: false,
  isConverting: false,
  files: [], // { id, file, name, size, status: 'queued'|'converting'|'done'|'error', markdown, error }
  selectedId: null,
  activeTab: "raw", // 'raw' | 'preview'
};

// DOM References
const el = {
  initBanner: document.getElementById("init-banner"),
  initSpinner: document.getElementById("init-spinner"),
  initStatusText: document.getElementById("init-status-text"),
  initPercent: document.getElementById("init-percent"),
  initProgressTrack: document.getElementById("init-progress-track"),
  initProgressFill: document.getElementById("init-progress-fill"),

  dropzone: document.getElementById("dropzone"),
  dropzoneHint: document.getElementById("dropzone-hint"),
  fileInput: document.getElementById("file-input"),

  queueList: document.getElementById("queue-list"),
  queueEmpty: document.getElementById("queue-empty"),
  queueCount: document.getElementById("queue-count"),
  btnDownloadZip: document.getElementById("btn-download-zip"),
  btnClearQueue: document.getElementById("btn-clear-queue"),

  viewerFilename: document.getElementById("viewer-filename"),
  viewerStats: document.getElementById("viewer-stats"),
  viewerEmpty: document.getElementById("viewer-empty"),
  viewerLoading: document.getElementById("viewer-loading"),
  viewerLoadingTitle: document.getElementById("viewer-loading-title"),
  viewerError: document.getElementById("viewer-error"),
  viewerErrorMessage: document.getElementById("viewer-error-message"),

  tabRaw: document.getElementById("tab-raw"),
  tabPreview: document.getElementById("tab-preview"),
  paneRaw: document.getElementById("pane-raw"),
  panePreview: document.getElementById("pane-preview"),
  rawEditor: document.getElementById("raw-editor"),
  previewContent: document.getElementById("preview-content"),

  btnCopyMd: document.getElementById("btn-copy-md"),
  btnCopyLabel: document.getElementById("btn-copy-label"),
  btnDownloadMd: document.getElementById("btn-download-md"),

  btnResetRuntime: document.getElementById("btn-reset-runtime"),
  btnThemeToggle: document.getElementById("btn-theme-toggle"),
  btnSettings: document.getElementById("btn-settings"),
  llmStatusDot: document.getElementById("llm-status-dot"),

  settingsModal: document.getElementById("settings-modal"),
  settingsForm: document.getElementById("settings-form"),
  btnCloseSettings: document.getElementById("btn-close-settings"),
  btnCancelSettings: document.getElementById("btn-cancel-settings"),
  btnClearSettings: document.getElementById("btn-clear-settings"),
  inputApiKey: document.getElementById("input-api-key"),
  inputBaseUrl: document.getElementById("input-base-url"),
  inputModelName: document.getElementById("input-model-name"),
  settingsFeedback: document.getElementById("settings-feedback"),
};

/* ==========================================================================
   Utilities
   ========================================================================== */

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

function toMarkdownFilename(originalName) {
  const dotIdx = originalName.lastIndexOf(".");
  const base = dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName;
  return `${base}.md`;
}

function computeStats(text) {
  const chars = text.length;
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  const trimmed = text.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  return `${lines.toLocaleString()} lines · ${words.toLocaleString()} words · ${chars.toLocaleString()} chars`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getLlmConfig() {
  return {
    apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) || DEFAULT_LLM_SETTINGS.apiKey,
    baseUrl: localStorage.getItem(STORAGE_KEYS.baseUrl) || DEFAULT_LLM_SETTINGS.baseUrl,
    model: localStorage.getItem(STORAGE_KEYS.model) || DEFAULT_LLM_SETTINGS.model,
  };
}

function updateLlmIndicator() {
  const cfg = getLlmConfig();
  const enabled = Boolean(cfg.apiKey && cfg.apiKey.trim());
  el.llmStatusDot.classList.toggle("is-active", enabled);
  el.btnSettings.title = enabled
    ? `Vision LLM active (${cfg.model})`
    : "Configure optional Vision LLM for image descriptions";
}

/* ==========================================================================
   Web Worker Lifecycle
   ========================================================================== */

function startWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  state.workerReady = false;
  state.isConverting = false;
  setDropzoneEnabled(false, "Initializing WebAssembly Python runtime...");
  showInitBanner("Loading WebAssembly Python runtime...", 10, "loading");

  const worker = new Worker("./worker.js");
  state.worker = worker;

  worker.onmessage = (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "status":
        handleWorkerStatus(msg);
        break;
      case "init_error":
        state.workerReady = false;
        setDropzoneEnabled(false, "Runtime failed to initialize.");
        showInitBanner(`Initialization error: ${msg.error}`, 100, "error");
        break;
      case "llm_configured":
        updateLlmIndicator();
        if (!el.settingsModal.hidden) {
          el.settingsFeedback.classList.remove("is-error");
          el.settingsFeedback.textContent = msg.llmEnabled
            ? `Vision LLM enabled (${msg.model}).`
            : "Vision LLM disabled. All conversions remain 100% local.";
        }
        break;
      case "llm_error":
        if (!el.settingsModal.hidden) {
          el.settingsFeedback.classList.add("is-error");
          el.settingsFeedback.textContent = `LLM configuration error: ${msg.error}`;
        }
        break;
      case "convert_success":
        handleConvertSuccess(msg.id, msg.markdown);
        break;
      case "convert_error":
        handleConvertError(msg.id, msg.error);
        break;
      default:
        break;
    }
  };

  worker.onerror = (err) => {
    console.error("Worker crashed:", err);
    state.workerReady = false;
    state.isConverting = false;
    setDropzoneEnabled(false, "Worker encountered a fatal error. Click Reset Runtime.");
    showInitBanner(
      `Worker error: ${err.message || "Out of memory or script failure. Click Reset Runtime."}`,
      100,
      "error"
    );

    // Mark any currently converting file as failed
    const active = state.files.find((f) => f.status === "converting");
    if (active) {
      active.status = "error";
      active.error = "Web Worker terminated unexpectedly (possibly out of memory). Click Reset Runtime and retry.";
      renderQueue();
      if (state.selectedId === active.id) renderViewer();
    }
  };

  worker.postMessage({
    type: "init",
    llmConfig: getLlmConfig(),
  });
}

function handleWorkerStatus({ stage, message, progress }) {
  const pct = typeof progress === "number" ? progress : 50;
  if (stage === "ready") {
    state.workerReady = true;
    showInitBanner("Ready", 100, "ready");
    setDropzoneEnabled(true, "Drag multiple files or click to select");
    setTimeout(() => {
      if (state.workerReady) {
        el.initBanner.hidden = true;
      }
    }, 1800);
    processNextInQueue();
  } else {
    showInitBanner(message, pct, "loading");
  }
}

function showInitBanner(text, percent, mode) {
  el.initBanner.hidden = false;
  el.initBanner.classList.toggle("is-ready", mode === "ready");
  el.initBanner.classList.toggle("is-error", mode === "error");
  el.initSpinner.style.display = mode === "loading" ? "inline-block" : "none";
  el.initStatusText.textContent = text;
  el.initPercent.textContent = `${percent}%`;
  el.initProgressFill.style.width = `${percent}%`;
  el.initProgressTrack.setAttribute("aria-valuenow", String(percent));
}

function setDropzoneEnabled(enabled, hintText) {
  el.dropzone.classList.toggle("is-disabled", !enabled);
  el.dropzone.setAttribute("aria-disabled", String(!enabled));
  el.fileInput.disabled = !enabled;
  if (hintText) {
    el.dropzoneHint.textContent = hintText;
  }
}

/* ==========================================================================
   File Queue & Conversion Pipeline
   ========================================================================== */

function enqueueFiles(fileList) {
  if (!state.workerReady || !fileList || fileList.length === 0) return;

  const incoming = Array.from(fileList);
  let firstAddedId = null;

  for (const file of incoming) {
    const id = generateId();
    if (!firstAddedId) firstAddedId = id;
    state.files.push({
      id,
      file,
      name: file.name,
      size: file.size,
      status: "queued",
      markdown: "",
      error: null,
    });
  }

  if (!state.selectedId && firstAddedId) {
    state.selectedId = firstAddedId;
  }

  renderQueue();
  renderViewer();
  processNextInQueue();
}

async function processNextInQueue() {
  if (!state.workerReady || state.isConverting) return;

  const nextItem = state.files.find((item) => item.status === "queued");
  if (!nextItem) return;

  state.isConverting = true;
  nextItem.status = "converting";
  renderQueue();
  if (state.selectedId === nextItem.id) {
    renderViewer();
  }

  try {
    const buffer = await nextItem.file.arrayBuffer();
    state.worker.postMessage(
      {
        type: "convert",
        id: nextItem.id,
        filename: nextItem.name,
        buffer,
      },
      [buffer] // Transferable ArrayBuffer for zero-copy performance
    );
  } catch (err) {
    handleConvertError(nextItem.id, `Failed to read file: ${err.message || err}`);
  }
}

function handleConvertSuccess(id, markdown) {
  state.isConverting = false;
  const item = state.files.find((f) => f.id === id);
  if (item) {
    item.status = "done";
    item.markdown = markdown;
    item.error = null;
  }

  renderQueue();
  if (state.selectedId === id) {
    renderViewer();
  }
  processNextInQueue();
}

function handleConvertError(id, errorMessage) {
  state.isConverting = false;
  const item = state.files.find((f) => f.id === id);
  if (item) {
    item.status = "error";
    item.error = errorMessage;
  }

  renderQueue();
  if (state.selectedId === id) {
    renderViewer();
  }
  processNextInQueue();
}

function removeFile(id) {
  const idx = state.files.findIndex((f) => f.id === id);
  if (idx === -1) return;

  state.files.splice(idx, 1);

  if (state.selectedId === id) {
    const nextSelected = state.files[idx] || state.files[idx - 1] || null;
    state.selectedId = nextSelected ? nextSelected.id : null;
  }

  renderQueue();
  renderViewer();
}

function clearQueue() {
  state.files = state.files.filter((f) => f.status === "converting");
  state.selectedId = state.files.length > 0 ? state.files[0].id : null;
  renderQueue();
  renderViewer();
}

/* ==========================================================================
   Rendering: Queue & Split-Pane Viewer
   ========================================================================== */

function getStatusBadgeInfo(status) {
  switch (status) {
    case "queued":
      return { label: "Queued", cls: "status-queued" };
    case "converting":
      return { label: "Converting...", cls: "status-converting" };
    case "done":
      return { label: "Done", cls: "status-done" };
    case "error":
      return { label: "Error", cls: "status-error" };
    default:
      return { label: status, cls: "status-queued" };
  }
}

function renderQueue() {
  el.queueCount.textContent = String(state.files.length);

  const completedFiles = state.files.filter((f) => f.status === "done");
  el.btnDownloadZip.hidden = completedFiles.length < 2;
  el.btnClearQueue.hidden = state.files.length === 0;

  el.queueList.innerHTML = "";

  if (state.files.length === 0) {
    el.queueList.appendChild(el.queueEmpty);
    el.queueEmpty.hidden = false;
    return;
  }

  for (const item of state.files) {
    const li = document.createElement("li");
    li.className = `queue-item${item.id === state.selectedId ? " is-selected" : ""}`;
    li.dataset.id = item.id;

    const top = document.createElement("div");
    top.className = "queue-item-top";

    const nameSpan = document.createElement("span");
    nameSpan.className = "queue-item-name";
    nameSpan.textContent = item.name;

    const badgeInfo = getStatusBadgeInfo(item.status);
    const badge = document.createElement("span");
    badge.className = `status-badge ${badgeInfo.cls}`;
    badge.textContent = badgeInfo.label;

    top.append(nameSpan, badge);

    const bottom = document.createElement("div");
    bottom.className = "queue-item-bottom";

    const meta = document.createElement("div");
    meta.className = "queue-item-meta";
    meta.textContent = formatBytes(item.size);

    const btns = document.createElement("div");
    btns.className = "queue-item-buttons";

    if (item.status === "done") {
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "queue-item-btn";
      dlBtn.title = "Download .md";
      dlBtn.setAttribute("aria-label", `Download ${toMarkdownFilename(item.name)}`);
      dlBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      dlBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadSingleMarkdown(item);
      });
      btns.appendChild(dlBtn);
    }

    if (item.status !== "converting") {
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "queue-item-btn btn-remove";
      rmBtn.title = "Remove from queue";
      rmBtn.setAttribute("aria-label", `Remove ${item.name}`);
      rmBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      rmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(item.id);
      });
      btns.appendChild(rmBtn);
    }

    bottom.append(meta, btns);
    li.append(top, bottom);

    li.addEventListener("click", () => {
      state.selectedId = item.id;
      renderQueue();
      renderViewer();
    });

    el.queueList.appendChild(li);
  }
}

function renderMarkdownPreview(markdownText) {
  if (typeof window.marked === "undefined" || typeof window.DOMPurify === "undefined") {
    el.previewContent.textContent = markdownText;
    return;
  }
  const rawHtml = window.marked.parse(markdownText, { gfm: true, breaks: false });
  const cleanHtml = window.DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  el.previewContent.innerHTML = cleanHtml;
}

function renderViewer() {
  const selected = state.files.find((f) => f.id === state.selectedId) || null;

  // Hide all states/panes first
  el.viewerEmpty.hidden = true;
  el.viewerLoading.hidden = true;
  el.viewerError.hidden = true;
  el.paneRaw.hidden = true;
  el.panePreview.hidden = true;

  if (!selected) {
    el.viewerFilename.textContent = "No file selected";
    el.viewerStats.textContent = "";
    el.btnCopyMd.disabled = true;
    el.btnDownloadMd.disabled = true;
    el.viewerEmpty.hidden = false;
    return;
  }

  el.viewerFilename.textContent = selected.name;

  if (selected.status === "queued" || selected.status === "converting") {
    el.viewerStats.textContent = selected.status === "queued" ? "Waiting in queue..." : "Converting...";
    el.btnCopyMd.disabled = true;
    el.btnDownloadMd.disabled = true;
    el.viewerLoadingTitle.textContent =
      selected.status === "queued" ? `Queued: ${selected.name}` : `Converting ${selected.name}...`;
    el.viewerLoading.hidden = false;
    return;
  }

  if (selected.status === "error") {
    el.viewerStats.textContent = "Conversion failed";
    el.btnCopyMd.disabled = true;
    el.btnDownloadMd.disabled = true;
    el.viewerErrorMessage.textContent = selected.error || "An unknown error occurred.";
    el.viewerError.hidden = false;
    return;
  }

  // Status: done
  el.btnCopyMd.disabled = false;
  el.btnDownloadMd.disabled = false;
  el.viewerStats.textContent = computeStats(selected.markdown);

  if (el.rawEditor.value !== selected.markdown) {
    el.rawEditor.value = selected.markdown;
  }

  if (state.activeTab === "raw") {
    el.paneRaw.hidden = false;
  } else {
    renderMarkdownPreview(selected.markdown);
    el.panePreview.hidden = false;
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  const isRaw = tab === "raw";
  el.tabRaw.classList.toggle("is-active", isRaw);
  el.tabRaw.setAttribute("aria-selected", String(isRaw));
  el.tabPreview.classList.toggle("is-active", !isRaw);
  el.tabPreview.setAttribute("aria-selected", String(!isRaw));
  renderViewer();
}

/* ==========================================================================
   Export & Clipboard Actions
   ========================================================================== */

function downloadSingleMarkdown(item) {
  const blob = new Blob([item.markdown], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, toMarkdownFilename(item.name));
}

async function downloadAllAsZip() {
  const doneItems = state.files.filter((f) => f.status === "done");
  if (doneItems.length === 0 || typeof window.JSZip === "undefined") return;

  const zip = new window.JSZip();
  const usedNames = new Map();

  for (const item of doneItems) {
    let mdName = toMarkdownFilename(item.name);
    if (usedNames.has(mdName)) {
      const count = usedNames.get(mdName) + 1;
      usedNames.set(mdName, count);
      const base = mdName.slice(0, -3);
      mdName = `${base}_${count}.md`;
    } else {
      usedNames.set(mdName, 1);
    }
    zip.file(mdName, item.markdown);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, "markitdown-converted.zip");
}

let copyResetTimer = null;

async function copySelectedMarkdown() {
  const selected = state.files.find((f) => f.id === state.selectedId);
  if (!selected || selected.status !== "done") return;

  try {
    await navigator.clipboard.writeText(selected.markdown);
  } catch {
    // Fallback for restricted clipboard contexts
    el.rawEditor.select();
    document.execCommand("copy");
  }

  el.btnCopyLabel.textContent = "Copied!";
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    el.btnCopyLabel.textContent = "Copy Markdown";
  }, 1800);
}

/* ==========================================================================
   Settings Modal & Theme Toggle
   ========================================================================== */

function openSettingsModal() {
  const cfg = getLlmConfig();
  el.inputApiKey.value = cfg.apiKey;
  el.inputBaseUrl.value = cfg.baseUrl;
  el.inputModelName.value = cfg.model;
  el.settingsFeedback.textContent = "";
  el.settingsFeedback.classList.remove("is-error");
  el.settingsModal.hidden = false;
  el.inputApiKey.focus();
}

function closeSettingsModal() {
  el.settingsModal.hidden = true;
}

function saveSettings(event) {
  event.preventDefault();
  const apiKey = el.inputApiKey.value.trim();
  const baseUrl = el.inputBaseUrl.value.trim() || DEFAULT_LLM_SETTINGS.baseUrl;
  const model = el.inputModelName.value.trim() || DEFAULT_LLM_SETTINGS.model;

  if (apiKey) {
    localStorage.setItem(STORAGE_KEYS.apiKey, apiKey);
  } else {
    localStorage.removeItem(STORAGE_KEYS.apiKey);
  }
  localStorage.setItem(STORAGE_KEYS.baseUrl, baseUrl);
  localStorage.setItem(STORAGE_KEYS.model, model);

  updateLlmIndicator();

  if (state.worker && state.workerReady) {
    el.settingsFeedback.classList.remove("is-error");
    el.settingsFeedback.textContent = apiKey
      ? "Applying Vision LLM settings (installing client if needed)..."
      : "Disabling Vision LLM...";
    state.worker.postMessage({
      type: "configure_llm",
      llmConfig: { apiKey, baseUrl, model },
    });
  } else {
    el.settingsFeedback.classList.remove("is-error");
    el.settingsFeedback.textContent = "Settings saved locally. They will apply once runtime is ready.";
  }
}

function clearLlmSettings() {
  localStorage.removeItem(STORAGE_KEYS.apiKey);
  el.inputApiKey.value = "";
  el.inputBaseUrl.value = DEFAULT_LLM_SETTINGS.baseUrl;
  el.inputModelName.value = DEFAULT_LLM_SETTINGS.model;
  localStorage.setItem(STORAGE_KEYS.baseUrl, DEFAULT_LLM_SETTINGS.baseUrl);
  localStorage.setItem(STORAGE_KEYS.model, DEFAULT_LLM_SETTINGS.model);

  updateLlmIndicator();

  if (state.worker && state.workerReady) {
    state.worker.postMessage({
      type: "configure_llm",
      llmConfig: DEFAULT_LLM_SETTINGS,
    });
  } else {
    el.settingsFeedback.classList.remove("is-error");
    el.settingsFeedback.textContent = "API key cleared.";
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(STORAGE_KEYS.theme, next);
}

/* ==========================================================================
   Event Listeners & Boot
   ========================================================================== */

function bindEvents() {
  // Drag-and-drop & Browse
  el.dropzone.addEventListener("click", () => {
    if (!state.workerReady) return;
    el.fileInput.click();
  });

  el.dropzone.addEventListener("keydown", (e) => {
    if (!state.workerReady) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.fileInput.click();
    }
  });

  el.fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      enqueueFiles(e.target.files);
      el.fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((evtName) => {
    el.dropzone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.workerReady) {
        el.dropzone.classList.add("is-dragover");
      }
    });
  });

  ["dragleave", "drop"].forEach((evtName) => {
    el.dropzone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.dropzone.classList.remove("is-dragover");
    });
  });

  el.dropzone.addEventListener("drop", (e) => {
    if (!state.workerReady) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      enqueueFiles(e.dataTransfer.files);
    }
  });

  // Viewer Tabs & Editable Raw Markdown
  el.tabRaw.addEventListener("click", () => setActiveTab("raw"));
  el.tabPreview.addEventListener("click", () => setActiveTab("preview"));

  el.rawEditor.addEventListener("input", () => {
    const selected = state.files.find((f) => f.id === state.selectedId);
    if (!selected || selected.status !== "done") return;
    selected.markdown = el.rawEditor.value;
    el.viewerStats.textContent = computeStats(selected.markdown);
  });

  // Export & Queue Actions
  el.btnCopyMd.addEventListener("click", copySelectedMarkdown);
  el.btnDownloadMd.addEventListener("click", () => {
    const selected = state.files.find((f) => f.id === state.selectedId);
    if (selected && selected.status === "done") {
      downloadSingleMarkdown(selected);
    }
  });
  el.btnDownloadZip.addEventListener("click", downloadAllAsZip);
  el.btnClearQueue.addEventListener("click", clearQueue);

  // Header Controls
  el.btnThemeToggle.addEventListener("click", toggleTheme);
  el.btnResetRuntime.addEventListener("click", () => {
    // Re-queue any interrupted conversion so the user doesn't lose progress
    for (const item of state.files) {
      if (item.status === "converting") {
        item.status = "queued";
      }
    }
    renderQueue();
    renderViewer();
    startWorker();
  });

  // Settings Modal
  el.btnSettings.addEventListener("click", openSettingsModal);
  el.btnCloseSettings.addEventListener("click", closeSettingsModal);
  el.btnCancelSettings.addEventListener("click", closeSettingsModal);
  el.btnClearSettings.addEventListener("click", clearLlmSettings);
  el.settingsForm.addEventListener("submit", saveSettings);

  el.settingsModal.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) {
      closeSettingsModal();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.settingsModal.hidden) {
      closeSettingsModal();
    }
  });
}

// Initialize App
bindEvents();
updateLlmIndicator();
renderQueue();
renderViewer();
startWorker();
