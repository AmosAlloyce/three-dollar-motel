export const WORLD = { width: 14, depth: 12, speed: 3.2 };
export const COLORS = ['#d87956', '#5b9c93', '#8b7aa8', '#cbac57', '#71925c', '#6b8db2'];
export const POOL = { x: 8.1, z: 4.0, w: 4.3, d: 5.1 };
export const SEATS = [
  { id: 'sofa-1', x: 2.0, z: 5.2, facing: 'right', label: 'Lounge sofa' },
  { id: 'sofa-2', x: 2.0, z: 6.2, facing: 'right', label: 'Lounge sofa' },
  { id: 'chair-1', x: 5.5, z: 5.2, facing: 'left', label: 'Lounge chair' },
  { id: 'chair-2', x: 5.5, z: 6.6, facing: 'left', label: 'Lounge chair' },
  { id: 'sunbed-1', x: 9.0, z: 10.5, facing: 'back', label: 'Pool lounger' },
  { id: 'sunbed-2', x: 11.0, z: 10.5, facing: 'back', label: 'Pool lounger' }
];
export const OBSTACLES = [
  { x: 1.0, z: 1.0, w: 3.8, d: 1.05, kind: 'desk' },
  { x: 3.25, z: 5.2, w: 1.25, d: 1.5, kind: 'table' },
  { x: 6.5, z: 1.2, w: 0.8, d: 0.8, kind: 'plant' },
  { x: 12.6, z: 1.4, w: 0.8, d: 0.8, kind: 'plant' }
];
export function inRect(x, z, rect, padding = 0) {
  return x >= rect.x - padding && x <= rect.x + rect.w + padding && z >= rect.z - padding && z <= rect.z + rect.d + padding;
}
export function isWalkable(x, z) {
  return Number.isFinite(x) && Number.isFinite(z) && x >= 0.4 && z >= 0.4 && x <= WORLD.width - 0.4 && z <= WORLD.depth - 0.4 && !OBSTACLES.some(rect => inRect(x, z, rect, 0.18));
}
export function inPool(x, z) { return inRect(x, z, POOL, -0.1); }
