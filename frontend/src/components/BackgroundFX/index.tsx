"use client";

import React, { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";

interface Particle {
  a: number;
  r: number;
  s: number;
  wobA: number;
  wobB: number;
  word: string;
  size: number;
  alpha: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  tx?: number;
  ty?: number;
  dx?: number;
  dy?: number;
  dist?: number;
  angle?: number;
  force?: number;
  vx1?: number;
  vy1?: number;
  vx2?: number;
  vy2?: number;
  vx3?: number;
  vy3?: number;
}

// Tech/cyberpunk themed words for the background
const TECH_WORDS = [
  'SIGNAL', 'PULSE', 'SYNAPSE', 'NEXUS', 'MATRIX', 'BINARY', 'CODE', 'NEURAL',
  'QUANTUM', 'VOID', 'NODE', 'GRID', 'CHIP', 'CORE', 'PIXEL', 'GLITCH', 'HACK',
  'CRYPTO', 'CHAIN', 'BLOCK', 'LEDGER', 'HASH', 'MINER', 'NODE', 'ORACLE',
  'TOKEN', 'VAULT', 'WALLET', 'MERKLE', 'PROTOCOL', 'CONSENSUS', 'SMART',
  'CONTRACT', 'DAPP', 'DEFI', 'NFT', 'DAO', 'GOVERNANCE', 'STAKING', 'YIELD',
  'LIQUIDITY', 'POOL', 'FARM', 'BRIDGE', 'LAYER', 'SCALE', 'ROLLUP', 'ZK',
  'ZKP', 'SNARK', 'STARK', 'VALIDIUM', 'VOLITION', 'OPTIMISTIC', 'VALIDATOR',
  'BLOCKCHAIN', 'DISTRIBUTED', 'IMMUTABLE', 'TRUSTLESS', 'PERMISSIONLESS',
  'CRYPTOGRAPHY', 'SIGNATURE', '404', '404', '404', '404' // More weight to 404
];

// Get a random word from the tech words array
function getRandomWord() {
  return TECH_WORDS[Math.floor(Math.random() * TECH_WORDS.length)];
}

// Cache for word measurements
const wordWidthCache = new Map<string, number>();

/**
 * BackgroundFX
 * Monochrome binary vortex ("0"/"1") swirling slowly like a whirlpool.
 * Uses GSAP ticker for stable timing and respects devicePixelRatio + resize.
 */
export const BackgroundFX: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [isMounted, setIsMounted] = useState(false);


  useEffect(() => {
    if (!isMounted) return;
    
    const parent = parentRef.current;
    const canvas = canvasRef.current;
    if (!parent || !canvas) return;
    
    let running = true;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mql.matches;
    const onRM = () => { reduced = mql.matches; };
    mql.addEventListener?.("change", onRM);

    const dark = true; // hero is always dark — site has no light mode

    const onMouseMove = (e: MouseEvent) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const my = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1;
      state.targetTiltX = Math.max(-1, Math.min(1, mx));
      state.targetTiltY = Math.max(-1, Math.min(1, my));
    };
    window.addEventListener("mousemove", onMouseMove);

    let dpr = Math.min(2, window.devicePixelRatio || 1);
    const state = {
      w: 0,
      h: 0,
      cx: 0,
      cy: 0,
      maxR: 0,
      baseRot: 0,
      t: 0,
      tiltX: 0,
      tiltY: 0,
      targetTiltX: 0,
      targetTiltY: 0,
    };

    let particles: Particle[] = [];

    const resize = () => {
      if (!parent) return;
      const { clientWidth: w, clientHeight: h } = parent;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.w = w; state.h = h; state.cx = w / 2; state.cy = h / 2;
      state.maxR = Math.hypot(w, h) * 0.55;

      // rebuild particles based on area
      const area = w * h;
      const target = Math.max(420, Math.min(1400, Math.floor(area / (reduced ? 5200 : 1200))));
      particles = [];
      for (let i = 0; i < target; i++) {
        const a = Math.random() * Math.PI * 2;
        const u = Math.random();
        const r = Math.sqrt(u) * state.maxR * (0.75 + 0.25 * Math.random());
        const speed = (reduced ? 0.00025 : 0.0006) * (0.4 + 0.6 * (1 - r / state.maxR));
        const size = 9 + (1 - r / state.maxR) * 5 + Math.random() * 2;
        const alpha = 0.2 + (1 - r / state.maxR) * 0.25;
        particles.push({
          a,
          r,
          s: speed,
          wobA: Math.random() * Math.PI * 2,
          wobB: Math.random() * Math.PI * 2,
          word: getRandomWord(),
          size,
          alpha,
        });
      }
    };

    resize();

    // Debounce resize: ignore changes < 2px (caused by scrollbar lock/unlock)
    // and delay rebuild to avoid flash during rapid resize events
    let resizeTimer: ReturnType<typeof setTimeout>;
    const debouncedResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const { clientWidth: w, clientHeight: h } = parent;
        if (Math.abs(w - state.w) > 2 || Math.abs(h - state.h) > 2) {
          resize();
        }
      }, 80);
    };
    const ro = new ResizeObserver(debouncedResize);
    ro.observe(parent);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const tick = () => {
      if (!running) return;
      if (!canvas) return;
      
      const { w, h, cx, cy, maxR } = state;
      // background
      ctx.fillStyle = dark ? "#0e0e10" : "#f6f6f6";
      ctx.fillRect(0, 0, w, h);

      // slow global rotation
      state.baseRot += reduced ? 0.0001 : 0.0002;
      state.t += 0.016;

      // smooth tilt towards target for semi-3D feel
      state.tiltX += (state.targetTiltX - state.tiltX) * 0.06;
      state.tiltY += (state.targetTiltY - state.tiltY) * 0.06;
      const tiltMag = Math.min(w, h) * 0.06;
      const centerShift = Math.min(w, h) * 0.02;
      const cx0 = cx + state.tiltX * centerShift;
      const cy0 = cy + state.tiltY * centerShift;

      // spiral arms modulation
      const armFreq = 3;
      const armAmp = Math.min(24, maxR * 0.02);

      // draw subtle spiral contour lines
      {
        const contours = 6;
        const swirlTurns = 2.2;
        const waveAmp = Math.min(14, maxR * 0.012);
        const waveFreq = 3;
        const lineCol = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.10)";
        ctx.save();
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 10]);
        for (let m = 1; m <= contours; m++) {
          const baseR = (m / (contours + 1)) * maxR;
          ctx.beginPath();
          let first = true;
          for (let theta = 0; theta <= Math.PI * 2 * (1 + swirlTurns); theta += 0.04) {
            const r0 = baseR + Math.sin(theta * waveFreq + state.t * 0.9 + m) * waveAmp;
            const swirl = theta + swirlTurns * (r0 / maxR) * Math.PI * 2;
            const rr = Math.max(6, Math.min(maxR, r0));
            const bx = cx0 + rr * Math.cos(swirl + state.baseRot);
            const by = cy0 + rr * Math.sin(swirl + state.baseRot);
            const depth = rr / maxR;
            const x3 = bx + state.tiltX * depth * tiltMag;
            const y3 = by + state.tiltY * depth * tiltMag * 1.2;
            if (first) { ctx.moveTo(x3, y3); first = false; }
            else { ctx.lineTo(x3, y3); }
          }
          ctx.strokeStyle = lineCol;
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
      }

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.a += p.s;
        const rWob = Math.sin(state.t * 0.6 + p.wobA) * (reduced ? 2.0 : 4.0);
        const arm = Math.sin(armFreq * (p.a + state.baseRot) + p.wobB) * armAmp;
        const rr = Math.max(8, Math.min(maxR, p.r + rWob + arm));
        const bx = cx0 + rr * Math.cos(p.a + state.baseRot);
        const by = cy0 + rr * Math.sin(p.a + state.baseRot);

        if (Math.random() < 0.001) {
          p.word = getRandomWord();
        }

        const fontSize = Math.max(8, p.size * 0.6);
        const fontKey = `${fontSize}px var(--font-space-mono)`;
        let wordWidth = wordWidthCache.get(p.word + fontKey);
        
        if (!wordWidth) {
          ctx.font = fontKey;
          wordWidth = ctx.measureText(p.word).width;
          wordWidthCache.set(p.word + fontKey, wordWidth);
        }
        
        const localAlpha = Math.max(0.05, Math.min(0.5, p.alpha * (1 - rr / (maxR + 1))));
        ctx.fillStyle = dark ? `rgba(255,255,255,${localAlpha * 0.8})` : `rgba(0,0,0,${localAlpha})`;
        ctx.font = fontKey;
        ctx.textAlign = 'center';
        ctx.fillText(p.word, bx, by);
      }
      
      requestAnimationFrame(tick);
    };

    // Start the animation loop
    requestAnimationFrame(tick);

    // Cleanup function
    return () => {
      running = false;
      clearTimeout(resizeTimer);
      ro.disconnect();
      mql.removeEventListener?.("change", onRM);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [isMounted]);

  // Set mounted after initial render
  useEffect(() => {
    setIsMounted(true);
    return () => setIsMounted(false);
  }, []);

  if (!isMounted) {
    return (
      <div
        ref={parentRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          pointerEvents: 'none',
          background: 'transparent'
        }}
      />
    );
  }

  return (
    <div
      ref={parentRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        background: 'transparent'
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', background: 'transparent', display: 'block' }}
      />
    </div>
  );
};

export default BackgroundFX;

