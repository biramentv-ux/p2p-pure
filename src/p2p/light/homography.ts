/**
 * Planar homography helpers for the light/colour transfer (M14).
 *
 * A homography H (3×3, row-major, h[8] normalised to 1) maps (x, y) to
 * ((h0·x + h1·y + h2) / w, (h3·x + h4·y + h5) / w) with w = h6·x + h7·y + h8.
 * Pure functions, no dependencies.
 */

export type Point = readonly [number, number]

/**
 * Solve the homography that maps the four `src` points onto the four `dst` points
 * (direct linear transform, 8×8 Gaussian elimination with partial pivoting).
 * Returns `null` for degenerate configurations (three collinear points etc.).
 */
export function solveHomography(src: readonly Point[], dst: readonly Point[]): Float64Array | null {
  if (src.length !== 4 || dst.length !== 4) throw new RangeError('need exactly 4 point pairs')
  // Augmented 8×9 matrix.
  const m: number[][] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let col = 0; col < 8; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    if (Math.abs(m[piv][col]) < 1e-12) return null
    if (piv !== col) [m[piv], m[col]] = [m[col], m[piv]]
    const p = m[col][col]
    for (let c = col; c < 9; c++) m[col][c] /= p
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = m[r][col]
      if (f === 0) continue
      for (let c = col; c < 9; c++) m[r][c] -= f * m[col][c]
    }
  }
  const h = new Float64Array(9)
  for (let i = 0; i < 8; i++) h[i] = m[i][8]
  h[8] = 1
  for (let i = 0; i < 9; i++) if (!Number.isFinite(h[i])) return null
  return h
}

/** Apply `h` to (x, y). Returns [NaN, NaN] on the line at infinity. */
export function applyHomography(h: Float64Array, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8]
  if (Math.abs(w) < 1e-12) return [NaN, NaN]
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}
