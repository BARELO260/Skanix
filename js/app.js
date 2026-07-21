/**
 * app.js — Wires together camera, cropping, editing, export and the
 * on-device history into a small view-router style single-page app.
 * No framework: views are plain <section> elements toggled by class,
 * state lives in a few module-level objects below.
 */
(() => {
  "use strict";

  /* ---------------------------------------------------------------
   * Small DOM helpers
   * --------------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg, type = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (type ? ` toast-${type}` : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function confirmDialog(message) {
    return new Promise((resolve) => {
      const backdrop = $("#confirmDialog");
      $("#confirmMessage").textContent = message;
      backdrop.classList.remove("hidden");
      const cleanup = (result) => {
        backdrop.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      };
      const okBtn = $("#confirmOk");
      const cancelBtn = $("#confirmCancel");
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function canvasFromImage(img) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c;
  }

  function cloneCanvas(src) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  /* ---------------------------------------------------------------
   * View router
   * --------------------------------------------------------------- */
  const Router = {
    show(viewId) {
      $$(".view").forEach((v) => v.classList.remove("view-active"));
      $(`#${viewId}`).classList.add("view-active");
      $$(".nav-btn[data-nav]").forEach((b) =>
        b.classList.toggle("nav-active", b.dataset.nav === viewId)
      );
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
      if (viewId !== "view-camera") CameraController.stop();
    },
  };

  /* ---------------------------------------------------------------
   * App-wide state
   * --------------------------------------------------------------- */
  const State = {
    uploadQueue: [],      // pending source images (HTMLImageElement) awaiting crop
    currentPages: [],     // pages of the document being built
    activePage: null,     // page currently in the crop/edit pipeline
    editingExistingIndex: null, // index into currentPages when re-editing
  };

  function newPage(baseCanvas) {
    return {
      id: uid(),
      base: baseCanvas,      // perspective-corrected canvas, rotation 0, no filter
      rotation: 0,
      filter: "document",
      brightness: 0,
      contrast: 0,
      saturation: 0,
    };
  }

  // Renders a page's base canvas through rotation + filter + adjustments.
  function renderPage(page, maxDim = 1600) {
    let src = page.base;
    // rotation
    if (page.rotation % 360 !== 0) {
      const rad = (page.rotation * Math.PI) / 180;
      const swap = page.rotation % 180 !== 0;
      const w = swap ? src.height : src.width;
      const h = swap ? src.width : src.height;
      const rc = document.createElement("canvas");
      rc.width = w; rc.height = h;
      const rctx = rc.getContext("2d");
      rctx.translate(w / 2, h / 2);
      rctx.rotate(rad);
      rctx.drawImage(src, -src.width / 2, -src.height / 2);
      src = rc;
    }
    // downscale for performance if huge
    let scale = 1;
    if (Math.max(src.width, src.height) > maxDim) {
      scale = maxDim / Math.max(src.width, src.height);
    }
    const out = document.createElement("canvas");
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0, out.width, out.height);

    const imgData = octx.getImageData(0, 0, out.width, out.height);
    ImageProcessing.applyFilter(imgData, page.filter);
    ImageProcessing.applyAdjustments(imgData, {
      brightness: page.brightness,
      contrast: page.contrast,
      saturation: page.saturation,
    });
    octx.putImageData(imgData, 0, 0);
    return out;
  }

  function pageThumb(page, maxDim = 500) {
    return renderPage(page, maxDim).toDataURL("image/jpeg", 0.82);
  }

  /* ---------------------------------------------------------------
   * HOME VIEW — capture entry points + history
   * --------------------------------------------------------------- */
  function updatePendingBar() {
    const bar = $("#pendingBar");
    if (State.currentPages.length > 0) {
      bar.classList.remove("hidden");
      $("#pendingCount").textContent = State.currentPages.length;
    } else {
      bar.classList.add("hidden");
    }
  }

  async function renderHistory() {
    const grid = $("#historyGrid");
    const docs = await DocuDB.getAll();
    if (docs.length === 0) {
      grid.innerHTML = `<p class="empty-hint">Aún no has escaneado ningún documento. Tus escaneos aparecerán aquí, guardados en este dispositivo.</p>`;
      return;
    }
    grid.innerHTML = "";
    for (const doc of docs) {
      const card = document.createElement("div");
      card.className = "history-card";
      const date = new Date(doc.createdAt);
      card.innerHTML = `
        <span class="hc-pages">${doc.pages.length} pág.</span>
        <img src="${doc.pages[0]}" alt="${doc.name}" loading="lazy" />
        <div class="hc-meta">
          <div class="hc-name">${escapeHtml(doc.name)}</div>
          <div class="hc-sub">${date.toLocaleDateString()}</div>
        </div>`;
      card.addEventListener("click", () => openViewer(doc.id));
      grid.appendChild(card);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  $("#openCameraBtn").addEventListener("click", startCameraFlow);
  $("#openUploadBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    for (const file of files) {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        State.uploadQueue.push(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    processNextInQueue();
  });
  $("#pendingReviewBtn").addEventListener("click", () => openReview());
  $("#clearHistoryBtn").addEventListener("click", async () => {
    if (!(await confirmDialog("¿Vaciar todo el historial de documentos guardados? Esta acción no se puede deshacer."))) return;
    await DocuDB.clear();
    renderHistory();
    toast("Historial eliminado");
  });

  /* ---------------------------------------------------------------
   * CAMERA VIEW
   * --------------------------------------------------------------- */
  async function startCameraFlow() {
    Router.show("view-camera");
    try {
      await CameraController.start($("#cameraVideo"));
    } catch (err) {
      toast("No se pudo acceder a la cámara. Revisa los permisos.", "error");
      Router.show("view-home");
    }
  }

  $("#cameraBackBtn").addEventListener("click", () => {
    CameraController.stop();
    Router.show("view-home");
  });
  $("#cameraSwitchBtn").addEventListener("click", () => CameraController.switchCamera());
  $("#shutterBtn").addEventListener("click", async () => {
    if (!CameraController.isActive()) return;
    SoundFX.shutter();
    const flash = $("#flashOverlay");
    flash.classList.remove("flashing"); void flash.offsetWidth; flash.classList.add("flashing");

    const canvas = $("#captureCanvas");
    CameraController.captureFrame(canvas);
    const img = await loadImage(canvas.toDataURL("image/jpeg", 0.95));
    State.uploadQueue.push(img);
    // keep camera open for rapid multi-page capture; queue processes in background
    processNextInQueue();
  });

  /* ---------------------------------------------------------------
   * QUEUE -> CROP VIEW
   * --------------------------------------------------------------- */
  let queueBusy = false;
  async function processNextInQueue() {
    if (queueBusy) return;
    const img = State.uploadQueue.shift();
    if (!img) return;
    queueBusy = true;
    CameraController.stop();
    await openCropView(canvasFromImage(img));
  }

  /* ----- Crop editor ----- */
  const Crop = {
    canvas: null, ctx: null,
    sourceCanvas: null,
    corners: null,        // image-space {x,y} x4 (TL,TR,BR,BL)
    scale: 1,
    dragIndex: -1,
    dpr: Math.max(1, window.devicePixelRatio || 1),
  };

  async function openCropView(sourceCanvas) {
    Crop.sourceCanvas = sourceCanvas;
    Router.show("view-crop");
    Crop.canvas = $("#cropCanvas");
    Crop.ctx = Crop.canvas.getContext("2d");

    const stage = document.querySelector(".crop-stage");
    const cssW = stage.clientWidth;
    const cssH = Math.min(window.innerHeight * 0.55, cssW * (sourceCanvas.height / sourceCanvas.width));
    const scale = cssW / sourceCanvas.width;
    Crop.scale = scale;
    Crop.canvas.style.width = cssW + "px";
    Crop.canvas.style.height = Math.round(sourceCanvas.height * scale) + "px";
    Crop.canvas.width = Math.round(cssW * Crop.dpr);
    Crop.canvas.height = Math.round(sourceCanvas.height * scale * Crop.dpr);

    Crop.corners = ImageProcessing.detectDocumentCorners(sourceCanvas);
    drawCrop();
  }

  function drawCrop() {
    const { ctx, canvas, sourceCanvas, corners, scale, dpr } = Crop;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);

    // dim outside the quad
    ctx.save();
    ctx.fillStyle = "rgba(5,7,14,0.45)";
    ctx.beginPath();
    ctx.rect(0, 0, sourceCanvas.width, sourceCanvas.height);
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.fill("evenodd");
    ctx.restore();

    // quad outline
    ctx.lineWidth = 2.5 / scale;
    ctx.strokeStyle = "#22D3EE";
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();

    // handles
    const r = 9 / scale;
    corners.forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(168,85,247,0.9)";
      ctx.fill();
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    });
  }

  function canvasPointFromEvent(e) {
    const rect = Crop.canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const xCss = clientX - rect.left;
    const yCss = clientY - rect.top;
    return { x: xCss / Crop.scale, y: yCss / Crop.scale };
  }

  function setupCropInteraction() {
    const canvas = $("#cropCanvas");
    const HIT_R = 26;

    function down(e) {
      if (!Crop.corners) return;
      const p = canvasPointFromEvent(e);
      let best = -1, bestD = Infinity;
      Crop.corners.forEach((c, i) => {
        const d = Math.hypot((c.x - p.x) * Crop.scale, (c.y - p.y) * Crop.scale);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (bestD <= HIT_R) {
        Crop.dragIndex = best;
        e.preventDefault();
      }
    }
    function move(e) {
      if (Crop.dragIndex === -1) return;
      e.preventDefault();
      const p = canvasPointFromEvent(e);
      const sc = Crop.sourceCanvas;
      p.x = Math.max(0, Math.min(sc.width, p.x));
      p.y = Math.max(0, Math.min(sc.height, p.y));
      Crop.corners[Crop.dragIndex] = p;
      drawCrop();
    }
    function up() { Crop.dragIndex = -1; }

    canvas.addEventListener("mousedown", down);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", up);
  }
  setupCropInteraction();

  $("#cropAutoBtn").addEventListener("click", () => {
    Crop.corners = ImageProcessing.detectDocumentCorners(Crop.sourceCanvas);
    drawCrop();
    toast("Bordes detectados automáticamente");
  });
  $("#cropResetBtn").addEventListener("click", () => {
    const sc = Crop.sourceCanvas;
    const mx = sc.width * 0.04, my = sc.height * 0.04;
    Crop.corners = [
      { x: mx, y: my }, { x: sc.width - mx, y: my },
      { x: sc.width - mx, y: sc.height - my }, { x: mx, y: sc.height - my },
    ];
    drawCrop();
  });
  $("#cropBackBtn").addEventListener("click", () => {
    queueBusy = false;
    if (State.currentPages.length > 0) openReview();
    else Router.show("view-home");
  });
  $("#cropConfirmBtn").addEventListener("click", async () => {
    const warped = ImageProcessing.warpPerspective(Crop.sourceCanvas, Crop.corners);
    if (State.editingExistingIndex !== null) {
      const p = State.currentPages[State.editingExistingIndex];
      p.base = warped; p.rotation = 0;
      State.activePage = p;
    } else {
      State.activePage = newPage(warped);
    }
    openEditView();
  });

  /* ---------------------------------------------------------------
   * EDIT VIEW (filters / adjustments / transform)
   * --------------------------------------------------------------- */
  let editRenderToken = 0;
  function openEditView() {
    Router.show("view-edit");
    const p = State.activePage;
    $$(".filter-chip").forEach((b) => b.classList.toggle("active", b.dataset.filter === p.filter));
    $("#rangeBrightness").value = p.brightness; $("#outBrightness").textContent = p.brightness;
    $("#rangeContrast").value = p.contrast; $("#outContrast").textContent = p.contrast;
    $("#rangeSaturation").value = p.saturation; $("#outSaturation").textContent = p.saturation;
    renderEditCanvas();
  }

  async function renderEditCanvas() {
    const token = ++editRenderToken;
    $("#editLoader").classList.remove("hidden");
    await new Promise((r) => requestAnimationFrame(r)); // let loader paint
    const p = State.activePage;
    const out = renderPage(p, 1400);
    if (token !== editRenderToken) return; // superseded by a newer render
    const canvas = $("#editCanvas");
    canvas.width = out.width; canvas.height = out.height;
    canvas.getContext("2d").drawImage(out, 0, 0);
    $("#editLoader").classList.add("hidden");
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  const debouncedRender = debounce(renderEditCanvas, 120);

  $$(".edit-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".edit-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      $$(".edit-panel").forEach((p) => p.classList.add("hidden"));
      $(`#panel-${tab.dataset.tab}`).classList.remove("hidden");
    });
  });

  $("#filterStrip").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;
    $$(".filter-chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    State.activePage.filter = btn.dataset.filter;
    debouncedRender();
  });

  function bindSlider(rangeId, outId, prop) {
    const range = $(rangeId), out = $(outId);
    range.addEventListener("input", () => {
      out.textContent = range.value;
      State.activePage[prop] = Number(range.value);
      debouncedRender();
    });
  }
  bindSlider("#rangeBrightness", "#outBrightness", "brightness");
  bindSlider("#rangeContrast", "#outContrast", "contrast");
  bindSlider("#rangeSaturation", "#outSaturation", "saturation");
  $("#resetAdjustBtn").addEventListener("click", () => {
    State.activePage.brightness = 0; State.activePage.contrast = 0; State.activePage.saturation = 0;
    $("#rangeBrightness").value = 0; $("#outBrightness").textContent = "0";
    $("#rangeContrast").value = 0; $("#outContrast").textContent = "0";
    $("#rangeSaturation").value = 0; $("#outSaturation").textContent = "0";
    renderEditCanvas();
  });

  $("#rotateLeftBtn").addEventListener("click", () => {
    State.activePage.rotation = (State.activePage.rotation + 270) % 360;
    renderEditCanvas();
  });
  $("#rotateRightBtn").addEventListener("click", () => {
    State.activePage.rotation = (State.activePage.rotation + 90) % 360;
    renderEditCanvas();
  });
  $("#backToCropBtn").addEventListener("click", async () => {
    await openCropView(State.activePage.base);
  });

  $("#editBackBtn").addEventListener("click", async () => {
    await openCropView(Crop.sourceCanvas || State.activePage.base);
  });

  $("#addPageBtn").addEventListener("click", () => {
    if (State.editingExistingIndex !== null) {
      State.currentPages[State.editingExistingIndex] = State.activePage;
      State.editingExistingIndex = null;
    } else {
      State.currentPages.push(State.activePage);
    }
    State.activePage = null;
    queueBusy = false;
    updatePendingBar();
    if (State.uploadQueue.length > 0) {
      processNextInQueue();
    } else {
      openReview();
    }
    toast("Página añadida ✓", "success");
  });

  /* ---------------------------------------------------------------
   * REVIEW / EXPORT VIEW
   * --------------------------------------------------------------- */
  function openReview() {
    Router.show("view-review");
    renderReviewGrid();
  }

  function renderReviewGrid() {
    const grid = $("#reviewGrid");
    grid.innerHTML = "";
    $("#reviewCount").textContent = `${State.currentPages.length} página${State.currentPages.length === 1 ? "" : "s"}`;
    State.currentPages.forEach((page, i) => {
      const card = document.createElement("div");
      card.className = "review-card";
      card.draggable = true;
      card.dataset.index = i;
      card.innerHTML = `
        <span class="rc-num">${i + 1}</span>
        <img src="${pageThumb(page, 360)}" alt="Página ${i + 1}" />
        <button class="rc-remove" aria-label="Eliminar página">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M18 6 6 18M6 6l12 12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>`;
      card.querySelector(".rc-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        State.currentPages.splice(i, 1);
        renderReviewGrid();
        updatePendingBar();
      });
      card.addEventListener("click", (e) => {
        if (e.target.closest(".rc-remove")) return;
        State.editingExistingIndex = i;
        State.activePage = State.currentPages[i];
        Crop.sourceCanvas = State.activePage.base;
        openEditView();
      });
      // simple drag-reorder
      card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", i));
      card.addEventListener("dragover", (e) => e.preventDefault());
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        const to = i;
        const [moved] = State.currentPages.splice(from, 1);
        State.currentPages.splice(to, 0, moved);
        renderReviewGrid();
      });
      grid.appendChild(card);
    });
  }

  $("#addMorePagesBtn").addEventListener("click", () => {
    State.editingExistingIndex = null;
    startCameraFlow();
  });

  $("#rangeQuality").addEventListener("input", (e) => {
    $("#outQuality").textContent = `${e.target.value}%`;
  });

  async function buildExportBlobs() {
    const format = document.querySelector('input[name="format"]:checked').value;
    const quality = Number($("#rangeQuality").value) / 100;
    const name = ($("#fileNameInput").value || "Documento").trim() || "Documento";
    const pages = State.currentPages.map((p) => renderPage(p, 2200));

    if (format === "pdf") {
      const { jsPDF } = window.jspdf;
      let pdf;
      pages.forEach((canvas, i) => {
        const w = canvas.width, h = canvas.height;
        const orientation = w > h ? "l" : "p";
        if (i === 0) {
          pdf = new jsPDF({ orientation, unit: "pt", format: [w, h] });
        } else {
          pdf.addPage([w, h], orientation);
        }
        const dataUrl = canvas.toDataURL("image/jpeg", Math.max(0.35, quality));
        pdf.addImage(dataUrl, "JPEG", 0, 0, w, h);
      });
      const blob = pdf.output("blob");
      return [{ blob, filename: `${name}.pdf`, mime: "application/pdf" }];
    }

    // image formats: one file per page
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const files = [];
    for (let i = 0; i < pages.length; i++) {
      const blob = await new Promise((resolve) => pages[i].toBlob(resolve, mime, quality));
      const suffix = pages.length > 1 ? `_${i + 1}` : "";
      files.push({ blob, filename: `${name}${suffix}.${ext}`, mime });
    }
    return files;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  $("#saveExportBtn").addEventListener("click", async () => {
    if (State.currentPages.length === 0) { toast("Añade al menos una página primero", "error"); return; }
    const btn = $("#saveExportBtn");
    btn.disabled = true; const original = btn.textContent; btn.textContent = "Exportando…";
    try {
      const files = await buildExportBlobs();
      files.forEach((f) => downloadBlob(f.blob, f.filename));

      // persist to history
      const name = ($("#fileNameInput").value || "Documento").trim() || "Documento";
      const thumbs = State.currentPages.map((p) => pageThumb(p, 900));
      await DocuDB.saveDocument({ id: uid(), name, createdAt: Date.now(), pages: thumbs });

      State.currentPages = [];
      updatePendingBar();
      renderHistory();
      Router.show("view-home");
      toast("Documento exportado y guardado ✓", "success");
    } catch (err) {
      console.error(err);
      toast("No se pudo exportar el documento", "error");
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });

  $("#shareBtn").addEventListener("click", async () => {
    if (State.currentPages.length === 0) { toast("Añade al menos una página primero", "error"); return; }
    try {
      const files = await buildExportBlobs();
      const shareFiles = files.map((f) => new File([f.blob], f.filename, { type: f.mime }));
      if (navigator.canShare && navigator.canShare({ files: shareFiles })) {
        await navigator.share({ files: shareFiles, title: $("#fileNameInput").value || "Documento" });
      } else {
        files.forEach((f) => downloadBlob(f.blob, f.filename));
        toast("Compartir no está disponible; se descargó el archivo");
      }
    } catch (err) {
      if (err.name !== "AbortError") toast("No se pudo compartir el archivo", "error");
    }
  });

  /* ---------------------------------------------------------------
   * DOCUMENT VIEWER (from history)
   * --------------------------------------------------------------- */
  let viewerDocId = null;
  async function openViewer(id) {
    const doc = await DocuDB.getById(id);
    if (!doc) return;
    viewerDocId = id;
    Router.show("view-viewer");
    $("#viewerTitle").textContent = doc.name;
    const grid = $("#viewerGrid");
    grid.innerHTML = "";
    doc.pages.forEach((src, i) => {
      const div = document.createElement("div");
      div.className = "review-card";
      div.innerHTML = `<span class="rc-num">${i + 1}</span><img src="${src}" alt="Página ${i + 1}" />`;
      grid.appendChild(div);
    });
  }

  $("#viewerDeleteBtn").addEventListener("click", async () => {
    if (!viewerDocId) return;
    if (!(await confirmDialog("¿Eliminar este documento de tu historial?"))) return;
    await DocuDB.remove(viewerDocId);
    renderHistory();
    Router.show("view-home");
    toast("Documento eliminado");
  });

  $("#viewerRenameBtn").addEventListener("click", async () => {
    if (!viewerDocId) return;
    const doc = await DocuDB.getById(viewerDocId);
    const name = prompt("Nuevo nombre del documento:", doc.name);
    if (!name) return;
    doc.name = name.trim().slice(0, 60) || doc.name;
    await DocuDB.saveDocument(doc);
    $("#viewerTitle").textContent = doc.name;
    renderHistory();
    toast("Documento renombrado", "success");
  });

  $("#viewerExportBtn").addEventListener("click", async () => {
    const doc = await DocuDB.getById(viewerDocId);
    if (!doc) return;
    try {
      const { jsPDF } = window.jspdf;
      const images = await Promise.all(doc.pages.map(loadImage));
      let pdf;
      images.forEach((img, i) => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const orientation = w > h ? "l" : "p";
        if (i === 0) pdf = new jsPDF({ orientation, unit: "pt", format: [w, h] });
        else pdf.addPage([w, h], orientation);
        pdf.addImage(img, "JPEG", 0, 0, w, h);
      });
      downloadBlob(pdf.output("blob"), `${doc.name}.pdf`);
      toast("PDF exportado ✓", "success");
    } catch (err) {
      console.error(err);
      toast("No se pudo exportar el PDF", "error");
    }
  });

  /* ---------------------------------------------------------------
   * Bottom navigation / theme / install
   * --------------------------------------------------------------- */
  $$(".nav-btn[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav;
      if (target === "view-review" && State.currentPages.length === 0) {
        toast("Aún no hay páginas en el documento actual");
        return;
      }
      Router.show(target);
      if (target === "view-review") renderReviewGrid();
      if (target === "view-home") renderHistory();
    });
  });
  document.querySelector('[data-action="scan-now"]').addEventListener("click", startCameraFlow);

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    localStorage.setItem("skanix-theme", theme);
  }
  $("#themeToggle").addEventListener("click", () => {
    const next = document.body.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
  });
  (function initTheme() {
    const saved = localStorage.getItem("skanix-theme");
    if (saved) applyTheme(saved);
    else if (window.matchMedia("(prefers-color-scheme: light)").matches) applyTheme("light");
  })();

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $("#installBtn").classList.remove("hidden");
  });
  $("#installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("#installBtn").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => $("#installBtn").classList.add("hidden"));

  /* ---------------------------------------------------------------
   * Service worker registration (offline support)
   * --------------------------------------------------------------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
    });
  }

  /* ---------------------------------------------------------------
   * Init
   * --------------------------------------------------------------- */
  renderHistory();
  updatePendingBar();
})();
