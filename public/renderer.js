import { WORLD, POOL, SEATS, OBSTACLES, isWalkable, inPool, inRect } from './world.js';
import { MYSTERY_SPOTS } from './mystery.js';

// Everything in the room is drawn here. World coordinates also power the server's
// collision checks; changing the size of the canvas never changes the room.
const TILE_X = 30;
const TILE_Y = 15;
const TILE_H = 30;
const TAU = Math.PI * 2;
const RECEPTION = OBSTACLES.find(item => item.kind === 'desk');
const PALETTE = {
  grout: '#d7ccb8', cream: '#f2e9d4', coral: '#ce785e', burgundy: '#714a43',
  sage: '#879985', green: '#536d55', water: '#5aafa8', ink: '#544b40',
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createHotelRenderer(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser does not support the hotel canvas.');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let scale = 1;
  let origin = { x: 0, y: 0 };
  let localId = null;
  let players = [];
  let mutedIds = new Set();
  let pointerStart = null;
  let pointerWorld = null;
  let hoveredSeat = null;
  let hoveredPlayer = null;
  let hoveredClue = null;
  let hoverReception = false;
  let collectedClues = new Set();
  let party = { active: false, endsAt: 0, startedBy: '' };
  let frame = 0;
  let lastTime = 0;
  let lastKeyAt = 0;
  let destroyed = false;
  let targetMarker = null;
  const positions = new Map();
  const playerHits = [];
  const keys = new Set();

  function project(x, z, h = 0) {
    return { x: (x - z) * TILE_X, y: (x + z) * TILE_Y - h * TILE_H };
  }

  function worldToScreen(x, z, h = 0) {
    const point = project(x, z, h);
    return { x: origin.x + point.x * scale, y: origin.y + point.y * scale };
  }

  function screenToWorld(x, y) {
    const localX = (x - origin.x) / scale / TILE_X;
    const localY = (y - origin.y) / scale / TILE_Y;
    return { x: (localX + localY) / 2, z: (localY - localX) / 2 };
  }

  function path(points) {
    ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();
  }

  function polygon(points, fill, stroke, lineWidth = 0.7) {
    path(points);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }

  function rect(x, z, w, d, fill, h = 0, stroke = null, lineWidth = 0.7) {
    polygon([project(x, z, h), project(x + w, z, h), project(x + w, z + d, h), project(x, z + d, h)], fill, stroke, lineWidth);
  }

  function line(points, color, lineWidth = 1) {
    ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function cube(x, z, w, d, h, top, left, right, base = 0) {
    const a = project(x, z, h + base);
    const b = project(x + w, z, h + base);
    const c = project(x + w, z + d, h + base);
    const e = project(x, z + d, h + base);
    polygon([b, c, project(x + w, z + d, base), project(x + w, z, base)], right || left);
    polygon([e, c, project(x + w, z + d, base), project(x, z + d, base)], left);
    polygon([a, b, c, e], top);
  }

  function ellipse(x, z, rx, ry, fill, h = 0, stroke = null, lineWidth = 1) {
    const p = project(x, z, h);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }

  function roundRect(x, y, w, h, r, fill, stroke = null) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.stroke(); }
  }

  function circle(x, y, radius, fill) {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fillStyle = fill; ctx.fill();
  }

  function shadow(x, z, rx, ry, opacity = 0.12) {
    ellipse(x, z, rx, ry, `rgba(82,67,45,${opacity})`, 0.006);
  }

  // Label drawn on the back wall's plane rather than floating above the room.
  function backWallLabel(x, h, w, text, smallText = '') {
    const p = project(x, 0.045, h);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.transform(1, 0.5, 0, 1, 0, 0);
    roundRect(0, 0, w, 40, 2.5, '#f6ecd4', '#cdb69a');
    ctx.fillStyle = PALETTE.burgundy;
    ctx.textAlign = 'center';
    ctx.font = '700 10px Georgia, serif';
    ctx.fillText(text, w / 2, 17);
    ctx.font = '600 4.5px system-ui, sans-serif';
    ctx.letterSpacing = '1px';
    ctx.fillText(smallText, w / 2, 28);
    ctx.letterSpacing = '0px';
    ctx.restore();
  }

  function drawArchitecture() {
    const floorPoints = [project(0, 0), project(WORLD.width, 0), project(WORLD.width, WORLD.depth), project(0, WORLD.depth)];
    ctx.save();
    ctx.shadowColor = '#65574529'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 17;
    polygon(floorPoints, '#d3bc99');
    ctx.restore();
    cube(0, 0, WORLD.width, WORLD.depth, 0.23, '#eaddc5', '#c3ae8c', '#cbb797', -0.23);
    rect(0.12, 0.12, WORLD.width - 0.24, WORLD.depth - 0.24, '#eae0cb', 0.015);
    for (let x = 0; x < WORLD.width; x++) {
      for (let z = 0; z < WORLD.depth; z++) {
        const poolTile = x > 7 && z > 2;
        const tones = poolTile ? ['#e5dfcc', '#e9e4d3'] : ['#e8dcc4', '#ebdfc9'];
        rect(x + 0.022, z + 0.022, 0.956, 0.956, tones[(x + z) % 2], 0.022);
      }
    }

    // Low walls keep the room readable as a single little dollhouse.
    cube(-0.17, -0.16, WORLD.width + 0.34, 0.16, 2.55, '#e9d9bf', '#ddc8aa', '#d5bca0');
    cube(-0.17, 0, 0.17, WORLD.depth, 2.55, '#efe0c7', '#d7c1a1', '#e4cfad');
    // Warm painted skirting, with a narrow highlight at its top.
    polygon([project(0, 0, 0.56), project(14, 0, 0.56), project(14, 0), project(0, 0)], '#c89778');
    polygon([project(0, 0, 0.56), project(0, 12, 0.56), project(0, 12), project(0, 0)], '#bc876e');
    line([project(0, 0, 0.58), project(14, 0, 0.58)], '#e3b194', 1.6);
    line([project(0, 0, 0.58), project(0, 12, 0.58)], '#dba386', 1.6);
    backWallLabel(1.04, 2.14, 116, 'THREE DOLLAR MOTEL', 'LOW RATES. HIGH SPIRITS.');
    backWallLabel(9.28, 2.02, 65, 'POOL CLUB', 'NO DIVING. JUST VIBES.');

    // A closed lift makes a future wing feel like part of the motel's story.
    polygon([project(6.75, 0.02, 2.05), project(8.15, 0.02, 2.05), project(8.15, 0.02), project(6.75, 0.02)], '#b6a98f', '#a3967d');
    polygon([project(6.87, 0.04, 1.94), project(8.03, 0.04, 1.94), project(8.03, 0.04, 0.12), project(6.87, 0.04, 0.12)], '#c5bca7');
    line([project(7.45, 0.055, 1.94), project(7.45, 0.055, 0.12)], '#aa9d85', 1);
    const lift = project(7.45, 0.08, 1.32);
    ctx.save(); ctx.translate(lift.x, lift.y); ctx.transform(1, 0.5, 0, 1, 0, 0);
    roundRect(-14, -8, 28, 19, 1, '#f6e4b5');
    ctx.fillStyle = '#8c7654'; ctx.textAlign = 'center'; ctx.font = '700 4.5px system-ui';
    ctx.fillText('MAYBE', 0, -1); ctx.fillText('TOMORROW', 0, 5);
    ctx.restore();

    // Framed sunset and room key hooks on the lounge wall.
    const artA = project(0.025, 4.25, 2.12);
    ctx.save(); ctx.translate(artA.x, artA.y); ctx.transform(1, -0.5, 0, 1, 0, 0);
    roundRect(-48, 0, 43, 36, 1, '#956c4f');
    roundRect(-45, 3, 37, 30, 0, '#eacb9d');
    circle(-25, 14, 8, '#ce7c59');
    polygon([{x:-45,y:25},{x:-29,y:18},{x:-8,y:28},{x:-8,y:33},{x:-45,y:33}], '#849378');
    ctx.restore();
    rect(0.6, 3.7, 5.65, 4.3, '#c48d71', 0.038);
    rect(0.71, 3.81, 5.43, 4.08, '#d7b08c', 0.04);
    rect(0.86, 3.96, 5.13, 3.78, '#dcc3a0', 0.043);
    // Woven rug lines are intentionally quiet beneath the furniture.
    for (let z = 4.18; z < 7.65; z += 0.22) line([project(1.0, z, 0.045), project(5.86, z, 0.045)], '#b7906c29', 0.55);
    rect(1.5, 2.65, 2.7, 0.56, '#bb8a6c', 0.03);
    rect(1.62, 2.74, 2.46, 0.38, '#d4ae88', 0.033);

    // Small inlaid floor plaques, part of the floor rather than extra UI.
    floorText(3.5, 9.1, 'THE LOUNGE', '#9e8c72', 8);
    floorText(10.7, 2.75, 'POOL HOURS: ALWAYS', '#9e8c72', 6);
  }

  function floorText(x, z, text, color, size) {
    const p = project(x, z, 0.035);
    ctx.save(); ctx.translate(p.x, p.y); ctx.transform(1, 0.5, -1, 0.5, 0, 0);
    ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.fillText(text, 0, 0); ctx.restore();
  }

  function drawPool(time) {
    const {x, z, w, d} = POOL;
    const celebrating = partyActive();
    rect(x - 0.24, z - 0.24, w + 0.48, d + 0.48, '#b8bba6', 0.024);
    rect(x - 0.16, z - 0.16, w + 0.32, d + 0.32, '#f4ebd7', 0.045);
    rect(x - 0.05, z - 0.05, w + 0.1, d + 0.1, '#467f80', 0.05);
    const corners = [project(x, z, 0.052), project(x+w, z, 0.052), project(x+w,z+d,0.052), project(x,z+d,0.052)];
    ctx.save(); path(corners); ctx.clip();
    const top = project(x, z); const bottom = project(x + w, z + d);
    const gradient = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y);
    gradient.addColorStop(0, celebrating ? '#7164ac' : '#539994');
    gradient.addColorStop(0.52, celebrating ? '#4bbfc0' : '#70bcb0');
    gradient.addColorStop(1, celebrating ? '#a4e1c5' : '#8bc8b9');
    polygon(corners, gradient);
    // An offset tile grid and softened ripples give the water depth without images.
    for (let tx = x; tx < x+w+0.5; tx += 0.65) line([project(tx,z,0.052), project(tx,z+d,0.052)], '#d6fff222', 0.8);
    for (let tz = z; tz < z+d+0.5; tz += 0.65) line([project(x,tz,0.052), project(x+w,tz,0.052)], '#d6fff222', 0.8);
    const shift = reducedMotion.matches ? 0 : time / 1800;
    for (let i = 0; i < 14; i++) {
      const wx = x + 0.2 + ((i * 1.33) % (w - 0.4));
      const wz = z + 0.35 + ((i * 1.97) % (d - 0.65));
      const p = project(wx, wz, 0.057);
      const drift = Math.sin(shift + i * 2) * 3;
      ctx.beginPath(); ctx.moveTo(p.x - 8, p.y + drift);
      ctx.bezierCurveTo(p.x - 3, p.y - 3 + drift, p.x+3,p.y+3+drift,p.x+10,p.y+drift);
      ctx.strokeStyle = `rgba(230,255,236,${0.19 + (Math.sin(shift+i)+1)*0.08})`; ctx.lineWidth = 1.1; ctx.stroke();
    }
    polygon([project(x,z,0.06), project(x+w,z,0.06),project(x+w,z+0.26,0.06),project(x+0.26,z+0.26,0.06),project(x+0.26,z+d,0.06),project(x,z+d,0.06)], '#346f7028');
    ctx.restore();
    // Coping joins and a ladder reinforce the pool's small motel scale.
    for (let n=0; n <= w; n+=0.62) {
      line([project(x+n,z-0.15,0.06), project(x+n,z-0.045,0.06)], '#cbbb9f', 0.7);
      line([project(x+n,z+d+0.04,0.06), project(x+n,z+d+0.15,0.06)], '#cbbb9f', 0.7);
    }
    for (let n=0; n <= d; n+=0.64) {
      line([project(x-0.15,z+n,0.06), project(x-0.045,z+n,0.06)], '#cbbb9f', 0.7);
      line([project(x+w+0.04,z+n,0.06), project(x+w+0.15,z+n,0.06)], '#cbbb9f', 0.7);
    }
    for (const railZ of [z+0.7,z+1.2]) {
      line([project(x-0.2,railZ,0.03),project(x-0.22,railZ,0.44),project(x+0.1,railZ,0.44),project(x+0.23,railZ,0.12)], '#748b81', 2.9);
      line([project(x-0.2,railZ,0.08),project(x-0.22,railZ,0.44),project(x+0.1,railZ,0.44)], '#e6e8cb', 1.2);
    }
    line([project(x+0.14,z+0.7,0.1),project(x+0.14,z+1.2,0.1)], '#cfdbc6', 2.3);
    // A lifebuoy, decorative and deliberately stationary.
    const ring = project(x+w+0.45,z+1.8,0.12);
    ctx.save();ctx.translate(ring.x,ring.y);ctx.scale(1,0.58);
    ctx.beginPath();ctx.arc(0,0,10,0,TAU);ctx.strokeStyle='#f8e9d0';ctx.lineWidth=5;ctx.stroke();
    for(let i=0;i<4;i++){ctx.beginPath();ctx.arc(0,0,10,i*Math.PI/2,i*Math.PI/2+0.35);ctx.strokeStyle='#c87a60';ctx.lineWidth=5.4;ctx.stroke();}
    ctx.restore();
    if (celebrating) drawPoolParty(time);
  }

  function partyActive() {
    return party.active && party.endsAt > Date.now();
  }

  function drawPoolParty(time) {
    // A handful of canvas shapes keeps the shared reward light on the VM and phones.
    for (let i = 0; i < 2; i++) {
      const bob = reducedMotion.matches ? 0 : Math.sin(time / 1400 + i * Math.PI) * 0.035;
      const float = project(POOL.x + 1.15 + i * 1.8, POOL.z + 1.8 + i * 1.6, 0.09 + bob);
      ctx.beginPath();
      ctx.ellipse(float.x, float.y, 14, 7, 0, 0, TAU);
      ctx.strokeStyle = i ? '#ff9cbf' : '#ffd18c'; ctx.lineWidth = 5; ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(float.x, float.y - 1, 14, 7, 0, Math.PI, TAU);
      ctx.strokeStyle = '#fff2dbaa'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    const left = project(POOL.x - 0.25, POOL.z - 0.38, 1.65);
    const right = project(POOL.x + POOL.w + 0.25, POOL.z - 0.38, 1.65);
    line([project(POOL.x - 0.25, POOL.z - 0.38), left], '#896b65', 2);
    line([project(POOL.x + POOL.w + 0.25, POOL.z - 0.38), right], '#896b65', 2);
    const dx = right.x - left.x, dy = right.y - left.y;
    ctx.beginPath(); ctx.moveTo(left.x, left.y);
    ctx.quadraticCurveTo(left.x + dx / 2, left.y + dy / 2 + 11, right.x, right.y);
    ctx.strokeStyle = '#785d74'; ctx.lineWidth = 1; ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const t = (i + 0.5) / 6;
      const x = left.x + dx * t, y = left.y + dy * t + 22 * t * (1 - t);
      ctx.beginPath(); ctx.moveTo(x - 7, y - dy / 20);
      ctx.lineTo(x + 7, y + dy / 20); ctx.lineTo(x + 1, y + 14); ctx.closePath();
      ctx.fillStyle = i % 3 === 0 ? '#f19eb5' : i % 3 === 1 ? '#ffe09b' : '#83d8cd'; ctx.fill();
    }
    floorText(POOL.x + POOL.w / 2, POOL.z - 0.9, 'POOL PARTY!', '#826076', 8);
  }

  function cluePoint(spot) {
    const point = worldToScreen(spot.x, spot.z, 0.06);
    return { x: point.x, y: point.y - 23 };
  }

  function drawClues() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < MYSTERY_SPOTS.length; i++) {
      const spot = MYSTERY_SPOTS[i];
      const point = cluePoint(spot);
      const collected = collectedClues.has(spot.id);
      const hovered = hoveredClue === spot.id;
      ctx.beginPath(); ctx.moveTo(point.x, point.y + 12); ctx.lineTo(point.x, point.y + 22);
      ctx.strokeStyle = collected ? '#487e70' : '#a55e47'; ctx.lineWidth = 2; ctx.stroke();
      circle(point.x, point.y, hovered ? 15 : 13, collected ? '#497f73' : '#fff0c6');
      ctx.beginPath(); ctx.arc(point.x, point.y, hovered ? 15 : 13, 0, TAU);
      ctx.strokeStyle = collected ? '#ddf4dc' : '#a9654e'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = collected ? '#f5ffe8' : '#794b3d';
      ctx.font = '700 14px system-ui, sans-serif';
      ctx.fillText(collected ? '✓' : String(i + 1), point.x, point.y + 0.5);
    }
  }

  function drawDesk() {
    const {x,z,w,d} = RECEPTION;
    shadow(x+w/2,z+d/2+0.1,69,18);
    cube(x,z,w,d,0.86,'#a77853','#b78962','#a27350');
    for (let n=0.13; n < w; n+=0.19) line([project(x+n,z+d+0.003,0.07),project(x+n,z+d+0.003,0.79)],'#946443',0.65);
    cube(x-0.08,z-0.06,w+0.16,d+0.12,0.105,'#f0dec0','#d9c29d','#cbb38d',0.86);
    // Guest book and a brass bell: visible, original little desk details.
    cube(x+1.32,z+0.32,0.7,0.4,0.05,'#6c826e','#596d5a','#59715f',0.97);
    rect(x+1.39,z+0.34,0.27,0.33,'#f5e8cf',1.028);
    rect(x+1.68,z+0.34,0.27,0.33,'#ebddc0',1.03);
    ellipse(x+2.8,z+0.7,6,2.6,'#8a7550',0.99);
    const bell = project(x+2.8,z+0.7,1.01);
    ctx.beginPath();ctx.arc(bell.x,bell.y,4.6,Math.PI,0);ctx.fillStyle='#c5a366';ctx.fill();
    circle(bell.x,bell.y-5.3,1.3,'#8b7245');
    cube(x+0.2,z+0.36,0.45,0.16,0.24,'#e9c794','#825d48','#a37c56',0.97);
    const sign = project(x+0.44,z+d+0.01,0.58);
    ctx.save();ctx.translate(sign.x,sign.y);ctx.transform(1,0.5,0,1,0,0);
    ctx.fillStyle='#f8e7c8';ctx.font='600 6px system-ui';ctx.textAlign='left';ctx.fillText('CHECK IN · CHILL OUT',0,0);ctx.restore();
    if(hoverReception) {
      rect(x-0.11,z-0.1,w+0.22,d+0.2,null,0.99,'#f9e3ad',1.7);
    }
  }

  function drawSofa() {
    const x=1.35,z=4.56,w=1.35,d=2.49;
    shadow(x+w/2,z+d/2,39,16);
    for (const [lx,lz] of [[x+0.13,z+0.13],[x+w-0.13,z+0.13],[x+0.13,z+d-0.13],[x+w-0.13,z+d-0.13]]) cube(lx,lz,0.12,0.12,0.2,'#835c42','#785b41','#6c5039');
    cube(x,z,w,d,0.36,'#ce8a6e','#ab6d55','#bd7c60',0.15);
    cube(x,z,0.29,d,0.66,'#d59979','#b6765d','#c28367',0.46);
    cube(x+0.3,z+0.15,w-0.36,1.04,0.16,'#dfa080','#ca896c','#cf8d6e',0.5);
    cube(x+0.3,z+1.27,w-0.36,1.03,0.16,'#dfa080','#ca896c','#cf8d6e',0.5);
    cube(x,z,w,0.23,0.46,'#d39474','#bb7b5f','#c7886a',0.44);
    cube(x,z+d-0.23,w,0.23,0.46,'#d39474','#bb7b5f','#c7886a',0.44);
    // Upholstery seams and a cream throw pillow.
    line([project(x+0.13,z+0.29,1.125),project(x+0.13,z+d-0.29,1.125)],'#e3ae8d',0.8);
    cube(x+0.34,z+0.31,0.42,0.45,0.19,'#ebd1a5','#d7b98f','#d4b088',0.66);
  }

  function drawChair(seat) {
    const x=seat.x-0.53,z=seat.z-0.5;
    shadow(seat.x,seat.z,25,11);
    for (const [lx,lz] of [[x+0.1,z+0.1],[x+0.88,z+0.1],[x+0.1,z+0.86],[x+0.88,z+0.86]]) cube(lx,lz,0.1,0.1,0.2,'#916f4d','#795d41','#76583e');
    cube(x,z,1.03,1,0.3,'#859680','#6d7d66','#73846d',0.19);
    cube(x+0.74,z,0.29,1,0.67,'#9aaa90','#7f9177','#8a9b81',0.43);
    cube(x+0.07,z+0.13,0.68,0.74,0.17,'#a6b095','#8f9d82','#99a68a',0.49);
    cube(x,z,1.03,0.16,0.37,'#98a78c','#7e8f75','#8c9c83',0.4);
    cube(x,z+0.84,1.03,0.16,0.37,'#98a78c','#7e8f75','#8c9c83',0.4);
  }

  function drawTable() {
    const table=OBSTACLES.find(item=>item.kind==='table');
    const {x,z,w,d}=table;
    shadow(x+w/2,z+d/2,29,12);
    for(const [lx,lz] of [[x+0.1,z+0.1],[x+w-0.22,z+0.1],[x+0.1,z+d-0.22],[x+w-0.22,z+d-0.22]]) cube(lx,lz,0.12,0.12,0.47,'#88684b','#87664b','#75533d');
    cube(x,z,w,d,0.12,'#b99469','#9e7a53','#ad865b',0.43);
    cube(x+0.1,z+0.33,0.5,0.59,0.025,'#d07859','#b5654b','#a65c45',0.56);
    rect(x+0.15,z+0.36,0.4,0.07,'#f0dac0',0.59);
    rect(x+0.15,z+0.74,0.27,0.1,'#f0dac0',0.59);
    ellipse(x+0.91,z+0.35,5.5,2.5,'#e9dbc0',0.57);
    cube(x+0.84,z+0.28,0.15,0.15,0.16,'#684e3d','#efe4ca','#d8cbb0',0.58);
    cube(x+0.82,z+1.1,0.26,0.25,0.2,'#d6b68d','#b9926c','#c7a278',0.56);
    const p=project(x+0.95,z+1.23,0.96);
    line([project(x+0.95,z+1.23,0.72),p],'#71835b',1.2);
    circle(p.x,p.y,3.5,'#f2e1a9');circle(p.x,p.y,1.25,'#c69152');
  }

  function drawSunbed(seat) {
    const x=seat.x-0.4,z=seat.z-0.86;
    shadow(seat.x,seat.z,29,11);
    cube(x,z,0.8,1.79,0.15,'#ab8860','#9a764f','#96704c',0.14);
    cube(x+0.04,z+0.47,0.72,1.23,0.12,'#f0dabc','#d9c09d','#dec5a1',0.29);
    // The raised back is a slope rather than a second chair.
    polygon([project(x+0.04,z+0.03,0.74),project(x+0.76,z+0.03,0.74),project(x+0.76,z+0.53,0.42),project(x+0.04,z+0.53,0.42)],'#f1dfc1','#d8bf98');
    for(let stripe=0.1;stripe<0.72;stripe+=0.25){
      rect(x+stripe,z+0.48,0.1,1.19,'#ca8b6b',0.418);
      polygon([project(x+stripe,z+0.04,0.745),project(x+stripe+0.1,z+0.04,0.745),project(x+stripe+0.1,z+0.53,0.425),project(x+stripe,z+0.53,0.425)],'#ca8b6b');
    }
    cube(x+0.05,z+0.19,0.7,0.22,0.07,'#f7e6c8','#dec6a3','#e5cfaa',0.62);
  }

  function drawPlant(obstacle, tall=false) {
    const x=obstacle.x+obstacle.w/2,z=obstacle.z+obstacle.d/2;
    shadow(x,z,20,8);
    const bottom=project(x,z,0.06),top=project(x,z,0.53);
    polygon([{x:top.x-11,y:top.y},{x:top.x+11,y:top.y},{x:bottom.x+7.2,y:bottom.y},{x:bottom.x-7.2,y:bottom.y}], '#bb8662');
    ellipse(x,z,11,5,'#d19a72',0.53);
    ellipse(x,z,8.2,3.4,'#756849',0.55);
    const plantHeight=tall?2.27:1.82;
    const tip=project(x+0.03,z,plantHeight);
    line([project(x,z,0.55),project(x+0.04,z,1.16),tip],'#8d8152',3.5);
    for(let i=0;i<7;i++) {
      const angle=i*TAU/7+0.2;
      const len=(tall?32:26)+(i%3)*4;
      const end={x:tip.x+Math.cos(angle)*len,y:tip.y+Math.sin(angle)*len*0.46+10};
      ctx.beginPath();ctx.moveTo(tip.x,tip.y);
      ctx.quadraticCurveTo((tip.x+end.x)/2+Math.sin(angle)*7,Math.min(tip.y,end.y)-11,end.x,end.y);
      ctx.quadraticCurveTo((tip.x+end.x)/2-Math.sin(angle)*5,(tip.y+end.y)/2+5,tip.x,tip.y);
      ctx.fillStyle=['#647c56','#748b60','#536e4e'][i%3];ctx.fill();
      line([tip,end],'#47634144',0.55);
    }
  }

  function drawSeatHover() {
    if(!hoveredSeat) return;
    const seat=SEATS.find(item=>item.id===hoveredSeat);
    if(!seat) return;
    ellipse(seat.x,seat.z,20,10,'#fff6d144',0.76,'#f9e6a8',1.3);
  }

  function drawAvatar(player, time) {
    const current=positions.get(player.id);
    if(!current) return;
    const {x,z}=current;
    const swimming=player.pose==='swim'||(player.pose!=='sit'&&inPool(x,z));
    const sitting=player.pose==='sit';
    const bob=!reducedMotion.matches&&swimming?Math.sin(time/470+current.seed)*0.055:0;
    const base=swimming?0.01+bob:sitting?0.46:0.02;
    const pos=project(x,z,base);
    const moving=Math.hypot(current.previousX-x,current.previousZ-z)>0.002;
    const step=!reducedMotion.matches&&moving&&!sitting&&!swimming?Math.sin(time/100+current.seed)*3:0;
    const isLocal=player.id===localId;
    const color=/^#[a-f\d]{6}$/i.test(player.color||'')?player.color:'#d87956';
    if(!swimming) shadow(x,z,sitting?12:10,4,0.17);
    if(isLocal) ellipse(x,z,15,7,'#fff3c026',swimming?0.075:0.05,'#fff5d9',1.8);
    if(swimming){
      const ripple=1+(reducedMotion.matches?0:Math.sin(time/510)*0.1);
      ellipse(x,z,17*ripple,7*ripple,null,0.075,'#e2fff491',1);
      ellipse(x,z,12,4,null,0.075,'#ddfff277',1);
    }
    ctx.save();ctx.translate(pos.x,pos.y);
    if(!swimming) {
      if(sitting){
        line([{x:-3,y:-6},{x:5,y:-2},{x:7,y:5}],'#444c49',5.5);
        line([{x:3,y:-7},{x:11,y:-3},{x:12,y:3}],'#515b57',5.5);
        line([{x:5,y:5},{x:9,y:5}],'#f4e5cb',3);
        line([{x:11,y:3},{x:15,y:3}],'#f4e5cb',3);
      }else{
        line([{x:-3.5,y:-12},{x:-4-step*.3,y:-2+step*.3}],'#48524f',5);
        line([{x:3.5,y:-12},{x:4+step*.3,y:-2-step*.3}],'#56605b',5);
        line([{x:-5-step*.3,y:-1+step*.3},{x:-1-step*.3,y:-1+step*.3}],'#f3e7ce',3.4);
        line([{x:2+step*.3,y:-1-step*.3},{x:6+step*.3,y:-1-step*.3}],'#f3e7ce',3.4);
      }
    }
    const torsoY=swimming?-11:sitting?-21:-27;
    roundRect(-7,torsoY,14,swimming?10:17,5,color);
    // A shoulder highlight makes the otherwise tiny silhouettes easy to tell apart.
    line([{x:-3,y:torsoY+2},{x:2,y:torsoY+2}],'#ffffff35',1.7);
    const handY=swimming?-4:torsoY+14;
    const wave=player.emote==='wave'&&player.emoteUntil>Date.now();
    const waveOffset=wave&&!reducedMotion.matches?Math.sin(time/100)*3:0;
    line([{x:-6,y:torsoY+5},{x:-10,y:handY}],'#e0ad88',3.3);
    line([{x:6,y:torsoY+5},{x:wave?12+waveOffset:10,y:wave?torsoY-7:handY}],'#e0ad88',3.3);
    const headY=torsoY-6.5;
    circle(0,headY,7.5,'#e2b18c');
    ctx.beginPath();ctx.arc(-0.5,headY-1.2,7.6,Math.PI*0.94,Math.PI*1.94);ctx.quadraticCurveTo(5,headY-3,-6,headY-2);ctx.closePath();ctx.fillStyle=['#554439','#5d4b3c','#76503a'][current.seed%3];ctx.fill();
    circle(-1.5,headY+1,0.75,'#514339');circle(3,headY+1,0.75,'#514339');
    line([{x:0,y:headY+4},{x:2,y:headY+4}],'#ae785c',0.7);
    if(swimming){
      line([{x:-9,y:0},{x:-3,y:1},{x:3,y:0},{x:9,y:1}],'#c7f0da',1.6);
    }
    ctx.restore();
    current.head={x:pos.x,y:pos.y+headY};
    playerHits.push({id:player.id,x:pos.x,y:pos.y+headY/2,r:16,top:pos.y+headY-11,bottom:pos.y+7});
  }

  function splitLines(text,maxWidth) {
    const words=String(text).replace(/\s+/g,' ').trim().split(' ');
    const lines=[];
    let current='';
    for(const word of words){
      const candidate=current?`${current} ${word}`:word;
      if(ctx.measureText(candidate).width<=maxWidth){current=candidate;continue;}
      if(current) lines.push(current);
      current=word;
      while(ctx.measureText(current).width>maxWidth&&current.length>1) current=current.slice(0,-1);
      if(current!==word) current=current.slice(0,-1)+'…';
      if(lines.length===1) break;
    }
    if(current) lines.push(current);
    const result=lines.slice(0,2);
    if(lines.length>=2&&words.join(' ').length>result.join(' ').length&&!result[1].endsWith('…')) {
      let finalLine=result[1];
      while(ctx.measureText(finalLine+'…').width>maxWidth)finalLine=finalLine.slice(0,-1);
      result[1]=finalLine+'…';
    }
    return result;
  }

  function drawPlayerLabel(player, now) {
    const current=positions.get(player.id);
    if(!current?.head)return;
    // Labels use screen pixels so they stay readable when the room shrinks on phones.
    const x=current.head.x*scale+origin.x,y=current.head.y*scale+origin.y;
    const isLocal=player.id===localId;
    const selected=hoveredPlayer===player.id;
    const name=String(player.name||'Guest').slice(0,20);
    ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.font='600 11px system-ui, sans-serif';
    const labelWidth=Math.min(150,ctx.measureText(name).width+16);
    const labelX=Math.max(labelWidth/2+4,Math.min(width-labelWidth/2-4,x));
    roundRect(labelX-labelWidth/2,y-27,labelWidth,19,5,isLocal?'#725546':'#faf3e3ee',selected?'#b39271':null);
    ctx.fillStyle=isLocal?'#fff7e8':'#615447';ctx.fillText(name,labelX,y-14,134);
    if(mutedIds.has(player.id)) return;
    if(player.chatText&&player.chatUntil>now){
      ctx.font='500 13px system-ui, sans-serif';
      const lines=splitLines(player.chatText,164);
      const bubbleWidth=Math.max(34,...lines.map(text=>ctx.measureText(text).width+18));
      const bubbleX=Math.max(bubbleWidth/2+4,Math.min(width-bubbleWidth/2-4,x));
      const bubbleHeight=lines.length*17+12;
      const top=y-34-bubbleHeight;
      ctx.save();ctx.shadowColor='#68503d18';ctx.shadowBlur=5;ctx.shadowOffsetY=2;
      roundRect(bubbleX-bubbleWidth/2,top,bubbleWidth,bubbleHeight,7,'#fffaf0','#d7c8ad');ctx.restore();
      polygon([{x:x-4,y:top+bubbleHeight-0.3},{x:x+4,y:top+bubbleHeight-0.3},{x,y:top+bubbleHeight+4}],'#fffaf0');
      ctx.fillStyle='#514b41';lines.forEach((text,index)=>ctx.fillText(text,bubbleX,top+17+index*17));
    }else if(player.emote&&player.emoteUntil>now){
      const emotes={wave:'👋',heart:'♥',laugh:'☺',splash:'💦'};
      const label=emotes[player.emote];
      if(!label)return;
      circle(x,y-43,13,'#fff7e6');
      ctx.font=player.emote==='heart'?'19px system-ui':'17px system-ui';
      ctx.fillStyle=player.emote==='heart'?'#cc7660':'#997447';ctx.fillText(label,x,y-37);
    }
  }

  function drawFloorPointer(time) {
    if(targetMarker) {
      const age=time-targetMarker.time;
      if(age>1000)targetMarker=null;
      else {
        const radius=reducedMotion.matches?9:6+age/100;
        ellipse(targetMarker.x,targetMarker.z,radius,radius*0.5,null,0.085,`rgba(112,98,73,${(1-age/1000)*0.6})`,1.4);
        circle(project(targetMarker.x,targetMarker.z,0.085).x,project(targetMarker.x,targetMarker.z,0.085).y,1.8,'#7e7256');
      }
    }
    if(pointerWorld&&!hoveredPlayer&&!hoveredSeat&&!hoveredClue&&!hoverReception&&isWalkable(pointerWorld.x,pointerWorld.z)) {
      ellipse(pointerWorld.x,pointerWorld.z,5,2.7,'#fff9dc77',0.07,'#b7a38299',0.7);
    }
  }

  function updatePositions(delta) {
    for(const player of players){
      if(!Number.isFinite(player.x)||!Number.isFinite(player.z))continue;
      let current=positions.get(player.id);
      if(!current){current={x:player.x,z:player.z,previousX:player.x,previousZ:player.z,seed:[...String(player.id)].reduce((value,char)=>value+char.charCodeAt(0),0)};positions.set(player.id,current);}
      current.previousX=current.x;current.previousZ=current.z;
      const distance=Math.hypot(player.x-current.x,player.z-current.z);
      const smoothing=distance>3||reducedMotion.matches?1:1-Math.exp(-delta/65);
      current.x+=(player.x-current.x)*smoothing;current.z+=(player.z-current.z)*smoothing;
    }
  }

  function moveWithKeyboard(time) {
    if(!keys.size||!localId||time-lastKeyAt<100)return;
    const local=players.find(player=>player.id===localId);
    if(!local)return;
    // Arrow directions follow the screen, so up actually feels like up.
    let dx=0,dz=0;
    if(keys.has('arrowup')||keys.has('w')){dx-=1;dz-=1;}
    if(keys.has('arrowdown')||keys.has('s')){dx+=1;dz+=1;}
    if(keys.has('arrowleft')||keys.has('a')){dx-=1;dz+=1;}
    if(keys.has('arrowright')||keys.has('d')){dx+=1;dz-=1;}
    const magnitude=Math.hypot(dx,dz);
    if(!magnitude)return;
    const distance=WORLD.speed*0.17;
    const destination={x:local.x+dx/magnitude*distance,z:local.z+dz/magnitude*distance};
    if(isWalkable(destination.x,destination.z))options.onMove?.(destination.x,destination.z);
    lastKeyAt=time;
  }

  function draw(time) {
    if(destroyed)return;
    frame=requestAnimationFrame(draw);
    if(!width||!height)return;
    const delta=Math.min(100,time-(lastTime||time-16));lastTime=time;
    moveWithKeyboard(time);updatePositions(delta);
    ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);ctx.clearRect(0,0,width,height);
    ctx.save();ctx.translate(origin.x,origin.y);ctx.scale(scale,scale);
    drawArchitecture();drawPool(time);drawFloorPointer(time);
    const items=[
      {depth:RECEPTION.x+RECEPTION.z+RECEPTION.w+RECEPTION.d-0.9,draw:drawDesk},
      {depth:6.7,draw:drawSofa},
      {depth:10.35,draw:drawTable},
      ...SEATS.filter(item=>item.id.startsWith('chair')).map(seat=>({depth:seat.x+seat.z-0.05,draw:()=>drawChair(seat)})),
      ...SEATS.filter(item=>item.id.startsWith('sunbed')).map(seat=>({depth:seat.x+seat.z-0.1,draw:()=>drawSunbed(seat)})),
      ...OBSTACLES.filter(item=>item.kind==='plant').map(plant=>({depth:plant.x+plant.z+0.65,draw:()=>drawPlant(plant,plant.x>10)})),
      ...players.map(player=>({depth:(positions.get(player.id)?.x??player.x)+(positions.get(player.id)?.z??player.z)+(player.pose==='sit'?0.2:0),draw:()=>drawAvatar(player,time)})),
    ];
    playerHits.length=0;
    items.sort((a,b)=>a.depth-b.depth).forEach(item=>item.draw());
    drawSeatHover();
    ctx.restore();
    ctx.save();
    drawClues();
    for(const player of players)drawPlayerLabel(player,Date.now());
    ctx.restore();
  }

  function resize() {
    const bounds=canvas.getBoundingClientRect();
    width=bounds.width;height=bounds.height;
    pixelRatio=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(width*pixelRatio);canvas.height=Math.round(height*pixelRatio);
    const minX=-WORLD.depth*TILE_X-42,maxX=WORLD.width*TILE_X+42,minY=-105,maxY=(WORLD.width+WORLD.depth)*TILE_Y+39;
    scale=Math.min(width/(maxX-minX),height/(maxY-minY));
    origin={x:(width-(maxX+minX)*scale)/2,y:(height-(maxY+minY)*scale)/2};
  }

  function pointerDetails(event) {
    const bounds=canvas.getBoundingClientRect();
    const screen={x:event.clientX-bounds.left,y:event.clientY-bounds.top};
    const world=screenToWorld(screen.x,screen.y);
    const point={x:(screen.x-origin.x)/scale,y:(screen.y-origin.y)/scale};
    let player=null;
    for(let i=playerHits.length-1;i>=0;i--){
      const hit=playerHits[i];
      if(Math.abs(point.x-hit.x)<hit.r&&point.y>hit.top&&point.y<hit.bottom){player=hit.id;break;}
    }
    let seat=null;
    let seatDistance=Infinity;
    for(const candidate of SEATS){
      const seatedPoint=project(candidate.x,candidate.z,0.58);
      const distance=Math.hypot(point.x-seatedPoint.x,(point.y-seatedPoint.y)*1.7);
      if(distance<24&&distance<seatDistance){seat=candidate.id;seatDistance=distance;}
    }
    const deskPoint=screenToWorld(screen.x,screen.y+0.6*TILE_H*scale);
    const reception=inRect(deskPoint.x,deskPoint.z,RECEPTION,0.1);
    let clue = null;
    for (const spot of MYSTERY_SPOTS) {
      const marker = cluePoint(spot);
      if (Math.hypot(screen.x - marker.x, screen.y - marker.y) <= 18) { clue = spot.id; break; }
    }
    return{screen,world,player,seat,reception,clue};
  }

  function onPointerMove(event) {
    if(event.pointerType==='touch')return;
    const hit=pointerDetails(event);
    pointerWorld=hit.world;hoveredPlayer=hit.player;hoveredSeat=hit.player?null:hit.seat;
    hoveredClue=!hit.player&&!hit.seat?hit.clue:null;hoverReception=!hit.player&&!hit.seat&&!hit.clue&&hit.reception;
    canvas.style.cursor=hit.player||hit.seat||hit.clue||hit.reception?'pointer':isWalkable(hit.world.x,hit.world.z)?'crosshair':'default';
  }

  function clearHover(){pointerWorld=null;hoveredPlayer=null;hoveredSeat=null;hoveredClue=null;hoverReception=false;canvas.style.cursor='default';}
  function onPointerDown(event){if(event.button!==0)return;pointerStart={x:event.clientX,y:event.clientY,id:event.pointerId};}
  function onPointerUp(event) {
    const start=pointerStart;pointerStart=null;
    if(!start||start.id!==event.pointerId||Math.hypot(start.x-event.clientX,start.y-event.clientY)>8)return;
    const hit=pointerDetails(event);
    if(hit.screen.x<0||hit.screen.y<0||hit.screen.x>width||hit.screen.y>height)return;
    canvas.focus({preventScroll:true});
    if(hit.player){options.onSelectPlayer?.(hit.player);return;}
    if(hit.seat){options.onSeat?.(hit.seat);return;}
    if(hit.clue){options.onClue?.(hit.clue);return;}
    if(hit.reception){options.onReception?.();return;}
    if(isWalkable(hit.world.x,hit.world.z)){
      targetMarker={...hit.world,time:performance.now()};options.onMove?.(hit.world.x,hit.world.z);
    }
  }
  function onPointerCancel(){pointerStart=null;}
  function onKeyDown(event){
    const key=event.key.toLowerCase();
    if(!['arrowup','arrowdown','arrowleft','arrowright','w','a','s','d'].includes(key)||event.ctrlKey||event.metaKey||event.altKey)return;
    event.preventDefault();keys.add(key);
  }
  function onKeyUp(event){keys.delete(event.key.toLowerCase());}
  function clearKeys(){keys.clear();}

  const observer=new ResizeObserver(resize);observer.observe(canvas);
  canvas.addEventListener('pointermove',onPointerMove);
  canvas.addEventListener('pointerleave',clearHover);
  canvas.addEventListener('pointerdown',onPointerDown);
  canvas.addEventListener('pointerup',onPointerUp);
  canvas.addEventListener('pointercancel',onPointerCancel);
  canvas.addEventListener('keydown',onKeyDown);
  canvas.addEventListener('keyup',onKeyUp);
  canvas.addEventListener('blur',clearKeys);
  window.addEventListener('blur',clearKeys);
  resize();frame=requestAnimationFrame(draw);

  return {
    setState(nextPlayers,nextLocalId){
      players=Array.isArray(nextPlayers)?nextPlayers.filter(player=>Number.isFinite(player.x)&&Number.isFinite(player.z)):[];
      localId=nextLocalId;
      const active=new Set(players.map(player=>player.id));
      for(const id of positions.keys())if(!active.has(id))positions.delete(id);
    },
    setMutedIds(nextMutedIds){mutedIds=new Set(nextMutedIds);},
    setClues(ids){collectedClues=new Set(Array.isArray(ids)?ids:[]);},
    setParty(nextParty){
      party={active:nextParty?.active===true,endsAt:Number(nextParty?.endsAt)||0,startedBy:String(nextParty?.startedBy||'')};
    },
    resize,
    focusSelf(){canvas.focus({preventScroll:true});},
    getDebugState(){
      return{width,height,scale,origin:{...origin},localId,playerCount:players.length,worldToScreen,screenToWorld,
        players:players.map(player=>({id:player.id,...positions.get(player.id)})),
        clues:MYSTERY_SPOTS.map(spot=>({id:spot.id,...cluePoint(spot),collected:collectedClues.has(spot.id)})),
        party:{...party,active:partyActive()},
        seats:SEATS.map(seat=>({id:seat.id,...worldToScreen(seat.x,seat.z,0.58)}))};
    },
    destroy(){
      destroyed=true;cancelAnimationFrame(frame);observer.disconnect();
      canvas.removeEventListener('pointermove',onPointerMove);canvas.removeEventListener('pointerleave',clearHover);
      canvas.removeEventListener('pointerdown',onPointerDown);canvas.removeEventListener('pointerup',onPointerUp);
      canvas.removeEventListener('pointercancel',onPointerCancel);canvas.removeEventListener('keydown',onKeyDown);
      canvas.removeEventListener('keyup',onKeyUp);canvas.removeEventListener('blur',clearKeys);window.removeEventListener('blur',clearKeys);
      positions.clear();keys.clear();
    },
  };
}
