/**
 * The animated backdrop of the login screen's brand panel.
 *
 * An isometric field of stacked tiles with a skyline that grows outward from the
 * centre of the panel: a ripple expands from the middle, raises the tallest
 * towers there, and builds progressively shorter ones as it travels out. The
 * height comes from a radial profile, so the silhouette stays centred however
 * the panel is sized.
 *
 * Two things make the towers read as buildings rather than as noise, and both
 * were wrong in the prototype: the facades are lit while the terrain stays dim
 * (a dark tower on a dark field is invisible), and the towers are sparse enough
 * that the terrain shows through between them (a dense field of extruded tiles
 * covers the whole panel and reads as one bright carpet).
 *
 * Plain canvas 2D, no libraries, device pixel ratio capped at 2. With
 * prefers-reduced-motion the scene is run forward once and then frozen, so the
 * skyline is there without any movement.
 */
import { useEffect, useRef } from "react";

const GRID = 60;
const CENTER = (GRID - 1) / 2;
/** Radius of the height profile, in cells. Slightly wider than the visible band. */
const PROFILE_SPAN = GRID * 0.62;
const TOWER_CAP = 240;

export function LoginBackdrop() {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let width = 0;
		let height = 0;
		let tileW = 24;
		let tileH = 12;
		/** Layer height of the terrain, and of one tower floor (taller, so towers have mass). */
		let layerPx = 7;
		let towerPx = 10;

		// Red anomaly clusters: fixed spots on the field that keep pulsing.
		const clusters = [
			{ i: 14, j: 34, r: 4.5, phase: 0 },
			{ i: 38, j: 18, r: 4, phase: 2.1 },
			{ i: 28, j: 44, r: 3.4, phase: 4.2 },
			{ i: 46, j: 33, r: 3.6, phase: 1.1 },
			{ i: 20, j: 12, r: 3.2, phase: 5 },
		];

		// Built height per cell: target, current (chases the target, which is what
		// makes a tower rise), and the cells still growing.
		const builtNow = new Float32Array(GRID * GRID);
		const builtTarget = new Float32Array(GRID * GRID);
		const growing: number[] = [];
		let towerCount = 0;

		// The ripple always starts at the centre of the panel.
		let ripple = { radius: 0, active: true };
		let nextRipple = 1400;
		// Cells this wave will build, decided up front. Rolling per frame instead
		// re-tests the same cell while the wave front is in range and ends up
		// building on most of the field.
		let pendingWave: { i: number; j: number; at: number }[] = [];

		let camX = 0;
		let camY = 0;
		const mouse = { x: 0.5, y: 0.5 };
		let time = 0;

		// Painter order: far rows first.
		const order: [number, number][] = [];
		for (let s = 0; s < GRID * 2; s += 1) {
			for (let i = Math.max(0, s - GRID + 1); i <= Math.min(GRID - 1, s); i += 1) {
				order.push([i, s - i]);
			}
		}

		const dust = Array.from({ length: 60 }, () => ({
			x: Math.random(),
			y: Math.random(),
			r: 0.6 + Math.random() * 1.2,
			v: 0.4 + Math.random() * 1.2,
			phase: Math.random() * Math.PI * 2,
		}));

		const profileHeight = (i: number, j: number) => {
			const d = Math.hypot(i - CENTER, j - CENTER);
			const t = Math.max(0, 1 - d / PROFILE_SPAN);
			return 3 + Math.pow(t, 1.25) * 10.5;
		};

		const buildTower = (i: number, j: number, instant: boolean) => {
			const idx = i * GRID + j;
			if (builtTarget[idx] > 0 || towerCount >= TOWER_CAP) return;
			const target = profileHeight(i, j) * (0.82 + Math.random() * 0.36);
			builtTarget[idx] = target;
			if (instant) builtNow[idx] = target;
			else growing.push(idx);
			towerCount += 1;
		};

		// Pick this wave's towers. The radius is biased towards the centre, so the
		// tall ones cluster into a downtown core instead of covering the field.
		const planWave = () => {
			pendingWave = [];
			if (towerCount >= TOWER_CAP) return;
			const quota = Math.min(130, TOWER_CAP - towerCount);
			for (let k = 0; k < quota * 3 && pendingWave.length < quota; k += 1) {
				const r = Math.pow(Math.random(), 1.1) * PROFILE_SPAN;
				const a = Math.random() * Math.PI * 2;
				const i = Math.round(CENTER + Math.cos(a) * r);
				const j = Math.round(CENTER + Math.sin(a) * r);
				if (i < 1 || j < 1 || i > GRID - 2 || j > GRID - 2) continue;
				if (builtTarget[i * GRID + j] > 0) continue;
				pendingWave.push({ i, j, at: Math.hypot(i - CENTER, j - CENTER) });
			}
		};

		const heightAt = (i: number, j: number, t: number) => {
			let v = 0;
			v += Math.sin(i * 0.42 + t * 0.7) * Math.cos(j * 0.36 - t * 0.5);
			v += Math.sin((i + j) * 0.22 + t * 0.35) * 0.6;
			v += Math.sin(i * 0.9 - t * 1.1) * Math.cos(j * 0.8 + t * 0.9) * 0.45;
			let h = Math.floor(Math.max(0.18, v - 0.32) * 3.6);
			for (const c of clusters) {
				const d = Math.hypot(i - c.i, j - c.j);
				if (d < c.r) {
					const pulse = 0.55 + 0.45 * Math.sin(t * 1.4 + c.phase);
					h = Math.max(h, Math.round(2 + (1 - d / c.r) * (3.4 + pulse * 2.6)));
				}
			}
			if (ripple.active) {
				const d = Math.abs(Math.hypot(i - CENTER, j - CENTER) - ripple.radius);
				if (d < 2.2) h += Math.round((1 - d / 2.2) * 3);
			}
			return h;
		};

		// The clusters never move, so resolve them once instead of per cell per frame.
		const clusterMask = new Uint8Array(GRID * GRID);
		for (let i = 0; i < GRID; i += 1) {
			for (let j = 0; j < GRID; j += 1) {
				for (const c of clusters) {
					if (Math.hypot(i - c.i, j - c.j) < c.r * 0.85) {
						clusterMask[i * GRID + j] = 1;
						break;
					}
				}
			}
		}

		// The glow is a full-panel radial gradient; rasterising it every frame is
		// the single most expensive thing here, so keep a cached copy.
		let glowLayer: HTMLCanvasElement | null = null;

		const sizeCanvas = () => {
			const rect = canvas.getBoundingClientRect();
			// Backing-store budget: the field is fill-rate bound, and a software
			// renderer on a 4K panel would otherwise cost ~140ms per frame.
			const budget = 4_000_000;
			const dpr = Math.min(2, Math.max(1, Math.sqrt(budget / Math.max(1, rect.width * rect.height))));
			canvas.width = Math.max(1, Math.round(rect.width * dpr));
			canvas.height = Math.max(1, Math.round(rect.height * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			width = rect.width;
			height = rect.height;
			// Scale the grid with the panel: GRID cells span the height, and the
			// diamond is wide enough to cover the width as well.
			tileW = Math.max(2 * height, width) / GRID;
			tileH = tileW / 2;
			layerPx = tileW * 0.29;
			towerPx = tileW * 0.42;

			const layer = document.createElement("canvas");
			layer.width = canvas.width;
			layer.height = canvas.height;
			const lctx = layer.getContext("2d");
			if (!lctx) {
				glowLayer = null;
				return;
			}
			lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const cx = width * 0.5;
			const cy = height * 0.5;
			const grad = lctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) * 0.5);
			grad.addColorStop(0, "rgba(44,96,158,0.26)");
			grad.addColorStop(1, "rgba(44,96,158,0)");
			lctx.fillStyle = grad;
			lctx.fillRect(0, 0, width, height);
			glowLayer = layer;
		};

		const draw = (dt: number, t: number) => {
			if (ripple.active) {
				ripple.radius += dt * 0.04;
				for (let k = pendingWave.length - 1; k >= 0; k -= 1) {
					if (pendingWave[k].at <= ripple.radius) {
						buildTower(pendingWave[k].i, pendingWave[k].j, false);
						pendingWave.splice(k, 1);
					}
				}
				if (ripple.radius > PROFILE_SPAN + 6) {
					ripple.active = false;
					nextRipple = 2600 + Math.random() * 2400;
				}
			} else {
				nextRipple -= dt;
				if (nextRipple <= 0) {
					ripple = { radius: 0, active: true };
					planWave();
				}
			}
			for (let k = growing.length - 1; k >= 0; k -= 1) {
				const idx = growing[k];
				const target = builtTarget[idx];
				builtNow[idx] = Math.min(target, builtNow[idx] + dt * 0.028);
				if (builtNow[idx] >= target) growing.splice(k, 1);
			}

			camX += ((mouse.x - 0.5) * 60 - camX) * 0.04;
			camY += ((mouse.y - 0.5) * 30 - camY) * 0.04;
			const ox = width * 0.5 + Math.sin(t * 0.05) * 24 - camX;
			// The centre of the grid lands on the centre of the panel.
			const oy = height * 0.5 - (GRID * tileH) / 2 + Math.cos(t * 0.04) * 10 + camY;

			ctx.clearRect(0, 0, width, height);
			// Cold glow behind the tallest towers (cached bitmap).
			if (glowLayer) ctx.drawImage(glowLayer, 0, 0, width, height);

			const cells: { i: number; j: number; sx: number; sy: number; terrainH: number; built: number; red: boolean }[] = [];
			for (const [i, j] of order) {
				const sx = ox + (i - j) * (tileW / 2);
				const sy = oy + (i + j) * (tileH / 2);
				if (sx < -tileW || sx > width + tileW || sy < -360 || sy > height + tileH + 40) continue;
				const built = builtNow[i * GRID + j];
				cells.push({ i, j, sx, sy, terrainH: heightAt(i, j, t), built, red: clusterMask[i * GRID + j] === 1 });
			}
			cells.sort((a, b) => a.i + a.j - (b.i + b.j));

			const hw = tileW / 2;
			const hh = tileH / 2;
			for (const c of cells) {
				// Depth fog by row only: the old metric was the grid diagonal, whose
				// maximum sits exactly on the centre, which fogged out the skyline.
				const fog = 0.5 + 0.5 * Math.min(1, (c.i + c.j) / (GRID * 2));
				const px = c.sx;
				const lift = c.terrainH * layerPx + c.built * towerPx;
				const py = c.sy - lift;
				const baseY = c.sy;
				const isTower = c.built >= 2.5;
				const tall = c.terrainH >= 3;

				if (c.red) {
					const pulse = 0.5 + 0.5 * Math.sin(t * 1.4 + (c.i + c.j) * 0.6);
					ctx.fillStyle = `rgba(180,40,52,${0.5 * fog})`;
					ctx.strokeStyle = `rgba(255,110,120,${(0.5 + pulse * 0.5) * fog})`;
				} else if (isTower) {
					// The top face only carries the outline; the brightness goes to the
					// facades, otherwise the field reads as a carpet of blue diamonds.
					ctx.fillStyle = `rgba(40,92,144,${0.95 * fog})`;
					ctx.strokeStyle = `rgba(170,228,255,${(c.built >= 8 ? 0.95 : 0.75) * fog})`;
				} else if (tall) {
					ctx.fillStyle = `rgba(40,74,110,${0.28 * fog})`;
					ctx.strokeStyle = `rgba(110,170,235,${0.18 * fog})`;
				} else {
					ctx.fillStyle = `rgba(17,26,38,${0.24 * fog})`;
					ctx.strokeStyle = `rgba(90,120,150,${0.06 * fog})`;
				}

				if (lift > 0) {
					const left = c.red
						? `rgba(120,24,32,${0.6 * fog})`
						: isTower
							? `rgba(58,122,186,${fog})`
							: `rgba(11,19,30,${0.8 * fog})`;
					const right = c.red
						? `rgba(70,12,18,${0.7 * fog})`
						: isTower
							? `rgba(26,66,108,${0.95 * fog})`
							: `rgba(7,12,20,${0.9 * fog})`;
					ctx.beginPath();
					ctx.moveTo(px - hw, py + hh);
					ctx.lineTo(px, py + 2 * hh);
					ctx.lineTo(px, baseY + 2 * hh);
					ctx.lineTo(px - hw, baseY + hh);
					ctx.closePath();
					ctx.fillStyle = left;
					ctx.fill();
					ctx.beginPath();
					ctx.moveTo(px + hw, py + hh);
					ctx.lineTo(px, py + 2 * hh);
					ctx.lineTo(px, baseY + 2 * hh);
					ctx.lineTo(px + hw, baseY + hh);
					ctx.closePath();
					ctx.fillStyle = right;
					ctx.fill();
				}

				ctx.beginPath();
				ctx.moveTo(px, py);
				ctx.lineTo(px + hw, py + hh);
				ctx.lineTo(px, py + 2 * hh);
				ctx.lineTo(px - hw, py + hh);
				ctx.closePath();
				ctx.fill();
				ctx.stroke();

				// Vertical edge: what turns a stack of tiles into a building.
				if (isTower && lift > 0) {
					ctx.strokeStyle = `rgba(190,235,255,${0.5 * fog})`;
					ctx.beginPath();
					ctx.moveTo(px, py + 2 * hh);
					ctx.lineTo(px, baseY + 2 * hh);
					ctx.stroke();
				}
				// Lit windows on some of the towers.
				if (c.built >= 3 && (c.i * 7 + c.j * 13) % 2 === 0) {
					ctx.fillStyle = `rgba(255,214,140,${0.8 * fog})`;
					const wins = Math.min(6, Math.floor(c.built * 0.8));
					for (let k = 0; k < wins; k += 1) {
						ctx.fillRect(px - hw * 0.42, py + hh + k * towerPx * 0.75 + 1, 2, 2);
					}
				}
			}

			for (const d of dust) {
				d.y -= (d.v * dt * 0.03) / Math.max(1, height);
				d.x += (Math.sin(t * 0.4 + d.phase) * 0.12) / Math.max(1, width);
				if (d.y < -0.02) {
					d.y = 1.02;
					d.x = Math.random();
				}
				const tw = 0.25 + 0.35 * Math.sin(t * 1.7 + d.phase) ** 2;
				ctx.fillStyle = `rgba(140,180,225,${tw})`;
				ctx.beginPath();
				ctx.arc(d.x * width, d.y * height, d.r, 0, Math.PI * 2);
				ctx.fill();
			}
		};

		// Seed the core so the panel is never empty, then let it rise.
		for (let i = 0; i < GRID; i += 1) {
			for (let j = 0; j < GRID; j += 1) {
				if (Math.hypot(i - CENTER, j - CENTER) < 4.5 && Math.random() < 0.5) buildTower(i, j, false);
			}
		}
		planWave();

		const host = canvas.parentElement ?? canvas;
		const onPointer = (event: PointerEvent) => {
			const rect = host.getBoundingClientRect();
			mouse.x = (event.clientX - rect.left) / Math.max(1, rect.width);
			mouse.y = (event.clientY - rect.top) / Math.max(1, rect.height);
		};
		const onLeave = () => {
			mouse.x = 0.5;
			mouse.y = 0.5;
		};
		host.addEventListener("pointermove", onPointer);
		host.addEventListener("pointerleave", onLeave);

		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		let raf = 0;
		let last = performance.now();
		const frame = (now: number) => {
			const dt = Math.min(50, now - last);
			last = now;
			time += dt / 1000;
			draw(dt, time);
			raf = requestAnimationFrame(frame);
		};

		const observer = new ResizeObserver(() => {
			sizeCanvas();
			if (reduceMotion) draw(0, time);
		});
		observer.observe(canvas);
		sizeCanvas();

		if (reduceMotion) {
			// Run the scene forward once so the skyline is fully built, then stop.
			for (let k = 0; k < 150; k += 1) {
				time += 1 / 60;
				draw(16.7, time);
			}
		} else {
			raf = requestAnimationFrame(frame);
		}

		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
			host.removeEventListener("pointermove", onPointer);
			host.removeEventListener("pointerleave", onLeave);
		};
	}, []);

	return <canvas className="auth-canvas" ref={canvasRef} aria-hidden="true" />;
}
