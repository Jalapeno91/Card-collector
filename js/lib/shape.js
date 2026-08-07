// Turns a card's stored `shape` (from an "Unusual shape" scan) into the CSS
// needed to render it: a clip-path tracing the true outline, and the aspect
// ratio that outline's box must be drawn at for the clip-path's percentages
// to land where they were traced, rather than stretched or squashed.

export function shapeStyle(shape){
  if (!shape || !Array.isArray(shape.points) || shape.points.length < 3) return null;
  const clipPath = 'polygon(' + shape.points
    .map(([x, y]) => `${(x*100).toFixed(2)}% ${(y*100).toFixed(2)}%`)
    .join(', ') + ')';
  return { clipPath, aspectRatio: String(shape.aspect || 1) };
}
