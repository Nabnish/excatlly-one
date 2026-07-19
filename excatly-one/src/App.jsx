import React, { useRef, useEffect, useState, useCallback } from "react";

/*
  EXACTLY ONE
  Start at 100 HP. Touch shards, spikes, heals, drain zones, volatile orbs,
  mines and freeze pickups to steer your HP. Land EXACTLY on 1 to win.
  Hit 0 (or below) -> instant loss. Timer runs out above 1 -> loss.
*/

const ARENA_W = 640;
const ARENA_H = 420;
const RUN_TIME = 55; // seconds
const PLAYER_R = 11;
const MAX_HP = 100;

const TYPES = {
  shard:    { key: "shard",    color: "#ff3347", r: 10, label: "Shard",   tag: "−5",   speed: 70,  fixed: -5 },
  spike:    { key: "spike",    color: "#c81c34", r: 16, label: "Spike",   tag: "−15",  speed: 55,  fixed: -15 },
  micro:    { key: "micro",    color: "#ff9fb2", r: 6,  label: "Micro",   tag: "−1",   speed: 95,  fixed: -1 },
  heal:     { key: "heal",     color: "#34d399", r: 11, label: "Heal",    tag: "+8",   speed: 60,  fixed: 8 },
  volatile: { key: "volatile", color: "#f5a623", r: 13, label: "Volatile",tag: "±",    speed: 80,  fixed: null },
  mine:     { key: "mine",     color: "#15161a", r: 15, label: "Mine",    tag: "KO",   speed: 110, fixed: -999, ring: "#ff3347" },
  freeze:   { key: "freeze",   color: "#5eead4", r: 10, label: "Freeze",  tag: "❄ +3s", speed: 65, fixed: 0 },
};

const SPAWN_WEIGHTS = [
  ["shard", 26], ["micro", 22], ["heal", 16], ["spike", 12],
  ["volatile", 12], ["mine", 6], ["freeze", 6],
];

function weightedType(excludeHeal) {
  const pool = excludeHeal ? SPAWN_WEIGHTS.filter(([k]) => k !== "heal") : SPAWN_WEIGHTS;
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [key, w] of pool) {
    if (r < w) return TYPES[key];
    r -= w;
  }
  return TYPES.shard;
}

// Non-linear gauge mapping: 0-10 HP gets 60% of the dial sweep so the
// win/lose margin near zero is actually readable.
function hpToT(hp) {
  const clamped = Math.max(0, Math.min(MAX_HP, hp));
  if (clamped <= 10) return (clamped / 10) * 0.6;
  return 0.6 + ((clamped - 10) / (MAX_HP - 10)) * 0.4;
}

const SWEEP_START = -220; // degrees
const SWEEP = 260;

function rand(min, max) { return Math.random() * (max - min) + min; }

export default function App() {
  const canvasRef = useRef(null);
  const needleRef = useRef(null);
  const wrapRef = useRef(null);

  const [phase, setPhase] = useState("menu"); // menu | playing | win | lose
  const [hpDisplay, setHpDisplay] = useState(MAX_HP);
  const [timeDisplay, setTimeDisplay] = useState(RUN_TIME);
  const [frozenBadge, setFrozenBadge] = useState(false);
  const [result, setResult] = useState(null);
  const [bestTime, setBestTime] = useState(null);
  const [lockedIn, setLockedIn] = useState(false);
  const [flashMsg, setFlashMsg] = useState(null);
  const [winFlash, setWinFlash] = useState(false);
  const flashTimeoutRef = useRef(null);

  const g = useRef(null); // mutable game state, avoids re-render per frame

  function triggerFlash(text, color, big) {
    setFlashMsg({ text, color, big, id: Math.random() });
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => setFlashMsg(null), big ? 1300 : 800);
  }

  const resetGame = useCallback(() => {
    g.current = {
      hp: MAX_HP,
      displayHp: MAX_HP,
      timeLeft: RUN_TIME,
      freezeLeft: 0,
      lockIn: false,
      player: { x: ARENA_W / 2, y: ARENA_H / 2, vx: 0, vy: 0 },
      keys: {},
      pointer: { active: false, x: ARENA_W / 2, y: ARENA_H / 2 },
      hazards: [],
      floaters: [],
      particles: [],
      spawnTimer: 0.4,
      elapsed: 0,
      ended: false,
      lastTs: null,
    };
    setHpDisplay(MAX_HP);
    setTimeDisplay(RUN_TIME);
    setFrozenBadge(false);
    setResult(null);
    setLockedIn(false);
    setFlashMsg(null);
    setWinFlash(false);
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
  }, []);

  const startGame = () => {
    resetGame();
    setPhase("playing");
  };

  // ---- input ----
  useEffect(() => {
    const down = (e) => {
      if (!g.current) return;
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " ", "w", "a", "s", "d"].includes(k)) e.preventDefault();
      g.current.keys[k] = true;
    };
    const up = (e) => {
      if (!g.current) return;
      g.current.keys[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", down, { passive: false });
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const pointerFromEvent = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * ARENA_W,
      y: ((clientY - rect.top) / rect.height) * ARENA_H,
    };
  };

  const onPointerDown = (e) => {
    if (!g.current) return;
    const p = pointerFromEvent(e);
    g.current.pointer = { active: true, ...p };
  };
  const onPointerMove = (e) => {
    if (!g.current || !g.current.pointer.active) return;
    const p = pointerFromEvent(e);
    g.current.pointer.x = p.x;
    g.current.pointer.y = p.y;
  };
  const onPointerUp = () => {
    if (!g.current) return;
    g.current.pointer.active = false;
  };

  function spawnFloater(x, y, text, color) {
    g.current.floaters.push({ x, y, text, color, life: 1 });
  }

  function spawnBurst(x, y, color, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(40, 160);
      g.current.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.4, 0.9), color,
      });
    }
  }

  function applyHP(delta, x, y, color, tag) {
    const gg = g.current;
    let next = gg.hp + delta;
    if (next > MAX_HP) next = MAX_HP;
    gg.hp = next;
    spawnFloater(x, y, tag, color);
    spawnBurst(x, y, color, delta < 0 ? 16 : 10);

    // Lock-In: once you're at or under 10 HP, heals stop spawning for the rest of the run
    if (next <= 10 && next > 0 && !gg.lockIn) {
      gg.lockIn = true;
      setLockedIn(true);
    }

    if (next === 2) {
      triggerFlash("SO CLOSE", "#f5a623");
    } else if (next === 3) {
      triggerFlash("ONE GOOD HIT...", "#f5a623");
    }

    if (next <= 0) {
      endRun(false, "Overkill", `You bottomed out at ${next} HP.`);
    } else if (next === 1) {
      endRun(true, "Exactly One", `Landed the run in ${(RUN_TIME - gg.timeLeft).toFixed(1)}s.`);
    }
  }

  function endRun(won, title, subtitle) {
    const gg = g.current;
    if (gg.ended) return;
    gg.ended = true;
    setResult({ won, title, subtitle });
    if (won) {
      const t = RUN_TIME - gg.timeLeft;
      setBestTime((b) => (b === null || t < b ? t : b));
      setWinFlash(true);
      triggerFlash("EXACTLY ONE", "#34d399", true);
      setTimeout(() => setWinFlash(false), 750);
    }
    setTimeout(() => setPhase(won ? "win" : "lose"), won ? 1300 : 550);
  }

  function spawnHazard() {
    const type = weightedType(g.current.lockIn);
    const edge = Math.floor(rand(0, 4));
    let x, y;
    if (edge === 0) { x = -20; y = rand(20, ARENA_H - 20); }
    else if (edge === 1) { x = ARENA_W + 20; y = rand(20, ARENA_H - 20); }
    else if (edge === 2) { x = rand(20, ARENA_W - 20); y = -20; }
    else { x = rand(20, ARENA_W - 20); y = ARENA_H + 20; }

    const targetX = rand(ARENA_W * 0.2, ARENA_W * 0.8);
    const targetY = rand(ARENA_H * 0.2, ARENA_H * 0.8);
    const ang = Math.atan2(targetY - y, targetX - x);
    const speed = type.speed * rand(0.75, 1.15);

    g.current.hazards.push({
      id: Math.random().toString(36).slice(2),
      type,
      x, y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      jitterT: 0,
      spin: rand(-2, 2),
      rot: rand(0, Math.PI * 2),
    });
  }

  // ---- main loop ----
  useEffect(() => {
    if (phase !== "playing") return;
    let raf;

    const step = (ts) => {
      const gg = g.current;
      if (!gg.lastTs) gg.lastTs = ts;
      let dt = (ts - gg.lastTs) / 1000;
      dt = Math.min(dt, 0.05);
      gg.lastTs = ts;

      if (!gg.ended) {
        gg.elapsed += dt;

        // freeze / timer
        if (gg.freezeLeft > 0) {
          gg.freezeLeft = Math.max(0, gg.freezeLeft - dt);
        } else {
          gg.timeLeft = Math.max(0, gg.timeLeft - dt);
        }

        // movement input
        const p = gg.player;
        let dx = 0, dy = 0;
        if (gg.keys["arrowleft"] || gg.keys["a"]) dx -= 1;
        if (gg.keys["arrowright"] || gg.keys["d"]) dx += 1;
        if (gg.keys["arrowup"] || gg.keys["w"]) dy -= 1;
        if (gg.keys["arrowdown"] || gg.keys["s"]) dy += 1;

        const speed = 220;
        if (gg.pointer.active) {
          const tdx = gg.pointer.x - p.x;
          const tdy = gg.pointer.y - p.y;
          const dist = Math.hypot(tdx, tdy);
          if (dist > 2) {
            p.vx = (tdx / dist) * speed;
            p.vy = (tdy / dist) * speed;
          } else { p.vx = 0; p.vy = 0; }
        } else if (dx || dy) {
          const len = Math.hypot(dx, dy) || 1;
          p.vx = (dx / len) * speed;
          p.vy = (dy / len) * speed;
        } else {
          p.vx *= 0.8; p.vy *= 0.8;
        }

        p.x = Math.max(PLAYER_R, Math.min(ARENA_W - PLAYER_R, p.x + p.vx * dt));
        p.y = Math.max(PLAYER_R, Math.min(ARENA_H - PLAYER_R, p.y + p.vy * dt));

        // spawn hazards
        gg.spawnTimer -= dt;
        const rampBonus = Math.min(gg.elapsed / 40, 1) * 0.5;
        if (gg.spawnTimer <= 0) {
          spawnHazard();
          gg.spawnTimer = rand(0.5, 0.95) * (1 - rampBonus * 0.4);
        }

        // update + collide hazards
        for (let i = gg.hazards.length - 1; i >= 0; i--) {
          const h = gg.hazards[i];
          h.rot += h.spin * dt;

          if (h.type.key === "mine") {
            // steer toward the player, but with a capped turn rate so it's dodgeable
            const desiredAng = Math.atan2(p.y - h.y, p.x - h.x);
            const curAng = Math.atan2(h.vy, h.vx);
            let diff = desiredAng - curAng;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            const maxTurn = 2.4 * dt;
            const newAng = curAng + Math.max(-maxTurn, Math.min(maxTurn, diff));
            h.vx = Math.cos(newAng) * h.type.speed;
            h.vy = Math.sin(newAng) * h.type.speed;
          }

          h.x += h.vx * dt;
          h.y += h.vy * dt;
          if (h.x < -40 || h.x > ARENA_W + 40 || h.y < -40 || h.y > ARENA_H + 40) {
            gg.hazards.splice(i, 1);
            continue;
          }

          const dist = Math.hypot(p.x - h.x, p.y - h.y);
          if (dist < PLAYER_R + h.type.r) {
            gg.hazards.splice(i, 1);
            if (h.type.key === "freeze") {
              gg.freezeLeft += 3;
              setFrozenBadge(true);
              spawnFloater(h.x, h.y, "❄ +3s", h.type.color);
              spawnBurst(h.x, h.y, h.type.color, 10);
            } else {
              const amount = h.type.fixed === null ? Math.round(rand(-20, -1)) : h.type.fixed;
              const tag = amount > 0 ? `+${amount}` : `${amount}`;
              applyHP(amount, h.x, h.y, h.type.ring || h.type.color, h.type.key === "mine" ? "KO" : tag);
            }
            if (gg.ended) break;
          }
        }

        if (gg.freezeLeft <= 0) setFrozenBadge(false);

        if (!gg.ended && gg.timeLeft <= 0 && gg.hp !== 1) {
          endRun(false, "Time's Up", `You ended at ${gg.hp} HP — not exactly one.`);
        }

        // smooth displayed HP toward actual
        gg.displayHp += (gg.hp - gg.displayHp) * Math.min(1, dt * 8);
      }

      // particles / floaters always animate, even briefly after end
      for (let i = gg.particles.length - 1; i >= 0; i--) {
        const pt = gg.particles[i];
        pt.x += pt.vx * dt; pt.y += pt.vy * dt;
        pt.vx *= 0.92; pt.vy *= 0.92;
        pt.life -= dt * 1.6;
        if (pt.life <= 0) gg.particles.splice(i, 1);
      }
      for (let i = gg.floaters.length - 1; i >= 0; i--) {
        const f = gg.floaters[i];
        f.y -= dt * 30;
        f.life -= dt * 0.9;
        if (f.life <= 0) gg.floaters.splice(i, 1);
      }

      draw();

      // throttle React state updates
      if (!gg._lastUi || ts - gg._lastUi > 80) {
        gg._lastUi = ts;
        setHpDisplay(Math.round(gg.displayHp));
        setTimeDisplay(gg.timeLeft);
      }
      if (needleRef.current) {
        const t = hpToT(gg.displayHp);
        const angle = SWEEP_START + t * SWEEP;
        needleRef.current.style.transform = `rotate(${angle}deg)`;
      }

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const gg = g.current;

    const grad = ctx.createRadialGradient(
      ARENA_W / 2, ARENA_H / 2, 40,
      ARENA_W / 2, ARENA_H / 2, ARENA_W * 0.7
    );
    grad.addColorStop(0, "#12141c");
    grad.addColorStop(1, "#07070a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, ARENA_W, ARENA_H);

    // faint grid
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    for (let x = 0; x < ARENA_W; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ARENA_H); ctx.stroke();
    }
    for (let y = 0; y < ARENA_H; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ARENA_W, y); ctx.stroke();
    }

    // particles
    for (const pt of gg.particles) {
      ctx.globalAlpha = Math.max(0, pt.life);
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // hazards
    for (const h of gg.hazards) {
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot);
      ctx.shadowColor = h.type.color;
      ctx.shadowBlur = 12;

      if (h.type.key === "mine") {
        ctx.fillStyle = h.type.color;
        ctx.strokeStyle = h.type.ring;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const rr = i % 2 === 0 ? h.type.r : h.type.r * 0.55;
          ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (h.type.key === "heal") {
        ctx.fillStyle = h.type.color;
        const s = h.type.r * 0.7;
        ctx.beginPath();
        ctx.moveTo(0, s * 0.6);
        ctx.bezierCurveTo(-s * 1.4, -s * 0.6, -s * 0.4, -s * 1.5, 0, -s * 0.4);
        ctx.bezierCurveTo(s * 0.4, -s * 1.5, s * 1.4, -s * 0.6, 0, s * 0.6);
        ctx.fill();
      } else if (h.type.key === "spike" || h.type.key === "shard" || h.type.key === "micro") {
        ctx.fillStyle = h.type.color;
        ctx.beginPath();
        ctx.moveTo(0, -h.type.r);
        ctx.lineTo(h.type.r * 0.8, h.type.r * 0.7);
        ctx.lineTo(-h.type.r * 0.8, h.type.r * 0.7);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = h.type.color;
        ctx.beginPath();
        ctx.arc(0, 0, h.type.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // player
    const p = gg.player;
    const pulse = 1 + Math.sin(performance.now() / 220) * 0.06;
    ctx.save();
    ctx.shadowColor = "#eef2f8";
    ctx.shadowBlur = 16;
    ctx.fillStyle = "#eef2f8";
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(94,234,212,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R * pulse + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // floating text
    ctx.textAlign = "center";
    ctx.font = "700 15px ui-monospace, monospace";
    for (const f of gg.floaters) {
      ctx.globalAlpha = Math.max(0, f.life);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  // ---- gauge ticks ----
  const ticks = [0, 1, 5, 10, 25, 50, 75, 100];

  return (
    <div className="min-h-screen w-full bg-[#050506] text-[#eef2f8] flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="flex items-baseline justify-between mb-3 px-1">
          <h1 className="text-2xl sm:text-3xl font-black tracking-[0.15em] uppercase">
            Exactly <span className="text-[#34d399]">One</span>
          </h1>
          {bestTime !== null && (
            <span className="text-xs font-mono text-[#f5a623] tracking-wide">
              best {bestTime.toFixed(1)}s
            </span>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-[#111319] to-[#08090c] p-4 sm:p-5 shadow-[0_0_60px_rgba(0,0,0,0.5)]">
          {/* Top timer */}
          {phase !== "menu" && (
            <>
              <div className="flex items-center justify-between mb-1.5 px-0.5">
                <span className="text-[11px] uppercase tracking-widest text-white/40 flex items-center gap-2">
                  Time Left
                  {lockedIn && (
                    <span className="text-[9px] font-bold tracking-widest uppercase text-[#ff3347] border border-[#ff3347]/50 rounded px-1.5 py-0.5">
                      Locked In · No Heals
                    </span>
                  )}
                </span>
                <span className={`font-mono text-2xl font-bold tabular-nums leading-none ${timeDisplay <= 10 ? "text-[#ff3347]" : "text-[#f5a623]"}`}>
                  {timeDisplay.toFixed(1)}s
                  {frozenBadge && <span className="ml-2 text-xs align-middle text-[#5eead4]">❄ frozen</span>}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-4">
                <div
                  className={`h-full rounded-full ${timeDisplay <= 10 ? "bg-[#ff3347]" : "bg-[#f5a623]"}`}
                  style={{ width: `${(timeDisplay / RUN_TIME) * 100}%`, transition: "width 0.1s linear" }}
                />
              </div>

              {/* HUD row */}
              <div className="flex items-center gap-4 mb-4">
                {/* Gauge */}
                <div className="relative w-28 h-28 shrink-0">
                  <svg viewBox="0 0 120 120" className="w-full h-full">
                    <circle cx="60" cy="60" r="52" fill="#0e1015" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
                    {ticks.map((v) => {
                      const t = hpToT(v);
                      const ang = ((SWEEP_START + t * SWEEP) * Math.PI) / 180;
                      const x1 = 60 + Math.cos(ang) * 46;
                      const y1 = 60 + Math.sin(ang) * 46;
                      const x2 = 60 + Math.cos(ang) * 52;
                      const y2 = 60 + Math.sin(ang) * 52;
                      const isOne = v === 1;
                      const isZero = v === 0;
                      return (
                        <line
                          key={v}
                          x1={x1} y1={y1} x2={x2} y2={y2}
                          stroke={isOne ? "#34d399" : isZero ? "#ff3347" : "rgba(255,255,255,0.35)"}
                          strokeWidth={isOne ? 3 : 1.5}
                        />
                      );
                    })}
                    <circle cx="60" cy="60" r="4" fill="#eef2f8" />
                    <line
                      ref={needleRef}
                      x1="60" y1="60" x2="60" y2="16"
                      stroke="#f5a623"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      style={{ transformOrigin: "60px 60px", transition: "none" }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-end pb-2 pointer-events-none">
                    <span className={`font-mono font-bold text-lg leading-none ${hpDisplay === 1 ? "text-[#34d399]" : hpDisplay <= 0 ? "text-[#ff3347]" : "text-[#eef2f8]"}`}>
                      {hpDisplay}
                    </span>
                    <span className="text-[9px] uppercase tracking-widest text-white/40">HP</span>
                  </div>
                </div>

                <div className="flex-1">
                  <p className="text-[11px] text-white/40 leading-snug">
                    Steer onto pickups to move your HP. Land <span className="text-[#34d399] font-semibold">exactly 1</span> to win.
                    Zero or below is instant loss, time out above 1 also loses. The black mine hunts you down — outrun or dodge it.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* Arena */}
          <div
            ref={wrapRef}
            className="relative rounded-xl overflow-hidden border border-white/10 select-none touch-none"
            style={{ aspectRatio: `${ARENA_W}/${ARENA_H}` }}
          >
            <canvas
              ref={canvasRef}
              width={ARENA_W}
              height={ARENA_H}
              className="w-full h-full block cursor-crosshair"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />

            {winFlash && (
              <div
                className="absolute inset-0 bg-[#34d399] pointer-events-none"
                style={{ animation: "washFlash 0.75s ease-out forwards" }}
              />
            )}

            {flashMsg && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4">
                <span
                  key={flashMsg.id}
                  className="font-black tracking-widest uppercase text-center"
                  style={{
                    color: flashMsg.big ? "#eef2f8" : flashMsg.color,
                    fontSize: flashMsg.big ? "clamp(1.75rem, 8vw, 3.25rem)" : "1.25rem",
                    textShadow: flashMsg.big ? `0 0 30px ${flashMsg.color}, 0 0 10px rgba(0,0,0,0.6)` : `0 0 24px ${flashMsg.color}`,
                    animation: `${flashMsg.big ? "flashPopBig" : "flashPop"} ${flashMsg.big ? 1.2 : 0.8}s ease-out forwards`,
                  }}
                >
                  {flashMsg.text}
                </span>
              </div>
            )}

            {phase === "menu" && (
              <Overlay>
                <h2 className="text-xl font-bold tracking-wide mb-1">Land the run at exactly 1 HP</h2>
                {bestTime !== null && (
                  <p className="text-xs font-mono text-[#f5a623] mb-3">Best time: {bestTime.toFixed(1)}s</p>
                )}
                <p className="text-sm text-white/60 mb-4 max-w-sm mx-auto">
                  Move with <span className="text-white">WASD / arrows</span> or drag on mobile.
                  Grab pickups to shift your HP down — or up if you overshoot. Zero or below is
                  instant loss, and running out of time above 1 loses too.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 justify-center max-w-sm mx-auto mb-5 text-left">
                  {Object.values(TYPES).map((t) => (
                    <div key={t.key} className="flex items-center gap-1.5 text-[11px] text-white/50">
                      <span className="w-2.5 h-2.5 rounded-sm inline-block shrink-0" style={{ background: t.color }} />
                      <span className="whitespace-nowrap">{t.label} <span className="font-mono text-white/70">{t.tag}</span></span>
                    </div>
                  ))}
                </div>

                <p className="text-[11px] text-[#ff3347]/80 mb-5">
                  Drop to 10 HP and you Lock In — no more heals for the rest of the run.
                </p>

                <button
                  onClick={startGame}
                  className="px-6 py-2.5 rounded-lg bg-[#34d399] text-black font-bold tracking-wide hover:bg-[#5fe3ae] transition"
                >
                  Start Run
                </button>
              </Overlay>
            )}

            {(phase === "win" || phase === "lose") && result && (
              <Overlay>
                <h2 className={`text-2xl font-black tracking-wide mb-1 ${phase === "win" ? "text-[#34d399]" : "text-[#ff3347]"}`}>
                  {result.title}
                </h2>
                <p className="text-sm text-white/60 mb-5">{result.subtitle}</p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    onClick={startGame}
                    className={`px-6 py-2.5 rounded-lg font-bold tracking-wide transition ${
                      phase === "win" ? "bg-[#34d399] text-black hover:bg-[#5fe3ae]" : "bg-white/10 text-white hover:bg-white/20"
                    }`}
                  >
                    Try Again
                  </button>
                  <button
                    onClick={() => setPhase("menu")}
                    className="px-5 py-2.5 rounded-lg font-semibold tracking-wide text-white/60 border border-white/15 hover:bg-white/10 hover:text-white transition"
                  >
                    Main Menu
                  </button>
                </div>
              </Overlay>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Overlay({ children }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm text-center px-6">
      <div>{children}</div>
    </div>
  );
}

// One-time global keyframes for close-call and win flashes.
if (typeof document !== "undefined" && !document.getElementById("exactly-one-keyframes")) {
  const style = document.createElement("style");
  style.id = "exactly-one-keyframes";
  style.textContent = `
    @keyframes flashPop {
      0% { opacity: 0; transform: scale(0.7); }
      18% { opacity: 1; transform: scale(1.08); }
      35% { transform: scale(1); }
      100% { opacity: 0; transform: scale(1); }
    }
    @keyframes flashPopBig {
      0% { opacity: 0; transform: scale(0.6); }
      20% { opacity: 1; transform: scale(1.1); }
      35% { transform: scale(1); }
      80% { opacity: 1; }
      100% { opacity: 0; transform: scale(1.02); }
    }
    @keyframes washFlash {
      0% { opacity: 0.65; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}
