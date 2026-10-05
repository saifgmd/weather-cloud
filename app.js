/* =====================================================================
 *  Weather Cloud
 *  --------------------------------------------------------------------
 *  Interactive rainy window with WebGL raindrops, live clock, weather.
 *
 *  @project  Weather Cloud
 *  @author   SAIF G.M.D
 *  @version  1.0.0
 * ===================================================================== */

(function () {
  "use strict";

  // =====================================================================
  // PART 1 — RAINYGLASS ENGINE (Self-contained WebGL raindrops)
  // =====================================================================
  const MAX_DROPLETS = 120;

  class RainyGlass {
    constructor(canvas, options = {}) {
      if (!canvas) throw new Error("RainyGlass: canvas is required");

      this.canvas = canvas;
      this.gl = null;
      this.program = null;
      this.texture = null;

      this.options = Object.assign(
        {
          dropletsRate: 45,
          maxDroplets: MAX_DROPLETS,
          minRadius: 8,
          maxRadius: 38,
          fallSpeed: 0.18,
          refraction: 1.4,
          blurStrength: 0.9,
          highlight: 0.35
        },
        options
      );

      this.droplets = [];
      this.lastSpawn = 0;
      this.lastTime = 0;
      this.isRunning = false;
      this.isDestroyed = false;
      this.rafId = null;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.bgImage = null;

      this._loop = this._loop.bind(this);
      this._onResize = this._onResize.bind(this);

      this._initWebGL();
      this.resize();
      window.addEventListener("resize", this._onResize);
    }

    _initWebGL() {
      const gl =
        this.canvas.getContext("webgl", {
          alpha: true,
          premultipliedAlpha: false,
          antialias: true
        }) ||
        this.canvas.getContext("experimental-webgl", { alpha: true });

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
        precision highp float;
        #define MAX_DROPLETS ${MAX_DROPLETS}
        varying vec2 v_uv;
        uniform sampler2D u_bg;
        uniform vec2 u_resolution;
        uniform int u_count;
        uniform vec2 u_droplets[MAX_DROPLETS];
        uniform float u_radii[MAX_DROPLETS];
        uniform float u_refraction;
        uniform float u_blur;
        uniform float u_highlight;

        void main() {
          vec2 uv = v_uv;
          vec2 pixel = uv * u_resolution;

          for (int i = 0; i < MAX_DROPLETS; i++) {
            if (i >= u_count) break;
            vec2 dpos = u_droplets[i] * u_resolution;
            float r = u_radii[i];
            vec2 diff = pixel - dpos;
            float dist = length(diff);

            if (dist < r) {
              float ratio = dist / r;
              float strength = (1.0 - ratio) * u_refraction * 0.028;
              vec2 dir = dist > 0.0 ? normalize(diff) : vec2(0.0);
              uv += dir * strength;

              float b = (1.0 - ratio) * u_blur * 0.004;
              vec4 c1 = texture2D(u_bg, uv + vec2(b, 0.0));
              vec4 c2 = texture2D(u_bg, uv - vec2(b, 0.0));
              vec4 c3 = texture2D(u_bg, uv + vec2(0.0, b));
              vec4 c4 = texture2D(u_bg, uv - vec2(0.0, b));
              vec4 blurred = (c1 + c2 + c3 + c4) * 0.25;

              float highlight = smoothstep(0.82, 1.0, ratio);
              gl_FragColor = mix(blurred, vec4(1.0), highlight * u_highlight);
              return;
            }
          }

          gl_FragColor = texture2D(u_bg, uv);
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

      this.uBg = gl.getUniformLocation(this.program, "u_bg");
      this.uResolution = gl.getUniformLocation(this.program, "u_resolution");
      this.uCount = gl.getUniformLocation(this.program, "u_count");
      this.uDroplets = gl.getUniformLocation(this.program, "u_droplets");
      this.uRadii = gl.getUniformLocation(this.program, "u_radii");
      this.uRefraction = gl.getUniformLocation(this.program, "u_refraction");
      this.uBlur = gl.getUniformLocation(this.program, "u_blur");
      this.uHighlight = gl.getUniformLocation(this.program, "u_highlight");

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

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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

    loadBackground(source) {
      if (!this.gl) return Promise.reject(new Error("WebGL not initialized"));

      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";

        img.onload = () => {
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          this.bgImage = img;
          resolve(img);
        };

        img.onerror = () => reject(new Error("Failed to load background"));
        img.src = source;
      });
    }

    setOptions(partial) {
      Object.assign(this.options, partial);
    }

    start() {
      if (this.isRunning || this.isDestroyed) return;
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
    }

    destroy() {
      this.isDestroyed = true;
      this.stop();
      window.removeEventListener("resize", this._onResize);
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
      console.log("[RainyGlass] destroyed");
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

    _updateDroplets(dt) {
      const opts = this.options;
      this.lastSpawn += dt;
      const spawnInterval = 1 / opts.dropletsRate;

      while (this.lastSpawn > spawnInterval) {
        this.lastSpawn -= spawnInterval;
        if (this.droplets.length < opts.maxDroplets) {
          this.droplets.push({
            x: Math.random(),
            y: -0.05 - Math.random() * 0.1,
            r: opts.minRadius + Math.random() * (opts.maxRadius - opts.minRadius),
            vy: opts.fallSpeed * (0.7 + Math.random() * 0.8),
            vx: (Math.random() - 0.5) * 0.015,
            life: 1
          });
        }
      }

      for (let i = this.droplets.length - 1; i >= 0; i--) {
        const d = this.droplets[i];
        d.y += d.vy * dt;
        d.x += d.vx * dt;
        d.vy += 0.03 * dt;
        d.life -= dt * 0.06;
        if (d.y > 1.15 || d.life <= 0) this.droplets.splice(i, 1);
      }
    }

    _render() {
      const gl = this.gl;
      if (!gl || !this.program) return;

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);

      const count = Math.min(this.droplets.length, MAX_DROPLETS);
      const positions = new Float32Array(MAX_DROPLETS * 2);
      const radii = new Float32Array(MAX_DROPLETS);

      for (let i = 0; i < count; i++) {
        const d = this.droplets[i];
        positions[i * 2] = d.x;
        positions[i * 2 + 1] = 1 - d.y;
        radii[i] = (d.r / this.canvas.width) * this.dpr * 1.2;
      }

      gl.uniform1i(this.uCount, count);
      gl.uniform2fv(this.uDroplets, positions);
      gl.uniform1fv(this.uRadii, radii);
      gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.uRefraction, this.options.refraction);
      gl.uniform1f(this.uBlur, this.options.blurStrength);
      gl.uniform1f(this.uHighlight, this.options.highlight);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.uBg, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // =====================================================================
  // PART 2 — UTILITIES
  // =====================================================================
  function $id(id) {
    return document.getElementById(id);
  }

  function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
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
    return /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url);
  }

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
    isIOS() {
      return /iPad|iPhone|iPod/.test(navigator.userAgent);
    },
    getMaxBlur() {
      return this.isMobile() ? 15 : 25;
    }
  };

  // =====================================================================
  // PART 4 — FULLSCREEN
  // =====================================================================
  const FullscreenAPI = {
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
        return Promise.reject(new Error("Not supported"));
      }
      try {
        const result = requestMethod.call(element);
        if (result && typeof result.then === "function") {
          return result.catch((err) => console.warn("Fullscreen error:", err));
        }
        return Promise.resolve();
      } catch (err) {
        console.error("Fullscreen exception:", err);
        return Promise.reject(err);
      }
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
          return Promise.resolve();
        } catch (err) {
          return Promise.reject(err);
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
      btn.setAttribute(
        "aria-label",
        isFullscreen ? "Exit fullscreen" : "Enter fullscreen mode"
      );
      btn.title = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
      btn.classList.toggle("active", isFullscreen);
    },
    init() {
      const self = this;
      [
        "fullscreenchange",
        "webkitfullscreenchange",
        "mozfullscreenchange",
        "MSFullscreenChange"
      ].forEach((eventName) => {
        document.addEventListener(
          eventName,
          () => self.updateButtonIcon(self.isFullscreen()),
          false
        );
      });
    }
  };

  // =====================================================================
  // PART 5 — AUDIO MANAGER
  // =====================================================================
  const AudioManager = {
    audio: null,
    sources: [],
    currentSourceIndex: 0,
    allSourcesFailed: false,
    loadAttempts: 0,
    maxLoadAttempts: 3,

    init(audioElement) {
      if (!audioElement) {
        console.warn("AudioManager: no audio element provided");
        this.allSourcesFailed = true;
        return;
      }
      this.audio = audioElement;
      this.sources = Array.from(audioElement.querySelectorAll("source"))
        .map((s) => s.src || s.getAttribute("src"))
        .filter(Boolean);

      if (this.sources.length === 0 && !audioElement.src) {
        console.warn("AudioManager: no audio sources found");
        this.allSourcesFailed = true;
        return;
      }
      this.setupEventListeners();
    },

    setupEventListeners() {
      if (!this.audio) return;
      const self = this;
      this.audio.addEventListener(
        "error",
        () => {
          console.warn("Audio source error:", self.audio && self.audio.currentSrc);
          self.tryNextSource();
        },
        true
      );
      this.audio.addEventListener("loadeddata", () => {
        console.log("Audio loaded:", self.audio && self.audio.currentSrc);
        self.loadAttempts = 0;
        self.allSourcesFailed = false;
      });
    },

    tryNextSource() {
      if (!this.audio) return;
      this.loadAttempts++;
      if (this.loadAttempts > this.maxLoadAttempts) {
        this.currentSourceIndex++;
        this.loadAttempts = 0;
      }
      if (this.currentSourceIndex >= this.sources.length) {
        if (!this.allSourcesFailed) {
          this.allSourcesFailed = true;
          console.error("All audio sources failed");
          state.soundOn = false;
          syncSoundUI();
        }
        return;
      }
      console.log("Trying fallback:", this.sources[this.currentSourceIndex]);
      this.audio.src = this.sources[this.currentSourceIndex];
      this.audio.load();
    },

    play() {
      if (!this.audio || this.allSourcesFailed) {
        return Promise.reject(new Error("Audio not available"));
      }
      return this.audio.play();
    },
    pause() {
      if (this.audio) this.audio.pause();
    },
    setVolume(volume) {
      if (!this.audio) return;
      this.audio.volume = Math.max(0, Math.min(1, volume));
    }
  };

  // =====================================================================
  // PART 6 — RESOURCE MANAGER
  // =====================================================================
  const ResourceManager = {
    blobUrls: new Set(),

    createBlobUrl(blob) {
      const url = URL.createObjectURL(blob);
      this.blobUrls.add(url);
      return url;
    },
    revokeAllBlobUrls() {
      if (this.blobUrls.size === 0) return;
      this.blobUrls.forEach((url) => URL.revokeObjectURL(url));
      this.blobUrls.clear();
    },
    cleanup() {
      this.revokeAllBlobUrls();
      destroyRainyGlass();
      console.log("[WeatherCloud] Resources cleaned up");
    }
  };

  // =====================================================================
  // PART 7 — LOADING CONTROLLER
  // =====================================================================
  const LoadingController = {
    currentLoadId: null,
    startLoading() {
      const loadId = Date.now() + "-" + Math.random().toString(36).slice(2, 11);
      this.currentLoadId = loadId;
      return loadId;
    },
    isCurrentLoading(id) {
      return this.currentLoadId === id;
    },
    cancelAll() {
      this.currentLoadId = null;
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
      const hostname = window.location.hostname;
      if (hostname.includes("cdpn.io") || hostname.includes("codepen.io")) {
        console.log("PWA: Service Worker skipped on CodePen");
        return;
      }
      if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
          navigator.serviceWorker
            .register("./sw.js")
            .then((reg) => console.log("SW registered:", reg.scope))
            .catch((err) => console.warn("SW registration failed:", err));
        });
      }
    },

    setupInstallPrompt() {
      const self = this;
      window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        self.deferredPrompt = e;
        if (self.installButton) self.installButton.classList.remove("hidden");
        console.log("PWA installable");
      });
      if (this.installButton) {
        this.installButton.addEventListener("click", () => self.promptInstall());
      }
      window.addEventListener("appinstalled", () => {
        self.deferredPrompt = null;
        if (self.installButton) self.installButton.classList.add("hidden");
        showToast("App installed!", "success");
      });
    },

    async promptInstall() {
      if (!this.deferredPrompt) {
        showToast("App is already installed or not supported", "info");
        return;
      }
      this.deferredPrompt.prompt();
      const { outcome } = await this.deferredPrompt.userChoice;
      console.log("Install outcome:", outcome);
      this.deferredPrompt = null;
    }
  };

  // =====================================================================
  // PART 9 — CONFIG & PRESETS (CORS-friendly sources)
  // =====================================================================
  const PRESETS = [
    {
      type: "image",
      label: "City",
      url: "https://picsum.photos/id/1015/1920/1080",
      thumb: "https://picsum.photos/id/1015/300/200"
    },
    {
      type: "image",
      label: "Forest",
      url: "https://picsum.photos/id/1018/1920/1080",
      thumb: "https://picsum.photos/id/1018/300/200"
    },
    {
      type: "image",
      label: "Mountain",
      url: "https://picsum.photos/id/1016/1920/1080",
      thumb: "https://picsum.photos/id/1016/300/200"
    },
    {
      type: "image",
      label: "Towers",
      url: "https://picsum.photos/id/1031/1920/1080",
      thumb: "https://picsum.photos/id/1031/300/200"
    },
    {
      type: "image",
      label: "Future",
      url: "https://picsum.photos/id/1041/1920/1080",
      thumb: "https://picsum.photos/id/1041/300/200"
    },
    {
      type: "image",
      label: "Sky",
      url: "https://picsum.photos/id/1019/1920/1080",
      thumb: "https://picsum.photos/id/1019/300/200"
    },
    {
      type: "video",
      label: "Hurricane",
      url: "https://cdn.pixabay.com/v
