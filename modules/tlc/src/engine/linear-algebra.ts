/** Small dense linear algebra, ported from the tablet engine (engine/math). */
export const LinearAlgebra = {
  /** Solves A·x = b by Gaussian elimination with partial pivoting. Throws if A is singular. */
  solve(a: number[][], b: number[]): number[] {
    const n = b.length;
    if (a.length !== n || a.some((row) => row.length !== n)) throw new Error(`Matrix must be ${n}x${n}`);
    const m: number[][] = a.map((row, r) => [...row, b[r]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      if (Math.abs(m[pivot][col]) < 1e-12) throw new Error('Singular matrix');
      if (pivot !== col) {
        const t = m[pivot];
        m[pivot] = m[col];
        m[col] = t;
      }
      for (let r = col + 1; r < n; r++) {
        const factor = m[r][col] / m[col][col];
        if (factor === 0) continue;
        for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
      }
    }
    const x = new Array<number>(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = m[r][n];
      for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
      x[r] = s / m[r][r];
    }
    return x;
  },

  /** Least-squares fit of y ≈ Σ c_j·basis_j(x) via the normal equations. */
  leastSquares(rows: number[][], y: number[]): number[] {
    if (rows.length !== y.length || rows.length === 0) throw new Error('rows and y must match and be non-empty');
    const p = rows[0].length;
    const ata: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const aty = new Array<number>(p).fill(0);
    rows.forEach((row, i) => {
      for (let j = 0; j < p; j++) {
        aty[j] += row[j] * y[i];
        for (let k = 0; k < p; k++) ata[j][k] += row[j] * row[k];
      }
    });
    return LinearAlgebra.solve(ata, aty);
  },
};
