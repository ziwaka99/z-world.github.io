/* ------------------------------------------------------------------
   One-page-at-a-time PDF viewer, built on PDF.js.

   Markup contract (see project-2.html):

     <section class="pdf-viewer" data-pdf-viewer
              data-pdf-state="loading"
              data-pdf-src="assets/.../portfolio.pdf">
       <div class="pdf-stage">
         <div data-pdf-frame>            <- the box the page is fitted into
           <canvas data-pdf-canvas>
           <div data-pdf-status>
         </div>
         <button data-pdf-prev> <button data-pdf-next>
         <span data-pdf-counter> <button data-pdf-fullscreen>
         <div data-pdf-bar>
       </div>
     </section>

   Note: the PDF is fetched with XHR/fetch, so opening these pages straight
   from disk (file://) will fail on CORS. Serve them over http — GitHub
   Pages, or `python -m http.server` locally.
------------------------------------------------------------------ */
(() => {
  "use strict";

  const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
  const MAX_DPR = 2; // Retina-sharp without blowing up memory on big pages.
  const SWIPE_PX = 45;

  /* The stage is sized against the sticky header, which is a different
     height on mobile. */
  function syncHeaderHeight() {
    const header = document.querySelector("header");
    const h = header ? Math.round(header.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--pdf-header-h", `${h}px`);
  }

  const fsElement = () =>
    document.fullscreenElement || document.webkitFullscreenElement || null;

  function setupViewer(root) {
    const url = root.dataset.pdfSrc;
    const pick = (name) => root.querySelector(`[data-pdf-${name}]`);

    const frame = pick("frame");
    const canvas = pick("canvas");
    const status = pick("status");
    const counter = pick("counter");
    const bar = pick("bar");
    const prevBtn = pick("prev");
    const nextBtn = pick("next");
    const fsBtn = pick("fullscreen");

    if (!frame || !canvas || !url) return;
    const ctx = canvas.getContext("2d");

    let doc = null;
    let current = 1;
    let queued = null; // page waiting to be drawn
    let running = false; // is the draw loop alive?
    let task = null; // in-flight PDF.js render task

    function fail(message) {
      root.dataset.pdfState = "error";
      status.innerHTML =
        `<div class="max-w-xs"><p>${message}</p>` +
        `<a href="${url}" target="_blank" rel="noopener" ` +
        `class="mt-3 inline-block text-zinc-200 underline underline-offset-4 hover:text-white">` +
        `Open the PDF directly</a></div>`;
    }

    /* The content box of the frame, i.e. how much room the page really has. */
    function innerSize() {
      const cs = getComputedStyle(frame);
      return {
        w: frame.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        h: frame.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      };
    }

    function chrome() {
      const total = doc ? doc.numPages : 0;
      if (counter) counter.textContent = total ? `${current} / ${total}` : "– / –";
      if (bar) bar.style.width = total ? `${(current / total) * 100}%` : "0%";
      if (prevBtn) prevBtn.disabled = !total || current <= 1;
      if (nextBtn) nextBtn.disabled = !total || current >= total;
    }

    async function paint(num) {
      const page = await doc.getPage(num);
      if (queued !== null && queued !== num) return; // already stale

      const { w, h } = innerSize();
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(Math.min(w / base.width, h / base.height), 0.05);
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

      /* Render off-screen so the page currently on display stays put until
         the next one is fully drawn — no white flash while flipping. */
      const buffer = document.createElement("canvas");
      buffer.width = Math.max(1, Math.floor(viewport.width * dpr));
      buffer.height = Math.max(1, Math.floor(viewport.height * dpr));

      task = page.render({
        canvasContext: buffer.getContext("2d", { alpha: false }),
        viewport,
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
      });
      await task.promise;
      task = null;
      if (queued !== null && queued !== num) return;

      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      ctx.drawImage(buffer, 0, 0);
      root.dataset.pdfState = "ready";

      if (num < doc.numPages) doc.getPage(num + 1).catch(() => {}); // warm the next page
    }

    async function pump() {
      running = true;
      while (queued !== null) {
        const num = queued;
        queued = null;
        try {
          await paint(num);
        } catch (err) {
          if (err && err.name === "RenderingCancelledException") continue;
          console.error(err);
          fail("This page could not be rendered.");
          break;
        }
      }
      running = false;
    }

    function show(num) {
      if (!doc) return;
      current = Math.min(Math.max(num, 1), doc.numPages);
      chrome();
      queued = current;
      if (task) task.cancel();
      if (!running) pump();
    }

    if (prevBtn) prevBtn.addEventListener("click", () => show(current - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => show(current + 1));

    /* Arrow keys, but only while the viewer actually fills the screen —
       otherwise they would hijack scrolling through the text above. */
    function onScreen() {
      if (fsElement() === root) return true;
      const box = root.getBoundingClientRect();
      const shown = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
      return shown / Math.min(box.height, window.innerHeight) > 0.6;
    }

    document.addEventListener("keydown", (e) => {
      if (!doc || !onScreen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          show(current - 1);
          break;
        case "ArrowRight":
        case "PageDown":
          show(current + 1);
          break;
        case "Home":
          show(1);
          break;
        case "End":
          show(doc.numPages);
          break;
        default:
          return;
      }
      e.preventDefault();
    });

    /* Swipe to flip on touch screens. */
    let sx = 0;
    let sy = 0;
    let tracking = false;
    frame.addEventListener(
      "touchstart",
      (e) => {
        tracking = e.touches.length === 1;
        if (!tracking) return;
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
      },
      { passive: true }
    );
    frame.addEventListener(
      "touchend",
      (e) => {
        if (!tracking) return;
        tracking = false;
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
          show(current + (dx < 0 ? 1 : -1));
        }
      },
      { passive: true }
    );

    if (fsBtn) {
      fsBtn.addEventListener("click", () => {
        if (fsElement()) {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else if (root.requestFullscreen || root.webkitRequestFullscreen) {
          (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
        }
      });
    }

    const onFullscreenChange = () => {
      const on = fsElement() === root;
      if (fsBtn) fsBtn.textContent = on ? "Exit full screen" : "Full screen";
      show(current); // refit to the new viewport
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    /* Refit on resize / rotation. */
    let reflowTimer;
    const reflow = () => {
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => {
        syncHeaderHeight();
        show(current);
      }, 150);
    };
    if ("ResizeObserver" in window) new ResizeObserver(reflow).observe(frame);
    else window.addEventListener("resize", reflow);
    window.addEventListener("orientationchange", reflow);

    if (!window.pdfjsLib) {
      fail("The PDF viewer could not be loaded.");
      return;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;

    const loading = pdfjsLib.getDocument({
      url,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
    });

    /* These files run to tens of MB, so show real progress. The label comes
       from the markup, so each page words it its own way. */
    const loadingLabel = (status.textContent || "Loading").trim().replace(/[….\s]+$/, "");
    loading.onProgress = ({ loaded, total }) => {
      if (!total || root.dataset.pdfState === "ready") return;
      status.textContent = `${loadingLabel}… ${Math.round((loaded / total) * 100)}%`;
    };

    loading.promise
      .then((pdf) => {
        doc = pdf;
        show(1);
      })
      .catch((err) => {
        console.error(err);
        fail("The portfolio could not be loaded.");
      });
  }

  function init() {
    syncHeaderHeight();
    window.addEventListener("resize", syncHeaderHeight);
    document.querySelectorAll("[data-pdf-viewer]").forEach(setupViewer);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
