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
  // PART 9 — CONFIG & PRESETS
  // =====================================================================
  const CONFIG = {
    codepenUrl: "",
    productionUrl: ""
  };

  const PRESETS = [
    {
      type: "image",
      label: "City",
      url: "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1920&q=80",
      thumb: "https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=300&q=60"
    },
    {
      type: "image",
      label: "Forest",
      url: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80",
      thumb: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=300&q=60"
    },
    {
      type: "image",
      label: "Mountain",
      url: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1920&q=80",
      thumb: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=300&q=60"
    },
    {
      type: "image",
      label: "Towers",
      url: "https://images.unsplash.com/photo-1514565131-fce0801e5785?w=1920&q=80",
      thumb: "https://images.unsplash.com/photo-1514565131-fce0801e5785?w=300&q=60"
    },
    {
      type: "image",
      label: "Future",
      url: "https://images.unsplash.com/photo-1494522855154-9297ac14b55f?w=1920&q=80",
      thumb: "https://images.unsplash.com/photo-1494522855154-9297ac14b55f?w=300&q=60"
    },
    {
      type: "image",
      label: "Sky",
      url: "https://images.unsplash.com/photo-1534088568595-a066f410bcda?w=1920&q=80",
      thumb: "https://images.unsplash.com/photo-1534088568595-a066f410bcda?w=300&q=60"
    },
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

  let state = new Proxy(
    { ...DEFAULT_STATE },
    {
      set(target, property, value) {
        const oldValue = target[property];
        if (property === "blur") {
          value = Math.min(value, DeviceInfo.getMaxBlur());
        }
        target[property] = value;
        if (oldValue !== value) {
          const visualProps = ["blur", "brightness", "rain", "overlayColor", "overlayOpacity"];
          if (visualProps.includes(property)) updateFilters();
        }
        return true;
      },
      get(target, property) {
        return target[property];
      }
    }
  );

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
  // PART 11 — HELPERS
  // =====================================================================
  function showToast(message, type = "info") {
    if (!toast) {
      console.log("[Toast]", message);
      return;
    }
    toast.textContent = message;
    toast.className = "toast show";
    if (type === "error") toast.classList.add("error");
    if (type === "success") toast.classList.add("success");
    setTimeout(() => toast.classList.remove("show", "error", "success"), 2500);
  }

  function showLoader(text = "Loading...") {
    if (!loadingOverlay) return;
    const textEl = loadingOverlay.querySelector(".loader-text");
    if (textEl) textEl.textContent = text;
    loadingOverlay.classList.add("active");
  }

  function hideLoader() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.remove("active");
  }

  const updateFilters = throttle(function () {
    if (!customBg || !customVideo || !canvas || !colorOverlay) return;
    const filter = `blur(${state.blur}px) brightness(${state.brightness / 100})`;
    customBg.style.filter = filter;
    customVideo.style.filter = filter;
    canvas.style.opacity = state.rain / 100;

    if (state.overlayColor !== "none" && state.overlayOpacity > 0) {
      colorOverlay.style.backgroundColor = state.overlayColor;
      colorOverlay.style.opacity = state.overlayOpacity / 100;
    } else {
      colorOverlay.style.opacity = 0;
    }
  }, 16);

  // =====================================================================
  // PART 12 — RAINYGLASS INTEGRATION
  // =====================================================================
  let rainyGlassInstance = null;

  function initRainyGlass() {
    if (!canvas || !customBg) return null;
    if (rainyGlassInstance && !rainyGlassInstance.isDestroyed) {
      return rainyGlassInstance;
    }

    const bgSrc = customBg.currentSrc || customBg.src;
    if (!bgSrc) {
      console.warn("[WeatherCloud] No background source");
      return null;
    }

    try {
      if (!rainyGlassInstance) {
        rainyGlassInstance = new RainyGlass(canvas, {
          dropletsRate: 40,
          maxDroplets: 110,
          minRadius: 8,
          maxRadius: 36,
          fallSpeed: 0.16,
          refraction: 1.4,
          blurStrength: 0.85,
          highlight: 0.32
        });
      }
      return rainyGlassInstance
        .loadBackground(bgSrc)
        .then(() => {
          rainyGlassInstance.start();
          console.log(
            "%c✓ RainyGlass started",
            "color:#6cf;font-weight:bold",
            "| Weather Cloud by SAIF G.M.D"
          );
          return rainyGlassInstance;
        })
        .catch((err) => {
          console.warn("[WeatherCloud] RainyGlass load failed:", err.message);
          return null;
        });
    } catch (err) {
      console.error("[WeatherCloud] RainyGlass init error:", err.message);
      return null;
    }
  }

  function reloadRainyGlassBackground() {
    if (!rainyGlassInstance || rainyGlassInstance.isDestroyed) {
      return initRainyGlass();
    }
    const bgSrc = customBg && (customBg.currentSrc || customBg.src);
    if (!bgSrc) return Promise.resolve(null);

    return rainyGlassInstance
      .loadBackground(bgSrc)
      .then(() => {
        if (!rainyGlassInstance.isRunning) rainyGlassInstance.start();
        return rainyGlassInstance;
      })
      .catch((err) => {
        console.warn("[WeatherCloud] BG reload failed:", err.message);
        return null;
      });
  }

  function destroyRainyGlass() {
    if (rainyGlassInstance) {
      rainyGlassInstance.destroy();
      rainyGlassInstance = null;
    }
  }

  // =====================================================================
  // PART 13 — BACKGROUND SWITCHER
  // =====================================================================
  function setBackground(url, type = "image", presetIndex = -1) {
    LoadingController.cancelAll();
    const loadId = LoadingController.startLoading();

    state.currentType = type;
    state.currentUrl = url;
    state.currentPresetIndex = presetIndex;

    if (presetIndex === -1) {
      document
        .querySelectorAll(".preset-item")
        .forEach((el) => el.classList.remove("active"));
    }

    if (type === "video") {
      showLoader("Loading video...");
      customBg.classList.add("hidden");
      customVideo.classList.remove("hidden");

      customVideo.muted = true;
      customVideo.loop = true;
      customVideo.playsInline = true;
      customVideo.setAttribute("playsinline", "");
      customVideo.pause();
      customVideo.removeAttribute("src");
      customVideo.load();
      customVideo.src = url;

      const playVideo = () => {
        if (!LoadingController.isCurrentLoading(loadId)) return;
        const promise = customVideo.play();
        if (promise !== undefined) {
          promise
            .then(() => {
              if (!LoadingController.isCurrentLoading(loadId)) {
                customVideo.pause();
                return;
              }
              hideLoader();
            })
            .catch((error) => {
              if (!LoadingController.isCurrentLoading(loadId)) return;
              hideLoader();
              if (error.name === "NotAllowedError") {
                showToast("Tap to start video", "info");
                const startVideo = () => {
                  customVideo.play().catch(() => {});
                  document.removeEventListener("click", startVideo);
                };
                document.addEventListener("click", startVideo, { once: true });
              } else {
                showToast("Video could not play", "error");
              }
            });
        }
      };

      const canPlayHandler = () => {
        if (LoadingController.isCurrentLoading(loadId)) playVideo();
      };

      if (customVideo.readyState >= 3) playVideo();
      else customVideo.addEventListener("canplay", canPlayHandler, { once: true });
    } else {
      showLoader("Loading image...");
      customVideo.pause();
      customVideo.classList.add("hidden");
      customBg.classList.remove("hidden");

      const imgLoadHandler = () => {
        if (!LoadingController.isCurrentLoading(loadId)) return;
        hideLoader();
        setTimeout(() => reloadRainyGlassBackground(), 150);
      };

      const imgErrorHandler = () => {
        if (!LoadingController.isCurrentLoading(loadId)) return;
        hideLoader();
        showToast("Image could not be loaded", "error");
        if (state.currentPresetIndex !== 0) {
          setBackground(PRESETS[0].url, PRESETS[0].type, 0);
          const first = document.querySelectorAll(".preset-item")[0];
          if (first) first.classList.add("active");
        }
      };

      customBg.onload = imgLoadHandler;
      customBg.onerror = imgErrorHandler;
      customBg.src = url;
      if (customBg.complete) imgLoadHandler();
    }

    updateFilters();
  }

  // =====================================================================
  // PART 14 — MEDIA ERROR HANDLERS
  // =====================================================================
  function setupMediaErrorHandlers() {
    if (!customVideo) return;
    customVideo.onerror = () => {
      hideLoader();
      showToast("Video could not be loaded", "error");
      if (state.currentPresetIndex !== 0) {
        setBackground(PRESETS[0].url, PRESETS[0].type, 0);
      }
    };
    customVideo.addEventListener("waiting", () => showLoader("Buffering..."));
    customVideo.addEventListener("playing", () => hideLoader());
    customVideo.addEventListener("canplay", () => hideLoader());
  }

  // =====================================================================
  // PART 15 — SOUND UI
  // =====================================================================
  function syncSoundUI() {
    const isOn = state.soundOn;
    if (soundBtn) {
      soundBtn.classList.toggle("active", isOn);
      soundBtn.setAttribute("aria-pressed", String(isOn));
    }
    if (soundToggleIcon) soundToggleIcon.textContent = isOn ? "🔊" : "🔇";
  }

  function setSound(on) {
    state.soundOn = !!on;
    syncSoundUI();

    if (state.soundOn) {
      if (!AudioManager.audio || AudioManager.allSourcesFailed) {
        state.soundOn = false;
        syncSoundUI();
        showToast("Audio not available", "info");
        return;
      }
      AudioManager.setVolume(state.volume / 100);
      AudioManager.play().catch(() => {
        state.soundOn = false;
        syncSoundUI();
        showToast("Autoplay blocked — click to enable", "info");
      });
    } else {
      AudioManager.pause();
    }
  }

  // =====================================================================
  // PART 16 — LOCALSTORAGE
  // =====================================================================
  function saveToLocalStorage() {
    try {
      const saveData = {
        blur: state.blur,
        brightness: state.brightness,
        rain: state.rain,
        overlayColor: state.overlayColor,
        overlayOpacity: state.overlayOpacity,
        volume: state.volume,
        soundOn: state.soundOn,
        currentPresetIndex: state.currentPresetIndex
      };
      localStorage.setItem("weatherCloudSettings", JSON.stringify(saveData));
      showToast("Settings saved", "success");
    } catch (e) {
      showToast("Could not save settings", "error");
      console.error(e);
    }
  }

  function loadFromLocalStorage() {
    try {
      const saved = localStorage.getItem("weatherCloudSettings");
      if (!saved) return false;
      const data = JSON.parse(saved);
      if (typeof data !== "object" || data === null) return false;

      const maxBlur = DeviceInfo.getMaxBlur();
      state.blur = Math.min(maxBlur, Math.max(0, parseInt(data.blur) || 5));
      state.brightness = Math.min(120, Math.max(20, parseInt(data.brightness) || 30));
      state.rain = Math.min(100, Math.max(20, parseInt(data.rain) || 70));
      state.volume = Math.min(100, Math.max(0, parseInt(data.volume) || 50));
      state.overlayOpacity = Math.min(80, Math.max(0, parseInt(data.overlayOpacity) || 0));
      state.overlayColor = data.overlayColor || "none";
      state.soundOn = typeof data.soundOn === "boolean" ? data.soundOn : true;
      state.currentPresetIndex =
        typeof data.currentPresetIndex === "number" ? data.currentPresetIndex : 0;

      if (state.currentPresetIndex >= 0 && state.currentPresetIndex < PRESETS.length) {
        state.currentUrl = PRESETS[state.currentPresetIndex].url;
        state.currentType = PRESETS[state.currentPresetIndex].type;
      }
      return true;
    } catch (e) {
      console.warn("localStorage read error:", e);
      return false;
    }
  }

  // =====================================================================
  // PART 17 — RESET
  // =====================================================================
  function resetToDefaults() {
    Object.keys(DEFAULT_STATE).forEach((key) => {
      state[key] = DEFAULT_STATE[key];
    });
    applyStateToUI();
    document.querySelectorAll(".preset-item").forEach((el, i) => {
      el.classList.toggle("active", i === 0);
    });
    try {
      localStorage.removeItem("weatherCloudSettings");
    } catch (e) {}
    setBackground(PRESETS[0].url, PRESETS[0].type, 0);
    setSound(state.soundOn);
    showToast("Reset to defaults", "success");
  }

  // =====================================================================
  // PART 18 — APPLY STATE TO UI
  // =====================================================================
  function applyStateToUI() {
    const maxBlur = DeviceInfo.getMaxBlur();

    const set = (id, value) => {
      const el = $id(id);
      if (el) el.value = value;
    };
    const setText = (id, text) => {
      const el = $id(id);
      if (el) el.textContent = text;
    };

    const blurRange = $id("blur-range");
    if (blurRange) blurRange.max = maxBlur;
    set("blur-range", state.blur);
    setText("blur-val", state.blur + "px");

    set("brightness-range", state.brightness);
    setText("brightness-val", state.brightness + "%");

    set("rain-range", state.rain);
    setText("rain-val", state.rain + "%");

    set("overlay-range", state.overlayOpacity);
    setText("overlay-val", state.overlayOpacity + "%");

    set("volume-range", state.volume);
    setText("volume-val", state.volume + "%");

    document.querySelectorAll(".color-btn").forEach((btn) => {
      const isActive = btn.dataset.color === state.overlayColor;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-checked", String(isActive));
    });

    updateFilters();
    syncSoundUI();
    if (AudioManager && AudioManager.setVolume) {
      AudioManager.setVolume(state.volume / 100);
    }
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
    }
    return window.location.origin + window.location.pathname + "?" + params.toString();
  }

  function loadFromUrl() {
    const params = new URLSearchParams(window.location.search);
    let hasUrlParams = false;
    const maxBlur = DeviceInfo.getMaxBlur();

    if (params.has("blur")) {
      state.blur = Math.min(maxBlur, Math.max(0, parseInt(params.get("blur")) || 5));
      hasUrlParams = true;
    }
    if (params.has("brightness")) {
      state.brightness = Math.min(120, Math.max(20, parseInt(params.get("brightness")) || 30));
      hasUrlParams = true;
    }
    if (params.has("rain")) {
      state.rain = Math.min(100, Math.max(20, parseInt(params.get("rain")) || 70));
      hasUrlParams = true;
    }
    if (params.has("volume")) {
      state.volume = Math.min(100, Math.max(0, parseInt(params.get("volume")) || 50));
      hasUrlParams = true;
    }
    if (params.has("color")) {
      const raw = params.get("color");
      if (raw && raw !== "none") {
        const hex = raw.startsWith("#") ? raw : "#" + raw;
        if (/^#([0-9A-F]{3}|[0-9A-F]{6})$/i.test(hex)) {
          state.overlayColor = hex;
          hasUrlParams = true;
        }
      }
    }
    if (params.has("colorOpacity")) {
      state.overlayOpacity = Math.min(80, Math.max(0, parseInt(params.get("colorOpacity")) || 0));
      hasUrlParams = true;
    }
    if (params.has("preset")) {
      const idx = parseInt(params.get("preset"));
      if (!isNaN(idx) && idx >= 0 && idx < PRESETS.length) {
        state.currentPresetIndex = idx;
        state.currentUrl = PRESETS[idx].url;
        state.currentType = PRESETS[idx].type;
      }
      hasUrlParams = true;
    }
    return hasUrlParams;
  }

  // =====================================================================
  // PART 20 — CLIPBOARD
  // =====================================================================
  function copyToClipboard(text) {
    if (navigator.clipboard) {
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
  function togglePanel(forceState) {
    if (!panel) return;
    const shouldOpen =
      typeof forceState === "boolean" ? forceState : !panel.classList.contains("open");

    if (shouldOpen) {
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
      if (settingsBtn) settingsBtn.setAttribute("aria-expanded", "true");
      const closeBtn = $id("panel-close");
      if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
    } else {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      if (settingsBtn) {
        settingsBtn.setAttribute("aria-expanded", "false");
        settingsBtn.focus();
      }
    }
  }

  function setupFocusTrap() {
    if (!panel) return;
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      if (!panel.classList.contains("open")) return;
      const focusable = panel.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
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
      const item = document.createElement("div");
      item.className =
        "preset-item" +
        (index === state.currentPresetIndex ? " active" : "") +
        (preset.type === "video" ? " video" : "");
      item.dataset.label = preset.label;
      item.dataset.index = index;
      item.style.backgroundImage = `url(${preset.thumb})`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === state.currentPresetIndex));
      item.setAttribute("tabindex", "0");
      item.setAttribute("aria-label", `${preset.label} ${preset.type}`);

      const selectPreset = () => {
        document.querySelectorAll(".preset-item").forEach((el) => {
          el.classList.remove("active");
          el.setAttribute("aria-selected", "false");
        });
        item.classList.add("active");
        item.setAttribute("aria-selected", "true");
        setBackground(preset.url, preset.type, index);
      };

      item.addEventListener("click", selectPreset);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectPreset();
        }
      });
      presetGrid.appendChild(item);
    });
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
      updateFilters();

      if (stateKey === "rain" && rainyGlassInstance) {
        const rate = 20 + (state.rain / 100) * 60;
        rainyGlassInstance.setOptions({ dropletsRate: rate });
      }
    });
  }

  // =====================================================================
  // PART 24 — CLOCK & WEATHER (Built-in, no external script)
  // =====================================================================
  const Clock = {
    elTime: $id("time-display"),
    elSeconds: $id("time-seconds"),
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
      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const seconds = String(now.getSeconds()).padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12 || 12;
      const hh = String(hours).padStart(2, "0");

      if (this.elTime) this.elTime.textContent = `${hh}:${minutes} ${ampm}`;
      if (this.elSeconds) this.elSeconds.textContent = seconds;

      const options = { year: "numeric", month: "short", day: "numeric" };
      if (this.elDate) this.elDate.textContent = now.toLocaleDateString("en-US", options);
      if (this.elDay) this.elDay.textContent = now.toLocaleDateString("en-US", { weekday: "long" });

      const h = now.getHours();
      let icon = "🌙";
      let text = "Night";
      if (h >= 5 && h < 7) {
        icon = "🌅";
        text = "Dawn";
      } else if (h >= 7 && h < 12) {
        icon = "☀️";
        text = "Morning";
      } else if (h >= 12 && h < 17) {
        icon = "☀️";
        text = "Afternoon";
      } else if (h >= 17 && h < 20) {
        icon = "🌇";
        text = "Evening";
      }
      if (this.elPhaseIcon) this.elPhaseIcon.textContent = icon;
      if (this.elPhaseText) this.elPhaseText.textContent = text;
    }
  };

  const Weather = {
    elLocation: $id("weather-location"),
    elTemp: $id("weather-temp"),
    elIcon: $id("weather-icon"),
    elDesc: $id("weather-desc"),
    elHumidity: $id("weather-humidity"),
    elWind: $id("weather-wind"),
    defaultCoords: { lat: 21.4858, lon: 39.1925, name: "Jeddah, SA" },

    init() {
      this.fetch(this.defaultCoords.lat, this.defaultCoords.lon, this.defaultCoords.name);
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            this.fetch(pos.coords.latitude, pos.coords.longitude, "My Location");
          },
          () => {},
          { timeout: 5000, maximumAge: 600000 }
        );
      }
    },

    async fetch(lat, lon, name) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Weather fetch failed");
        const data = await res.json();
        const cur = data.current;
        this.render(cur, name);
      } catch (err) {
        console.warn("Weather error:", err.message);
        if (this.elDesc) this.elDesc.textContent = "Weather unavailable";
      }
    },

    render(cur, name) {
      const code = cur.weather_code;
      const info = this.decode(code);
      if (this.elLocation) this.elLocation.textContent = name;
      if (this.elTemp) this.elTemp.textContent = Math.round(cur.temperature_2m) + "°";
      if (this.elIcon) this.elIcon.textContent = info.icon;
      if (this.elDesc) this.elDesc.textContent = info.desc;
      if (this.elHumidity) this.elHumidity.textContent = cur.relative_humidity_2m + "%";
      if (this.elWind) this.elWind.textContent = Math.round(cur.wind_speed_10m) + " km/h";
    },

    decode(code) {
      const map = {
        0: { icon: "☀️", desc: "Clear sky" },
        1: { icon: "🌤️", desc: "Mainly clear" },
        2: { icon: "⛅", desc: "Partly cloudy" },
        3: { icon: "☁️", desc: "Overcast" },
        45: { icon: "🌫️", desc: "Fog" },
        48: { icon: "🌫️", desc: "Depositing rime fog" },
        51: { icon: "🌦️", desc: "Light drizzle" },
        53: { icon: "🌦️", desc: "Moderate drizzle" },
        55: { icon: "🌧️", desc: "Dense drizzle" },
        61: { icon: "🌧️", desc: "Slight rain" },
        63: { icon: "🌧️", desc: "Moderate rain" },
        65: { icon: "⛈️", desc: "Heavy rain" },
        71: { icon: "🌨️", desc: "Slight snow" },
        73: { icon: "🌨️", desc: "Moderate snow" },
        75: { icon: "❄️", desc: "Heavy snow" },
        80: { icon: "🌦️", desc: "Rain showers" },
        81: { icon: "🌧️", desc: "Heavy showers" },
        82: { icon: "⛈️", desc: "Violent showers" },
        95: { icon: "⛈️", desc: "Thunderstorm" },
        96: { icon: "⛈️", desc: "Thunderstorm with hail" },
        99: { icon: "⛈️", desc: "Thunderstorm with heavy hail" }
      };
      return map[code] || { icon: "🌡️", desc: "Unknown" };
    }
  };

  // =====================================================================
  // PART 25 — TOUCH SUPPORT
  // =====================================================================
  function setupTouchSupport() {
    let touchStartX = 0;
    const threshold = 60;

    document.addEventListener(
      "touchstart",
      (e) => {
        touchStartX = e.changedTouches[0].screenX;
      },
      { passive: true }
    );

    document.addEventListener(
      "touchend",
      (e) => {
        const diff = touchStartX - e.changedTouches[0].screenX;
        if (diff > threshold && touchStartX > window.innerWidth - 60) {
          togglePanel(true);
        }
        if (diff < -threshold && panel && panel.classList.contains("open")) {
          togglePanel(false);
        }
      },
      { passive: true }
    );
  }

  // =====================================================================
  // PART 26 — MAIN INITIALIZATION
  // =====================================================================
  document.addEventListener("DOMContentLoaded", () => {
    AudioManager.init(rainAudio);
    PWAManager.init();
    setupMediaErrorHandlers();
    setupFocusTrap();

    // Load state
    const hasUrlParams = loadFromUrl();
    if (!hasUrlParams) loadFromLocalStorage();

    const blurSlider = $id("blur-range");
    if (blurSlider) blurSlider.max = DeviceInfo.getMaxBlur();

    createPresets();
    applyStateToUI();

    // Initial background
    if (
      state.currentPresetIndex >= 0 &&
      state.currentPresetIndex < PRESETS.length
    ) {
      setBackground(
        PRESETS[state.currentPresetIndex].url,
        PRESETS[state.currentPresetIndex].type,
        state.currentPresetIndex
      );
    }

    // Initialize RainyGlass engine
    setTimeout(initRainyGlass, 500);

    // Setup sliders
    setupSlider("blur", "blur", "px");
    setupSlider("brightness", "brightness", "%");
    setupSlider("rain", "rain", "%");
    setupSlider("overlay", "overlayOpacity", "%");

    // Volume slider
    const volumeSlider = $id("volume-range");
    const volumeDisplay = $id("volume-val");
    if (volumeSlider && volumeDisplay) {
      volumeSlider.addEventListener("input", (e) => {
        state.volume = parseInt(e.target.value, 10) || 0;
        volumeDisplay.textContent = state.volume + "%";
        AudioManager.setVolume(state.volume / 100);
      });
    }

    // Enable audio on first user gesture
    const enableAudioOnFirstGesture = () => {
      if (state.soundOn) {
        AudioManager.setVolume(state.volume / 100);
        AudioManager.play().catch(() => {});
      }
      window.removeEventListener("pointerdown", enableAudioOnFirstGesture);
      window.removeEventListener("keydown", enableAudioOnFirstGesture);
      window.removeEventListener("touchstart", enableAudioOnFirstGesture);
    };
    window.addEventListener("pointerdown", enableAudioOnFirstGesture, { once: true });
    window.addEventListener("keydown", enableAudioOnFirstGesture, { once: true });
    window.addEventListener("touchstart", enableAudioOnFirstGesture, {
      once: true,
      passive: true
    });

    // UI Controls
    if (settingsBtn) {
      settingsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePanel();
      });
    }

    const panelCloseBtn = $id("panel-close");
    if (panelCloseBtn) {
      panelCloseBtn.addEventListener("click", () => togglePanel(false));
    }

    if (soundBtn) {
      soundBtn.addEventListener("click", () => setSound(!state.soundOn));
    }

    const fullscreenBtn = $id("btn-fullscreen");
    FullscreenAPI.init();
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", (e) => {
        e.preventDefault();
        FullscreenAPI.toggle();
      });
    }

    // Click outside panel to close (desktop)
    document.addEventListener("click", (e) => {
      if (
        window.innerWidth > 768 &&
        panel &&
        !panel.contains(e.target) &&
        !e.target.closest(".ui-btn") &&
        !e.target.closest(".skip-link") &&
        panel.classList.contains("open")
      ) {
        togglePanel(false);
      }
    });

    // Color buttons
    document.querySelectorAll(".color-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".color-btn").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-checked", "true");
        state.overlayColor = btn.dataset.color;

        const overlayRange = $id("overlay-range");
        const overlayVal = $id("overlay-val");

        if (state.overlayColor === "none") {
          state.overlayOpacity = 0;
          if (overlayRange) overlayRange.value = 0;
          if (overlayVal) overlayVal.textContent = "0%";
        } else if (state.overlayOpacity === 0) {
          state.overlayOpacity = 30;
          if (overlayRange) overlayRange.value = 30;
          if (overlayVal) overlayVal.textContent = "30%";
        }
        updateFilters();
      });
    });

    // URL input
    const urlBtn = $id("url-btn");
    if (urlBtn) {
      urlBtn.addEventListener("click", () => {
        const input = $id("url-input");
        const raw = input ? input.value.trim() : "";
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
        if (input) input.value = "";
        showToast(type === "video" ? "Video loaded" : "Image loaded", "success");
      });
    }

    const urlInput = $id("url-input");
    if (urlInput) {
      urlInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") urlBtn && urlBtn.click();
      });
    }

    // File upload
    const fileBtn = $id("file-btn");
    const fileInput = $id("file-input");
    if (fileBtn) {
      fileBtn.addEventListener("click", () => fileInput && fileInput.click());
    }
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
          if (file.size > 50 * 1024 * 1024) {
            showToast("File too large (max 50MB)", "error");
            return;
          }
          const blobUrl = ResourceManager.createBlobUrl(file);
          const type = file.type.startsWith("video/") ? "video" : "image";
          setBackground(blobUrl, type, -1);
          showToast(type === "video" ? "Video loaded" : "Image loaded", "success");
        }
        e.target.value = "";
      });
    }

    // Actions
    const shareBtn = $id("btn-share");
    if (shareBtn) shareBtn.addEventListener("click", () => copyToClipboard(generateShareUrl()));

    const saveBtn = $id("btn-save");
    if (saveBtn) saveBtn.addEventListener("click", saveToLocalStorage);

    const resetBtn = $id("btn-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (confirm("Reset all settings to defaults?")) resetToDefaults();
      });
    }

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "Escape") togglePanel(false);
      if (e.key === "s" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setSound(!state.soundOn);
      }
      if (e.key === "f" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        FullscreenAPI.toggle();
      }
      if (e.key === "p" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        togglePanel();
      }
    });

    // Cleanup
    const cleanup = () => {
      try {
        ResourceManager.cleanup();
        Clock.stop();
      } catch (e) {
        console.warn("Cleanup error:", e);
      }
    };
    window.addEventListener("pagehide", cleanup, { once: true });
    window.addEventListener("beforeunload", cleanup, { once: true });

    // Visibility
    document.addEventListener("visibilitychange", () => {
      if (state.currentType === "video") {
        if (document.hidden) customVideo.pause();
        else customVideo.play().catch(() => {});
      }
    });

    // Resize
    const handleResize = debounce(() => {
      if (rainyGlassInstance && !rainyGlassInstance.isDestroyed) {
        rainyGlassInstance.resize();
      }
    }, 200);
    window.addEventListener("resize", handleResize);

    // Touch support
    setupTouchSupport();

    // Start clock & weather (built-in)
    Clock.start();
    Weather.init();

    console.log(
      "%c Weather Cloud %c v1.0.0 %c by SAIF G.M.D ",
      "background:linear-gradient(135deg,#6cf,#8af);color:#000;font-weight:bold;padding:4px 8px;border-radius:4px 0 0 4px",
      "background:#1a1f2a;color:#6cf;padding:4px 8px",
      "background:#0a0e14;color:#8af;padding:4px 8px;border-radius:0 4px 4px 0"
    );
  });
})();
