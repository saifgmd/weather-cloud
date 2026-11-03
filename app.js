/* =====================================================================
 *  Weather Cloud
 *  --------------------------------------------------------------------
 *  Interactive rainy window with WebGL raindrops, live clock, weather,
 *  city/village search, 24-hour and 5-day forecast.
 *
 *  @project  Weather Cloud
 *  @author   SAIF G.M.D
 *  @version  1.5.0
 * ===================================================================== */

(function () {
  "use strict";

  const APP_VERSION = "1.5.0";

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
      // Extra drops fade out naturally instead of vanishing at once
      const max = this.options.maxDroplets;
      for (let i = max; i < this.droplets.length; i++) {
        const d = this.droplets[i];
        if (d.slides && d.life > d.delay) continue; // already running down the glass
        d.slides = false;
        d.ttl = Math.min(d.ttl, d.life + Math.random() * 1.5);
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
      // Size comes from CSS (full screen + overscan for the iOS home-screen bug)
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
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

  function cap(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== null && text !== undefined) el.textContent = text;
    return el;
  }

  function flagEmoji(cc) {
    if (!/^[A-Z]{2}$/.test(cc || "")) return "📍";
    return String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  }

  function formatTime12(h24, m) {
    const hh = String(h24 % 12 || 12).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    return `${hh}:${mm} ${h24 >= 12 ? I18n.t("pm") : I18n.t("am")}`;
  }

  // Line icons for the control buttons (emoji render inconsistently across devices)
  const ICONS = {
    soundOn: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>',
    fsEnter: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    fsExit: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
  };

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

  // =====================================================================
  // PART 2b — LANGUAGE (Arabic / English, follows the device by default)
  // ---------------------------------------------------------------------
  // Numbers always use Western digits (26°, 05:03) for quick reading.
  // Static HTML texts use data-i18n / data-i18n-aria / data-i18n-title /
  // data-i18n-ph attributes; everything else calls t("key", {vars}).
  // =====================================================================
  const STRINGS = {
    en: {
      am: "AM", pm: "PM",
      // static UI
      skip: "Skip to settings", loading: "Loading...",
      changeLocation: "Change location", searchHint: "Search city or village (/)",
      localTime: "Local time at this location",
      humidity: "Humidity", wind: "Wind", feels: "Feels", uv: "UV", feelsLike: "Feels like", uvIndex: "UV index",
      next24: "Next 24 hours", backToNow: "Back to now",
      fiveDay: "5-day forecast", tapDay: "Tap a day for hours",
      soundBtn: "Rain sound", settings: "Settings", closeSettings: "Close settings",
      location: "Location", change: "Change",
      window: "Window", live: "Live weather", alwaysRain: "Always rain",
      prayerTimes: "Prayer times", prayerHint: "Umm al-Qura method, shown in the hourly forecast.",
      language: "Language", langAuto: "Auto",
      blur: "Blur", brightness: "Brightness", rain: "Rain", overlay: "Overlay", overlayColor: "Overlay color",
      cNone: "None", cBlue: "Blue", cPurple: "Purple", cRed: "Red", cGreen: "Green", cAmber: "Amber",
      volume: "Volume", background: "Background", customUrl: "Custom URL", load: "Load",
      upload: "Upload", chooseFile: "Choose File…",
      share: "Share", save: "Save", reset: "Reset", install: "Install App",
      kSound: "Sound", kFull: "Fullscreen", kSettings: "Settings", kSearch: "Search",
      by: "by", dataBy: "Weather data by",
      searchTitle: "Search location", searchPh: "Search city or village…", closeSearch: "Close search",
      myLocation: "Use my current location", clear: "Clear", locations: "Locations",
      deepSearch: "Still can't find it? Deep search (OpenStreetMap)",
      // presets
      City: "City", Forest: "Forest", Mountain: "Mountain", Towers: "Towers", Future: "Future", Sky: "Sky",
      Hurricane: "Hurricane", River: "River", Beach: "Beach", image: "image", video: "video",
      // messages
      fsUnsupported: "Fullscreen not supported", fsEnter: "Enter fullscreen", fsExit: "Exit fullscreen",
      fsEnterTitle: "Fullscreen (F)", fsExitTitle: "Exit fullscreen (F)",
      installed: "App installed!", installNo: "App is already installed or not supported",
      loadingImage: "Loading image...", loadingVideo: "Loading video...", buffering: "Buffering...",
      tapVideo: "Tap to start video", videoNoPlay: "Video could not play",
      imageFail: "Image could not be loaded", videoFail: "Video could not be loaded",
      soundNA: "Rain sound unavailable", soundMute: "Mute rain (S)", soundPlay: "Play rain sound (S)",
      audioNA: "Audio not available", tapSound: "Tap anywhere to enable sound",
      saved: "Settings saved", savedNoUpload: "Settings saved (uploaded files aren't kept)",
      saveFail: "Could not save settings", resetDone: "Reset to defaults",
      resetConfirm: "Reset all settings to defaults?",
      copied: "Link copied!", copyFail: "Copy failed",
      enterUrl: "Please enter a URL", badUrl: "Invalid or unsafe URL", tooLarge: "File too large (max 50MB)",
      version: "Version {v}",
      // places
      sharedLocation: "Shared location", myPlace: "My Location", unknownPlace: "Unknown place",
      locAria: "Location: {x}. Change location",
      // weather card
      loadingWx: "Loading…", wxUnavailable: "Weather unavailable",
      updated: "Updated {ago}", offline: "Offline · {ago}", justNow: "just now",
      hilo: "H: {h}   L: {l}", kmh: "km/h",
      uvLow: "Low", uvMod: "Moderate", uvHigh: "High", uvVHigh: "Very high", uvExt: "Extreme",
      uvAria: "UV index {uv}, {label}",
      now: "Now", today: "Today", sunrise: "Sunrise", sunset: "Sunset",
      p_fajr: "Fajr", p_dhuhr: "Dhuhr", p_asr: "Asr", p_maghrib: "Maghrib", p_isha: "Isha",
      prayerAria: "{name} at {time}: {temp}°, {desc}", sunAria: "{text} at {time}",
      popAria: ", {pop}% chance of rain",
      nextPrayer: "{name} {time} · in {in}", nextPrayerTitle: "Next prayer: {name} at {time}",
      dayAria: "{day}: {desc}, low {lo}°, high {hi}°{pop}. Show hourly forecast",
      // rain countdown
      rLight: "Light rain", rRain: "Rain", rHeavy: "Heavy rain",
      rContinues: "Rain continues for the next few hours",
      rStopsIn: "Rain stops in about {m} min",
      rStartsNow: "{w} starting now", rStartsIn: "{w} starts in about {m} min",
      rLikelyContinue: "Rain likely to continue for the next few hours",
      rEaseHour: "Rain should ease within the hour", rEaseAt: "Rain should ease around {t}",
      rLikelyHour: "{w} likely within the hour", rExpected: "{w} expected around {t} ({p} chance)",
      // window status
      wAlways: "Always raining, whatever the weather.", wNow: "Now: {x}", wPreview: "Preview: {x}",
      wStorm: "Thunderstorm", wHeavy: "Heavy rain", wRain: "Rain", wLight: "Light rain",
      wFog: "fog on the glass", wCond: "condensation", wDusty: "dusty air", wDust: "light dust",
      wSunny: "Sunny — dry glass", wNight: "Clear night — dry glass", wDry: "Dry glass",
      wDustVal: " (dust {v} µg/m³)", listSep: ", ",
      // search
      recent: "Recent", results: "Results", extResults: "Extended results",
      typeHint: "Type a city, town or village name",
      searching: "Searching…", searchingOsm: "Searching OpenStreetMap…",
      villageDown: " · village search didn't respond",
      villageDownEmpty: "Village search didn't respond — try the deep search below.",
      noPlaces: "No places found. Check the spelling or try another name.",
      noResults: "No results — try the extended search below.",
      searchFail: "Search failed — check your connection.",
      locating: "Locating…",
      geo1: "Location permission denied. Allow it in your browser settings, or search instead.",
      geo2: "Your location is unavailable right now.", geo3: "Locating timed out. Try again.",
      geoX: "Could not get your location."
    },
    ar: {
      am: "ص", pm: "م",
      skip: "انتقل إلى الإعدادات", loading: "جارٍ التحميل…",
      changeLocation: "تغيير الموقع", searchHint: "ابحث عن مدينة أو قرية (/)",
      localTime: "الوقت المحلي في هذا الموقع",
      humidity: "الرطوبة", wind: "الرياح", feels: "الإحساس", uv: "الأشعة", feelsLike: "درجة الإحساس",
      uvIndex: "مؤشر الأشعة فوق البنفسجية",
      next24: "الساعات الـ 24 القادمة", backToNow: "العودة للآن",
      fiveDay: "توقعات 5 أيام", tapDay: "اضغط يوماً لعرض ساعاته",
      soundBtn: "صوت المطر", settings: "الإعدادات", closeSettings: "إغلاق الإعدادات",
      location: "الموقع", change: "تغيير",
      window: "النافذة", live: "الطقس الحي", alwaysRain: "مطر دائم",
      prayerTimes: "أوقات الصلاة", prayerHint: "بطريقة أم القرى، وتظهر في توقعات الساعات.",
      language: "اللغة", langAuto: "تلقائي",
      blur: "التمويه", brightness: "السطوع", rain: "المطر", overlay: "طبقة لونية", overlayColor: "لون الطبقة",
      cNone: "بدون", cBlue: "أزرق", cPurple: "بنفسجي", cRed: "أحمر", cGreen: "أخضر", cAmber: "كهرماني",
      volume: "مستوى الصوت", background: "الخلفية", customUrl: "رابط مخصص", load: "تحميل",
      upload: "رفع ملف", chooseFile: "اختر ملفاً…",
      share: "مشاركة", save: "حفظ", reset: "إعادة ضبط", install: "تثبيت التطبيق",
      kSound: "الصوت", kFull: "ملء الشاشة", kSettings: "الإعدادات", kSearch: "البحث",
      by: "تطوير", dataBy: "بيانات الطقس من",
      searchTitle: "البحث عن موقع", searchPh: "ابحث عن مدينة أو قرية…", closeSearch: "إغلاق البحث",
      myLocation: "استخدم موقعي الحالي", clear: "مسح", locations: "المواقع",
      deepSearch: "لم تجده؟ بحث عميق (OpenStreetMap)",
      City: "مدينة", Forest: "غابة", Mountain: "جبل", Towers: "أبراج", Future: "مستقبل", Sky: "سماء",
      Hurricane: "إعصار", River: "نهر", Beach: "شاطئ", image: "صورة", video: "فيديو",
      fsUnsupported: "ملء الشاشة غير مدعوم", fsEnter: "ملء الشاشة", fsExit: "الخروج من ملء الشاشة",
      fsEnterTitle: "ملء الشاشة (F)", fsExitTitle: "الخروج من ملء الشاشة (F)",
      installed: "تم تثبيت التطبيق!", installNo: "التطبيق مثبّت مسبقاً أو غير مدعوم",
      loadingImage: "جارٍ تحميل الصورة…", loadingVideo: "جارٍ تحميل الفيديو…", buffering: "جارٍ التحميل…",
      tapVideo: "اضغط لتشغيل الفيديو", videoNoPlay: "تعذّر تشغيل الفيديو",
      imageFail: "تعذّر تحميل الصورة", videoFail: "تعذّر تحميل الفيديو",
      soundNA: "صوت المطر غير متاح", soundMute: "إيقاف صوت المطر (S)", soundPlay: "تشغيل صوت المطر (S)",
      audioNA: "الصوت غير متاح", tapSound: "اضغط في أي مكان لتفعيل الصوت",
      saved: "تم حفظ الإعدادات", savedNoUpload: "تم الحفظ (الملفات المرفوعة لا تُحفظ)",
      saveFail: "تعذّر حفظ الإعدادات", resetDone: "تمت إعادة الضبط",
      resetConfirm: "إعادة كل الإعدادات إلى الوضع الافتراضي؟",
      copied: "تم نسخ الرابط!", copyFail: "تعذّر النسخ",
      enterUrl: "أدخل رابطاً", badUrl: "رابط غير صالح أو غير آمن", tooLarge: "الملف كبير جداً (الحد 50 ميجابايت)",
      version: "الإصدار {v}",
      sharedLocation: "موقع مشترك", myPlace: "موقعي", unknownPlace: "مكان غير معروف",
      locAria: "الموقع: {x}. تغيير الموقع",
      loadingWx: "جارٍ التحميل…", wxUnavailable: "الطقس غير متاح",
      updated: "حُدّث {ago}", offline: "دون اتصال · {ago}", justNow: "الآن",
      hilo: "العظمى: {h}   الصغرى: {l}", kmh: "كم/س",
      uvLow: "منخفض", uvMod: "متوسط", uvHigh: "مرتفع", uvVHigh: "مرتفع جداً", uvExt: "شديد",
      uvAria: "مؤشر الأشعة فوق البنفسجية {uv}، {label}",
      now: "الآن", today: "اليوم", sunrise: "الشروق", sunset: "الغروب",
      p_fajr: "الفجر", p_dhuhr: "الظهر", p_asr: "العصر", p_maghrib: "المغرب", p_isha: "العشاء",
      prayerAria: "{name} الساعة {time}: {temp}°، {desc}", sunAria: "{text} الساعة {time}",
      popAria: "، احتمال المطر {pop}%",
      nextPrayer: "{name} {time} · بعد {in}", nextPrayerTitle: "الصلاة القادمة: {name} الساعة {time}",
      dayAria: "{day}: {desc}، الصغرى {lo}°، العظمى {hi}°{pop}. عرض توقعات الساعات",
      rLight: "مطر خفيف", rRain: "مطر", rHeavy: "مطر غزير",
      rContinues: "المطر مستمر خلال الساعات القادمة",
      rStopsIn: "يتوقف المطر بعد {m} تقريباً",
      rStartsNow: "{w} يبدأ الآن", rStartsIn: "{w} يبدأ بعد {m} تقريباً",
      rLikelyContinue: "يُرجّح استمرار المطر خلال الساعات القادمة",
      rEaseHour: "يُتوقع أن يخف المطر خلال الساعة", rEaseAt: "يُتوقع أن يخف المطر نحو {t}",
      rLikelyHour: "{w} محتمل خلال الساعة", rExpected: "{w} متوقع نحو {t} (احتمال {p})",
      wAlways: "المطر دائم مهما كان الطقس.", wNow: "الآن: {x}", wPreview: "معاينة: {x}",
      wStorm: "عاصفة رعدية", wHeavy: "مطر غزير", wRain: "مطر", wLight: "مطر خفيف",
      wFog: "ضباب على الزجاج", wCond: "بخار على الزجاج", wDusty: "غبار كثيف", wDust: "غبار خفيف",
      wSunny: "مشمس — زجاج جاف", wNight: "ليل صافٍ — زجاج جاف", wDry: "زجاج جاف",
      wDustVal: " (غبار {v} ميكروغرام/م³)", listSep: "، ",
      recent: "الأخيرة", results: "النتائج", extResults: "نتائج البحث العميق",
      typeHint: "اكتب اسم مدينة أو قرية",
      searching: "جارٍ البحث…", searchingOsm: "جارٍ البحث في OpenStreetMap…",
      villageDown: " · بحث القرى لم يستجب",
      villageDownEmpty: "بحث القرى لم يستجب — جرّب البحث العميق بالأسفل.",
      noPlaces: "لم يُعثر على أماكن. تأكد من الكتابة أو جرّب اسماً آخر.",
      noResults: "لا توجد نتائج — جرّب البحث العميق بالأسفل.",
      searchFail: "فشل البحث — تحقق من الاتصال.",
      locating: "جارٍ تحديد موقعك…",
      geo1: "تم رفض إذن الموقع. فعّله من إعدادات المتصفح، أو ابحث عن مدينتك.",
      geo2: "موقعك غير متاح حالياً.", geo3: "انتهت مهلة تحديد الموقع. حاول مرة أخرى.",
      geoX: "تعذّر تحديد موقعك."
    }
  };

  // Weather descriptions (icons stay in WEATHER_CODES)
  const WEATHER_AR = {
    0: "سماء صافية", 1: "صحو غالباً", 2: "غائم جزئياً", 3: "غائم",
    45: "ضباب", 48: "ضباب متجمّد",
    51: "رذاذ خفيف", 53: "رذاذ متوسط", 55: "رذاذ كثيف", 56: "رذاذ متجمّد", 57: "رذاذ متجمّد كثيف",
    61: "مطر خفيف", 63: "مطر متوسط", 65: "مطر غزير", 66: "مطر متجمّد", 67: "مطر متجمّد غزير",
    71: "ثلج خفيف", 73: "ثلج متوسط", 75: "ثلج كثيف", 77: "حبيبات ثلجية",
    80: "زخات مطر", 81: "زخات غزيرة", 82: "زخات عنيفة", 85: "زخات ثلجية", 86: "زخات ثلجية كثيفة",
    95: "عاصفة رعدية", 96: "عاصفة رعدية مع بَرَد", 99: "عاصفة رعدية شديدة"
  };

  const I18n = {
    pref: "auto", // "auto" | "ar" | "en"
    lang: "en",

    detect() {
      const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
      return String(list[0] || "en").toLowerCase().startsWith("ar") ? "ar" : "en";
    },

    init(urlLang) {
      let saved = null;
      try {
        saved = localStorage.getItem("weatherCloudLang");
      } catch {}
      const pick = urlLang || saved;
      this.pref = pick === "ar" || pick === "en" ? pick : "auto";
      this.lang = this.pref === "auto" ? this.detect() : this.pref;
      this.applyDocument();
    },

    setPref(pref) {
      this.pref = pref === "ar" || pref === "en" ? pref : "auto";
      try {
        localStorage.setItem("weatherCloudLang", this.pref);
      } catch {}
      this.lang = this.pref === "auto" ? this.detect() : this.pref;
      this.applyDocument();
    },

    get rtl() {
      return this.lang === "ar";
    },

    /** Locale for Intl: Gregorian calendar + Western digits in both languages. */
    get locale() {
      return this.lang === "ar" ? "ar-u-ca-gregory-nu-latn" : "en-US";
    },

    /** Language code for the geocoding APIs. */
    get apiLang() {
      return this.lang;
    },

    t(key, vars) {
      const table = STRINGS[this.lang] || STRINGS.en;
      let s = key in table ? table[key] : key in STRINGS.en ? STRINGS.en[key] : key;
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
      return s;
    },

    /** Arabic counted nouns: 1 دقيقة · 2 دقيقتين · 3–10 دقائق · 11+ دقيقة */
    count(n, unit) {
      if (this.lang !== "ar") {
        const en = { min: "min", hour: "h", day: "d", result: n === 1 ? "result" : "results" };
        return `${n} ${en[unit]}`;
      }
      const ar = {
        min: ["دقيقة", "دقيقتين", "دقائق", "دقيقة"],
        hour: ["ساعة", "ساعتين", "ساعات", "ساعة"],
        day: ["يوم", "يومين", "أيام", "يوماً"],
        result: ["نتيجة واحدة", "نتيجتان", "نتائج", "نتيجة"]
      }[unit];
      if (n === 1) return ar[0];
      if (n === 2) return ar[1];
      if (n >= 3 && n <= 10) return `${n} ${ar[2]}`;
      return `${n} ${ar[3]}`;
    },

    /** Short duration for "next prayer": 41m / 1h 20m · 41د / 1س 20د */
    duration(mins) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (this.lang === "ar") return h ? `${h}س ${m}د` : `${m}د`;
      return h ? `${h}h ${m}m` : `${m}m`;
    },

    date(dateStr, opts) {
      return new Date(dateStr + "T12:00:00Z").toLocaleDateString(this.locale, { timeZone: "UTC", ...opts });
    },

    hijri(dateStr, withYear = false) {
      try {
        return new Date(dateStr + "T12:00:00Z").toLocaleDateString("ar-u-ca-islamic-umalqura-nu-latn", {
          day: "numeric",
          month: "long",
          ...(withYear ? { year: "numeric" } : {}),
          timeZone: "UTC"
        });
      } catch {
        return "";
      }
    },

    applyDocument() {
      const root = document.documentElement;
      root.lang = this.lang;
      root.dir = this.rtl ? "rtl" : "ltr";
    },

    /** Translate the static HTML. */
    apply() {
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = this.t(el.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
        el.setAttribute("aria-label", this.t(el.dataset.i18nAria));
      });
      document.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.title = this.t(el.dataset.i18nTitle);
      });
      document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
        el.placeholder = this.t(el.dataset.i18nPh);
      });
      document.querySelectorAll(".seg-btn[data-lang]").forEach((btn) => {
        const on = btn.dataset.lang === this.pref;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-checked", String(on));
      });
      ["weather-location", "panel-location"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.dir = this.rtl ? "rtl" : "ltr";
      });
    }
  };
  const t = (key, vars) => I18n.t(key, vars);

  /** Keep "36°" / "70%" in one piece inside Arabic sentences. A number that
   *  follows Arabic letters becomes an "Arabic number" for the bidi algorithm
   *  and the °/% sign would jump to its left ("°36"). LRI…PDI isolates it. */
  function ltr(str) {
    return I18n.rtl ? "\u2066" + str + "\u2069" : str;
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
        showToast(t("fsUnsupported"), "error");
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
      const icon = btn.querySelector(".ui-icon");
      if (icon) icon.innerHTML = isFullscreen ? ICONS.fsExit : ICONS.fsEnter;
      btn.setAttribute("aria-label", isFullscreen ? t("fsExit") : t("fsEnter"));
      btn.title = isFullscreen ? t("fsExitTitle") : t("fsEnterTitle");
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
        showToast(t("installed"), "success");
      });
    },

    async promptInstall() {
      if (!this.deferredPrompt) {
        showToast(t("installNo"), "info");
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
    soundOn: false, // never start sound by surprise; the user turns it on
    currentType: "image",
    currentUrl: PRESETS[0].url,
    currentPresetIndex: 0,
    windowMode: "live", // "live" = glass follows the real weather, "rain" = always raining
    prayers: true
  };

  const VISUAL_PROPS = ["blur", "brightness", "rain", "overlayColor", "overlayOpacity", "windowMode"];

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

  /** Rain amount (0–1) → drop spawn rate and density. 0 = no rain. */
  function rainOptions(k) {
    k = Math.max(0, Math.min(1, k));
    return {
      dropletsRate: k === 0 ? 0 : 3 + k * 22,
      maxDroplets: Math.round(k * MAX_DROPLETS),
      minRadius: 5,
      maxRadius: 22,
      slideChance: 0.4
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
  function showLoader(text = t("loading"), delay = 0) {
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
    // Fog and dust sit on the glass too, so they follow the same brightness
    const fxBrightness = `brightness(${Math.max(0.35, state.brightness / 100)})`;
    ["fx-fog", "fx-dust"].forEach((id) => {
      const el = $id(id);
      if (el) el.style.filter = fxBrightness;
    });

    WindowScene.refresh();

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
        ...WindowScene.dropOptions(),
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
      showLoader(t("loadingVideo"));
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
              showToast(t("tapVideo"), "info");
              document.addEventListener("click", () => customVideo.play().catch(() => {}), { once: true });
            } else if (error.name !== "AbortError") {
              showToast(t("videoNoPlay"), "error");
            }
          });
      };

      if (customVideo.readyState >= 3) playVideo();
      else customVideo.addEventListener("canplay", playVideo, { once: true });
    } else {
      showLoader(t("loadingImage"));
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
        showToast(t("imageFail"), "error");
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
      showToast(t("videoFail"), "error");
      if (state.currentPresetIndex !== 0) setBackground(PRESETS[0].url, PRESETS[0].type, 0);
    });
    // Only show the overlay if buffering lasts a while
    customVideo.addEventListener("waiting", () => {
      if (state.currentType === "video") showLoader(t("buffering"), 800);
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
      soundBtn.title = AudioManager.failed ? t("soundNA") : playing ? t("soundMute") : t("soundPlay");
    }
    if (soundToggleIcon) soundToggleIcon.innerHTML = playing ? ICONS.soundOn : ICONS.soundOff;
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
      showToast(t("audioNA"), "info");
      return;
    }
    AudioManager.setVolume(state.volume / 100);
    AudioManager.play().catch((err) => {
      if (err && err.name === "NotAllowedError") showToast(t("tapSound"), "info");
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
      customType: state.currentType,
      windowMode: state.windowMode,
      prayers: state.prayers
    };
    if (storeSet(LS_KEYS.settings, saveData)) {
      const note = state.currentPresetIndex === -1 && !saveData.customUrl ? t("savedNoUpload") : t("saved");
      showToast(note, "success");
    } else {
      showToast(t("saveFail"), "error");
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
    state.soundOn = typeof data.soundOn === "boolean" ? data.soundOn : false;
    state.windowMode = data.windowMode === "rain" ? "rain" : "live";
    state.prayers = typeof data.prayers === "boolean" ? data.prayers : true;

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
    showToast(t("resetDone"), "success");
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

    document.querySelectorAll(".seg-btn[data-window]").forEach((btn) => {
      const on = btn.dataset.window === state.windowMode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", String(on));
    });
    const prayerToggle = $id("prayer-toggle");
    if (prayerToggle) prayerToggle.checked = !!state.prayers;

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
    if (state.windowMode === "rain") params.set("window", "rain");
    if (!state.prayers) params.set("prayers", "0");
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
    if (params.has("window")) {
      state.windowMode = params.get("window") === "rain" ? "rain" : "live";
      result.hasSettings = true;
    }
    if (params.has("prayers")) {
      state.prayers = params.get("prayers") !== "0";
      result.hasSettings = true;
    }
    result.scene = (params.get("scene") || "").toLowerCase();
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
        name: params.get("place") || t("sharedLocation"),
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
        .then(() => showToast(t("copied"), "success"))
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
      showToast(t("copied"), "success");
    } catch {
      showToast(t("copyFail"), "error");
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
      item.dataset.label = t(preset.label);
      item.style.backgroundImage = `url("${preset.thumb}")`;
      item.setAttribute("aria-label", `${t(preset.label)} (${t(preset.type)})`);
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
  // PART 24 — CLOCK (1-second ticker; time & date live in the weather card)
  // =====================================================================
  const Clock = {
    timerId: null,

    start() {
      this.tick();
      // Align ticks to the start of each second so minutes flip on time
      setTimeout(() => {
        this.tick();
        this.timerId = setInterval(() => this.tick(), 1000);
      }, 1000 - (Date.now() % 1000));
    },

    stop() {
      if (this.timerId) clearInterval(this.timerId);
    },

    tick() {
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

  /** The default city, named in the interface language. */
  function defaultLocation() {
    return I18n.lang === "ar"
      ? { ...DEFAULT_LOCATION, name: "جدة", sub: "منطقة مكة المكرمة، السعودية" }
      : { ...DEFAULT_LOCATION };
  }

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
      name: cleanText(o.name) || t("unknownPlace"),
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

  /** Name + country code. The name is wrapped in Unicode isolates (FSI…PDI)
   *  so Arabic names don't flip the order: "جدة, SA", not "SA ,جدة". */
  function locationLabel(loc) {
    const name = "\u2068" + loc.name + "\u2069";
    return loc.cc ? `${name}${t("listSep")}${loc.cc}` : name;
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

  /** Loose name matching: ignores case, Arabic diacritics and letter variants. */
  function normalizeName(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f\u064B-\u065F\u0670\u0640]/g, "") // accents, tashkeel, tatweel
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/^(ال|al[\s-]|el[\s-])/, "")
      .replace(/[\s\-'’]+/g, " ")
      .trim();
  }

  function distanceKm(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
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
        `?name=${encodeURIComponent(query)}&count=10&language=${I18n.apiLang}&format=json`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("Search failed (" + res.status + ")");
      const data = await res.json();
      return (data.results || [])
        .map((r) =>
          normalizeLocation({
            name: r.name,
            sub: uniqueParts([r.admin2, r.admin1, r.country], r.name).join(t("listSep")),
            cc: r.country_code,
            lat: r.latitude,
            lon: r.longitude,
            source: "search"
          })
        )
        .filter(Boolean);
    },

    /** Photon (komoot, OpenStreetMap data): made for search-as-you-type and
     *  covers small villages and hamlets. Biased toward `near` so places close
     *  to the user rank first, like the iPhone Weather app. */
    async searchPhoton(query, signal, near) {
      const lang = I18n.apiLang === "en" ? "en" : "default"; // default = local (Arabic) names
      let url =
        "https://photon.komoot.io/api/" +
        `?q=${encodeURIComponent(query)}&limit=10&lang=${lang}&osm_tag=place`;
      if (near) url += `&lat=${near.lat}&lon=${near.lon}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error("Photon failed (" + res.status + ")");
      const data = await res.json();
      const skip = new Set(["city_block", "plot", "square", "house"]);
      return (data.features || [])
        .filter((f) => f && f.properties && f.geometry && !skip.has(f.properties.osm_value))
        .map((f) => {
          const p = f.properties;
          const [lon, lat] = f.geometry.coordinates || [];
          return normalizeLocation({
            name: p.name,
            sub: uniqueParts([p.county || p.city || p.district, p.state, p.country], p.name).join(t("listSep")),
            cc: p.countrycode,
            lat,
            lon,
            source: "search",
            osm: true
          });
        })
        .filter((loc) => loc && loc.name !== t("unknownPlace"));
    },

    /** Both sources at once: GeoNames (big places, ranked by population) and
     *  Photon (villages). Merged, de-duplicated, best name matches first. */
    async searchAll(query, signal, near) {
      const TIMEOUT = Symbol("timeout");
      const [a, b] = await Promise.allSettled([
        this.search(query, signal),
        Promise.race([
          this.searchPhoton(query, signal, near),
          new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 4500))
        ])
      ]);
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      // Remember which source answered, so the dialog can say so
      this.lastOsmStatus =
        b.status === "rejected" ? "error" : b.value === TIMEOUT ? "timeout" : "ok";
      if (b.status === "rejected") console.warn("Village search (Photon) failed:", b.reason);
      const geo = a.status === "fulfilled" ? a.value : [];
      const osm = b.status === "fulfilled" && Array.isArray(b.value) ? b.value : [];
      if (a.status === "rejected" && b.status === "rejected") throw a.reason;
      osm.forEach((loc) => (loc.osm = true));

      const q = normalizeName(query);
      const merged = [];
      [...geo, ...osm].forEach((loc) => {
        const n = normalizeName(loc.name);
        const dup = merged.some(
          (m) => m.cc === loc.cc && normalizeName(m.name) === n && distanceKm(m, loc) < 20
        );
        if (!dup) merged.push(loc);
      });
      const rank = (loc) => {
        const n = normalizeName(loc.name);
        return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
      };
      return merged
        .map((loc, i) => ({ loc, i, r: rank(loc) }))
        .sort((x, y) => x.r - y.r || x.i - y.i)
        .slice(0, 12)
        .map((x) => x.loc);
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
        `?q=${encodeURIComponent(query)}&format=jsonv2&limit=10&addressdetails=1&accept-language=${I18n.apiLang}`;
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
            ).join(t("listSep")),
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
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=${I18n.apiLang}`
        );
        if (!res.ok) throw new Error("Reverse geocode failed");
        const d = await res.json();
        const name = d.city || d.locality || d.principalSubdivision || d.countryName || t("myPlace");
        return {
          name,
          sub: uniqueParts([d.principalSubdivision, d.countryName], name).join(t("listSep")),
          cc: d.countryCode || ""
        };
      } catch (err) {
        console.warn("Reverse geocoding failed:", err.message);
        return { name: t("myPlace"), sub: "", cc: "" };
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
    if (!e) return { icon: "🌡️", desc: I18n.lang === "ar" ? "غير معروف" : "Unknown" };
    return { icon: isDay ? e[0] : e[1], desc: I18n.lang === "ar" ? WEATHER_AR[code] || e[2] : e[2] };
  }

  function uvLevel(uv) {
    if (uv < 3) return [t("uvLow"), "uv-low"];
    if (uv < 6) return [t("uvMod"), "uv-mod"];
    if (uv < 8) return [t("uvHigh"), "uv-high"];
    if (uv < 11) return [t("uvVHigh"), "uv-vhigh"];
    return [t("uvExt"), "uv-extreme"];
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
    return `linear-gradient(${I18n.rtl ? "270deg" : "90deg"}, ${stops.join(", ")})`;
  }

  const WEATHER_REFRESH_MS = 15 * 60 * 1000;

  const Weather = {
    els: {
      locBtn: $id("btn-location"),
      locName: $id("weather-location"),
      locTime: $id("weather-time"),
      locDate: $id("weather-date"),
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
      rainAlert: $id("rain-alert"),
      hourlySection: $id("hourly-section"),
      hourlyTitle: $id("hourly-title"),
      hourlyReset: $id("hourly-reset"),
      nextPrayer: $id("next-prayer"),
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
      const initial = sharedLocation || saved || defaultLocation();
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
        this.renderEmpty(t("loadingWx"));
      }
      this.refresh();
    },

    renderLocation() {
      const loc = this.location;
      const label = locationLabel(loc);
      if (this.els.locName) this.els.locName.textContent = label;
      if (this.els.locBtn) {
        this.els.locBtn.setAttribute("aria-label", t("locAria", { x: label }));
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
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m," +
        "wind_direction_10m,precipitation,is_day" +
        "&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,is_day,uv_index" +
        "&minutely_15=precipitation" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
        "&timezone=auto&forecast_days=5";

      // Dust for the window effect (optional: failure is ignored)
      const airUrl =
        "https://air-quality-api.open-meteo.com/v1/air-quality" +
        `?latitude=${loc.lat}&longitude=${loc.lon}&current=dust,pm10&timezone=auto`;
      const airPromise = fetch(airUrl, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("Weather fetch failed (" + res.status + ")");
        const data = await res.json();
        if (id !== this.reqId) return; // a newer request (another city) won
        const air = await airPromise;
        if (id !== this.reqId) return;
        if (air && air.current) {
          data.air = { dust: air.current.dust, pm10: air.current.pm10 };
        } else if (this.data && this.data.air && this.data.latitude === data.latitude) {
          data.air = this.data.air; // keep the last known value for this place
        }
        const at = Date.now();
        storeSet(LS_KEYS.weather, { key: locationKey(loc), at, data });
        this.render(data, at);
      } catch (err) {
        if (err.name === "AbortError" || id !== this.reqId) return;
        console.warn("Weather error:", err.message);
        if (this.data) {
          this.setUpdated(this.dataAt, true);
        } else {
          this.renderEmpty(t("wxUnavailable"));
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
      if (e.nextPrayer) e.nextPrayer.hidden = true;
      ["humidity", "wind", "feels", "uv"].forEach((k) => {
        if (e[k]) e[k].textContent = "--";
      });
      if (e.hourlyStrip) e.hourlyStrip.innerHTML = "";
      if (e.dailyList) e.dailyList.innerHTML = "";
      if (e.updated) e.updated.textContent = "";
    },

    /** Relative time ("Updated 5 min ago") so it never mixes the device's
     *  clock with the city's clock shown next to it. */
    setUpdated(at, offline = false) {
      this.updatedOffline = offline;
      if (!this.els.updated) return;
      if (!at) {
        this.els.updated.textContent = "";
        return;
      }
      const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
      let ago;
      const unit = (n, u) => (I18n.lang === "ar" ? `قبل ${I18n.count(n, u)}` : `${I18n.count(n, u)} ago`);
      if (mins < 1) ago = t("justNow");
      else if (mins < 60) ago = unit(mins, "min");
      else if (mins < 1440) ago = unit(Math.floor(mins / 60), "hour");
      else ago = unit(Math.floor(mins / 1440), "day");
      const text = offline ? t("offline", { ago }) : t("updated", { ago });
      if (this.els.updated.textContent !== text) this.els.updated.textContent = text;
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
      // City-local time & date once we know its UTC offset, device time before that
      const iso = this.cityNowIso();
      const time = formatTime12(+iso.slice(11, 13), +iso.slice(14, 16));
      if (this.els.locTime && this.els.locTime.textContent !== time) {
        this.els.locTime.textContent = time;
        this.updateNextPrayer();
        this.renderRainAlert();
        if (this.dataAt) this.setUpdated(this.dataAt, this.updatedOffline);
      }
      const dayKey = iso.slice(0, 10);
      if (this.els.locDate && this.lastDateKey !== dayKey) {
        this.lastDateKey = dayKey;
        const full = I18n.date(dayKey, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        if (I18n.lang === "ar") {
          // "الثلاثاء، 3 نوفمبر · 12 جمادى الأولى" (years in the tooltip)
          const hijri = I18n.hijri(dayKey);
          this.els.locDate.textContent =
            I18n.date(dayKey, { weekday: "long", day: "numeric", month: "long" }) + (hijri ? ` · ${hijri}` : "");
          this.els.locDate.title = full + (hijri ? ` · ${I18n.hijri(dayKey, true)}` : "");
        } else {
          this.els.locDate.textContent = full;
          this.els.locDate.title = "";
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
      if (e.wind) e.wind.textContent = Math.round(cur.wind_speed_10m) + " " + t("kmh");
      if (e.feels) e.feels.textContent = Math.round(cur.apparent_temperature) + "°";

      const daily = data.daily;
      const ti = this.todayIndex();
      if (e.hilo && daily && daily.temperature_2m_max) {
        e.hilo.textContent = t("hilo", {
          h: ltr(Math.round(daily.temperature_2m_max[ti]) + "°"),
          l: ltr(Math.round(daily.temperature_2m_min[ti]) + "°")
        });
      }

      const hi = this.nowHourIndex();
      const uvRaw = data.hourly && data.hourly.uv_index ? data.hourly.uv_index[hi] : null;
      if (e.uv) {
        if (hi >= 0 && Number.isFinite(uvRaw)) {
          const uv = Math.round(uvRaw);
          const [label, cls] = uvLevel(uv);
          e.uv.textContent = uv;
          e.uv.className = "stat-value " + cls;
          if (e.uvBox) e.uvBox.setAttribute("aria-label", t("uvAria", { uv, label }));
          if (e.uvBox) e.uvBox.title = `${t("uvIndex")}: ${label}`;
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
      WindowScene.refresh();
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
        title = t("next24");
      } else {
        const date = d.daily.time[this.selectedDay];
        start = h.time.findIndex((t) => t.startsWith(date));
        if (start === -1) {
          this.selectedDay = null;
          this.renderHourly(true);
          return;
        }
        title = I18n.date(date, { weekday: "long", day: "numeric", month: "short" });
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
          label: isNow ? t("now") : h.time[i].slice(11, 16),
          icon: decodeWeather(h.weather_code[i], h.is_day ? h.is_day[i] !== 0 : true).icon,
          pop: Number.isFinite(pop) && pop >= 20 ? Math.round(pop) : null,
          temp: Math.round(h.temperature_2m[i])
        });
      }

      // Sunrise / sunset / prayer markers inside the visible window
      const from = this.selectedDay === null ? this.cityNowIso() : h.time[start];
      const to = h.time[end] || "9999";
      const dl = d.daily || {};
      const markers = [["sunrise", "🌅", t("sunrise")]];
      if (!state.prayers) markers.push(["sunset", "🌇", t("sunset")]); // Maghrib marks sunset
      markers.forEach(([field, icon, text]) => {
        (dl[field] || []).forEach((t) => {
          if (typeof t === "string" && t >= from && t < to) {
            items.push({ key: t, sun: true, label: t.slice(11, 16), icon, text });
          }
        });
      });

      if (state.prayers) {
        this.prayerList().forEach((p) => {
          if (p.key < from || p.key >= to) return;
          // Weather during the hour the prayer falls in
          const hi = h.time.indexOf(p.key.slice(0, 13) + ":00");
          if (hi === -1) return;
          const w = decodeWeather(h.weather_code[hi], h.is_day ? h.is_day[hi] !== 0 : true);
          items.push({
            key: p.key,
            prayer: true,
            label: p.key.slice(11, 16),
            name: t("p_" + p.id),
            icon: w.icon,
            desc: w.desc,
            temp: Math.round(h.temperature_2m[hi])
          });
        });
      }
      items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

      e.hourlyStrip.innerHTML = items
        .map((it) => {
          if (it.prayer) {
            return (
              `<div class="hour-item prayer" role="listitem" ` +
              `aria-label="${escapeHtml(t("prayerAria", { name: it.name, time: it.label, temp: it.temp, desc: it.desc }))}">` +
              `<span class="hour-time">${escapeHtml(it.label)}</span>` +
              `<span class="hour-icon" aria-hidden="true">${it.icon}</span>` +
              `<span class="hour-pop prayer-name">${it.name}</span>` +
              `<span class="hour-temp">${it.temp}°</span></div>`
            );
          }
          if (it.sun) {
            return (
              `<div class="hour-item sun" role="listitem" aria-label="${escapeHtml(t("sunAria", { text: it.text, time: it.label }))}">` +
              `<span class="hour-time">${escapeHtml(it.label)}</span>` +
              `<span class="hour-icon" aria-hidden="true">${it.icon}</span>` +
              `<span class="hour-temp sun-text">${it.text}</span></div>`
            );
          }
          const popHtml = it.pop !== null
            ? `<span class="hour-pop">${it.pop}%</span>`
            : `<span class="hour-pop empty" aria-hidden="true"></span>`;
          const aria = escapeHtml(`${it.label}: ${it.temp}°` + (it.pop !== null ? t("popAria", { pop: it.pop }) : ""));
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
      this.updateNextPrayer();
      this.renderRainAlert();
    },

    // ---------------------------------------------------------------
    // Rain countdown ("Rain starts in about 40 min")
    // ---------------------------------------------------------------
    /** True 15-minute forecasts exist only for North America (NOAA HRRR)
     *  and Central Europe (DWD ICON-D2). Elsewhere Open-Meteo interpolates
     *  hourly data, so we speak in approximate times instead of minutes. */
    hasNativeMinutely() {
      const { lat, lon } = this.location || {};
      if (!Number.isFinite(lat)) return false;
      const northAmerica = lat >= 21 && lat <= 53 && lon >= -134 && lon <= -60;
      const centralEurope = lat >= 43 && lat <= 58 && lon >= -4 && lon <= 20;
      return northAmerica || centralEurope;
    },

    /** Returns { text, kind } or null when no rain change is expected soon. */
    rainAlert() {
      const d = this.data;
      if (!d || !d.current) return null;
      const nowIso = this.cityNowIso();
      const nowMs = Date.parse(nowIso + ":00Z");
      const at = (iso) => Date.parse(iso + ":00Z");
      const intensity = (mmPerHour) => (mmPerHour >= 7.6 ? t("rHeavy") : mmPerHour >= 2.5 ? t("rRain") : t("rLight"));
      const minsText = (n) => (I18n.lang === "ar" ? I18n.count(n, "min") : String(n));
      const code = d.current.weather_code;
      const rainingNow =
        (d.current.precipitation || 0) >= 0.1 || !!RAIN_BY_CODE[code];
      const fmtClock = (ms) => {
        const iso = new Date(ms).toISOString();
        const h24 = +iso.slice(11, 13);
        const mm = iso.slice(14, 16);
        const ap = h24 >= 12 ? t("pm") : t("am");
        return mm === "00" ? `${h24 % 12 || 12} ${ap}` : `${h24 % 12 || 12}:${mm} ${ap}`;
      };

      // ---- Precise: 15-minute data (native regions only)
      const m = d.minutely_15;
      if (this.hasNativeMinutely() && m && m.time && m.precipitation) {
        // Each value is the rain of the 15 minutes BEFORE its timestamp
        const slots = [];
        for (let i = 0; i < m.time.length; i++) {
          const end = at(m.time[i]);
          if (end <= nowMs) continue;
          if (end - nowMs > 3 * 3600000) break;
          slots.push({ start: end - 900000, end, mm: m.precipitation[i] || 0 });
        }
        if (slots.length) {
          const wet = (s) => s.mm >= 0.1;
          const roundMin = (ms) => Math.max(5, Math.round((ms - nowMs) / 300000) * 5);
          if (rainingNow || wet(slots[0])) {
            const k = slots.findIndex((s, i) => !wet(s) && (!slots[i + 1] || !wet(slots[i + 1])));
            if (k === -1) return { kind: "on", text: t("rContinues") };
            return { kind: "stop", text: t("rStopsIn", { m: minsText(roundMin(slots[k].start)) }) };
          }
          const k = slots.findIndex(wet);
          if (k === -1 || slots[k].start - nowMs > 2 * 3600000) return null;
          const mins = Math.round((slots[k].start - nowMs) / 60000);
          const peak = Math.max(...slots.slice(k, k + 4).map((s) => s.mm)) * 4;
          if (mins <= 5) return { kind: "start", text: t("rStartsNow", { w: intensity(peak) }) };
          return { kind: "start", text: t("rStartsIn", { w: intensity(peak), m: minsText(roundMin(slots[k].start)) }) };
        }
      }

      // ---- Approximate: hourly model data (rest of the world)
      const h = d.hourly;
      if (!h || !h.time || !h.precipitation) return null;
      const hours = [];
      for (let i = 0; i < h.time.length; i++) {
        const start = at(h.time[i]) - 3600000; // value = rain of the preceding hour
        const end = at(h.time[i]);
        if (end <= nowMs) continue;
        if (start - nowMs > 6 * 3600000) break;
        const pop = h.precipitation_probability ? h.precipitation_probability[i] : null;
        hours.push({ start, end, mm: h.precipitation[i] || 0, pop: Number.isFinite(pop) ? pop : 50 });
      }
      if (!hours.length) return null;
      const likely = (x) => x.mm >= 0.2 && x.pop >= 40;
      if (rainingNow) {
        const k = hours.findIndex((x) => x.mm < 0.1);
        if (k === -1) return { kind: "on", text: t("rLikelyContinue") };
        if (k === 0) return { kind: "stop", text: t("rEaseHour") };
        return { kind: "stop", text: t("rEaseAt", { t: fmtClock(hours[k].start) }) };
      }
      const k = hours.findIndex(likely);
      if (k === -1) return null;
      const word = intensity(hours[k].mm);
      if (hours[k].start <= nowMs) return { kind: "start", text: t("rLikelyHour", { w: word }) };
      return {
        kind: "start",
        text: t("rExpected", { w: word, t: fmtClock(hours[k].start), p: ltr(Math.round(hours[k].pop) + "%") })
      };
    },

    renderRainAlert() {
      const el = this.els.rainAlert;
      if (!el) return;
      const alert = this.selectedDay === null ? this.rainAlert() : null;
      if (!alert) {
        el.hidden = true;
        return;
      }
      const icon = alert.kind === "stop" ? "🌤️" : "☔";
      const text = `${icon} ${alert.text}`;
      if (el.textContent !== text) el.textContent = text;
      el.dataset.kind = alert.kind;
      el.hidden = false;
    },

    /** Prayer times for every forecast day at the current place (memoized). */
    prayerList() {
      const d = this.data;
      if (!d || !d.daily || !d.daily.time || !this.location) return [];
      const key = `${locationKey(this.location)}|${d.utc_offset_seconds}|${d.daily.time.join(",")}`;
      if (this._prayerKey !== key) {
        this._prayerKey = key;
        this._prayers = PrayerTimes.forDates(
          d.daily.time,
          this.location.lat,
          this.location.lon,
          (d.utc_offset_seconds || 0) / 3600
        );
      }
      return this._prayers;
    },

    updateNextPrayer() {
      const el = this.els.nextPrayer;
      if (!el) return;
      const show = state.prayers && this.selectedDay === null && !!this.data;
      const now = show ? this.cityNowIso() : "";
      const next = show ? this.prayerList().find((p) => p.key > now) : null;
      if (!next) {
        el.hidden = true;
        return;
      }
      const mins = Math.round((Date.parse(next.key + ":00Z") - Date.parse(now + ":00Z")) / 60000);
      const name = t("p_" + next.id);
      const time = next.key.slice(11, 16);
      const text = t("nextPrayer", { name, time, in: I18n.duration(mins) });
      if (el.textContent !== text) el.textContent = text;
      el.title = t("nextPrayerTitle", { name, time });
      el.hidden = false;
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
        const name = isToday ? t("today") : I18n.date(date, { weekday: I18n.lang === "ar" ? "long" : "short" });
        const longName = isToday ? t("today") : I18n.date(date, { weekday: "long" });
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
          t("dayAria", { day: longName, desc: info.desc, lo, hi, pop: pop !== null ? t("popAria", { pop }) : "" })
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
          dot.style.left = (I18n.rtl ? 100 - x : x).toFixed(1) + "%";
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
          const pos = Math.abs(strip.scrollLeft); // RTL scrolls with negative values
          if ((ev.deltaY < 0 && pos <= 0) || (ev.deltaY > 0 && pos >= max - 1)) return;
          ev.preventDefault();
          strip.scrollBy({ left: I18n.rtl ? -ev.deltaY : ev.deltaY });
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
  // PART 26b — PRAYER TIMES (Umm al-Qura, computed on the device)
  // ---------------------------------------------------------------------
  // Fajr: sun 18.5° below the horizon · Dhuhr: solar noon
  // Asr: shadow = object + noon shadow (standard) · Maghrib: sunset
  // Isha: 90 min after Maghrib (120 min in Ramadan)
  // Works for any place on Earth; returns city-local "YYYY-MM-DDTHH:MM".
  // =====================================================================
  const PrayerTimes = {
    NAMES: { fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" },

    rad: (d) => (d * Math.PI) / 180,
    deg: (r) => (r * 180) / Math.PI,
    fixAngle(a) {
      return a - 360 * Math.floor(a / 360);
    },
    fixHour(h) {
      return h - 24 * Math.floor(h / 24);
    },

    julian(y, m, d) {
      if (m <= 2) {
        y -= 1;
        m += 12;
      }
      const A = Math.floor(y / 100);
      const B = 2 - A + Math.floor(A / 4);
      return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
    },

    /** Sun declination and equation of time for a Julian date. */
    sun(jd) {
      const D = jd - 2451545.0;
      const g = this.fixAngle(357.529 + 0.98560028 * D);
      const q = this.fixAngle(280.459 + 0.98564736 * D);
      const L = this.fixAngle(q + 1.915 * Math.sin(this.rad(g)) + 0.02 * Math.sin(this.rad(2 * g)));
      const e = 23.439 - 0.00000036 * D;
      const RA = this.deg(Math.atan2(Math.cos(this.rad(e)) * Math.sin(this.rad(L)), Math.cos(this.rad(L)))) / 15;
      return {
        decl: this.deg(Math.asin(Math.sin(this.rad(e)) * Math.sin(this.rad(L)))),
        eqt: q / 15 - this.fixHour(RA)
      };
    },

    /** Prayer times (local hours) for one date. NaN when the sun never reaches the angle. */
    compute(dateStr, lat, lon, tzHours, ramadan) {
      const [y, m, d] = dateStr.split("-").map(Number);
      const jd = this.julian(y, m, d) - lon / (15 * 24);
      const midDay = (t) => this.fixHour(12 - this.sun(jd + t).eqt);
      const angleTime = (angle, t, ccw) => {
        const decl = this.sun(jd + t).decl;
        const c =
          (-Math.sin(this.rad(angle)) - Math.sin(this.rad(decl)) * Math.sin(this.rad(lat))) /
          (Math.cos(this.rad(decl)) * Math.cos(this.rad(lat)));
        if (c < -1 || c > 1) return NaN; // polar day/night
        const T = this.deg(Math.acos(c)) / 15;
        return midDay(t) + (ccw ? -T : T);
      };
      const asrTime = (t) => {
        const decl = this.sun(jd + t).decl;
        const angle = -this.deg(Math.atan(1 / (1 + Math.tan(this.rad(Math.abs(lat - decl))))));
        return angleTime(angle, t, false);
      };

      const guess = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, maghrib: 18 };
      let t = { ...guess };
      for (let i = 0; i < 2; i++) {
        const f = (k) => (Number.isFinite(t[k]) ? t[k] : guess[k]) / 24;
        t = {
          fajr: angleTime(18.5, f("fajr"), true),
          sunrise: angleTime(0.833, f("sunrise"), true),
          dhuhr: midDay(f("dhuhr")),
          asr: asrTime(f("asr")),
          maghrib: angleTime(0.833, f("maghrib"), false)
        };
      }
      const adj = tzHours - lon / 15;
      const out = {};
      Object.keys(t).forEach((k) => {
        out[k] = t[k] + adj;
      });
      out.isha = out.maghrib + (ramadan ? 2 : 1.5);
      return out;
    },

    isRamadan(dateStr) {
      try {
        const month = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
          month: "numeric",
          timeZone: "UTC"
        }).format(new Date(dateStr + "T12:00:00Z"));
        return parseInt(month, 10) === 9;
      } catch {
        return false;
      }
    },

    /** Sorted list of { key: "YYYY-MM-DDTHH:MM", id, name } for the given dates. */
    forDates(dates, lat, lon, tzHours) {
      const list = [];
      dates.forEach((date) => {
        const times = this.compute(date, lat, lon, tzHours, this.isRamadan(date));
        const base = Date.parse(date + "T00:00:00Z");
        Object.keys(this.NAMES).forEach((id) => {
          const hrs = times[id];
          if (!Number.isFinite(hrs)) return;
          const minutes = Math.round(hrs * 60);
          list.push({
            key: new Date(base + minutes * 60000).toISOString().slice(0, 16),
            id,
            name: this.NAMES[id]
          });
        });
      });
      return list.sort((a, b) => (a.key < b.key ? -1 : 1));
    }
  };

  // =====================================================================
  // PART 26c — LIVE WINDOW (the glass reacts to the real weather)
  // ---------------------------------------------------------------------
  // rain  → drops whose amount follows the real rain (+ lightning in storms)
  // fog   → condensation on the glass (fog codes or high humidity)
  // dust  → sandy haze with drifting grains (Open-Meteo air quality: dust)
  // sun   → dry glass with warm light glare · clear night → soft moonlight
  // "Always rain" keeps the classic look. ?scene=… previews any scene.
  // =====================================================================
  const RAIN_BY_CODE = {
    51: 0.22, 53: 0.32, 55: 0.42, 56: 0.3, 57: 0.42,
    61: 0.45, 63: 0.65, 65: 0.9, 66: 0.5, 67: 0.85,
    80: 0.5, 81: 0.75, 82: 1, 95: 0.85, 96: 0.95, 99: 1
  };

  const SCENE_PRESETS = {
    rain: { rain: 0.65 },
    drizzle: { rain: 0.28, fog: 0.25 },
    storm: { rain: 1, storm: true },
    fog: { fog: 0.9 },
    dust: { dust: 0.85, wind: 35, windDir: 60 },
    clear: { sun: 1 },
    night: { moon: 1 },
    cloudy: {}
  };

  const DustParticles = {
    canvas: null,
    ctx: null,
    grains: [],
    target: 0,
    wind: 20,
    dir: 0,
    raf: null,
    last: 0,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas ? canvas.getContext("2d") : null;
      this.resize();
      window.addEventListener("resize", debounce(() => this.resize(), 200));
    },

    resize() {
      if (!this.canvas) return;
      this.canvas.width = this.canvas.clientWidth || window.innerWidth;
      this.canvas.height = this.canvas.clientHeight || window.innerHeight;
      this.draw(0);
    },

    set(amount, windKmh, windDir) {
      if (!this.ctx) return;
      this.target = Math.round(Math.max(0, Math.min(1, amount)) * 260);
      this.wind = Number.isFinite(windKmh) ? windKmh : 20;
      this.dir = Number.isFinite(windDir) ? windDir : 270;
      while (this.grains.length < this.target) this.grains.push(this.grain(true));
      if (this.grains.length > this.target) this.grains.length = this.target;
      if (reducedMotionQuery.matches || !this.target) {
        this.stop();
        this.draw(0);
      } else {
        this.start();
      }
    },

    grain(anywhere) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.8,
        a: 0.25 + Math.random() * 0.55,
        s: 0.6 + Math.random() * 0.8,
        wob: Math.random() * Math.PI * 2,
        fresh: !anywhere
      };
    },

    start() {
      if (this.raf) return;
      this.last = performance.now();
      const loop = (now) => {
        const dt = Math.min((now - this.last) / 1000, 0.05);
        this.last = now;
        if (!document.hidden) this.draw(dt);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    },

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
    },

    draw(dt) {
      const { ctx, canvas } = this;
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      // Meteorological direction = where the wind comes FROM; grains move the other way
      const speed = 25 + this.wind * 5;
      const vx = -Math.sin(this.dir * Math.PI / 180) * speed;
      const sign = vx < 0 ? -1 : 1;
      ctx.fillStyle = "rgb(250, 222, 180)";
      for (const g of this.grains) {
        g.wob += dt * 2;
        g.x += (vx * g.s + sign * 8) * dt;
        g.y += Math.sin(g.wob) * 6 * dt + 4 * dt;
        if (g.x < -5) g.x = w + 5;
        if (g.x > w + 5) g.x = -5;
        if (g.y > h + 5) g.y = -5;
        ctx.globalAlpha = g.a;
        ctx.beginPath();
        ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };

  const WindowScene = {
    els: {},
    override: null,
    scene: null,
    flashTimer: null,
    fogKey: "",

    init(override) {
      this.els = {
        dust: $id("fx-dust"),
        fog: $id("fx-fog"),
        glare: $id("fx-glare"),
        flash: $id("fx-flash"),
        status: $id("window-status")
      };
      this.override = SCENE_PRESETS[override] ? override : null;
      DustParticles.init(this.els.dust);
      window.addEventListener("resize", debounce(() => this.drawFog(), 300));
      document.addEventListener("visibilitychange", () => this.scheduleFlash());
    },

    /** Turn the forecast into effect strengths (0–1). */
    fromWeather(data) {
      const s = { rain: 0, fog: 0, dust: 0, sun: 0, moon: 0, storm: false };
      if (!data || !data.current) return s;
      const c = data.current;
      const code = c.weather_code;
      const isDay = c.is_day !== 0;
      const precip = Number.isFinite(c.precipitation) ? c.precipitation : 0;

      s.rain = Math.max(RAIN_BY_CODE[code] || 0, Math.min(1, precip / 4));
      s.storm = code >= 95;

      const hum = c.relative_humidity_2m;
      if (code === 45 || code === 48) s.fog = 0.9;
      else if (hum >= 93) s.fog = 0.6;
      else if (hum >= 85) s.fog = 0.3;
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) s.fog = Math.max(s.fog, 0.7); // frosty glass

      const dust = data.air && Number.isFinite(data.air.dust) ? data.air.dust : 0;
      s.dust = Math.max(0, Math.min(1, (dust - 50) / 350));
      s.dustValue = dust;

      if (!s.rain && code <= 2) {
        const clear = code === 0 ? 1 : code === 1 ? 0.8 : 0.45;
        if (isDay) s.sun = clear * (1 - s.dust * 0.8);
        else s.moon = clear * (1 - s.dust * 0.8);
      }
      s.wind = c.wind_speed_10m;
      s.windDir = c.wind_direction_10m;
      return s;
    },

    current() {
      if (this.override) {
        return { rain: 0, fog: 0, dust: 0, sun: 0, moon: 0, storm: false, wind: 20, windDir: 270, ...SCENE_PRESETS[this.override] };
      }
      if (state.windowMode === "rain") {
        return { rain: state.rain / 100, fog: 0, dust: 0, sun: 0, moon: 0, storm: false, classic: true };
      }
      return this.fromWeather(Weather.data);
    },

    /** RainyGlass options for the current scene. */
    dropOptions(s = this.current()) {
      if (s.classic) return rainOptions(s.rain);
      // In live mode the Rain slider scales the real amount (70% ≈ as-is)
      const scale = Math.min(1.43, state.rain / 70);
      // Any real rain should read clearly on the glass: drizzle ≈ 0.5, heavy ≈ 1
      if (s.rain > 0) return rainOptions(Math.min(1, (0.3 + s.rain * 0.8) * scale));
      if (s.fog > 0) {
        // Condensation: many small beads that stay put
        const k = Math.min(1, s.fog * scale);
        return {
          dropletsRate: k === 0 ? 0 : 4 + k * 10,
          maxDroplets: Math.round(k * 60),
          minRadius: 2,
          maxRadius: 7,
          slideChance: 0
        };
      }
      return { dropletsRate: 0, maxDroplets: 0 }; // dry glass
    },

    refresh() {
      const s = this.current();
      this.scene = s;
      if (rainyGlassInstance && !rainyGlassInstance.isDestroyed) {
        rainyGlassInstance.setOptions(this.dropOptions(s));
      }

      const { fog, dust, glare } = this.els;
      if (fog) {
        if (s.fog > 0) this.drawFog();
        fog.style.opacity = (s.fog * 0.85).toFixed(2);
      }
      if (dust) {
        dust.style.opacity = (s.dust * 0.9).toFixed(2);
        DustParticles.set(s.dust, s.wind, s.windDir);
      }
      if (glare) {
        const b = Math.min(1, 0.45 + state.brightness / 100);
        glare.classList.toggle("moon", !s.sun && s.moon > 0);
        glare.style.opacity = ((s.sun || s.moon * 0.7) * b).toFixed(2);
      }
      this.storm = !!s.storm;
      this.scheduleFlash();
      this.updateStatus(s);
    },

    /** Uneven condensation texture, drawn at low resolution (it's blurry anyway). */
    drawFog() {
      const c = this.els.fog;
      if (!c) return;
      const w = Math.ceil((c.clientWidth || window.innerWidth) / 4);
      const h = Math.ceil((c.clientHeight || window.innerHeight) / 4);
      const key = w + "x" + h;
      if (this.fogKey === key) return;
      this.fogKey = key;
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.clearRect(0, 0, w, h);

      const base = g.createLinearGradient(0, 0, 0, h);
      base.addColorStop(0, "rgba(214, 226, 238, 0.42)");
      base.addColorStop(1, "rgba(224, 234, 244, 0.68)");
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);

      // Denser patches
      for (let i = 0; i < 70; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = (0.04 + Math.random() * 0.2) * Math.max(w, h);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(238, 244, 250, ${0.08 + Math.random() * 0.18})`);
        grad.addColorStop(1, "rgba(238, 244, 250, 0)");
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      // Thinner patches, mostly in the middle
      g.globalCompositeOperation = "destination-out";
      for (let i = 0; i < 26; i++) {
        const x = w * (0.15 + Math.random() * 0.7);
        const y = h * (0.1 + Math.random() * 0.65);
        const r = (0.05 + Math.random() * 0.16) * Math.max(w, h);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(0, 0, 0, ${0.15 + Math.random() * 0.25})`);
        grad.addColorStop(1, "rgba(0, 0, 0, 0)");
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      g.globalCompositeOperation = "source-over";
    },

    /** Gentle, infrequent lightning during thunderstorms (off with reduced motion). */
    scheduleFlash() {
      clearTimeout(this.flashTimer);
      if (!this.storm || reducedMotionQuery.matches || document.hidden || !this.els.flash) return;
      this.flashTimer = setTimeout(() => {
        const el = this.els.flash;
        if (el.animate) {
          el.animate(
            [
              { opacity: 0 },
              { opacity: 0.28, offset: 0.08 },
              { opacity: 0.04, offset: 0.22 },
              { opacity: 0.2, offset: 0.32 },
              { opacity: 0 }
            ],
            { duration: 900, easing: "ease-out" }
          );
        }
        this.scheduleFlash();
      }, 7000 + Math.random() * 11000);
    },

    updateStatus(s) {
      const el = this.els.status;
      if (!el) return;
      let text;
      if (s.classic) {
        text = t("wAlways");
      } else {
        const parts = [];
        if (s.storm) parts.push(t("wStorm"));
        else if (s.rain >= 0.7) parts.push(t("wHeavy"));
        else if (s.rain >= 0.4) parts.push(t("wRain"));
        else if (s.rain > 0) parts.push(t("wLight"));
        if (s.fog >= 0.8) parts.push(t("wFog"));
        else if (s.fog > 0) parts.push(t("wCond"));
        if (s.dust > 0) parts.push(s.dust >= 0.5 ? t("wDusty") : t("wDust"));
        if (!parts.length) parts.push(s.sun ? t("wSunny") : s.moon ? t("wNight") : t("wDry"));
        const line = cap(parts.join(t("listSep")));
        text = t(this.override ? "wPreview" : "wNow", { x: line });
        if (s.dustValue >= 50 && !this.override) text += t("wDustVal", { v: Math.round(s.dustValue) });
      }
      el.textContent = text;
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
      this.listTitle.textContent = t("recent");
      this.clearRecentsBtn.hidden = recents.length === 0;
      this.setStatus(recents.length ? "" : t("typeHint"));
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
      this.setStatus(mode === "extended" ? t("searchingOsm") : t("searching"));
      try {
        const results = await fetcher(q, controller.signal);
        if (id !== this.reqId) return;
        this.input.removeAttribute("aria-busy");
        this.listHead.hidden = results.length === 0;
        this.listTitle.textContent = mode === "extended" ? t("extResults") : t("results");
        this.clearRecentsBtn.hidden = true;
        this.attrib.hidden = !(mode === "extended" || results.some((r) => r.osm));
        this.render(results, mode);
        const osmDown = mode === "results" && Geo.lastOsmStatus && Geo.lastOsmStatus !== "ok";
        if (results.length) {
          this.setStatus(I18n.count(results.length, "result") + (osmDown ? t("villageDown") : ""));
        } else if (osmDown) {
          this.setStatus(t("villageDownEmpty"));
        } else {
          this.setStatus(mode === "extended" ? t("noPlaces") : t("noResults"));
        }
        this.extBtn.hidden = mode === "extended";
      } catch (err) {
        if (err.name === "AbortError" || id !== this.reqId) return;
        this.input.removeAttribute("aria-busy");
        this.setStatus(t("searchFail"));
      }
    },

    search(q) {
      const near = Weather.location;
      return this.run((query, signal) => Geo.searchAll(query, signal, near), "results", q);
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
      this.setStatus(t("locating"));
      this.geoBtn.disabled = true;
      try {
        const loc = await Weather.locateMe();
        if (!this.isOpen()) return;
        this.close();
        if (loc) showToast(`📍 ${locationLabel(loc)}`, "success");
      } catch (err) {
        const code = err && err.code;
        this.setStatus(code >= 1 && code <= 3 ? t("geo" + code) : t("geoX"));
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
  /** Switch the interface language and redraw everything that shows text. */
  function setLanguage(pref) {
    I18n.setPref(pref);
    I18n.apply();
    createPresets();
    applyStateToUI();
    if (FullscreenAPI.supported()) FullscreenAPI.updateButtonIcon(FullscreenAPI.isFullscreen());
    const versionEl = $id("app-version");
    if (versionEl) versionEl.textContent = t("version", { v: APP_VERSION });
    if (Weather.location && Weather.location.source === "default") Weather.location = defaultLocation();
    Weather.lastDateKey = null;
    Weather.renderLocation();
    if (Weather.data) Weather.render(Weather.data, Weather.dataAt);
    else Weather.renderEmpty(t("loadingWx"));
    WindowScene.refresh();
    if (CitySearch.isOpen()) CitySearch.handleQuery();
  }

  function init() {
    // Language first, so every text below is drawn in the right one
    I18n.init(new URLSearchParams(window.location.search).get("lang"));
    I18n.apply();

    AudioManager.init(rainAudio);
    PWAManager.init();
    FullscreenAPI.init();
    setupMediaHandlers();
    setupFocusTrap();

    const fromUrl = loadFromUrl();
    if (!fromUrl.hasSettings) loadFromLocalStorage();

    WindowScene.init(fromUrl.scene);
    createPresets();
    applyStateToUI();
    ensureRain();

    if (FullscreenAPI.supported()) FullscreenAPI.updateButtonIcon(false);

    // Language: auto (device) / Arabic / English
    document.querySelectorAll(".seg-btn[data-lang]").forEach((btn) => {
      btn.addEventListener("click", () => setLanguage(btn.dataset.lang));
    });

    // Window: live weather / always rain
    document.querySelectorAll(".seg-btn[data-window]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.windowMode = btn.dataset.window === "rain" ? "rain" : "live";
        applyStateToUI();
      });
    });

    const prayerToggle = $id("prayer-toggle");
    if (prayerToggle) {
      prayerToggle.addEventListener("change", () => {
        state.prayers = prayerToggle.checked;
        Weather.renderHourly();
      });
    }

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
          showToast(t("enterUrl"), "error");
          return;
        }
        const safe = sanitizeUrl(raw);
        if (!safe) {
          showToast(t("badUrl"), "error");
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
            showToast(t("tooLarge"), "error");
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
        if (confirm(t("resetConfirm"))) resetToDefaults();
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

    const versionEl = $id("app-version");
    if (versionEl) versionEl.textContent = t("version", { v: APP_VERSION });

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
