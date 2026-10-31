(() => {
  // Portal presets and shared page elements.
  const presets = {
    etlab: { width: 150, height: 200, maxKB: 30, sizeLabel: "30 KB" },
    ssc: { width: 200, height: 230, maxKB: 50, sizeLabel: "50 KB" }
  };
  const presetSelect = document.getElementById("preset");
  const customFields = document.getElementById("custom-fields");
  const targetSummary = document.getElementById("target-summary");
  const fileInput = document.getElementById("file-input");
  const folderInput = document.getElementById("folder-input");
  const dropZone = document.getElementById("drop-zone");
  const folderButton = document.getElementById("folder-button");
  const batchList = document.getElementById("batch-list");
  const folderArchives = document.getElementById("folder-archives");
  const batchEmpty = document.getElementById("batch-empty");
  const fileCount = document.getElementById("file-count");
  const clearButton = document.getElementById("clear-button");
  const notice = document.getElementById("notice");
  const items = new Map();
  const folderBatches = new Map();
  const activeUploads = new Set();
  const maxUploadBytes = 60 * 1024 * 1024;
  let nextId = 0;
  let nextFolderId = 0;

  // Read the active preset or the user's custom compression settings.
  function getSettings() {
    if (presetSelect.value !== "custom") return presets[presetSelect.value];

    const sizeValue = Number(document.getElementById("custom-size").value);
    const sizeUnit = document.getElementById("custom-size-unit").value;
    return {
      width: document.getElementById("custom-width").value === ""
        ? null
        : Number(document.getElementById("custom-width").value),
      height: document.getElementById("custom-height").value === ""
        ? null
        : Number(document.getElementById("custom-height").value),
      maxKB: sizeValue * (sizeUnit === "MB" ? 1024 : 1),
      sizeLabel: `${sizeValue || "—"} ${sizeUnit}`
    };
  }

  function updateTarget() {
    const custom = presetSelect.value === "custom";
    customFields.classList.toggle("hidden", !custom);
    customFields.classList.toggle("grid", custom);
    const settings = getSettings();
    targetSummary.textContent = `${settings.width === null ? "Original" : settings.width} × ${settings.height === null ? "Original" : settings.height} px · ≤ ${settings.sizeLabel}`;
  }

  // Shared display helpers and batch state.
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function updateBatchState() {
    const count = items.size;
    fileCount.textContent = `${count} ${count === 1 ? "file" : "files"}`;
    batchEmpty.classList.toggle("hidden", count > 0);
    clearButton.classList.toggle("hidden", count === 0);
  }

  function createUploadState() {
    return {
      status: "idle",
      progress: 0,
      error: "",
      task: null,
      uploadUrl: null,
      retryTimer: null,
      retryNow: null,
      onUpdate: null
    };
  }

  function renderUploadAction(upload) {
    if (upload.status === "complete") {
      return `<span class="px-3 py-2 text-xs font-semibold text-forest">Uploaded ✓</span>`;
    }

    if (upload.status === "uploading" || upload.status === "retrying") {
      const label = upload.status === "retrying"
        ? `${navigator.onLine ? "Reconnecting" : "Waiting for internet"} · ${upload.progress}%`
        : `Uploading · ${upload.progress}%`;
      return `<span class="px-3 py-2 text-xs font-semibold text-muted" role="status">${label}</span>`;
    }

    if (upload.status === "error") {
      return `<span class="px-3 py-2 text-xs font-semibold text-red-700" role="status" title="${escapeHTML(upload.error)}">Upload failed</span>`;
    }

    return `<span class="px-3 py-2 text-xs font-semibold text-muted" role="status">Upload queued</span>`;
  }

  function startResumableUpload(file, uploadState, onUpdate) {
    if (uploadState.status === "uploading" || uploadState.status === "retrying") return;

    const endpoint = window.EZUP_TUS_ENDPOINT;
    if (!window.tus || typeof window.tus.Upload !== "function") {
      uploadState.status = "error";
      uploadState.error = "The resumable upload library did not load. Check your connection and refresh.";
      onUpdate();
      return;
    }
    if (!endpoint || endpoint.includes("YOUR-FLY-SERVICE")) {
      uploadState.status = "error";
      uploadState.error = "Set the tus server URL in upload-config.js.";
      onUpdate();
      return;
    }
    if (file.size > maxUploadBytes) {
      uploadState.status = "error";
      uploadState.error = "The compressed image exceeds the 60 MiB upload limit.";
      onUpdate();
      return;
    }

    uploadState.status = "uploading";
    uploadState.error = "";
    if (!uploadState.uploadUrl) uploadState.progress = 0;
    uploadState.retryNow = null;
    uploadState.onUpdate = onUpdate;
    activeUploads.add(uploadState);
    onUpdate();

    function startAttempt() {
      uploadState.retryTimer = null;
      uploadState.status = navigator.onLine ? "uploading" : "retrying";
      onUpdate();
      const upload = new window.tus.Upload(file, {
        endpoint,
        uploadUrl: uploadState.uploadUrl,
        chunkSize: 5 * 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        metadata: {
          filename: file.name,
          filetype: file.type || "application/octet-stream"
        },
        onChunkComplete(_chunkSize, bytesAccepted, bytesTotal) {
          uploadState.progress = bytesTotal
            ? Math.floor((bytesAccepted / bytesTotal) * 100)
            : 0;
          uploadState.status = navigator.onLine ? "uploading" : "retrying";
          onUpdate();
        },
        onUploadUrlAvailable() {
          if (uploadState.task === upload) {
            uploadState.uploadUrl = upload.url;
          }
        },
        onError(error) {
          const status = error.originalResponse?.getStatus?.();
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
            uploadState.status = "error";
            uploadState.error = error.message || `Upload rejected (${status}).`;
            uploadState.task = null;
            uploadState.retryNow = null;
            activeUploads.delete(uploadState);
            onUpdate();
            return;
          }

          uploadState.status = "retrying";
          uploadState.error = "";
          uploadState.task = null;
          uploadState.retryNow = startAttempt;
          onUpdate();
          uploadState.retryTimer = window.setTimeout(startAttempt, 5000);
        },
        onSuccess() {
          uploadState.status = "complete";
          uploadState.progress = 100;
          uploadState.error = "";
          uploadState.task = null;
          uploadState.uploadUrl = null;
          uploadState.retryNow = null;
          activeUploads.delete(uploadState);
          onUpdate();
        }
      });

      uploadState.task = upload;
      const start = () => {
        if (uploadState.task === upload) upload.start();
      };

      if (uploadState.uploadUrl) {
        start();
        return;
      }

      upload.findPreviousUploads().then(previousUploads => {
        if (uploadState.task !== upload) return;
        const latestUpload = previousUploads
          .slice()
          .sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime))[0];
        if (latestUpload) {
          upload.resumeFromPreviousUpload(latestUpload);
          uploadState.uploadUrl = latestUpload.uploadUrl;
        }
        start();
      }).catch(error => {
        if (uploadState.task !== upload) return;
        uploadState.status = "error";
        uploadState.error = error instanceof Error ? error.message : "Could not resume this upload.";
        uploadState.task = null;
        uploadState.retryNow = null;
        activeUploads.delete(uploadState);
        onUpdate();
      });
    }

    uploadState.retryNow = startAttempt;
    startAttempt();
  }

  function stopUpload(uploadState) {
    activeUploads.delete(uploadState);
    uploadState.retryNow = null;
    uploadState.onUpdate = null;
    if (uploadState.retryTimer !== null) {
      window.clearTimeout(uploadState.retryTimer);
      uploadState.retryTimer = null;
    }
    if (uploadState.task) {
      uploadState.task.abort();
      uploadState.task = null;
    }
  }

  window.addEventListener("offline", () => {
    activeUploads.forEach(uploadState => {
      if (uploadState.status !== "uploading") return;
      uploadState.status = "retrying";
      uploadState.onUpdate?.();
    });
  });

  window.addEventListener("online", () => {
    activeUploads.forEach(uploadState => {
      if (
        uploadState.status !== "retrying" ||
        uploadState.task ||
        !uploadState.retryNow
      ) {
        return;
      }
      if (uploadState.retryTimer !== null) {
        window.clearTimeout(uploadState.retryTimer);
        uploadState.retryTimer = null;
      }
      uploadState.retryNow();
    });
  });

  // Render the status, output size, and download action for an image.
  function renderItem(item) {
    const statusContent = item.status === "processing"
      ? `
        <span class="flex items-center gap-2 text-clay">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-clay"></span>
          Compressing
        </span>
        <span class="mt-2 block h-1 w-24 overflow-hidden rounded-full bg-ink/10">
          <span class="progress-fill block h-full rounded-full bg-clay" style="width:${item.progress}%"></span>
        </span>`
      : item.status === "done"
        ? `
          <span class="flex items-center gap-1.5 font-semibold ${item.withinLimit ? "text-forest" : "text-clay"}">
            <span>${item.withinLimit ? "✓" : "!"}</span>
            ${item.withinLimit ? "Ready" : "Over size target"}
          </span>`
        : `
          <span class="font-semibold text-red-700" title="${escapeHTML(item.error || "Compression failed")}">
            Could not compress
          </span>`;
    const output = item.status === "done"
      ? `
        <span class="mono font-medium text-ink">
          ${formatBytes(item.output.size)}
          ${item.withinLimit ? "" : `<span class="ml-1 text-clay">(over ${escapeHTML(item.maxSizeLabel)})</span>`}
        </span>`
      : item.status === "error"
        ? `<span class="text-xs text-red-700">${escapeHTML(item.error || "Try another image.")}</span>`
        : `<span class="text-muted">—</span>`;
    const download = item.status === "done" && item.upload.status === "complete"
      ? `
        <a
          href="${item.url}"
          download="${escapeHTML(item.output.name)}"
          class="inline-flex items-center gap-2 rounded-lg bg-forest px-3 py-2 text-xs font-bold text-white transition hover:bg-ink focus:outline-none focus:ring-2 focus:ring-forest/40"
          aria-label="Download ${escapeHTML(item.output.name)}"
        >
          Download <span aria-hidden="true">↓</span>
        </a>`
      : `
        <button
          type="button"
          disabled
          class="inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-ink/5 px-3 py-2 text-xs font-bold text-muted opacity-70"
          aria-label="Download available after upload completes"
          title="Download available after upload completes"
        >
          Download <span aria-hidden="true">↓</span>
        </button>`;
    const uploadAction = item.status === "done"
      ? renderUploadAction(item.upload)
      : "";

    const row = document.getElementById(`item-${item.id}`);
    row.innerHTML = `
      <div class="flex min-w-0 items-center gap-3 sm:gap-4">
        <div class="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-paper text-forest">
          ${item.preview
            ? `<img src="${item.preview}" alt="" class="h-full w-full object-cover">`
            : `
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="1.6"/>
                <circle cx="9" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/>
                <path d="m5 17 4-4 3 3 3-4 4 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>`}
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-bold" title="${escapeHTML(item.file.name)}">${escapeHTML(item.file.name)}</p>
          <p class="mt-1 text-xs text-muted">
            Original · <span class="mono">${formatBytes(item.file.size)}</span>
          </p>
        </div>
      </div>
      <div class="grid grid-cols-2 items-center gap-x-3 gap-y-2 sm:contents">
        <div class="text-xs sm:px-2">
          <span class="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted sm:hidden">Status</span>
          ${statusContent}
        </div>
        <div class="text-xs sm:px-2">
          <span class="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted sm:hidden">Compressed</span>
          ${output}
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        ${download}
        ${uploadAction}
      </div>`;
  }

  // Escape file names and errors before adding them to the page.
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  // Create image rows and folder archive cards.
  function makeItem(file) {
    const id = ++nextId;
    const item = {
      id,
      file,
      status: "processing",
      progress: 0,
      output: null,
      url: null,
      preview: null,
      withinLimit: false,
      error: "",
      maxKB: 0,
      maxSizeLabel: "",
      upload: createUploadState()
    };
    items.set(id, item);
    const row = document.createElement("article");
    row.id = `item-${id}`;
    row.className = "file-row grid gap-3 border-b border-ink/10 bg-white py-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(100px,.7fr)_minmax(120px,.8fr)_auto] sm:items-center sm:gap-4";
    batchList.prepend(row);
    updateBatchState();
    renderItem(item);
    return item;
  }

  function makeFolderBatch(folderName, files) {
    const id = ++nextFolderId;
    const batch = {
      id,
      folderName,
      items: [],
      paths: new Map(),
      archiveURL: null,
      archiveFile: null,
      status: "processing"
    };
    files.forEach(({ file, path }) => {
      const item = makeItem(file);
      item.folderBatchId = id;
      batch.items.push(item);
      batch.paths.set(item.id, path);
    });
    folderBatches.set(id, batch);
    renderFolderBatch(batch);
    return batch;
  }

  function renderFolderBatch(batch) {
    let card = document.getElementById(`folder-archive-${batch.id}`);
    if (!card) {
      card = document.createElement("article");
      card.id = `folder-archive-${batch.id}`;
      card.className = "flex flex-col gap-3 border border-forest/20 bg-sky-50 p-4 sm:flex-row sm:items-center sm:justify-between";
      folderArchives.prepend(card);
    }
    const readyCount = batch.items.filter(item => item.status === "done").length;
    const failedCount = batch.items.filter(item => item.status === "error").length;
    const finished = readyCount + failedCount === batch.items.length;
    const status = batch.status === "zipping"
      ? "Building ZIP…"
      : batch.status === "ready"
        ? `${readyCount} compressed ${readyCount === 1 ? "image" : "images"} in ZIP`
        : finished
          ? `${readyCount} of ${batch.items.length} images compressed${failedCount ? ` · ${failedCount} failed` : ""}`
          : `${readyCount} of ${batch.items.length} images compressed`;
    const action = batch.status === "ready"
      ? `
        <div class="flex flex-wrap items-center gap-2">
          <a href="${batch.archiveURL}" download="${escapeHTML(batch.folderName)}.zip" class="inline-flex shrink-0 items-center justify-center gap-2 rounded-sm bg-forest px-4 py-2.5 text-xs font-bold text-white transition hover:bg-sky-900 focus:outline-none focus:ring-2 focus:ring-forest/40">Download ZIP <span aria-hidden="true">↓</span></a>
          <span class="text-xs text-muted">ZIP uploads are not accepted by the server.</span>
        </div>`
      : `<span class="shrink-0 border border-ink/10 bg-white px-4 py-2.5 text-xs font-bold ${batch.status === "error" ? "text-red-700" : "text-muted"}">${batch.status === "zipping" ? "Preparing…" : batch.status === "error" ? "ZIP unavailable" : "ZIP pending"}</span>`;
    card.innerHTML = `
      <div class="flex min-w-0 items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-forest">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 7.5h15v12h-15zM3.5 4.5h17v3h-17zM10 11h4m-2-3.5V19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <div class="min-w-0"><p class="truncate text-sm font-bold">${escapeHTML(batch.folderName)}.zip</p><p class="mt-1 text-xs text-muted">${escapeHTML(status)}</p></div>
      </div>
      ${action}`;
  }

  // Package a completed folder batch into a downloadable ZIP archive.
  async function buildFolderArchive(batch) {
    const succeeded = batch.items.filter(item => item.status === "done");
    if (batch.items.some(item => item.status === "processing")) return;
    if (!succeeded.length) {
      batch.status = "error";
      renderFolderBatch(batch);
      return;
    }
    if (!window.JSZip) {
      batch.status = "error";
      notice.textContent = "The ZIP library did not load. Check your connection and refresh.";
      renderFolderBatch(batch);
      return;
    }
    batch.status = "zipping";
    renderFolderBatch(batch);
    try {
      const zip = new window.JSZip();
      const usedPaths = new Set();
      succeeded.forEach(item => {
        const relativePath = batch.paths.get(item.id) || item.file.name;
        const safePath = relativePath.replace(/\\/g, "/").split("/").filter(part => part && part !== "." && part !== "..");
        const filename = (safePath.pop() || item.file.name).replace(/\.[^.]+$/, "");
        const directory = safePath.join("/");
        const basePath = directory ? `${directory}/${filename}` : filename;
        let zipPath = `${basePath}.jpg`;
        let duplicate = 2;
        while (usedPaths.has(zipPath.toLowerCase())) {
          zipPath = `${basePath} (${duplicate++}).jpg`;
        }
        usedPaths.add(zipPath.toLowerCase());
        zip.file(zipPath || item.output.name, item.output);
      });
      const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      batch.archiveFile = new File([archive], `${batch.folderName}.zip`, { type: "application/zip" });
      batch.archiveURL = URL.createObjectURL(batch.archiveFile);
      batch.status = "ready";
    } catch (error) {
      batch.status = "error";
      notice.textContent = `Could not create ZIP for ${batch.folderName}: ${error instanceof Error ? error.message : "unknown error"}`;
    }
    renderFolderBatch(batch);
  }

  // Resize to the requested bounds, then compress the JPEG in-browser.
  function fitImageToBounds(file, maxWidth, maxHeight) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const sourceURL = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(sourceURL);
        const widthBound = maxWidth || image.naturalWidth;
        const heightBound = maxHeight || image.naturalHeight;
        const scale = Math.min(1, widthBound / image.naturalWidth, heightBound / image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("This browser could not prepare the image."));
          return;
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob(blob => {
          canvas.width = 0;
          canvas.height = 0;
          if (!blob) {
            reject(new Error("The browser could not convert this image."));
            return;
          }
          resolve({
            file: new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: Date.now() }),
            maxWidthOrHeight: Math.max(width, height)
          });
        }, "image/jpeg", 0.94);
      };
      image.onerror = () => {
        URL.revokeObjectURL(sourceURL);
        reject(new Error("This image could not be opened."));
      };
      image.src = sourceURL;
    });
  }

  async function compressItem(item, settings) {
    try {
      if ((settings.width !== null && (!Number.isInteger(settings.width) || settings.width < 1)) ||
          (settings.height !== null && (!Number.isInteger(settings.height) || settings.height < 1))) {
        throw new Error("Enter valid image dimensions.");
      }
      if (!Number.isFinite(settings.maxKB) || settings.maxKB <= 0) {
        throw new Error("Enter valid dimensions and a size limit greater than zero.");
      }
      if (settings.maxKB > maxUploadBytes / 1024) {
        throw new Error("The maximum compressed size is 60 MiB (60 MB).");
      }
      if (!window.imageCompression) {
        throw new Error("The compression library did not load. Check your connection and refresh.");
      }
      const resized = await fitImageToBounds(item.file, settings.width, settings.height);
      const compressed = await window.imageCompression(resized.file, {
        maxSizeMB: settings.maxKB / 1024,
        maxWidthOrHeight: resized.maxWidthOrHeight,
        useWebWorker: true,
        maxIteration: 15,
        initialQuality: 0.9,
        fileType: "image/jpeg",
        onProgress: progress => {
          if (!items.has(item.id)) return;
          item.progress = Math.max(5, Math.min(95, Math.round(progress)));
          renderItem(item);
        }
      });
      if (!items.has(item.id)) return;
      item.output = new File([compressed], resized.file.name, { type: compressed.type || "image/jpeg", lastModified: Date.now() });
      item.url = URL.createObjectURL(item.output);
      item.status = "done";
      item.progress = 100;
      item.maxKB = settings.maxKB;
      item.maxSizeLabel = settings.sizeLabel;
      item.withinLimit = item.output.size <= settings.maxKB * 1024;
    } catch (error) {
      if (!items.has(item.id)) return;
      item.status = "error";
      item.error = error instanceof Error ? error.message : "Unexpected compression error.";
      notice.textContent = `${item.file.name}: ${item.error}`;
    }
    if (items.has(item.id)) {
      renderItem(item);
      if (item.status === "done") {
        startResumableUpload(item.output, item.upload, () => renderItem(item));
      }
      if (item.folderBatchId) {
        const batch = folderBatches.get(item.folderBatchId);
        if (batch) {
          renderFolderBatch(batch);
          buildFolderArchive(batch);
        }
      }
    }
  }

  // Accept individual files and recursively read dropped folders.
  function acceptFiles(fileList, folderName = null) {
    const files = Array.from(fileList, file => ({
      file,
      path: file.webkitRelativePath || file._ezUpRelativePath || file.name
    }));
    notice.textContent = "";
    const imageExtensions = /\.(jpe?g|png|webp)$/i;
    const imageFiles = files.filter(({ file }) => imageExtensions.test(file.name));
    const rejected = files.length - imageFiles.length;
    if (rejected) notice.textContent = `${rejected} non-image ${rejected === 1 ? "file was" : "files were"} skipped.`;
    if (!imageFiles.length && files.length) {
      notice.textContent = "Please choose image files (JPG, PNG, or WEBP).";
      return;
    }
    const settings = getSettings();
    if (folderName && imageFiles.length) {
      const batch = makeFolderBatch(folderName, imageFiles);
      batch.items.forEach(item => compressItem(item, settings));
    } else {
      imageFiles.forEach(({ file }) => compressItem(makeItem(file), settings));
    }
    fileInput.value = "";
    folderInput.value = "";
  }

  function readDirectory(entry) {
    return new Promise((resolve, reject) => {
      const reader = entry.createReader();
      const files = [];
      function readNextBatch() {
        reader.readEntries(entries => {
          if (!entries.length) {
            resolve(files);
            return;
          }
          Promise.all(entries.map(readEntry)).then(batch => {
            batch.forEach(group => files.push(...group));
            readNextBatch();
          }, reject);
        }, reject);
      }
      readNextBatch();
    });
  }

  function readEntry(entry) {
    if (entry.isFile) {
      return new Promise((resolve, reject) => {
        entry.file(file => {
          file._ezUpRelativePath = entry.fullPath.replace(/^\/+/, "");
          resolve([file]);
        }, reject);
      });
    }
    if (entry.isDirectory) return readDirectory(entry);
    return Promise.resolve([]);
  }

  async function acceptDrop(dataTransfer) {
    const droppedItems = Array.from(dataTransfer.items || []).map(item => ({
      entry: typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null,
      file: typeof item.getAsFile === "function" ? item.getAsFile() : null
    })).filter(item => item.entry || item.file);
    if (!droppedItems.some(item => item.entry)) {
      acceptFiles(dataTransfer.files);
      return;
    }
    try {
      const groups = await Promise.all(droppedItems.map(item =>
        item.entry ? readEntry(item.entry) : Promise.resolve([item.file])
      ));
      const files = groups.flat();
      const directoryEntries = droppedItems.filter(item => item.entry && item.entry.isDirectory);
      const folderName = directoryEntries.length
        ? (directoryEntries.length === 1 ? directoryEntries[0].entry.name : "dropped-folders")
        : null;
      acceptFiles(files, folderName);
    } catch (error) {
      notice.textContent = `Could not read the dropped folder: ${error instanceof Error ? error.message : "unknown error"}`;
    }
  }

  // Connect page controls to file selection, drag-and-drop, and cleanup.
  presetSelect.addEventListener("change", updateTarget);
  ["custom-width", "custom-height", "custom-size", "custom-size-unit"].forEach(id => {
    document.getElementById(id).addEventListener("input", updateTarget);
  });
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", event => acceptFiles(event.target.files));
  folderButton.addEventListener("click", () => folderInput.click());
  folderInput.addEventListener("change", event => {
    const firstPath = event.target.files[0]?.webkitRelativePath || "";
    const folderName = firstPath.split("/")[0] || "compressed-images";
    acceptFiles(event.target.files, folderName);
  });
  ["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.add("drop-active");
  }));
  ["dragleave", "drop"].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("drop-active");
  }));
  dropZone.addEventListener("drop", event => acceptDrop(event.dataTransfer));
  clearButton.addEventListener("click", () => {
    items.forEach(item => {
      stopUpload(item.upload);
      if (item.url) URL.revokeObjectURL(item.url);
      if (item.preview) URL.revokeObjectURL(item.preview);
      const row = document.getElementById(`item-${item.id}`);
      if (row) row.remove();
    });
    folderBatches.forEach(batch => {
      if (batch.archiveURL) URL.revokeObjectURL(batch.archiveURL);
      const card = document.getElementById(`folder-archive-${batch.id}`);
      if (card) card.remove();
    });
    items.clear();
    folderBatches.clear();
    notice.textContent = "";
    updateBatchState();
  });
  updateTarget();
})();
