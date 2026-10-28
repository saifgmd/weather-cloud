/* =====================================================================
 *  Weather Cloud
 *  --------------------------------------------------------------------
 *  Interactive rainy window with WebGL raindrops, live clock, weather,
 *  city/village search, 24-hour and 5-day forecast.
 *
 *  @project  Weather Cloud
 *  @author   SAIF G.M.D
 *  @version  1.1.0
 * ===================================================================== */

(function () {
  "use strict";

  const APP_VERSION = "1.1.0";

  // =====================================================================
  // PART 1 — RAINYGLASS ENGINE (Self-contained WebGL raindrops)
  // ---------------------------------------------------------------------
  // The canvas is transparent everywhere except inside the drops, so the
  // CSS-filtered background (blur / brightness) stays visible. Each drop
  // acts like a small lens showing an inverted, sharper view of the scene.
  // =====================================================================
  const MAX_DROPLETS = 80;      // 80 vec3 uniforms — fits mobile GPU limits
  const BG_SCALE = 1.05;        // must match CSS scale() on #custom-bg / #custom-video
  const MAX_TEXTURE_DIM = 2048; // large uploads are downscaled before upload

  class RainyGlass {
    constructor(canvas, options = {}) {
      if (!canvas) throw new Error("RainyGlass: canvas is required");

      this.canvas = canvas;
      this.gl = null;
      this.program = null;
      this.texture = null;
      this.u = {};

      this.options = Object.assign(
        {
          dropletsRate: 14,   // new drops per second
          maxDroplets: MAX_DROPLETS,
          minRadius: 5,       // CSS px
          maxRadius: 22,      // CSS px
          slideChance: 0.4,
          fallSpeed: 0.22,    // screen heights per second (max)
          refraction: 0.6,
          highlight: 0.45,
          reducedMotion: false
        },
        options
      );

      this.droplets = [];
      this.dropData = new Float32Array(MAX_DROPLETS * 3);
      this.lastSpawn = 0;
      this.lastTime = 0;
      this.frame = 0;
      this.isRunning = false;
      this.isDestroyed = false;
      this.rafId = null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      this.source = null;
      this.sourceIsVideo = false;
      this.videoTainted = false;
      this.hasTexture = false;
      this.cover = [1 / BG_SCALE, 1 / BG_SCALE];
      this.scratch = document.createElement("canvas");

      this._loop = this._loop.bind(this);
      this._onResize = this._onResize.bind(this);
      this._onContextLost = (e) => {
        e.preventDefault();
        this.stop();
        this.program = null;
        this.texture = null;
      };
      this._onContextRestored = () => {
        this._initWebGL();
        if (this.source) this.setSource(this.source);
        this.start();
      };

      this._initWebGL();
      this.resize();
      window.addEventListener("resize", this._onResize);
      canvas.addEventListener("webglcontextlost", this._onContextLost, false);
      canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);
    }

    get isReady() {
      return !!(this.gl && this.program);
    }

    _initWebGL() {
      const attrs = { alpha: true, premultipliedAlpha: true, antialias: false };
      const gl =
        this.canvas.getContext("webgl", attrs) ||
        this.canvas.getContext("experimental-webgl", attrs);

      if (!gl) {
        console.warn("[RainyGlass] WebGL not supported");
        return;
      }
      this.gl = gl;

      const vertSrc = `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `;

      const fragSrc = `
        precision mediump float;
        #define MAX_DROPLETS ${MAX_DROPLETS}
        varying vec2 v_uv;
        uniform sampler2D u_bg;
        uniform vec2 u_resolution;
        uniform int u_count;
        uniform vec3 u_drops[MAX_DROPLETS];   // x px, y px, radius px
        uniform vec2 u_cover;                 // object-fit: cover mapping
        uniform float u_hasTex;               // 0 = plain glass drops (no CORS)
        uniform float u_refraction;
        uniform float u_highlight;

        vec2 coverUV(vec2 uv) {
          return clamp((uv - 0.5) * u_cover + 0.5, 0.0, 1.0);
        }

        void main() {
          vec2 p = v_uv * u_resolution;

          for (int i = 0; i < MAX_DROPLETS; i++) {
            if (i >= u_count) break;
            vec3 d = u_drops[i];
            vec2 diff = p - d.xy;
            diff.y *= 0.9;                    // slightly taller than wide
            float dist = length(diff);
            float r = d.z;

            if (r > 0.5 && dist < r) {
              float t = dist / r;             // 0 center -> 1 edge
              vec2 n = diff / r;              // -1..1 inside the drop
              float edge = 1.0 - smoothstep(r - 1.5, r, dist);

              // Lens: inverted, minified view of the scene behind the drop
              vec2 sp = d.xy - diff * (u_refraction * 4.0);
              vec3 col = texture2D(u_bg, coverUV(sp / u_resolution)).rgb;

              float rim = smoothstep(0.6, 1.0, t);
              col *= mix(1.08, 0.55, rim);

              vec2 hl = n - vec2(-0.32, 0.38);
              float spec = 1.0 - smoothstep(0.0, 0.32, length(hl));
              col += spec * u_highlight;

              // Plain mode: glassy outline + highlight only
              float plainA = edge * (0.06 + rim * 0.32 + spec * 0.55);
              vec3 color = mix(vec3(1.0), col, u_hasTex);
              float alpha = mix(plainA, edge, u_hasTex);

              gl_FragColor = vec4(color * alpha, alpha);
              return;
            }
          }

          gl_FragColor = vec4(0.0);
        }
      `;

      this.program = this._createProgram(vertSrc, fragSrc);
      if (!this.program) return;

      gl.useProgram(this.program);

      this.positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      const aPos = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      ["u_bg", "u_resolution", "u_count", "u_drops", "u_cover", "u_hasTex", "u_refraction", "u_highlight"]
        .forEach((name) => {
          this.u[name] = gl.getUniformLocation(this.program, name);
        });

      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([10, 10, 20, 255])
      );
      gl.disable(gl.BLEND);
    }

    _createProgram(vertSrc, fragSrc) {
      const gl = this.gl;
      const vert = this._compileShader(gl.VERTEX_SHADER, vertSrc);
      const frag = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
      if (!vert || !frag) return null;

      const program = gl.createProgram();
      gl.attachShader(program, vert);
      gl.attachShader(program, frag);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("[RainyGlass] Link error:", gl.getProgramInfoLog(program));
        return null;
      }
      return program;
    }

    _compileShader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("[RainyGlass] Shader error:", gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    }

    _upload(el) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    }

    /**
     * Use an <img> or <video> element (already loaded in the page) as the
     * scene behind the drops. Cross-origin media without CORS can't be read
     * by WebGL; in that case the drops fall back to plain glass drops.
     */
    setSource(el) {
      this.source = el || null;
      this.sourceIsVideo = !!el && el.tagName === "VIDEO";
      this.videoTainted = false;
      this.hasTexture = false;
      if (!this.isReady || !el) return false;

      if (this.sourceIsVideo) {
        this._updateCover();
        return true; // uploaded every other frame in _render
      }

      const w = el.naturalWidth;
      const h = el.naturalHeight;
      if (!w || !h) return false;

      try {
        let src = el;
        if (Math.max(w, h) > MAX_TEXTURE_DIM) {
          const s = MAX_TEXTURE_DIM / Math.max(w, h);
          this.scratch.width = Math.round(w * s);
          this.scratch.height = Math.round(h * s);
          this.scratch.getContext("2d").drawImage(el, 0, 0, this.scratch.width, this.scratch.height);
          src = this.scratch;
        }
        this._upload(src);
        this.hasTexture = true;
      } catch (err) {
        // SecurityError: cross-origin image without CORS headers
        this.hasTexture = false;
      } finally {
        this.scratch.width = this.scratch.height = 1;
      }
      this._updateCover();
      return this.hasTexture;
    }

    _updateCover() {
      const el = this.source;
      const iw = el ? (this.sourceIsVideo ? el.videoWidth : el.naturalWidth) : 0;
      const ih = el ? (this.sourceIsVideo ? el.videoHeight : el.naturalHeight) : 0;
      if (!iw || !ih || !this.canvas.height) {
        this.cover = [1 / BG_SCALE, 1 / BG_SCALE];
        return;
      }
      const cA = this.canvas.width / this.canvas.height;
      const iA = iw / ih;
      let sx = 1;
      let sy = 1;
      if (cA > iA) sy = iA / cA;
      else sx = cA / iA;
      this.cover = [sx / BG_SCALE, sy / BG_SCALE];
    }

    setOptions(partial) {
      Object.assign(this.options, partial);
      if (this.droplets.length > this.options.maxDroplets) {
        this.droplets.length = this.options.maxDroplets;
      }
    }

    start() {
      if (this.isRunning || this.isDestroyed || !this.isReady) return;
      this.isRunning = true;
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this._loop);
    }

    stop() {
      this.isRunning = false;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    }

    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      this._updateCover();
    }

    destroy() {
      this.isDestroyed = true;
      this.stop();
      window.removeEventListener("resize", this._onResize);
      this.canvas.removeEventListener("webglcontextlost", this._onContextLost);
      this.canvas.removeEventListener("webglcontextrestored", this._onContextRestored);
      const gl = this.gl;
      if (gl) {
        if (this.texture) gl.deleteTexture(this.texture);
        if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
        if (this.program) gl.deleteProgram(this.program);
      }
      this.droplets = [];
      this.gl = null;
      this.program = null;
      this.texture = null;
    }

    _onResize() {
      this.resize();
    }

    _loop(now) {
      if (!this.isRunning) return;
      const dt = Math.min((now - this.lastTime) / 1000, 0.05);
      this.lastTime = now;
      this._updateDroplets(dt);
      this._render();
      this.rafId = requestAnimationFrame(this._loop);
    }

    _spawn() {
      const o = this.options;
      const span = o.maxRadius - o.minRadius;
      const r = o.minRadius + Math.pow(Math.random(), 2.2) * span; // mostly small drops
      const slides =
        !o.reducedMotion && r > o.minRadius + span * 0.3 && Math.random() < o.slideChance;
      this.droplets.push({
        x: Math.random(),
        y: Math.random() * 0.95,
        r,
        rNow: 0,
        vy: 0,
        slides,
        delay: slides ? 0.4 + Math.random() * 2.5 : 0,
        life: 0,
        ttl: 5 + Math.random() * 10,
        wobble: Math.random() * Math.PI * 2
      });
    }

    _updateDroplets(dt) {
      const o = this.options;

      if (o.dropletsRate > 0 && o.maxDroplets > 0) {
        this.lastSpawn += dt;
        const interval = 1 / o.dropletsRate;
        while (this.lastSpawn > interval) {
          this.lastSpawn -= interval;
          if (this.droplets.length < Math.min(o.maxDroplets, MAX_DROPLETS)) this._spawn();
        }
      } else {
        this.lastSpawn = 0;
      }

      for (let i = this.droplets.length - 1; i >= 0; i--) {
        const d = this.droplets[i];
        d.life += dt;
        d.rNow = d.r * Math.min(1, d.life / 0.15);

        if (d.slides && d.life > d.delay) {
          const target = o.fallSpeed * (0.35 + d.r / o.maxRadius);
          d.vy += (target - d.vy) * Math.min(1, dt * 2);
          d.y += d.vy * dt;
          d.x += Math.sin(d.life * 3 + d.wobble) * dt * 0.004;
          if (d.y > 1.08) this.droplets.splice(i, 1);
        } else if (!d.slides && d.life > d.ttl) {
          const fade = 1 - (d.life - d.ttl) / 1.5;
          if (fade <= 0) this.droplets.splice(i, 1);
          else d.rNow *= fade;
        }
      }
    }

    _render() {
      const gl = this.gl;
      if (!gl || !this.program) return;

      const W = this.canvas.width;
      const H = this.canvas.height;
      if (!W || !H) return;

      // Live video texture (every other frame to save bandwidth)
      if (this.sourceIsVideo && !this.videoTainted && this.source) {
        this.frame++;
        const v = this.source;
        if (v.readyState >= 2 && v.videoWidth && this.frame % 2 === 0) {
          try {
            this._upload(v);
            if (!this.hasTexture) {
              this.hasTexture = true;
              this._updateCover();
            }
          } catch (err) {
            this.videoTainted = true; // cross-origin video without CORS
            this.hasTexture = false;
          }
        }
      }

      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);

      const count = Math.min(this.droplets.length, MAX_DROPLETS);
      const data = this.dropData;
      for (let i = 0; i < count; i++) {
        const d = this.droplets[i];
        data[i * 3] = d.x * W;
        data[i * 3 + 1] = (1 - d.y) * H;
        data[i * 3 + 2] = d.rNow * this.dpr;
      }

      gl.uniform1i(this.u.u_count, count);
      gl.uniform3fv(this.u.u_drops, data);
      gl.uniform2f(this.u.u_resolution, W, H);
      gl.uniform2f(this.u.u_cover, this.cover[0], this.cover[1]);
      gl.uniform1f(this.u.u_hasTex, this.hasTexture ? 1 : 0);
      gl.uniform1f(this.u.u_refraction, this.options.refraction);
      gl.uniform1f(this.u.u_highlight, this.options.highlight);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.u.u_bg, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // =====================================================================
  // PART 2 — UTILITIES
  // =====================================================================
  function $id(id) {
    return document.getElementById(id);
  }

  /** Run fn at most once per animation frame, always with the latest state. */
  function rafBatch(fn) {
    let queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn();
      });
    };
  }

  function debounce(func, wait) {
    let timeout;
    const debounced = function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
    debounced.cancel = () => clearTimeout(timeout);
    return debounced;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** parseInt + clamp, keeping 0 as a valid value. */
  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function isValidUrl(string) {
    if (!string || typeof string !== "string") return false;
    try {
      const url = new URL(string);
      return ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  }

  function sanitizeUrl(url) {
    if (!isValidUrl(url)) return null;
    try {
      return new URL(url).href;
    } catch {
      return null;
    }
  }

  function isVideoUrl(url) {
    return /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(url);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function flagEmoji(cc) {
    if (!/^[A-Z]{2}$/.test(cc || "")) return "📍";
    return String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  }

  function formatTime12(h24, m) {
    const hh = String(h24 % 12 || 12).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    return `${hh}:${mm} ${h24 >= 12 ? "PM" : "AM"}`;
  }

  const LS_KEYS = {
    settings: "weatherCloudSettings",
    location: "weatherCloudLocation",
    recents: "weatherCloudRecents",
    weather: "weatherCloudLastWeather"
  };

  function storeGet(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function storeRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }

  const reducedMotionQuery = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const LANG = (() => {
    const l = (navigator.language || "en").slice(0, 2).toLowerCase();
    return /^[a-z]{2}$/.test(l) ? l : "en";
  })();

  // =====================================================================
  // PART 3 — DEVICE DETECTION
  // =====================================================================
  const DeviceInfo = {
    isMobile() {
      return (
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent
        ) || window.innerWidth <= 768
      );
    },
    getMaxBlur() {
      return this.isMobile() ? 15 : 25;
    }
  };

  // =====================================================================
  // PART 4 — FULLSCREEN
  // =====================================================================
  const FullscreenAPI = {
    supported() {
      const el = document.documentElement;
      return !!(
        el.requestFullscreen ||
        el.webkitRequestFullscreen ||
        el.mozRequestFullScreen ||
        el.msRequestFullscreen
      );
    },
    isFullscreen() {
      return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
    },
    enter(element) {
      element = element || document.documentElement;
      const requestMethod =
        element.requestFullscreen ||
        element.webkitRequestFullscreen ||
        element.mozRequestFullScreen ||
        element.msRequestFullscreen;
      if (!requestMethod) {
        showToast("Fullscreen not supported", "error");
        return Promise.resolve();
      }
      try {
        const result = requestMethod.call(element);
        if (result && typeof result.then === "function") {
          return result.catch((err) => console.warn("Fullscreen error:", err));
        }
      } catch (err) {
        console.warn("Fullscreen exception:", err);
      }
      return Promise.resolve();
    },
    exit() {
      const exitMethod =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;
      if (exitMethod && this.isFullscreen()) {
        try {
          const result = exitMethod.call(document);
          if (result && typeof result.then === "function") {
            return result.catch((err) => console.warn("Exit error:", err));
          }
        } catch (err) {
          console.warn("Exit exception:", err);
        }
      }
      return Promise.resolve();
    },
    toggle() {
      return this.isFullscreen() ? this.exit() : this.enter();
    },
    updateButtonIcon(isFullscreen) {
      const btn = $id("btn-fullscreen");
      if (!btn) return;
      btn.textContent = isFullscreen ? "✕" : "⛶";
      btn.setAttribute("aria-label", isFullscreen ? "Exit fullscreen" : "Enter fullscreen");
      btn.title = isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)";
      btn.classList.toggle("active", isFullscreen);
    },
    init() {
      const btn = $id("btn-fullscreen");
      if (!this.supported()) {
        if (btn) btn.hidden = true; // e.g. iPhone Safari
        return;
      }
      ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"]
        .forEach((eventName) => {
          document.addEventListener(eventName, () => this.updateButtonIcon(this.isFullscreen()));
        });
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          this.toggle();
        });
      }
    }
  };

  // =====================================================================
  // PART 5 — AUDIO MANAGER
  // ---------------------------------------------------------------------
  // Sources are tried in order (data-sources="a.mp3, b.mp3"): put a local
  // rain.mp3 first so the sound also works offline.
  // =====================================================================
  const AudioManager = {
    audio: null,
    sources: [],
    index: 0,
    failed: false,
    wantPlaying: false,

    init(audioElement) {
      if (!audioElement) {
        this.failed = true;
        return;
      }
      this.audio = audioElement;
      this.sources = (audioElement.dataset.sources || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (this.sources.length === 0) {
        console.warn("AudioManager: no audio sources found");
        this.failed = true;
        return;
      }
      audioElement.addEventListener("error", () => this._next());
      audioElement.addEventListener("play", syncSoundUI);
      audioElement.addEventListener("pause", syncSoundUI);
      audioElement.src = this.sources[0];
    },

    _next() {
      if (!this.audio || this.failed) return;
      this.index++;
      if (this.index >= this.sources.length) {
        this.failed = true;
        console.warn("All audio sources failed");
        syncSoundUI();
        return;
      }
      this.audio.src = this.sources[this.index];
      this.audio.load();
      if (this.wantPlaying) this.audio.play().catch(() => {});
    },

    get isPlaying() {
      return !!this.audio && !this.audio.paused;
    },

    play() {
      if (!this.audio || this.failed) {
        return Promise.reject(new Error("Audio not available"));
      }
      this.wantPlaying = true;
      return this.audio.play();
    },
    pause() {
      this.wantPlaying = false;
      if (this.audio) this.audio.pause();
    },
    setVolume(volume) {
      if (!this.audio) return;
      this.audio.volume = Math.max(0, Math.min(1, volume));
    }
  };

  // =====================================================================
  // PART 6 — RESOURCE MANAGER (blob URLs from uploads)
  // =====================================================================
  const ResourceManager = {
    blobUrls: new Set(),

    createBlobUrl(blob) {
      const url = URL.createObjectURL(blob);
      this.blobUrls.add(url);
      return url;
    },
    /** Free every uploaded file except the one currently displayed. */
    releaseExcept(keepUrl) {
      this.blobUrls.forEach((url) => {
        if (url !== keepUrl) {
          URL.revokeObjectURL(url);
          this.blobUrls.delete(url);
        }
      });
    },
    revokeAll() {
      this.blobUrls.forEach((url) => URL.revokeObjectURL(url));
      this.blobUrls.clear();
    }
  };

  // =====================================================================
  // PART 7 — LOADING CONTROLLER
  // =====================================================================
  const LoadingController = {
    currentLoadId: 0,
    startLoading() {
      this.currentLoadId++;
      return this.currentLoadId;
    },
    isCurrentLoading(id) {
      return this.currentLoadId === id;
    }
  };

  // =====================================================================
  // PART 8 — PWA MANAGER
  // =====================================================================
  const PWAManager = {
    deferredPrompt: null,
    installButton: null,

    init() {
      this.installButton = $id("btn-install");
      this.registerServiceWorker();
      this.setupInstallPrompt();
    },

    registerServiceWorker() {
      const { hostname, protocol } = window.location;
      if (protocol === "file:" || hostname.includes("cdpn.io") || hostname.includes("codepen.io")) {
        return;
      }
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
          navigator.serviceWorker
            .register("./sw.js")
            .catch((err) => console.warn("SW registration failed:", err));
        });
      }
    },

    setupInstallPrompt() {
      window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        this.deferredPrompt = e;
        if (this.installButton) this.installButton.classList.remove("hidden");
      });
      if (this.installButton) {
        this.installButton.addEventListener("click", () => this.promptInstall());
      }
      window.addEventListener("appinstalled", () => {
        this.deferredPrompt = null;
        if (this.installButton) this.installButton.classList.add("hidden");
        showToast("App installed!", "success");
      });
    },

    async promptInstall() {
      if (!this.deferredPrompt) {
        showToast("App is already installed or not supported", "info");
        return;
      }
      this.deferredPrompt.prompt();
      await this.deferredPrompt.userChoice.catch(() => {});
      this.deferredPrompt = null;
    }
  };

  // =====================================================================
  // PART 9 — CONFIG & PRESETS (CORS-friendly sources)
  // =====================================================================
  const PRESETS = [
    { type: "image", label: "City", url: "https://picsum.photos/id/1015/1920/1080", thumb: "https://picsum.photos/id/1015/300/200" },
    { type: "image", label: "Forest", url: "https://picsum.photos/id/1018/1920/1080", thumb: "https://picsum.photos/id/1018/300/200" },
    { type: "image", label: "Mountain", url: "https://picsum.photos/id/1016/1920/1080", thumb: "https://picsum.photos/id/1016/300/200" },
    { type: "image", label: "Towers", url: "https://picsum.photos/id/1031/1920/1080", thumb: "https://picsum.photos/id/1031/300/200" },
    { type: "image", label: "Future", url: "https://picsum.photos/id/1041/1920/1080", thumb: "https://picsum.photos/id/1041/300/200" },
    { type: "image", label: "Sky", url: "https://picsum.photos/id/1019/1920/1080", thumb: "https://picsum.photos/id/1019/300/200" },
    {
      type: "video",
      label: "Hurricane",
      url: "https://cdn.pixabay.com/video/2019/03/18/22070-325253460_large.mp4",
      thumb: "https://cdn.pixabay.com/video/2019/03/18/22070-325253460_tiny.jpg"
    },
    {
      type: "video",
      label: "River",
      url: "https://cdn.pixabay.com/video/2020/12/01/58020-486900427_large.mp4",
      thumb: "https://cdn.pixabay.com/video/2020/12/01/58020-486900427_tiny.jpg"
    },
    {
      type: "video",
      label: "Beach",
      url: "https://videos.pexels.com/video-files/2439510/2439510-hd_1920_1080_30fps.mp4",
      thumb: "https://images.pexels.com/videos/2439510/free-video-2439510.jpg?auto=compress&cs=tinysrgb&w=300&h=200&dpr=1"
    }
  ];

  const OVERLAY_COLORS = ["none", "#3b82f6", "#8b5cf6", "#ef4444", "#10b981", "#f59e0b"];

  const DEFAULT_STATE = {
    blur: 5,
    brightness: 30,
    rain: 70,
    overlayColor: "none",
    overlayOpacity: 0,
    volume: 50,
    soundOn: true,
    currentType: "image",
    currentUrl: PRESETS[0].url,
    currentPresetIndex: 0
  };

  const VISUAL_PROPS = ["blur", "brightness", "rain", "overlayColor", "overlayOpacity"];

  const state = new Proxy(
    { ...DEFAULT_STATE },
    {
      set(target, property, value) {
        if (property === "blur") value = Math.min(value, DeviceInfo.getMaxBlur());
        const changed = target[property] !== value;
        target[property] = value;
        if (changed && VISUAL_PROPS.includes(property)) updateFilters();
        return true;
      }
    }
  );

  function isValidOverlayColor(c) {
    return c === "none" || /^#[0-9a-f]{6}$/i.test(c || "");
  }

  /** Rain slider (0–100) → drop spawn rate and density. 0 = no rain. */
  function rainOptions(rain) {
    const k = Math.max(0, Math.min(100, rain)) / 100;
    return {
      dropletsRate: k === 0 ? 0 : 3 + k * 22,
      maxDroplets: Math.round(k * MAX_DROPLETS)
    };
  }

  // =====================================================================
  // PART 10 — DOM ELEMENTS
  // =====================================================================
  const customBg = $id("custom-bg");
  const customVideo = $id("custom-video");
  const colorOverlay = $id("color-overlay");
  const canvas = $id("bg-canvas");
  const panel = $id("panel");
  const presetGrid = $id("preset-grid");
  const rainAudio = $id("rain-audio");
  const toast = $id("toast");
  const soundToggleIcon = $id("sound-toggle");
  const soundBtn = $id("btn-sound");
  const loadingOverlay = $id("loading-overlay");
  const settingsBtn = $id("btn-settings");

  // =====================================================================
  // PART 11 — HELPERS (toast, loader, filters)
  // =====================================================================
  let toastTimer = null;
  function showToast(message, type = "info") {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = "toast show";
    if (type === "error") toast.classList.add("error");
    if (type === "success") toast.classList.add("success");
    toastTimer = setTimeout(() => toast.classList.remove("show", "error", "success"), 2600);
  }

  let loaderTimer = null;
  function showLoader(text = "Loading...", delay = 0) {
    if (!loadingOverlay) return;
    clearTimeout(loaderTimer);
    const run = () => {
      const textEl = loadingOverlay.querySelector(".loader-text");
      if (textEl) textEl.textContent = text;
      loadingOverlay.classList.add("active");
    };
    if (delay) loaderTimer = setTimeout(run, delay);
    else run();
  }

  function hideLoader() {
    clearTimeout(loaderTimer);
    if (loadingOverlay) loadingOverlay.classList.remove("active");
  }

  const updateFilters = rafBatch(function () {
    if (!customBg || !customVideo || !canvas || !colorOverlay) return;
    const brightness = `brightness(${state.brightness / 100})`;
    const filter = `blur(${state.blur}px) ${brightness}`;
    customBg.style.filter = filter;
    customVideo.style.filter = filter;
    canvas.style.filter = brightness; // drops match the dimmed background

    if (rainyGlassInstance) rainyGlassInstance.setOptions(rainOptions(state.rain));

    if (state.overlayColor !== "none" && state.overlayOpacity > 0) {
      colorOverlay.style.backgroundColor = state.overlayColor;
      colorOverlay.style.opacity = state.overlayOpacity / 100;
    } else {
      colorOverlay.style.opacity = 0;
    }
  });

  // =====================================================================
  // PART 12 — RAINYGLASS INTEGRATION
  // =====================================================================
  let rainyGlassInstance = null;

  function ensureRain() {
    if (rainyGlassInstance && !rainyGlassInstance.isDestroyed) return rainyGlassInstance;
    if (!canvas) return null;
    try {
      rainyGlassInstance = new RainyGlass(canvas, {
        ...rainOptions(state.rain),
        reducedMotion: reducedMotionQuery.matches
      });
    } catch (err) {
      console.warn("[WeatherCloud] RainyGlass init error:", err.message);
      return null;
    }
    if (!rainyGlassInstance.isReady) {
      canvas.hidden = true;
      return rainyGlassInstance;
    }
    rainyGlassInstance.start();
    return rainyGlassInstance;
  }

  function attachRainSource(el) {
    const rain = ensureRain();
    if (rain) rain.setSource(el);
  }

  // =====================================================================
  // PART 13 — BACKGROUND SWITCHER
  // =====================================================================
  function markActivePreset(index) {
    document.querySelectorAll(".preset-item").forEach((el, i) => {
      const active = i === index;
      el.classList.toggle("active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }

  function setBackground(url, type = "image", presetIndex = -1, opts = {}) {
    const loadId = LoadingController.startLoading();
    const isCurrent = () => LoadingController.isCurrentLoading(loadId);

    state.currentType = type;
    state.currentUrl = url;
    state.currentPresetIndex = presetIndex;
    markActivePreset(presetIndex);
    ResourceManager.releaseExcept(url);

    if (type === "video") {
      showLoader("Loading video...");
      customBg.classList.add("hidden");
      customVideo.classList.remove("hidden");

      customVideo.muted = true;
      customVideo.loop = true;
      customVideo.playsInline = true;
      customVideo.pause();
      customVideo.src = url;

      const playVideo = () => {
        if (!isCurrent()) return;
        const promise = customVideo.play();
        if (!promise) return;
        promise
          .then(() => {
            if (!isCurrent()) return;
            hideLoader();
            attachRainSource(customVideo);
          })
          .catch((error) => {
            if (!isCurrent()) return;
            hideLoader();
            attachRainSource(customVideo);
            if (error.name === "NotAllowedError") {
              showToast("Tap to start video", "info");
              document.addEventListener("click", () => customVideo.play().catch(() => {}), { once: true });
            } else if (error.name !== "AbortError") {
              showToast("Video could not play", "error");
            }
          });
      };

      if (customVideo.readyState >= 3) playVideo();
      else customVideo.addEventListener("canplay", playVideo, { once: true });
    } else {
      showLoader("Loading image...");
      customVideo.pause();
      customVideo.removeAttribute("src");
      customVideo.load(); // release the previous video
      customVideo.classList.add("hidden");
      customBg.classList.remove("hidden");

      const isBlob = url.startsWith("blob:");
      let handled = false;

      const onLoad = () => {
        if (!isCurrent() || handled) return;
        handled = true;
        hideLoader();
        attachRainSource(customBg);
      };

      const onError = () => {
        if (!isCurrent() || handled) return;
        handled = true;
        // Many hosts don't send CORS headers: retry without CORS.
        // The image will show, but the drops use "plain glass" mode.
        if (!opts.noCors && !isBlob) {
          setBackground(url, type, presetIndex, { noCors: true });
          return;
        }
        hideLoader();
        showToast("Image could not be loaded", "error");
        if (presetIndex !== 0) {
          setBackground(PRESETS[0].url, PRESETS[0].type, 0);
        } else {
          customBg.classList.add("hidden"); // offline: keep the dark backdrop
          attachRainSource(null);
        }
      };

      customBg.onload = onLoad;
      customBg.onerror = onError;
      if (opts.noCors || isBlob) customBg.removeAttribute("crossorigin");
      else customBg.crossOrigin = "anonymous";
      customBg.src = url;
      if (customBg.complete && customBg.naturalWidth) onLoad();
    }

    updateFilters();
  }

  // =====================================================================
  // PART 14 — MEDIA EVENT HANDLERS
  // =====================================================================
  function setupMediaHandlers() {
    if (!customVideo) return;
    customVideo.addEventListener("error", () => {
      if (state.currentType !== "video" || !customVideo.getAttribute("src")) return;
      hideLoader();
      showToast("Video could not be loaded", "error");
      if (state.currentPresetIndex !== 0) setBackground(PRESETS[0].url, PRESETS[0].type, 0);
    });
    // Only show the overlay if buffering lasts a while
    customVideo.addEventListener("waiting", () => {
      if (state.currentType === "video") showLoader("Buffering...", 800);
    });
    customVideo.addEventListener("playing", hideLoader);
  }

  // =====================================================================
  // PART 15 — SOUND
  // =====================================================================
  function syncSoundUI() {
    const playing = AudioManager.isPlaying;
    if (soundBtn) {
      soundBtn.classList.toggle("active", playing);
      soundBtn.setAttribute("aria-pressed", String(playing));
      soundBtn.title = AudioManager.failed
        ? "Rain sound unavailable"
        : playing
          ? "Mute rain (S)"
          : "Play rain sound (S)";
    }
    if (soundToggleIcon) soundToggleIcon.textContent = playing ? "🔊" : "🔇";
  }

  function setSound(on) {
    state.soundOn = !!on;
    if (!state.soundOn) {
      AudioManager.pause();
      syncSoundUI();
      return;
    }
    if (AudioManager.failed) {
      state.soundOn = false;
      syncSoundUI();
      showToast("Audio not available", "info");
      return;
    }
    AudioManager.setVolume(state.volume / 100);
    AudioManager.play().catch((err) => {
      if (err && err.name === "NotAllowedError") showToast("Tap anywhere to enable sound", "info");
      syncSoundUI();
    });
  }

  function setupAudioUnlock() {
    // Browsers block autoplay until the first user gesture.
    const unlock = (e) => {
      const onSoundBtn = e.target && e.target.closest && e.target.closest("#btn-sound");
      if (!onSoundBtn && state.soundOn && !AudioManager.isPlaying && !AudioManager.failed) {
        AudioManager.setVolume(state.volume / 100);
        AudioManager.play().catch(() => {});
      }
      window.removeEventListener("click", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
    window.addEventListener("click", unlock, true);
    window.addEventListener("keydown", unlock, true);

    // Try right away: allowed for installed PWAs / frequently visited sites
    if (state.soundOn && !AudioManager.failed) {
      AudioManager.setVolume(state.volume / 100);
      AudioManager.play().catch(() => {});
    }
  }

  // =====================================================================
  // PART 16 — LOCALSTORAGE (visual settings)
  // =====================================================================
  function saveToLocalStorage() {
    const saveData = {
      blur: state.blur,
      brightness: state.brightness,
      rain: state.rain,
      overlayColor: state.overlayColor,
      overlayOpacity: state.overlayOpacity,
      volume: state.volume,
      soundOn: state.soundOn,
      currentPresetIndex: state.currentPresetIndex,
      // Custom web URLs can be restored; uploaded files (blob:) can't
      customUrl: state.currentPresetIndex === -1 && isValidUrl(state.currentUrl) ? state.currentUrl : "",
      customType: state.currentType
    };
    if (storeSet(LS_KEYS.settings, saveData)) {
      const note = state.currentPresetIndex === -1 && !saveData.customUrl
        ? "Settings saved (uploaded files aren't kept)"
        : "Settings saved";
      showToast(note, "success");
    } else {
      showToast("Could not save settings", "error");
    }
  }

  function applySavedSettings(data) {
    if (!data || typeof data !== "object") return false;
    state.blur = clampInt(data.blur, 0, DeviceInfo.getMaxBlur(), DEFAULT_STATE.blur);
    state.brightness = clampInt(data.brightness, 20, 120, DEFAULT_STATE.brightness);
    state.rain = clampInt(data.rain, 0, 100, DEFAULT_STATE.rain);
    state.volume = clampInt(data.volume, 0, 100, DEFAULT_STATE.volume);
    state.overlayOpacity = clampInt(data.overlayOpacity, 0, 80, 0);
    state.overlayColor = isValidOverlayColor(data.overlayColor) ? data.overlayColor : "none";
    state.soundOn = typeof data.soundOn === "boolean" ? data.soundOn : true;

    const idx = clampInt(data.currentPresetIndex, -1, PRESETS.length - 1, 0);
    if (idx === -1 && isValidUrl(data.customUrl)) {
      state.currentPresetIndex = -1;
      state.currentUrl = data.customUrl;
      state.currentType = data.customType === "video" ? "video" : "image";
    } else {
      const safeIdx = idx === -1 ? 0 : idx;
      state.currentPresetIndex = safeIdx;
      state.currentUrl = PRESETS[safeIdx].url;
      state.currentType = PRESETS[safeIdx].type;
    }
    return true;
  }

  function loadFromLocalStorage() {
    return applySavedSettings(storeGet(LS_KEYS.settings));
  }

  // =====================================================================
  // PART 17 — RESET
  // =====================================================================
  function resetToDefaults() {
    Object.keys(DEFAULT_STATE).forEach((key) => {
      state[key] = DEFAULT_STATE[key];
    });
    applyStateToUI();
    storeRemove(LS_KEYS.settings);
    setBackground(PRESETS[0].url, PRESETS[0].type, 0);
    setSound(state.soundOn);
    showToast("Reset to defaults", "success");
  }

  // =====================================================================
  // PART 18 — APPLY STATE TO UI
  // =====================================================================
  function applyStateToUI() {
    const setVal = (id, value) => {
      const el = $id(id);
      if (el) el.value = value;
    };
    const setText = (id, text) => {
      const el = $id(id);
      if (el) el.textContent = text;
    };

    const blurRange = $id("blur-range");
    if (blurRange) blurRange.max = DeviceInfo.getMaxBlur();
    setVal("blur-range", state.blur);
    setText("blur-val", state.blur + "px");

    setVal("brightness-range", state.brightness);
    setText("brightness-val", state.brightness + "%");

    setVal("rain-range", state.rain);
    setText("rain-val", state.rain + "%");

    setVal("overlay-range", state.overlayOpacity);
    setText("overlay-val", state.overlayOpacity + "%");

    setVal("volume-range", state.volume);
    setText("volume-val", state.volume + "%");

    document.querySelectorAll(".color-btn").forEach((btn) => {
      const isActive = btn.dataset.color === state.overlayColor;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-checked", String(isActive));
    });

    updateFilters();
    syncSoundUI();
    AudioManager.setVolume(state.volume / 100);
  }

  // =====================================================================
  // PART 19 — SHARE URL
  // =====================================================================
  function generateShareUrl() {
    const params = new URLSearchParams();
    params.set("blur", state.blur);
    params.set("brightness", state.brightness);
    params.set("rain", state.rain);
    params.set("volume", state.volume);
    params.set("sound", state.soundOn ? "1" : "0");
    if (state.overlayColor !== "none") {
      params.set("color", state.overlayColor.replace("#", ""));
      params.set("colorOpacity", state.overlayOpacity);
    }
    if (state.currentPresetIndex >= 0) {
      params.set("preset", state.currentPresetIndex);
    } else if (isValidUrl(state.currentUrl)) {
      params.set("bg", state.currentUrl);
    }
    const loc = Weather.location;
    if (loc) {
      params.set("lat", (+loc.lat).toFixed(4));
      params.set("lon", (+loc.lon).toFixed(4));
      params.set("place", loc.name);
      if (loc.cc) params.set("cc", loc.cc);
    }
    return window.location.origin + window.location.pathname + "?" + params.toString();
  }

  function loadFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const result = { hasSettings: false, location: null };

    if (params.has("blur")) {
      state.blur = clampInt(params.get("blur"), 0, DeviceInfo.getMaxBlur(), DEFAULT_STATE.blur);
      result.hasSettings = true;
    }
    if (params.has("brightness")) {
      state.brightness = clampInt(params.get("brightness"), 20, 120, DEFAULT_STATE.brightness);
      result.hasSettings = true;
    }
    if (params.has("rain")) {
      state.rain = clampInt(params.get("rain"), 0, 100, DEFAULT_STATE.rain);
      result.hasSettings = true;
    }
    if (params.has("volume")) {
      state.volume = clampInt(params.get("volume"), 0, 100, DEFAULT_STATE.volume);
      result.hasSettings = true;
    }
    if (params.has("sound")) {
      state.soundOn = params.get("sound") !== "0";
      result.hasSettings = true;
    }
    if (params.has("color")) {
      const raw = params.get("color") || "";
      const hex = raw.startsWith("#") ? raw : "#" + raw;
      if (isValidOverlayColor(hex)) {
        state.overlayColor = hex;
        result.hasSettings = true;
      }
    }
    if (params.has("colorOpacity")) {
      state.overlayOpacity = clampInt(params.get("colorOpacity"), 0, 80, 0);
      result.hasSettings = true;
    }
    if (params.has("preset")) {
      const idx = clampInt(params.get("preset"), 0, PRESETS.length - 1, 0);
      state.currentPresetIndex = idx;
      state.currentUrl = PRESETS[idx].url;
      state.currentType = PRESETS[idx].type;
      result.hasSettings = true;
    } else if (params.has("bg")) {
      const bg = sanitizeUrl(params.get("bg"));
      if (bg) {
        state.currentPresetIndex = -1;
        state.currentUrl = bg;
        state.currentType = isVideoUrl(bg) ? "video" : "image";
        result.hasSettings = true;
      }
    }
    if (params.has("lat") && params.has("lon")) {
      result.location = normalizeLocation({
        name: params.get("place") || "Shared location",
        cc: params.get("cc") || "",
        lat: params.get("lat"),
        lon: params.get("lon"),
        source: "shared"
      });
    }
    return result;
  }

  // =====================================================================
  // PART 20 — CLIPBOARD / SHARE
  // =====================================================================
  function shareSettings() {
    const url = generateShareUrl();
    if (navigator.share && DeviceInfo.isMobile()) {
      navigator.share({ title: "Weather Cloud", url }).catch(() => {});
      return;
    }
    copyToClipboard(url);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(text)
        .then(() => showToast("Link copied!", "success"))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const input = document.createElement("input");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand("copy");
      showToast("Link copied!", "success");
    } catch {
      showToast("Copy failed", "error");
    }
    document.body.removeChild(input);
  }

  // =====================================================================
  // PART 21 — PANEL
  // =====================================================================
  function isPanelOpen() {
    return !!panel && panel.classList.contains("open");
  }

  function togglePanel(forceState) {
    if (!panel) return;
    const shouldOpen = typeof forceState === "boolean" ? forceState : !isPanelOpen();
    if (shouldOpen === isPanelOpen()) return;

    if (shouldOpen) {
      panel.classList.add("open");
      panel.inert = false;
      panel.removeAttribute("inert");
      if (settingsBtn) settingsBtn.setAttribute("aria-expanded", "true");
      const closeBtn = $id("panel-close");
      if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
    } else {
      const hadFocus = panel.contains(document.activeElement);
      panel.classList.remove("open");
      panel.inert = true;
      panel.setAttribute("inert", "");
      if (settingsBtn) {
        settingsBtn.setAttribute("aria-expanded", "false");
        if (hadFocus) settingsBtn.focus();
      }
    }
  }

  function setupFocusTrap() {
    if (!panel) return;
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || !isPanelOpen()) return;
      const focusable = Array.from(
        panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // =====================================================================
  // PART 22 — PRESETS CREATION
  // =====================================================================
  function createPresets() {
    if (!presetGrid) return;
    presetGrid.innerHTML = "";
    PRESETS.forEach((preset, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "preset-item" + (preset.type === "video" ? " video" : "");
      item.dataset.label = preset.label;
      item.style.backgroundImage = `url("${preset.thumb}")`;
      item.setAttribute("aria-label", `${preset.label} (${preset.type})`);
      item.addEventListener("click", () => setBackground(preset.url, preset.type, index));
      presetGrid.appendChild(item);
    });
    markActivePreset(state.currentPresetIndex);
  }

  // =====================================================================
  // PART 23 — SLIDERS
  // =====================================================================
  function setupSlider(id, stateKey, suffix) {
    const slider = $id(id + "-range");
    const display = $id(id + "-val");
    if (!slider || !display) return;

    slider.addEventListener("input", (e) => {
      state[stateKey] = parseInt(e.target.value, 10) || 0;
      display.textContent = state[stateKey] + suffix;
    });
  }

  // =====================================================================
  // PART 24 — CLOCK (device time)
  // =====================================================================
  const Clock = {
    elTime: $id("time-display"),
    elSeconds: $id("time-seconds"),
    elAmPm: $id("time-ampm"),
    elDate: $id("date-display"),
    elDay: $id("day-display"),
    elPhaseIcon: $id("day-phase-icon"),
    elPhaseText: $id("day-phase-text"),
    timerId: null,

    start() {
      this.tick();
      this.timerId = setInterval(() => this.tick(), 1000);
    },

    stop() {
      if (this.timerId) clearInterval(this.timerId);
    },

    tick() {
      const now = new Date();
      const h24 = now.getHours();
      const hh = String(h24 % 12 || 12).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");

      if (this.elTime) this.elTime.textContent = `${hh}:${mm}`;
      if (this.elSeconds) this.elSeconds.textContent = ss;
      if (this.elAmPm) this.elAmPm.textContent = h24 >= 12 ? "PM" : "AM";

      const month = now.toLocaleString("en-US", { month: "short" });
      if (this.elDate) this.elDate.textContent = `${now.getDate()} ${month} ${now.getFullYear()}`;
      if (this.elDay) {
        this.elDay.textContent = now.toLocaleString("en-US", { weekday: "long" }).toUpperCase();
      }

      let icon = "🌙";
      let text = "Night";
      if (h24 >= 5 && h24 < 7) {
        icon = "🌅";
        text = "Dawn";
      } else if (h24 >= 7 && h24 < 12) {
        icon = "☀️";
        text = "Morning";
      } else if (h24 >= 12 && h24 < 17) {
        icon = "☀️";
        text = "Afternoon";
      } else if (h24 >= 17 && h24 < 20) {
        icon = "🌇";
        text = "Evening";
      }
      if (this.elPhaseIcon) this.elPhaseIcon.textContent = icon;
      if (this.elPhaseText) this.elPhaseText.textContent = text;

      Weather.tick();
    }
  };

  // =====================================================================
  // PART 25 — LOCATIONS (normalize, recent searches, geocoding)
  // =====================================================================
  const DEFAULT_LOCATION = {
    name: "Jeddah",
    sub: "Makkah Region, Saudi Arabia",
    cc: "SA",
    lat: 21.4858,
    lon: 39.1925,
    source: "default"
  };

  function cleanText(v, max = 80) {
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  }

  function normalizeLocation(o) {
    if (!o || typeof o !== "object") return null;
    const lat = parseFloat(o.lat);
    const lon = parseFloat(o.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return null;
    }
    const cc = cleanText(o.cc, 2).toUpperCase();
    return {
      name: cleanText(o.name) || "Unknown place",
      sub: cleanText(o.sub, 160),
      cc: /^[A-Z]{2}$/.test(cc) ? cc : "",
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
      source: cleanText(o.source, 12) || "search"
    };
  }

  function locationKey(loc) {
    return `${(+loc.lat).toFixed(2)},${(+loc.lon).toFixed(2)}`;
  }

  function locationLabel(loc) {
    return loc.cc ? `${loc.name}, ${loc.cc}` : loc.name;
  }

  function uniqueParts(parts, exclude) {
    const seen = new Set([String(exclude || "").toLowerCase()]);
    return parts.filter((p) => {
      const k = String(p || "").trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const Recents = {
    max: 5,
    list() {
      const raw = storeGet(LS_KEYS.recents, []);
      return Array.isArray(raw) ? raw.map(normalizeLocation).filter(Boolean).slice(0, this.max) : [];
    },
    add(loc) {
      const key = locationKey(loc);
      const list = this.list().filter((l) => locationKey(l) !== key);
      list.unshift({ ...loc, source: "search" });
      storeSet(LS_KEYS.recents, list.slice(0, this.max));
    },
    clear() {
      storeRemove(LS_KEYS.recents);
    }
  };

  const Geo = {
    /** Open-Meteo geocoding (GeoNames): fast, made for autocomplete. */
    async search(query, signal) {
      const url =
        "https://geocoding-api.open-meteo.com/v1/search" +
        `?name=${encodeURIComponent(query)}&count=10&language=${LANG}&format=json`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("Search failed (" + res.status + ")");
      const data = await res.json();
      return (data.results || [])
        .map((r) =>
          normalizeLocation({
            name: r.name,
            sub: uniqueParts([r.admin2, r.admin1, r.country], r.name).join(", "),
            cc: r.country_code,
            lat: r.latitude,
            lon: r.longitude,
            source: "search"
          })
        )
        .filter(Boolean);
    },

    /** OpenStreetMap Nominatim: covers small villages. Max 1 request/second,
     *  only on explicit user action (no autocomplete) per its usage policy. */
    lastExtended: 0,
    async searchExtended(query, signal) {
      const wait = 1100 - (Date.now() - this.lastExtended);
      if (wait > 0) await sleep(wait);
      this.lastExtended = Date.now();
      const url =
        "https://nominatim.openstreetmap.org/search" +
        `?q=${encodeURIComponent(query)}&format=jsonv2&limit=10&addressdetails=1&accept-language=${LANG}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("Search failed (" + res.status + ")");
      const data = await res.json();
      return (Array.isArray(data) ? data : [])
        .map((r) => {
          const a = r.address || {};
          const name =
            r.name || a.village || a.town || a.city || a.hamlet || (r.display_name || "").split(",")[0];
          return normalizeLocation({
            name,
            sub: uniqueParts(
              [a.county || a.state_district || a.city, a.state || a.region, a.country],
              name
            ).join(", "),
            cc: a.country_code,
            lat: r.lat,
            lon: r.lon,
            source: "search"
          });
        })
        .filter(Boolean);
    },

    /** Coordinates → place name (BigDataCloud, free, no key). */
    async reverse(lat, lon) {
      try {
        const res = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=${LANG}`
        );
        if (!res.ok) throw new Error("Reverse geocode failed");
        const d = await res.json();
        const name = d.city || d.locality || d.principalSubdivision || d.countryName || "My Location";
        return {
          name,
          sub: uniqueParts([d.principalSubdivision, d.countryName], name).join(", "),
          cc: d.countryCode || ""
        };
      } catch (err) {
        console.warn("Reverse geocoding failed:", err.message);
        return { name: "My Location", sub: "", cc: "" };
      }
    },

    current() {
      return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) {
          reject({ code: 0, message: "Geolocation not supported" });
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve(pos.coords),
          reject,
          { timeout: 10000, maximumAge: 600000 }
        );
      });
    }
  };

  // =====================================================================
  // PART 26 — WEATHER (current, 24-hour strip, 5-day forecast)
  // =====================================================================
  const WEATHER_CODES = {
    0: ["☀️", "🌙", "Clear sky"],
    1: ["🌤️", "🌙", "Mainly clear"],
    2: ["⛅", "☁️", "Partly cloudy"],
    3: ["☁️", "☁️", "Overcast"],
    45: ["🌫️", "🌫️", "Fog"],
    48: ["🌫️", "🌫️", "Rime fog"],
    51: ["🌦️", "🌧️", "Light drizzle"],
    53: ["🌦️", "🌧️", "Moderate drizzle"],
    55: ["🌧️", "🌧️", "Dense drizzle"],
    56: ["🌧️", "🌧️", "Freezing drizzle"],
    57: ["🌧️", "🌧️", "Dense freezing drizzle"],
    61: ["🌧️", "🌧️", "Slight rain"],
    63: ["🌧️", "🌧️", "Moderate rain"],
    65: ["⛈️", "⛈️", "Heavy rain"],
    66: ["🌧️", "🌧️", "Freezing rain"],
    67: ["🌧️", "🌧️", "Heavy freezing rain"],
    71: ["🌨️", "🌨️", "Slight snow"],
    73: ["🌨️", "🌨️", "Moderate snow"],
    75: ["❄️", "❄️", "Heavy snow"],
    77: ["🌨️", "🌨️", "Snow grains"],
    80: ["🌦️", "🌧️", "Rain showers"],
    81: ["🌧️", "🌧️", "Heavy showers"],
    82: ["⛈️", "⛈️", "Violent showers"],
    85: ["🌨️", "🌨️", "Snow showers"],
    86: ["❄️", "❄️", "Heavy snow showers"],
    95: ["⛈️", "⛈️", "Thunderstorm"],
    96: ["⛈️", "⛈️", "Thunderstorm + hail"],
    99: ["⛈️", "⛈️", "Severe thunderstorm"]
  };

  function decodeWeather(code, isDay = true) {
    const e = WEATHER_CODES[code];
    if (!e) return { icon: "🌡️", desc: "Unknown" };
    return { icon: isDay ? e[0] : e[1], desc: e[2] };
  }

  function uvLevel(uv) {
    if (uv < 3) return ["Low", "uv-low"];
    if (uv < 6) return ["Moderate", "uv-mod"];
    if (uv < 8) return ["High", "uv-high"];
    if (uv < 11) return ["Very high", "uv-vhigh"];
    return ["Extreme", "uv-extreme"];
  }

  // Temperature → color for the 5-day range bars
  const TEMP_STOPS = [
    [-10, [110, 168, 255]],
    [5, [90, 200, 250]],
    [15, [110, 220, 160]],
    [24, [255, 214, 10]],
    [32, [255, 159, 10]],
    [42, [255, 69, 58]]
  ];

  function tempColor(t) {
    if (t <= TEMP_STOPS[0][0]) return `rgb(${TEMP_STOPS[0][1]})`;
    for (let i = 1; i < TEMP_STOPS.length; i++) {
      const [t1, c1] = TEMP_STOPS[i];
      if (t <= t1) {
        const [t0, c0] = TEMP_STOPS[i - 1];
        const k = (t - t0) / (t1 - t0);
        return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",")})`;
      }
    }
    return `rgb(${TEMP_STOPS[TEMP_STOPS.length - 1][1]})`;
  }

  function tempGradient(min, max) {
    const stops = [0, 0.25, 0.5, 0.75, 1].map((k) => tempColor(min + (max - min) * k));
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }

  const WEATHER_REFRESH_MS = 15 * 60 * 1000;

  const Weather = {
    els: {
      locBtn: $id("btn-location"),
      locName: $id("weather-location"),
      locTime: $id("weather-time"),
      updated: $id("weather-updated"),
      temp: $id("weather-temp"),
      icon: $id("weather-icon"),
      desc: $id("weather-desc"),
      hilo: $id("weather-hilo"),
      humidity: $id("weather-humidity"),
      wind: $id("weather-wind"),
      feels: $id("weather-feels"),
      uv: $id("weather-uv"),
      uvBox: $id("weather-uv-box"),
      hourlySection: $id("hourly-section"),
      hourlyTitle: $id("hourly-title"),
      hourlyReset: $id("hourly-reset"),
      hourlyStrip: $id("hourly-strip"),
      dailyList: $id("daily-list"),
      panelLocation: $id("panel-location")
    },

    location: null,
    data: null,
    dataAt: 0,
    reqId: 0,
    controller: null,
    selectedDay: null, // null = "next 24 hours", otherwise index into daily arrays
    lastHourKey: "",

    init(sharedLocation) {
      const saved = normalizeLocation(storeGet(LS_KEYS.location));
      const initial = sharedLocation || saved || DEFAULT_LOCATION;
      this.setLocation(initial, { save: false });

      // Auto-detect only when permission was already granted (no surprise prompt)
      if (!sharedLocation && (!saved || saved.source === "gps")) this.tryAutoLocate();

      setInterval(() => this.refreshIfStale(), 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.refreshIfStale();
      });
      window.addEventListener("online", () => this.refresh());

      this.setupHourlyScroll();
      if (this.els.hourlyReset) {
        this.els.hourlyReset.addEventListener("click", () => this.selectDay(null));
      }
    },

    async tryAutoLocate() {
      if (!navigator.permissions || !navigator.geolocation) return;
      try {
        const status = await navigator.permissions.query({ name: "geolocation" });
        if (status.state === "granted") await this.locateMe();
      } catch {
        /* ignore */
      }
    },

    async locateMe() {
      const coords = await Geo.current();
      const place = await Geo.reverse(coords.latitude, coords.longitude);
      const loc = normalizeLocation({ ...place, lat: coords.latitude, lon: coords.longitude, source: "gps" });
      if (loc) this.setLocation(loc, { save: true });
      return loc;
    },

    setLocation(loc, { save = false } = {}) {
      const normalized = normalizeLocation(loc);
      if (!normalized) return;
      this.location = normalized;
      this.selectedDay = null;
      if (save) storeSet(LS_KEYS.location, normalized);
      this.renderLocation();

      // Instant paint from the last saved forecast for this place (works offline)
      const cached = storeGet(LS_KEYS.weather);
      if (cached && cached.key === locationKey(normalized) && cached.data && cached.data.current) {
        this.render(cached.data, cached.at || 0);
      } else {
        this.data = null;
        this.renderEmpty("Loading…");
      }
      this.refresh();
    },

    renderLocation() {
      const loc = this.location;
      const label = locationLabel(loc);
      if (this.els.locName) this.els.locName.textContent = label;
      if (this.els.locBtn) {
        this.els.locBtn.setAttribute("aria-label", `Location: ${label}. Change location`);
        this.els.locBtn.title = loc.sub ? `${loc.name} — ${loc.sub}` : loc.name;
      }
      if (this.els.panelLocation) this.els.panelLocation.textContent = label;
    },

    refreshIfStale() {
      if (Date.now() - this.dataAt > WEATHER_REFRESH_MS) this.refresh();
    },

    async refresh() {
      const loc = this.location;
      if (!loc) return;
      const id = ++this.reqId;
      if (this.controller) this.controller.abort();
      const controller = (this.controller = new AbortController());

      const url =
        "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${loc.lat}&longitude=${loc.lon}` +
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
        "&hourly=temperature_2m,weather_code,precipitation_probability,is_day,uv_index" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
        "&timezone=auto&forecast_days=5";

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("Weather fetch failed (" + res.status + ")");
        const data = await res.json();
        if (id !== this.reqId) return; // a newer request (another city) won
        const at = Date.now();
        storeSet(LS_KEYS.weather, { key: locationKey(loc), at, data });
        this.render(data, at);
      } catch (err) {
        if (err.name === "AbortError" || id !== this.reqId) return;
        console.warn("Weather error:", err.message);
        if (this.data) {
          this.setUpdated(this.dataAt, true);
        } else {
          this.renderEmpty("Weather unavailable");
        }
      }
    },

    renderEmpty(message) {
      const e = this.els;
      if (e.temp) e.temp.textContent = "--";
      if (e.icon) {
        e.icon.textContent = "☁️";
        e.icon.classList.remove("sunny");
      }
      if (e.desc) e.desc.textContent = message;
      if (e.hilo) e.hilo.textContent = "";
      ["humidity", "wind", "feels", "uv"].forEach((k) => {
        if (e[k]) e[k].textContent = "--";
      });
      if (e.hourlyStrip) e.hourlyStrip.innerHTML = "";
      if (e.dailyList) e.dailyList.innerHTML = "";
      if (e.updated) e.updated.textContent = "";
    },

    setUpdated(at, offline = false) {
      if (!this.els.updated) return;
      if (!at) {
        this.els.updated.textContent = "";
        return;
      }
      const d = new Date(at);
      const t = formatTime12(d.getHours(), d.getMinutes());
      this.els.updated.textContent = offline ? `Offline · ${t}` : `Updated ${t}`;
      this.els.updated.classList.toggle("offline", offline);
    },

    /** "YYYY-MM-DDTHH:MM" for the location's current local time. */
    cityNowIso() {
      const off = this.data && Number.isFinite(this.data.utc_offset_seconds)
        ? this.data.utc_offset_seconds
        : -new Date().getTimezoneOffset() * 60;
      return new Date(Date.now() + off * 1000).toISOString().slice(0, 16);
    },

    nowHourIndex() {
      const h = this.data && this.data.hourly;
      if (!h || !h.time) return -1;
      const key = this.cityNowIso().slice(0, 13);
      return h.time.findIndex((t) => t.slice(0, 13) === key);
    },

    todayIndex() {
      const d = this.data && this.data.daily;
      if (!d || !d.time) return 0;
      const idx = d.time.indexOf(this.cityNowIso().slice(0, 10));
      return idx === -1 ? 0 : idx;
    },

    /** Called every second by the clock. */
    tick() {
      if (this.els.locTime) {
        if (this.data) {
          const iso = this.cityNowIso();
          this.els.locTime.textContent = formatTime12(+iso.slice(11, 13), +iso.slice(14, 16));
        } else {
          const now = new Date();
          this.els.locTime.textContent = formatTime12(now.getHours(), now.getMinutes());
        }
      }
      // Roll the "Now" slot / "Today" row forward as time passes
      if (this.data) {
        const hourKey = this.cityNowIso().slice(0, 13);
        if (this.lastHourKey && hourKey !== this.lastHourKey) {
          this.renderHourly();
          this.renderDaily();
        }
        this.lastHourKey = hourKey;
      }
    },

    render(data, at) {
      if (!data || !data.current) return;
      this.data = data;
      this.dataAt = at || Date.now();
      this.lastHourKey = this.cityNowIso().slice(0, 13);

      const e = this.els;
      const cur = data.current;
      const isDay = cur.is_day !== 0;
      const info = decodeWeather(cur.weather_code, isDay);

      if (e.temp) e.temp.textContent = Math.round(cur.temperature_2m);
      if (e.icon) {
        e.icon.textContent = info.icon;
        e.icon.classList.toggle("sunny", isDay && cur.weather_code <= 2);
      }
      if (e.desc) e.desc.textContent = info.desc;
      if (e.humidity) e.humidity.textContent = Math.round(cur.relative_humidity_2m) + "%";
      if (e.wind) e.wind.textContent = Math.round(cur.wind_speed_10m) + " km/h";
      if (e.feels) e.feels.textContent = Math.round(cur.apparent_temperature) + "°";

      const daily = data.daily;
      const ti = this.todayIndex();
      if (e.hilo && daily && daily.temperature_2m_max) {
        e.hilo.textContent =
          `H: ${Math.round(daily.temperature_2m_max[ti])}°   L: ${Math.round(daily.temperature_2m_min[ti])}°`;
      }

      const hi = this.nowHourIndex();
      const uvRaw = data.hourly && data.hourly.uv_index ? data.hourly.uv_index[hi] : null;
      if (e.uv) {
        if (hi >= 0 && Number.isFinite(uvRaw)) {
          const uv = Math.round(uvRaw);
          const [label, cls] = uvLevel(uv);
          e.uv.textContent = uv;
          e.uv.className = "stat-value " + cls;
          if (e.uvBox) e.uvBox.setAttribute("aria-label", `UV index ${uv}, ${label}`);
          if (e.uvBox) e.uvBox.title = `UV index: ${label}`;
        } else {
          e.uv.textContent = "--";
          e.uv.className = "stat-value";
        }
      }

      const ageMin = (Date.now() - this.dataAt) / 60000;
      this.setUpdated(this.dataAt, ageMin > 30 && !navigator.onLine);
      this.renderHourly();
      this.renderDaily();
      this.tick();
    },

    selectDay(index) {
      const ti = this.todayIndex();
      this.selectedDay = index === null || index === ti || index === this.selectedDay ? null : index;
      this.renderHourly(true);
      this.renderDaily();
      if (this.els.hourlySection && DeviceInfo.isMobile()) {
        this.els.hourlySection.scrollIntoView({
          block: "nearest",
          behavior: reducedMotionQuery.matches ? "auto" : "smooth"
        });
      }
    },

    renderHourly(resetScroll = false) {
      const e = this.els;
      const d = this.data;
      if (!e.hourlyStrip || !d || !d.hourly || !d.hourly.time) return;
      const h = d.hourly;

      let start;
      let title;
      const nowIdx = this.nowHourIndex();
      if (this.selectedDay === null) {
        start = Math.max(0, nowIdx);
        title = "Next 24 hours";
      } else {
        const date = d.daily.time[this.selectedDay];
        start = h.time.findIndex((t) => t.startsWith(date));
        if (start === -1) {
          this.selectedDay = null;
          this.renderHourly(true);
          return;
        }
        title = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
          weekday: "long",
          day: "numeric",
          month: "short",
          timeZone: "UTC"
        });
      }
      const end = Math.min(start + 24, h.time.length);

      if (e.hourlyTitle) e.hourlyTitle.textContent = title;
      if (e.hourlyReset) e.hourlyReset.hidden = this.selectedDay === null;

      const items = [];
      for (let i = start; i < end; i++) {
        const isNow = this.selectedDay === null && i === nowIdx;
        const pop = h.precipitation_probability ? h.precipitation_probability[i] : null;
        items.push({
          key: h.time[i],
          now: isNow,
          label: isNow ? "Now" : h.time[i].slice(11, 16),
          icon: decodeWeather(h.weather_code[i], h.is_day ? h.is_day[i] !== 0 : true).icon,
          pop: Number.isFinite(pop) && pop >= 20 ? Math.round(pop) : null,
          temp: Math.round(h.temperature_2m[i])
        });
      }

      // Sunrise / sunset markers inside the visible window
      const from = this.selectedDay === null ? this.cityNowIso() : h.time[start];
      const to = h.time[end] || "9999";
      const dl = d.daily || {};
      [["sunrise", "🌅", "Sunrise"], ["sunset", "🌇", "Sunset"]].forEach(([field, icon, text]) => {
        (dl[field] || []).forEach((t) => {
          if (typeof t === "string" && t >= from && t < to) {
            items.push({ key: t, sun: true, label: t.slice(11, 16), icon, text });
          }
        });
      });
      items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

      e.hourlyStrip.innerHTML = items
        .map((it) => {
          if (it.sun) {
            return (
              `<div class="hour-item sun" role="listitem" aria-label="${it.text} at ${escapeHtml(it.label)}">` +
              `<span class="hour-time">${escapeHtml(it.label)}</span>` +
              `<span class="hour-icon" aria-hidden="true">${it.icon}</span>` +
              `<span class="hour-temp sun-text">${it.text}</span></div>`
            );
          }
          const popHtml = it.pop !== null
            ? `<span class="hour-pop">${it.pop}%</span>`
            : `<span class="hour-pop empty" aria-hidden="true"></span>`;
          const aria = `${it.now ? "Now" : escapeHtml(it.label)}: ${it.temp}°` +
            (it.pop !== null ? `, ${it.pop}% chance of rain` : "");
          return (
            `<div class="hour-item${it.now ? " now" : ""}" role="listitem" aria-label="${aria}">` +
            `<span class="hour-time">${escapeHtml(it.label)}</span>` +
            `<span class="hour-icon" aria-hidden="true">${it.icon}</span>` +
            popHtml +
            `<span class="hour-temp">${it.temp}°</span></div>`
          );
        })
        .join("");

      if (resetScroll) e.hourlyStrip.scrollLeft = 0;
    },

    renderDaily() {
      const e = this.els;
      const d = this.data;
      if (!e.dailyList || !d || !d.daily || !d.daily.time) return;
      const dl = d.daily;
      const ti = this.todayIndex();
      const days = [];
      for (let j = ti; j < Math.min(ti + 5, dl.time.length); j++) days.push(j);
      if (!days.length) return;

      const mins = days.map((j) => dl.temperature_2m_min[j]);
      const maxs = days.map((j) => dl.temperature_2m_max[j]);
      const gMin = Math.floor(Math.min(...mins));
      const gMax = Math.ceil(Math.max(...maxs));
      const span = Math.max(1, gMax - gMin);
      const gradient = tempGradient(gMin, gMax);
      const curTemp = d.current ? d.current.temperature_2m : null;

      e.dailyList.innerHTML = "";
      days.forEach((j) => {
        const isToday = j === ti;
        const date = dl.time[j];
        const name = isToday
          ? "Today"
          : new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
        const longName = isToday
          ? "Today"
          : new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
        const info = decodeWeather(dl.weather_code[j], true);
        const lo = Math.round(dl.temperature_2m_min[j]);
        const hi = Math.round(dl.temperature_2m_max[j]);
        const popRaw = dl.precipitation_probability_max ? dl.precipitation_probability_max[j] : null;
        const pop = Number.isFinite(popRaw) && popRaw >= 20 ? Math.round(popRaw) : null;

        const left = ((dl.temperature_2m_min[j] - gMin) / span) * 100;
        const right = ((gMax - dl.temperature_2m_max[j]) / span) * 100;
        const selected = this.selectedDay === null ? isToday : this.selectedDay === j;

        const row = createEl("button", "day-row" + (selected ? " selected" : ""));
        row.type = "button";
        row.setAttribute("aria-pressed", String(selected));
        row.setAttribute(
          "aria-label",
          `${longName}: ${info.desc}, low ${lo}°, high ${hi}°` +
            (pop !== null ? `, ${pop}% chance of rain` : "") +
            ". Show hourly forecast"
        );

        row.appendChild(createEl("span", "day-name", name));

        const iconWrap = createEl("span", "day-icon");
        iconWrap.setAttribute("aria-hidden", "true");
        iconWrap.appendChild(createEl("span", "day-emoji", info.icon));
        if (pop !== null) iconWrap.appendChild(createEl("span", "day-pop", pop + "%"));
        row.appendChild(iconWrap);

        const minEl = createEl("span", "day-min", lo + "°");
        minEl.setAttribute("aria-hidden", "true");
        row.appendChild(minEl);

        const bar = createEl("span", "day-bar");
        bar.setAttribute("aria-hidden", "true");
        const fill = createEl("span", "day-bar-fill");
        fill.style.background = gradient;
        fill.style.setProperty("--l", left.toFixed(1) + "%");
        fill.style.setProperty("--r", right.toFixed(1) + "%");
        bar.appendChild(fill);
        if (isToday && Number.isFinite(curTemp)) {
          const dot = createEl("span", "day-dot");
          const x = Math.max(0, Math.min(100, ((curTemp - gMin) / span) * 100));
          dot.style.left = x.toFixed(1) + "%";
          bar.appendChild(dot);
        }
        row.appendChild(bar);

        const maxEl = createEl("span", "day-max", hi + "°");
        maxEl.setAttribute("aria-hidden", "true");
        row.appendChild(maxEl);

        row.addEventListener("click", () => this.selectDay(j));
        e.dailyList.appendChild(row);
      });
    },

    /** Mouse wheel + drag scrolling for the hourly strip on desktop. */
    setupHourlyScroll() {
      const strip = this.els.hourlyStrip;
      if (!strip) return;

      strip.addEventListener(
        "wheel",
        (ev) => {
          if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
          const max = strip.scrollWidth - strip.clientWidth;
          if (max <= 0) return;
          const next = strip.scrollLeft + ev.deltaY;
          if ((ev.deltaY < 0 && strip.scrollLeft <= 0) || (ev.deltaY > 0 && strip.scrollLeft >= max)) return;
          ev.preventDefault();
          strip.scrollLeft = Math.max(0, Math.min(max, next));
        },
        { passive: false }
      );

      let dragging = false;
      let startX = 0;
      let startLeft = 0;
      strip.addEventListener("pointerdown", (ev) => {
        if (ev.pointerType !== "mouse" || ev.button !== 0) return;
        dragging = true;
        startX = ev.clientX;
        startLeft = strip.scrollLeft;
        strip.classList.add("dragging");
      });
      window.addEventListener("pointermove", (ev) => {
        if (!dragging) return;
        strip.scrollLeft = startLeft - (ev.clientX - startX);
      });
      window.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        strip.classList.remove("dragging");
      });
    }
  };

  // =====================================================================
  // PART 27 — CITY / VILLAGE SEARCH
  // =====================================================================
  const CitySearch = {
    dialog: $id("search-dialog"),
    input: $id("search-input"),
    list: $id("search-results"),
    listHead: $id("search-list-head"),
    listTitle: $id("search-list-title"),
    clearRecentsBtn: $id("search-clear-recents"),
    status: $id("search-status"),
    geoBtn: $id("search-geo"),
    extBtn: $id("search-extended"),
    attrib: $id("search-attrib"),
    closeBtn: $id("search-close"),

    items: [],
    activeIndex: -1,
    mode: "recent",
    reqId: 0,
    controller: null,
    opener: null,

    isOpen() {
      return !!this.dialog && this.dialog.open;
    },

    init() {
      if (!this.dialog || !this.input) return;

      this.onInput = debounce(() => this.handleQuery(), 300);
      this.input.addEventListener("input", () => {
        this.extBtn.hidden = this.input.value.trim().length < 2;
        this.onInput();
      });
      this.input.addEventListener("keydown", (e) => this.handleKey(e));
      this.closeBtn.addEventListener("click", () => this.close());
      this.geoBtn.addEventListener("click", () => this.useMyLocation());
      this.extBtn.addEventListener("click", () => this.searchExtended());
      this.clearRecentsBtn.addEventListener("click", () => {
        Recents.clear();
        this.showRecents();
        this.input.focus();
      });

      // Click on the dimmed backdrop closes the dialog
      this.dialog.addEventListener("click", (e) => {
        if (e.target === this.dialog) this.close();
      });
      this.dialog.addEventListener("close", () => {
        this.abort();
        this.onInput.cancel();
        if (this.opener && document.contains(this.opener)) this.opener.focus();
      });
    },

    open(opener) {
      if (!this.dialog) return;
      this.opener = opener || document.activeElement;
      this.input.value = "";
      this.extBtn.hidden = true;
      this.showRecents();
      if (typeof this.dialog.showModal === "function") {
        if (!this.dialog.open) this.dialog.showModal();
      } else {
        this.dialog.setAttribute("open", "");
      }
      setTimeout(() => this.input.focus(), 30);
    },

    close() {
      if (!this.dialog) return;
      if (typeof this.dialog.close === "function") this.dialog.close();
      else this.dialog.removeAttribute("open");
    },

    abort() {
      this.reqId++;
      if (this.controller) this.controller.abort();
      this.controller = null;
      this.input.removeAttribute("aria-busy");
    },

    setStatus(text) {
      this.status.textContent = text || "";
    },

    showRecents() {
      this.abort();
      const recents = Recents.list();
      this.attrib.hidden = true;
      this.render(recents, "recent");
      this.listHead.hidden = recents.length === 0;
      this.listTitle.textContent = "Recent";
      this.clearRecentsBtn.hidden = recents.length === 0;
      this.setStatus(recents.length ? "" : "Type a city, town or village name");
    },

    handleQuery() {
      const q = this.input.value.trim();
      if (q.length < 2) {
        this.showRecents();
        return;
      }
      this.search(q);
    },

    async run(fetcher, mode, q) {
      this.abort();
      const id = this.reqId;
      const controller = (this.controller = new AbortController());
      this.input.setAttribute("aria-busy", "true");
      this.setStatus(mode === "extended" ? "Searching OpenStreetMap…" : "Searching…");
      try {
        const results = await fetcher(q, controller.signal);
        if (id !== this.reqId) return;
        this.input.removeAttribute("aria-busy");
        this.listHead.hidden = results.length === 0;
        this.listTitle.textContent = mode === "extended" ? "Extended results" : "Results";
        this.clearRecentsBtn.hidden = true;
        this.attrib.hidden = mode !== "extended";
        this.render(results, mode);
        if (results.length) {
          this.setStatus(`${results.length} result${results.length > 1 ? "s" : ""}`);
        } else {
          this.setStatus(
            mode === "extended"
              ? "No places found. Check the spelling or try another name."
              : "No results — try the extended search below."
          );
        }
        this.extBtn.hidden = mode === "extended";
      } catch (err) {
        if (err.name === "AbortError" || id !== this.reqId) return;
        this.input.removeAttribute("aria-busy");
        this.setStatus("Search failed — check your connection.");
      }
    },

    search(q) {
      return this.run((query, signal) => Geo.search(query, signal), "results", q);
    },

    searchExtended() {
      const q = this.input.value.trim();
      if (q.length < 2) return;
      this.onInput.cancel();
      return this.run((query, signal) => Geo.searchExtended(query, signal), "extended", q);
    },

    render(items, mode) {
      // de-duplicate by coordinates
      const seen = new Set();
      this.items = items.filter((loc) => {
        const k = locationKey(loc);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      this.mode = mode;
      this.activeIndex = -1;
      this.input.removeAttribute("aria-activedescendant");
      this.list.innerHTML = "";

      this.items.forEach((loc, i) => {
        const li = createEl("li", "search-option");
        li.id = "search-opt-" + i;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");

        const flag = createEl("span", "opt-flag", flagEmoji(loc.cc));
        flag.setAttribute("aria-hidden", "true");
        const text = createEl("span", "opt-text");
        const name = createEl("span", "opt-name", loc.name);
        name.dir = "auto";
        text.appendChild(name);
        if (loc.sub) {
          const sub = createEl("span", "opt-sub", loc.sub);
          sub.dir = "auto";
          text.appendChild(sub);
        }
        li.append(flag, text);

        li.addEventListener("click", () => this.select(i));
        li.addEventListener("mousemove", () => this.setActive(i, false));
        this.list.appendChild(li);
      });

      this.input.setAttribute("aria-expanded", String(this.items.length > 0));
    },

    setActive(i, scroll = true) {
      const options = this.list.querySelectorAll(".search-option");
      options.forEach((el, j) => {
        const on = j === i;
        el.classList.toggle("active", on);
        el.setAttribute("aria-selected", String(on));
      });
      this.activeIndex = i;
      if (i >= 0 && options[i]) {
        this.input.setAttribute("aria-activedescendant", options[i].id);
        if (scroll) options[i].scrollIntoView({ block: "nearest" });
      } else {
        this.input.removeAttribute("aria-activedescendant");
      }
    },

    handleKey(e) {
      const n = this.items.length;
      if (e.key === "ArrowDown" && n) {
        e.preventDefault();
        this.setActive((this.activeIndex + 1) % n);
      } else if (e.key === "ArrowUp" && n) {
        e.preventDefault();
        this.setActive((this.activeIndex - 1 + n) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (this.activeIndex >= 0) {
          this.select(this.activeIndex);
        } else if (this.input.value.trim().length >= 2) {
          // Enter = search now; on results with no match → extended search
          if (this.mode === "results" && n === 0) this.searchExtended();
          else if (this.mode === "results" && n > 0) this.select(0);
          else {
            this.onInput.cancel();
            this.search(this.input.value.trim());
          }
        }
      }
    },

    select(i) {
      const loc = this.items[i];
      if (!loc) return;
      Weather.setLocation(loc, { save: true });
      Recents.add(loc);
      this.close();
      showToast(`📍 ${locationLabel(loc)}`, "success");
    },

    async useMyLocation() {
      this.abort();
      this.setStatus("Locating…");
      this.geoBtn.disabled = true;
      try {
        const loc = await Weather.locateMe();
        if (!this.isOpen()) return;
        this.close();
        if (loc) showToast(`📍 ${locationLabel(loc)}`, "success");
      } catch (err) {
        const messages = {
          1: "Location permission denied. Allow it in your browser settings, or search instead.",
          2: "Your location is unavailable right now.",
          3: "Locating timed out. Try again."
        };
        this.setStatus(messages[err && err.code] || "Could not get your location.");
      } finally {
        this.geoBtn.disabled = false;
      }
    }
  };

  // =====================================================================
  // PART 28 — TOUCH SUPPORT (swipe to close the settings panel)
  // =====================================================================
  function setupTouchSupport() {
    if (!panel) return;
    let startX = 0;
    let startY = 0;
    let startScroll = 0;

    panel.addEventListener(
      "touchstart",
      (e) => {
        const t = e.changedTouches[0];
        startX = t.clientX;
        startY = t.clientY;
        startScroll = panel.scrollTop;
      },
      { passive: true }
    );

    panel.addEventListener(
      "touchend",
      (e) => {
        if (!isPanelOpen()) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        const isSheet = window.innerWidth <= 480;
        if (isSheet && dy > 90 && Math.abs(dx) < 60 && startScroll <= 0) togglePanel(false);
        if (!isSheet && dx > 90 && Math.abs(dy) < 60) togglePanel(false);
      },
      { passive: true }
    );
  }

  // =====================================================================
  // PART 29 — KEYBOARD SHORTCUTS
  // ---------------------------------------------------------------------
  // e.code (physical key) works with any keyboard layout, incl. Arabic.
  // =====================================================================
  function setupKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (CitySearch.isOpen()) return; // the dialog handles its own keys
      const t = e.target;
      const tag = t && t.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable);

      if (e.key === "Escape") {
        if (isPanelOpen()) togglePanel(false);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.code) {
        case "KeyS":
          e.preventDefault();
          setSound(!AudioManager.isPlaying);
          break;
        case "KeyF":
          if (FullscreenAPI.supported()) {
            e.preventDefault();
            FullscreenAPI.toggle();
          }
          break;
        case "KeyP":
          e.preventDefault();
          togglePanel();
          break;
        case "Slash":
          e.preventDefault();
          CitySearch.open();
          break;
        default:
          break;
      }
    });
  }

  // =====================================================================
  // PART 30 — MAIN INITIALIZATION
  // =====================================================================
  function init() {
    AudioManager.init(rainAudio);
    PWAManager.init();
    FullscreenAPI.init();
    setupMediaHandlers();
    setupFocusTrap();

    const fromUrl = loadFromUrl();
    if (!fromUrl.hasSettings) loadFromLocalStorage();

    createPresets();
    applyStateToUI();
    ensureRain();

    if (state.currentPresetIndex >= 0 && state.currentPresetIndex < PRESETS.length) {
      const p = PRESETS[state.currentPresetIndex];
      setBackground(p.url, p.type, state.currentPresetIndex);
    } else if (isValidUrl(state.currentUrl)) {
      setBackground(state.currentUrl, state.currentType, -1);
    } else {
      setBackground(PRESETS[0].url, PRESETS[0].type, 0);
    }

    setupSlider("blur", "blur", "px");
    setupSlider("brightness", "brightness", "%");
    setupSlider("rain", "rain", "%");
    setupSlider("overlay", "overlayOpacity", "%");

    const volumeSlider = $id("volume-range");
    const volumeDisplay = $id("volume-val");
    if (volumeSlider && volumeDisplay) {
      volumeSlider.addEventListener("input", (e) => {
        state.volume = parseInt(e.target.value, 10) || 0;
        volumeDisplay.textContent = state.volume + "%";
        AudioManager.setVolume(state.volume / 100);
      });
    }

    setupAudioUnlock();

    if (settingsBtn) {
      settingsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePanel();
      });
    }

    const panelCloseBtn = $id("panel-close");
    if (panelCloseBtn) panelCloseBtn.addEventListener("click", () => togglePanel(false));

    const skipLink = document.querySelector(".skip-link");
    if (skipLink) {
      skipLink.addEventListener("click", (e) => {
        e.preventDefault();
        togglePanel(true);
      });
    }

    if (soundBtn) {
      soundBtn.addEventListener("click", () => setSound(!AudioManager.isPlaying));
    }

    // Click outside closes the side panel (desktop)
    document.addEventListener("click", (e) => {
      if (
        window.innerWidth > 768 &&
        isPanelOpen() &&
        !panel.contains(e.target) &&
        !e.target.closest(".ui-btn") &&
        !e.target.closest(".skip-link") &&
        !e.target.closest("#search-dialog")
      ) {
        togglePanel(false);
      }
    });

    document.querySelectorAll(".color-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".color-btn").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-checked", "true");
        state.overlayColor = OVERLAY_COLORS.includes(btn.dataset.color) ? btn.dataset.color : "none";

        const overlayRange = $id("overlay-range");
        const overlayVal = $id("overlay-val");
        if (state.overlayColor === "none") {
          state.overlayOpacity = 0;
        } else if (state.overlayOpacity === 0) {
          state.overlayOpacity = 30;
        }
        if (overlayRange) overlayRange.value = state.overlayOpacity;
        if (overlayVal) overlayVal.textContent = state.overlayOpacity + "%";
      });
    });

    const urlBtn = $id("url-btn");
    const urlInput = $id("url-input");
    if (urlBtn) {
      urlBtn.addEventListener("click", () => {
        const raw = urlInput ? urlInput.value.trim() : "";
        if (!raw) {
          showToast("Please enter a URL", "error");
          return;
        }
        const safe = sanitizeUrl(raw);
        if (!safe) {
          showToast("Invalid or unsafe URL", "error");
          return;
        }
        const type = isVideoUrl(safe) ? "video" : "image";
        setBackground(safe, type, -1);
        if (urlInput) urlInput.value = "";
      });
    }
    if (urlInput) {
      urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && urlBtn) urlBtn.click();
      });
    }

    const fileBtn = $id("file-btn");
    const fileInput = $id("file-input");
    if (fileBtn && fileInput) fileBtn.addEventListener("click", () => fileInput.click());
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
          if (file.size > 50 * 1024 * 1024) {
            showToast("File too large (max 50MB)", "error");
          } else {
            const blobUrl = ResourceManager.createBlobUrl(file);
            const type = file.type.startsWith("video/") ? "video" : "image";
            setBackground(blobUrl, type, -1);
          }
        }
        e.target.value = "";
      });
    }

    const shareBtn = $id("btn-share");
    if (shareBtn) shareBtn.addEventListener("click", shareSettings);

    const saveBtn = $id("btn-save");
    if (saveBtn) saveBtn.addEventListener("click", saveToLocalStorage);

    const resetBtn = $id("btn-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (confirm("Reset all settings to defaults?")) resetToDefaults();
      });
    }

    const locBtn = $id("btn-location");
    if (locBtn) locBtn.addEventListener("click", () => CitySearch.open(locBtn));

    const changeLocBtn = $id("btn-change-location");
    if (changeLocBtn) {
      changeLocBtn.addEventListener("click", () => {
        togglePanel(false);
        CitySearch.open(locBtn);
      });
    }

    setupKeyboard();

    // Free uploaded files only when the page is really unloaded (keeps bfcache working)
    window.addEventListener("pagehide", (e) => {
      if (!e.persisted) ResourceManager.revokeAll();
    });

    document.addEventListener("visibilitychange", () => {
      if (state.currentType !== "video") return;
      if (document.hidden) customVideo.pause();
      else customVideo.play().catch(() => {});
    });

    window.addEventListener(
      "resize",
      debounce(() => {
        const blurRange = $id("blur-range");
        const max = DeviceInfo.getMaxBlur();
        if (blurRange) blurRange.max = max;
        if (state.blur > max) {
          state.blur = max;
          applyStateToUI();
        }
      }, 200)
    );

    const onMotionPref = () => {
      if (rainyGlassInstance) rainyGlassInstance.setOptions({ reducedMotion: reducedMotionQuery.matches });
    };
    if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener("change", onMotionPref);

    setupTouchSupport();
    CitySearch.init();
    Weather.init(fromUrl.location);
    Clock.start();

    console.log(
      `%c Weather Cloud %c v${APP_VERSION} %c by SAIF G.M.D `,
      "background:linear-gradient(135deg,#6cf,#8af);color:#000;font-weight:bold;padding:4px 8px;border-radius:4px 0 0 4px",
      "background:#1a1f2a;color:#6cf;padding:4px 8px",
      "background:#0a0e14;color:#8af;padding:4px 8px;border-radius:0 4px 4px 0"
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
