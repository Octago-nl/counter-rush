/* Counter Rush — game.js
 * A self-contained, guaranteed-playable multi-lane serve-and-dispatch time-manager
 * (genome: counter-rush): work a glowing four-lane counter, slide full orders down a
 * lane to slake advancing patrons, then catch the empties they push back before they
 * smash on the floor. Patrons queue faster and walk quicker as the shift ramps; clear
 * a whole rush to grab a tip-token and a brief slow-motion breather. Let a patron reach
 * the counter, or miss a returning empty, and you burn one of three lives.
 *
 * INTEGRATES the shared Octagonal engine/beacon + the reusable engine/arcade-controls.js
 * deck when present (canonical-origin load), but NEVER depends on any of them for the
 * core loop, so the cabinet plays even if the engine/deck fail to load. No build step;
 * classic script.
 */
(function () {
  "use strict";

  /* ---- Cartridge integration (all guarded — missing engine = no-op, never a crash) ---- */
  var SLUG = "counter-rush";
  var Beacon = (window.OCTAGO_BEACON && typeof window.OCTAGO_BEACON.emit === "function")
    ? window.OCTAGO_BEACON : { emit: function () {} };
  var VARIANT = "A";
  // Boot the beacon ourselves: this cabinet does NOT call OCTAGO.boot(), so nothing
  // else inits the beacon — without this, emit() only buffers and never POSTs.
  if (window.OCTAGO_BEACON && window.OCTAGO_BEACON.init) {
    window.OCTAGO_BEACON.init({ collector: window.OCTAGO_COLLECTOR || "", key: window.OCTAGO_KEY || "octgnl_pub_live", entity: "slug", slug: SLUG });
  }
  function emit(event, value, unit, dims) {
    try {
      Beacon.emit(event, {
        entity: SLUG, value: value == null ? 1 : value, unit: unit || "count",
        dims: Object.assign({ variant: VARIANT, slug: SLUG }, dims || {})
      });
    } catch (e) {}
  }

  /* ---- live error telemetry (the template pattern for every game) ----------------------
   * A crash used to die silently. Now the rAF loop is wrapped and BOTH global error hooks
   * funnel through emit("error", ...) (the only error verb in the vocab). Guarded so the
   * reporter itself can never throw. QA (?debug=1) can read errorCount() as evidence.
   */
  var _errCount = 0, _lastErr = null;
  function emitError(msg, src) {
    _errCount++;
    _lastErr = { msg: String(msg == null ? "" : msg), src: String(src == null ? "" : src) };
    try { emit("error", 1, "count", { msg: _lastErr.msg.slice(0, 120), src: _lastErr.src.slice(0, 60) }); } catch (e) {}
  }
  addEventListener("error", function (e) {
    try { emitError((e && e.message) || "error", ((e && e.filename) || "") + ":" + ((e && e.lineno) || 0)); } catch (_) {}
  });
  addEventListener("unhandledrejection", function (e) {
    try { var r = e && e.reason; emitError((r && r.message) || String(r || "rejection"), "promise"); } catch (_) {}
  });

  var reduce = false;
  try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /* ---- procedural WebAudio SFX -----------------------------------------------------------
   * Every sound is SYNTHESIZED (OscillatorNode/GainNode/noise buffer) so the cartridge ships
   * ZERO audio assets. Lazy AudioContext, resumed on first gesture (autoplay policy). Mute
   * toggle persists to localStorage.
   */
  var Sound = (function () {
    var ctx = null, master = null, muted = false;
    try { muted = localStorage.getItem("oct.counter-rush.muted") === "1"; } catch (e) {}
    var VOL = 0.5;
    function ensure() {
      if (ctx) return ctx;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : VOL;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; }
      return ctx;
    }
    function unlock() {
      var c = ensure();
      if (c && c.state === "suspended") { try { c.resume(); } catch (e) {} }
    }
    function tone(o) {
      if (muted) return;
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime, dur = o.dur || 0.08;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = o.type || "square";
      osc.frequency.setValueAtTime(o.f0, t0);
      if (o.f1 != null) { try { osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dur); } catch (e) {} }
      var peak = o.gain == null ? 0.28 : o.gain;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function noise(dur, gain, hp) {
      if (muted) return;
      var c = ensure(); if (!c) return;
      var t0 = c.currentTime, n = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, n, c.sampleRate), data = buf.getChannelData(0);
      for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      var src = c.createBufferSource(); src.buffer = buf;
      var f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp || 700;
      var g = c.createGain(); g.gain.value = gain == null ? 0.22 : gain;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0);
    }
    function arp(freqs, step, type) {
      if (muted) return;
      for (var i = 0; i < freqs.length; i++) {
        (function (f, d) { setTimeout(function () { tone({ type: type, f0: f, dur: step * 1.5, gain: 0.24 }); }, d * 1000); })(freqs[i], step * i);
      }
    }
    var SFX = {
      serve: function () { tone({ type: "triangle", f0: 520, f1: 780, dur: 0.09, gain: 0.22 }); },
      pour: function () { noise(0.07, 0.10, 2200); },
      clink: function () { tone({ type: "sine", f0: 1400, f1: 900, dur: 0.07, gain: 0.30 }); noise(0.03, 0.08, 4000); },
      whiff: function () { tone({ type: "sine", f0: 260, dur: 0.05, gain: 0.10 }); },
      lane: function () { tone({ type: "square", f0: 300, dur: 0.03, gain: 0.10 }); },
      smash: function () { noise(0.22, 0.30, 500); tone({ type: "sawtooth", f0: 180, f1: 60, dur: 0.22, gain: 0.24 }); },
      miss: function () { tone({ type: "sawtooth", f0: 220, f1: 90, dur: 0.28, gain: 0.26 }); },
      rushclear: function () { arp([523, 659, 784, 1047, 1319], 0.075, "triangle"); },
      over: function () { arp([392, 330, 262, 196], 0.13, "sawtooth"); },
      start: function () { arp([262, 392, 523], 0.06, "square"); }
    };
    return {
      play: function (name) { try { if (SFX[name]) SFX[name](); } catch (e) {} },
      unlock: unlock,
      toggle: function () { muted = !muted; if (master) master.gain.value = muted ? 0 : VOL; try { localStorage.setItem("oct.counter-rush.muted", muted ? "1" : "0"); } catch (e) {} return muted; },
      isMuted: function () { return muted; }
    };
  })();
  (function () {
    var done = false;
    function go() { if (done) return; done = true; Sound.unlock(); }
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
      try { addEventListener(ev, go, { passive: true }); } catch (e) { addEventListener(ev, go); }
    });
  })();

  /* ---- canvas + DOM -----------------------------------------------------------------------*/
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var W = canvas.width, H = canvas.height;
  var els = {
    score: document.getElementById("score"), best: document.getElementById("best"),
    level: document.getElementById("level"), lives: document.getElementById("lives"),
    combo: document.getElementById("combo"), rush: document.getElementById("reso"),
    overlay: document.getElementById("overlay"), title: document.getElementById("title"),
    tag: document.getElementById("tag"), start: document.getElementById("start"),
    share: document.getElementById("share"), shareWrap: document.getElementById("share-wrap"),
    a11y: document.getElementById("a11y-status")
  };
  var best = 0;
  try { best = +(localStorage.getItem("oct.counter-rush.best") || 0) | 0; } catch (e) {}
  if (els.best) els.best.textContent = best;

  function announce(msg) { if (els.a11y) els.a11y.textContent = msg; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* ---- layout ---------------------------------------------------------------------------- */
  var LANES = 4;
  var TOP_MARGIN = 70, BOTTOM_MARGIN = 30;
  var LANE_H = (H - TOP_MARGIN - BOTTOM_MARGIN) / LANES;   // 125
  var BAR_X = 56;                 // counter edge — orders launch from here, empties must reach here
  var SPAWN_X = W - 26;           // patrons walk in from here
  var CATCH_ZONE = 48;            // px window past the counter edge where CATCH succeeds

  function laneCenterY(i) { return TOP_MARGIN + i * LANE_H + LANE_H / 2; }

  /* ---- beat-my-score deep link (?s=&p=) --------------------------------------------------- */
  var q = new URLSearchParams(location.search);
  var rivalScore = +q.get("s") || 0, rival = q.get("p") || "";

  /* ---- flags.json → monetization slots ---------------------------------------------------- */
  fetch("./flags.json").then(function (r) { return r.json(); }).then(function (f) {
    var slots = (f && f.slots) || {};
    VARIANT = (f && f.experiment && f.experiment.variant) || "A";
    Object.keys(slots).forEach(function (k) {
      var on = slots[k] && slots[k].on;
      var el = document.querySelector('[data-slot="' + k + '"]');
      if (el && on) {
        el.classList.add("on");
        if (k === "cabinet_banner") {
          emit("ad_impression", 1, "count", { network: (slots[k].network || "house") });
          el.addEventListener("click", function () { emit("ad_click", 1, "count", { network: (slots[k].network || "house") }); });
        }
        if (k === "insert_coin_jar") {
          el.href = "https://ko-fi.com/octagonal";        // hosted checkout — zero server
          el.addEventListener("click", function () {
            emit("coin_insert", 1, "count");
            emit("checkout_step", 1, "count", { step: "jar_click" });
          });
        }
        if (k === "arcade_pass_gate") {
          el.style.cursor = "pointer";
          el.addEventListener("click", function () { emit("checkout_step", 1, "count", { step: "pass_gate_click" }); });
        }
      }
    });
  }).catch(function () {/* flags optional */ });

  /* ---- arcade control deck (engine/arcade-controls.js) ------------------------------------ */
  var deck = null;
  (function mountDeck() {
    try {
      var mountEl = document.getElementById("controls");
      if (mountEl && window.ArcadeControls) {
        deck = window.ArcadeControls.mount({
          mount: mountEl, theme: "synthwave",
          layout: [
            { id: "lanepad", type: "dpad", side: "left", label: "LANE",
              keys: { up: ["ArrowUp", "KeyW"], down: ["ArrowDown", "KeyS"] } },
            { id: "serve", type: "button", side: "center", label: "SERVE", sub: "pour",
              ariaLabel: "Serve a drink in the selected lane", keys: ["Space", "KeyZ"] },
            { id: "catch", type: "button", side: "right", label: "CATCH", sub: "grab",
              ariaLabel: "Catch a returning empty glass", keys: ["KeyX", "Enter"] }
          ]
        });
      }
    } catch (e) { deck = null; }
  })();

  /* ---- keyboard fallback (only wired if the deck failed to load — never double-fires) ----- */
  var pendingServe = false, pendingCatch = false;
  if (!deck) {
    addEventListener("keydown", function (e) {
      if (e.repeat) return;
      if (e.code === "ArrowUp" || e.code === "KeyW") { laneMove(-1); Sound.play("lane"); }
      else if (e.code === "ArrowDown" || e.code === "KeyS") { laneMove(1); Sound.play("lane"); }
      else if (e.code === "Space" || e.code === "KeyZ") { pendingServe = true; }
      else if (e.code === "KeyX" || e.code === "Enter") { pendingCatch = true; }
    });
  }

  /* ---- touch fallback (canvas tap zones + makeshift buttons, only if the deck failed) ----- */
  var fallbackBar = null;
  if (!deck) {
    canvas.addEventListener("pointerdown", function (e) {
      var r = canvas.getBoundingClientRect();
      var y = (e.clientY - r.top) / r.height * H;
      if (y < H / 2) laneMove(-1); else laneMove(1);
      Sound.play("lane");
    });
    fallbackBar = document.createElement("div");
    fallbackBar.style.cssText = "display:flex;gap:10px;justify-content:center;margin-top:6px";
    var b1 = document.createElement("button"), b2 = document.createElement("button");
    b1.className = "btn"; b1.textContent = "▶ SERVE"; b1.type = "button";
    b2.className = "btn mag"; b2.textContent = "◎ CATCH"; b2.type = "button";
    b1.addEventListener("click", function () { pendingServe = true; });
    b2.addEventListener("click", function () { pendingCatch = true; });
    fallbackBar.appendChild(b1); fallbackBar.appendChild(b2);
    var mountEl = document.getElementById("controls");
    if (mountEl) mountEl.parentNode.insertBefore(fallbackBar, mountEl.nextSibling);
  }

  function laneMove(delta) {
    if (!S || S.mode !== "play") return;
    S.selected = clamp(S.selected + delta, 0, LANES - 1);
  }

  /* ---- state ------------------------------------------------------------------------------ */
  var S = null;
  var particles = [];
  var shake = 0;

  function newLane() { return { patrons: [], orders: [], spawnT: rand(0.6, 1.4) }; }

  function difficultyFor(level) {
    return {
      spawnMin: Math.max(0.85, 2.5 - 0.14 * level),
      spawnMax: Math.max(1.5, 4.0 - 0.18 * level),
      maxQueue: level >= 8 ? 3 : (level >= 3 ? 2 : 1),
      pSpeed: Math.min(150, 40 + level * 7),
      dSpeed: Math.min(340, 210 + level * 6),
      eSpeed: Math.min(360, 225 + level * 6)
    };
  }
  function rushTargetFor(level) { return 8 + level * 3; }

  function startGame() {
    S = {
      mode: "play", score: 0, level: 1, lives: 3, combo: 1,
      selected: 1, rushServed: 0, rushTarget: rushTargetFor(1),
      lanes: [newLane(), newLane(), newLane(), newLane()],
      slowmo: 0, clearT: 0, startTs: Date.now(), last: performance.now(), __injectErr: false
    };
    els.overlay.classList.add("hide");
    els.shareWrap.style.display = "none";
    Sound.play("start");
    emit("play_start", 1, "count", {});
    emit("level", 1, "count", {});
    hud();
    announce("Shift started. Level 1.");
    requestAnimationFrame(loop);
  }

  function comboMul() { return 1 + Math.min(9, S.combo - 1) * 0.1; }

  function addScore(base) {
    var pts = Math.round(base * comboMul());
    S.score += pts;
    return pts;
  }

  function spawnShards(x, y, color, n) {
    if (reduce) return;
    for (var i = 0; i < n; i++) {
      particles.push({
        x: x, y: y, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200 - 30,
        t: 1, color: color, s: 2 + Math.random() * 3
      });
    }
  }
  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt; p.t -= dt * 1.6;
      if (p.t <= 0) particles.splice(i, 1);
    }
    if (shake > 0) shake = Math.max(0, shake - dt * 3.2);
  }

  /* ---- lane simulation ---------------------------------------------------------------------
   * Each lane holds `patrons` (walking in from the right, or exiting after being served) and
   * `orders` (a full drink sliding right toward a patron, or an empty glass sliding back left
   * toward the counter). This is the whole mechanic: SERVE spawns a full order aimed at the
   * nearest un-served patron; when it reaches them the order flips to an empty and the patron
   * peels off; CATCH claims an empty inside the counter-edge window before it smashes.
   */
  function updateLane(lane, li, dt, diff) {
    // spawn (frozen once the rush quota is met, so the round can actually drain and clear)
    lane.spawnT -= dt;
    if (lane.spawnT <= 0 && lane.patrons.length < diff.maxQueue && S.rushServed < S.rushTarget) {
      lane.patrons.push({ x: SPAWN_X, speed: diff.pSpeed, state: "walk" });
      lane.spawnT = rand(diff.spawnMin, diff.spawnMax);
    }

    // patrons
    for (var i = lane.patrons.length - 1; i >= 0; i--) {
      var p = lane.patrons[i];
      if (p.state === "walk") {
        p.x -= p.speed * dt;
        if (p.x <= BAR_X) {
          lane.patrons.splice(i, 1);
          missPatron(li);
          continue;
        }
      } else { // exit
        p.x += p.speed * 1.6 * dt;
        if (p.x > SPAWN_X + 20) lane.patrons.splice(i, 1);
      }
    }

    // orders (full -> travel right toward nearest walking patron; empty -> travel left to counter)
    for (var j = lane.orders.length - 1; j >= 0; j--) {
      var o = lane.orders[j];
      if (o.dir > 0) {
        o.x += diff.dSpeed * dt;
        var hitP = null;
        for (var k = 0; k < lane.patrons.length; k++) {
          var cand = lane.patrons[k];
          if (cand.state === "walk" && o.x >= cand.x) { if (!hitP || cand.x < hitP.x) hitP = cand; }
        }
        if (!hitP && o.x > SPAWN_X + 40) { lane.orders.splice(j, 1); continue; }  // orphaned pour (target already left) — no penalty
        if (hitP) {
          hitP.state = "exit";
          o.dir = -1; o.x = hitP.x;
          S.rushServed++;
          addScore(10);
          S.combo++;
          spawnShards(o.x, laneCenterY(li), "#20e6ff", 8);
          Sound.play("serve");
          emit("quest_progress", S.rushServed, "count", { quest: "rush", target: S.rushTarget, level: S.level });
          hud();
        }
      } else {
        o.x -= diff.eSpeed * dt;
        if (o.x <= BAR_X - 6) {
          lane.orders.splice(j, 1);
          missCatch(li, o);
        }
      }
    }
  }

  function missPatron(li) {
    if (!S || S.mode !== "play") return;
    S.lives--; S.combo = 1; shake = 1;
    Sound.play("miss");
    spawnShards(BAR_X, laneCenterY(li), "#ff2fb9", 10);
    hud();
    announce("A patron reached the counter. Life lost.");
    if (S.lives <= 0) endGame(false);
  }
  function missCatch(li, o) {
    if (!S || S.mode !== "play") return;
    S.lives--; S.combo = 1; shake = 1;
    Sound.play("smash");
    spawnShards(BAR_X, laneCenterY(li), "#ffd23f", 10);
    hud();
    announce("An empty glass smashed. Life lost.");
    if (S.lives <= 0) endGame(false);
  }

  function serveAction() {
    if (!S || S.mode !== "play") return;
    var lane = S.lanes[S.selected];
    var waiting = 0, inflight = 0;
    for (var i = 0; i < lane.patrons.length; i++) if (lane.patrons[i].state === "walk") waiting++;
    for (var j = 0; j < lane.orders.length; j++) if (lane.orders[j].dir > 0) inflight++;
    if (waiting > inflight) {
      lane.orders.push({ x: BAR_X, dir: 1 });
      Sound.play("pour");
      spawnShards(BAR_X, laneCenterY(S.selected), "#ff2fb9", 4);
    } else {
      Sound.play("whiff");
    }
  }

  function catchAction() {
    if (!S || S.mode !== "play") return;
    var lane = S.lanes[S.selected];
    var target = null;
    for (var i = 0; i < lane.orders.length; i++) {
      var o = lane.orders[i];
      if (o.dir < 0 && o.x <= BAR_X + CATCH_ZONE) { if (!target || o.x < target.x) target = o; }
    }
    if (target) {
      lane.orders.splice(lane.orders.indexOf(target), 1);
      addScore(15);
      S.combo++;
      Sound.play("clink");
      spawnShards(BAR_X, laneCenterY(S.selected), "#20e6ff", 8);
      hud();
    } else {
      Sound.play("whiff");
    }
  }

  function onServeBtn() {
    Sound.unlock();
    if (!S || S.mode === "idle" || S.mode === "over") { startGame(); return; }
    if (S.mode === "rushclear") { proceedAfterClear(); return; }
    if (S.mode === "play") serveAction();
  }
  function onCatchBtn() {
    if (S && S.mode === "play") catchAction();
  }

  function allLanesClearOfWalkers() {
    for (var i = 0; i < S.lanes.length; i++) {
      var lp = S.lanes[i].patrons;
      for (var j = 0; j < lp.length; j++) if (lp[j].state === "walk") return false;
    }
    return true;
  }

  function checkRushClear() {
    if (S.mode !== "play") return;
    if (S.rushServed >= S.rushTarget && allLanesClearOfWalkers()) {
      S.mode = "rushclear"; S.clearT = 1.6;
      var bonus = 100 + S.level * 15;
      S.score += bonus;
      S.slowmo = reduce ? 0 : 1.2;
      shake = Math.max(shake, 0.6);
      Sound.play("rushclear");
      emit("tip", bonus, "count", { level: S.level });
      emit("xp_earn", 10 + S.level, "count", {});
      hud();
      announce("Rush cleared! Tip token earned. Bonus " + bonus + ".");
    }
  }
  function proceedAfterClear() {
    if (!S || S.mode !== "rushclear") return;
    S.level++;
    S.rushServed = 0;
    S.rushTarget = rushTargetFor(S.level);
    S.lanes = [newLane(), newLane(), newLane(), newLane()];
    S.mode = "play"; S.slowmo = 0;
    emit("level", S.level, "count", {});
    hud();
    announce("Level " + S.level + ".");
  }

  function endGame(won) {
    S.mode = "over";
    Sound.play("over");
    var dur = Date.now() - S.startTs;
    emit("score", S.score, "count");
    emit("play_end", dur, "ms", { score: S.score, level: S.level, won: 0 });
    if (S.score > best) { best = S.score; try { localStorage.setItem("oct.counter-rush.best", best); } catch (e) {} if (els.best) els.best.textContent = best; }
    els.title.textContent = "GAME OVER";
    els.tag.innerHTML = "score <b style='color:#20e6ff'>" + S.score + "</b> · reached level <b>" + S.level + "</b><br>" +
      (S.score >= best ? "★ NEW BEST ★" : "best " + best) + " — press SERVE to work another shift";
    els.start.textContent = "▶ INSERT COIN";
    els.shareWrap.style.display = "";
    announce("Game over. Final score " + S.score + ".");
    hud();
    els.overlay.classList.remove("hide");
  }

  function hud() {
    if (!S) return;
    if (els.score) els.score.textContent = S.score;
    if (els.level) els.level.textContent = S.level;
    if (els.lives) els.lives.textContent = Math.max(0, S.lives);
    if (els.combo) els.combo.textContent = "x" + Math.max(1, S.combo);
    if (els.rush) els.rush.textContent = Math.min(S.rushServed, S.rushTarget) + "/" + S.rushTarget;
  }

  /* ---- share (beat-my-score deep link) ----------------------------------------------------- */
  function share() {
    var pid = (function () { try { var p = localStorage.getItem("oct_pid"); if (!p) { p = "g" + (Date.now() % 1e7); localStorage.setItem("oct_pid", p); } return p; } catch (e) { return "g" + (Date.now() % 1e7); } })();
    var sc = S ? S.score : 0;
    var url = location.origin + location.pathname + "?s=" + sc + "&p=" + encodeURIComponent(pid);
    emit("share_click", 1, "count", { score: sc });
    var text = "I served " + sc + " in Counter Rush — can you beat it? ⯃";
    if (navigator.share) { navigator.share({ title: "Counter Rush", text: text, url: url }).catch(function () {}); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () {
        els.share.textContent = "✓ LINK COPIED";
        setTimeout(function () { els.share.textContent = "↗ SHARE / BEAT MY SCORE"; }, 1500);
      }).catch(function () { prompt("Copy your challenge link:", url); });
    } else prompt("Copy your challenge link:", url);
  }
  if (els.start) els.start.addEventListener("click", onServeBtn);
  if (els.share) els.share.addEventListener("click", share);

  /* ---- drawing ------------------------------------------------------------------------------ */
  var tPulse = 0;
  function drawBackdrop() {
    ctx.fillStyle = "#070225";
    ctx.fillRect(0, 0, W, H);
    // marquee glow
    var glow = 0.55 + 0.35 * Math.sin(tPulse * 2.2);
    ctx.save();
    ctx.textAlign = "center"; ctx.font = "bold 22px Chakra Petch, monospace";
    ctx.shadowColor = "#ff2fb9"; ctx.shadowBlur = 18 * glow;
    ctx.fillStyle = "#ffe9fb";
    ctx.fillText("◆ COUNTER RUSH ◆", W / 2, 40);
    ctx.restore();
    // counter (the bar itself, running the full lane depth at BAR_X)
    var top = TOP_MARGIN, bot = TOP_MARGIN + LANES * LANE_H;
    var grad = ctx.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, "#241147"); grad.addColorStop(1, "#0b0420");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top, BAR_X - 4, bot - top);
    ctx.strokeStyle = "rgba(32,230,255,.55)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(BAR_X, top); ctx.lineTo(BAR_X, bot); ctx.stroke();
    // lane dividers
    ctx.strokeStyle = "rgba(143,134,201,.18)"; ctx.lineWidth = 1;
    for (var i = 0; i <= LANES; i++) {
      var y = TOP_MARGIN + i * LANE_H;
      ctx.beginPath(); ctx.moveTo(BAR_X, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  function drawBarkeep() {
    if (!S) return;
    var y = laneCenterY(S.selected);
    var glow = 0.6 + 0.4 * Math.sin(tPulse * 6);
    ctx.save();
    ctx.shadowColor = "#20e6ff"; ctx.shadowBlur = 14 * glow;
    ctx.fillStyle = "#e9e6ff";
    ctx.beginPath();
    ctx.moveTo(BAR_X - 26, y - 14);
    ctx.lineTo(BAR_X - 8, y);
    ctx.lineTo(BAR_X - 26, y + 14);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawPatron(p, y) {
    var glow = p.state === "exit" ? 0.35 : 0.7;
    ctx.save();
    ctx.shadowColor = "#20e6ff"; ctx.shadowBlur = 10 * glow;
    ctx.fillStyle = p.state === "exit" ? "rgba(32,230,255,.45)" : "#7ef3ff";
    // head
    ctx.beginPath(); ctx.arc(p.x, y - 16, 7, 0, Math.PI * 2); ctx.fill();
    // body (triangle silhouette)
    ctx.beginPath();
    ctx.moveTo(p.x - 11, y + 16);
    ctx.lineTo(p.x + 11, y + 16);
    ctx.lineTo(p.x, y - 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawOrder(o, y) {
    var isFull = o.dir > 0;
    ctx.save();
    ctx.shadowBlur = 10;
    ctx.shadowColor = isFull ? "#ff2fb9" : "#ffd23f";
    ctx.strokeStyle = isFull ? "#ff6afd" : "#ffe08a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(o.x - 7, y + 10); ctx.lineTo(o.x - 5, y - 10); ctx.lineTo(o.x + 5, y - 10); ctx.lineTo(o.x + 7, y + 10);
    ctx.closePath(); ctx.stroke();
    if (isFull) { ctx.fillStyle = "rgba(255,47,185,.55)"; ctx.fillRect(o.x - 5, y - 2, 10, 10); }
    ctx.restore();
    // catch-zone pulse hint for empties nearing the counter
    if (!isFull && o.x <= BAR_X + CATCH_ZONE + 20) {
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.25 * Math.sin(tPulse * 10);
      ctx.strokeStyle = "#20e6ff"; ctx.lineWidth = 2;
      ctx.strokeRect(BAR_X - 2, y - LANE_H / 2 + 4, CATCH_ZONE, LANE_H - 8);
      ctx.restore();
    }
  }

  function draw() {
    ctx.save();
    if (shake > 0) {
      var mag = shake * 6;
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }
    drawBackdrop();
    if (S) {
      for (var i = 0; i < LANES; i++) {
        var y = laneCenterY(i);
        var lane = S.lanes[i];
        for (var j = 0; j < lane.orders.length; j++) drawOrder(lane.orders[j], y);
        for (var k = 0; k < lane.patrons.length; k++) drawPatron(lane.patrons[k], y);
        if (i === S.selected) {
          ctx.save();
          ctx.globalAlpha = 0.10;
          ctx.fillStyle = "#20e6ff";
          ctx.fillRect(BAR_X, TOP_MARGIN + i * LANE_H, W - BAR_X, LANE_H);
          ctx.restore();
        }
      }
      drawBarkeep();
    }
    // particles
    for (var p = 0; p < particles.length; p++) {
      var pt = particles[p];
      ctx.save();
      ctx.globalAlpha = Math.max(0, pt.t);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.s / 2, pt.y - pt.s / 2, pt.s, pt.s);
      ctx.restore();
    }
    ctx.restore();

    if (S && S.mode === "rushclear") {
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(tPulse * 8);
      ctx.textAlign = "center"; ctx.font = "bold 26px Chakra Petch, monospace";
      ctx.shadowColor = "#ffd23f"; ctx.shadowBlur = 16;
      ctx.fillStyle = "#fff8dc";
      ctx.fillText("RUSH CLEARED · TIP EARNED", W / 2, H / 2);
      ctx.restore();
    }
  }

  /* ---- main loop (crash-safe) ---------------------------------------------------------------
   * Wrapped in try/catch: a thrown error funnels through emitError + a REAL endGame(false) so
   * telemetry (score/play_end) is preserved and the overlay/controls re-arm — never a bare
   * mode='over' flip, which would softlock the frame and drop telemetry.
   */
  function loop(now) {
    if (!S) return;
    try {
      var dt = (now - S.last) / 1000; S.last = now;
      if (dt > 0.08) dt = 0.08;

      // input
      if (deck) {
        var st = deck.state();
        if (st.lanepad && st.lanepad.justPressed) {
          if (st.lanepad.justPressed.up) laneMove(-1);
          if (st.lanepad.justPressed.down) laneMove(1);
        }
        if (st.serve && st.serve.justPressed) onServeBtn();
        if (st["catch"] && st["catch"].justPressed) onCatchBtn();
        deck.frameEnd();
      } else {
        if (pendingServe) { pendingServe = false; onServeBtn(); }
        if (pendingCatch) { pendingCatch = false; onCatchBtn(); }
      }

      tPulse += dt;

      if (S.mode === "play") {
        if (S.__injectErr) { S.__injectErr = false; throw new Error("qa-injected loop error"); }
        var scale = (S.slowmo > 0 && !reduce) ? 0.32 : 1;
        if (S.slowmo > 0) S.slowmo = Math.max(0, S.slowmo - dt);
        var diff = difficultyFor(S.level);
        for (var i = 0; i < LANES; i++) updateLane(S.lanes[i], i, dt * scale, diff);
        checkRushClear();
      } else if (S.mode === "rushclear") {
        S.clearT -= dt;
        if (S.clearT <= 0) proceedAfterClear();
      }
      updateParticles(dt);
      draw();

      if (S.mode === "play" || S.mode === "rushclear") requestAnimationFrame(loop);
      else requestAnimationFrame(loopIdle);
    } catch (err) {
      // fail SAFE: report once, drop to the idle loop (no simulation) so a per-frame throw
      // cannot spin the CPU. The cabinet stays interactive; a reload restarts cleanly.
      emitError((err && err.message) || err, "loop");
      try { if (S && S.mode === "play") endGame(false); }
      catch (_) { try { if (S) S.mode = "over"; } catch (__) {} }
      try { requestAnimationFrame(loopIdle); } catch (_) {}
    }
  }
  function loopIdle(now) {
    if (!S) { requestAnimationFrame(function () { draw(); }); return; }
    try {
      var dt = (now - S.last) / 1000; S.last = now; if (dt > 0.08) dt = 0.08;
      tPulse += dt;
      if (deck) {
        var st = deck.state();
        if (st.serve && st.serve.justPressed) onServeBtn();
        deck.frameEnd();
      } else if (pendingServe) { pendingServe = false; onServeBtn(); }
      updateParticles(dt);
      draw();
      if (S && (S.mode === "over" || S.mode === "idle")) requestAnimationFrame(loopIdle);
    } catch (err) {
      emitError((err && err.message) || err, "loopIdle");
    }
  }

  /* ---- optional test hook (inert unless ?debug=1) — used only by the QA smoke harness ------ */
  if (/[?&]debug=1/.test(location.search)) {
    window.__CR = {
      state: function () { return S; },
      errorCount: function () { return _errCount; },
      lastError: function () { return _lastErr; },
      injectError: function () { if (S) S.__injectErr = true; },
      start: function () { startGame(); },
      serve: function () { onServeBtn(); },
      catchNow: function () { onCatchBtn(); },
      laneMove: function (d) { laneMove(d); },
      forceRushClear: function () { if (S) { S.rushServed = S.rushTarget; } },
      forceMiss: function () { if (S) missCatch(S.selected, { x: BAR_X }); }
    };
  }

  /* ---- boot: idle attract-mode + deep-link challenge ---------------------------------------- */
  S = { mode: "idle", last: performance.now(), lanes: [newLane(), newLane(), newLane(), newLane()], selected: 1, score: 0, level: 1, lives: 3, combo: 1, rushServed: 0, rushTarget: rushTargetFor(1) };
  hud();
  if (rivalScore > 0) {
    els.tag.innerHTML = "a challenger served <b style='color:#20e6ff'>" + rivalScore + "</b> — can you beat it?<br>▲▼ lane · SERVE pour · CATCH grab";
    emit("cross_promo_click", 1, "count", { referrer: "share", rival: rival });
  }
  draw();          // draw the idle board behind the overlay
  requestAnimationFrame(loopIdle);
})();
