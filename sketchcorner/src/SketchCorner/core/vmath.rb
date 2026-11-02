# frozen_string_literal: true
#
# .SketchCorner - pure-Ruby vector math.
#
# Every geometric routine in the engine works on plain [x, y, z] arrays so the
# whole solver can run (and be unit-tested) outside SketchUp. Lengths are in
# SketchUp internal units (inches).

module SketchCorner
  module VMath
    EPS = 1.0e-9
    # Distance under which two points are the same vertex. SketchUp merges
    # vertices closer than 0.001", so we stay well below that.
    POINT_TOL = 1.0e-4

    module_function

    def add(a, b)   [a[0] + b[0], a[1] + b[1], a[2] + b[2]] end
    def sub(a, b)   [a[0] - b[0], a[1] - b[1], a[2] - b[2]] end
    def scale(a, s) [a[0] * s, a[1] * s, a[2] * s] end
    def neg(a)      [-a[0], -a[1], -a[2]] end
    def dot(a, b)   a[0] * b[0] + a[1] * b[1] + a[2] * b[2] end

    def cross(a, b)
      [a[1] * b[2] - a[2] * b[1],
       a[2] * b[0] - a[0] * b[2],
       a[0] * b[1] - a[1] * b[0]]
    end

    def len(a)  Math.sqrt(dot(a, a)) end
    def dist(a, b) len(sub(a, b)) end

    def norm(a)
      l = len(a)
      l < EPS ? [0.0, 0.0, 0.0] : scale(a, 1.0 / l)
    end

    def lerp(a, b, t) [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] end
    def mid(a, b) lerp(a, b, 0.5) end

    # a + b*s (the most common combination in the solver).
    def madd(a, b, s) [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s] end

    def same?(a, b, tol = POINT_TOL)
      (a[0] - b[0]).abs <= tol && (a[1] - b[1]).abs <= tol && (a[2] - b[2]).abs <= tol &&
        dist(a, b) <= tol
    end

    def zero?(a, tol = EPS) len(a) <= tol end

    # Unsigned angle between two vectors, radians.
    def angle(a, b)
      la = len(a)
      lb = len(b)
      return 0.0 if la < EPS || lb < EPS
      c = dot(a, b) / (la * lb)
      Math.acos([[c, -1.0].max, 1.0].min)
    end

    def centroid(points)
      s = [0.0, 0.0, 0.0]
      points.each { |p| s = add(s, p) }
      scale(s, 1.0 / [points.size, 1].max)
    end

    # Newell normal of a (possibly non-planar) polygon; length = 2 * area.
    def newell(points)
      n = [0.0, 0.0, 0.0]
      count = points.size
      count.times do |i|
        a = points[i]
        b = points[(i + 1) % count]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
      end
      n
    end

    def polygon_area(points) len(newell(points)) * 0.5 end

    # Maximum distance of any point from the best-fit (Newell) plane.
    def planarity_error(points)
      n = norm(newell(points))
      return 0.0 if zero?(n)
      c = centroid(points)
      points.map { |p| dot(sub(p, c), n).abs }.max || 0.0
    end

    def planar?(points, tol = 1.0e-3)
      points.size <= 3 || planarity_error(points) <= tol
    end

    # Orthonormal in-plane basis [x_axis, y_axis] for a plane normal.
    def plane_basis(normal)
      n = norm(normal)
      helper = n[0].abs < 0.9 ? [1.0, 0.0, 0.0] : [0.0, 1.0, 0.0]
      x = norm(cross(helper, n))
      y = cross(n, x)
      [x, y]
    end

    def to_2d(points, normal, origin = nil)
      x, y = plane_basis(normal)
      o = origin || points.first
      points.map { |p| d = sub(p, o); [dot(d, x), dot(d, y)] }
    end

    def area_2d(pts)
      s = 0.0
      pts.each_with_index do |a, i|
        b = pts[(i + 1) % pts.size]
        s += a[0] * b[1] - b[0] * a[1]
      end
      s * 0.5
    end

    def cross_2d(o, a, b) (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]) end

    # Proper (interior) segment intersection in 2D; shared endpoints do not count.
    def segments_cross_2d?(p1, p2, q1, q2, eps = 1.0e-9)
      d1 = cross_2d(q1, q2, p1)
      d2 = cross_2d(q1, q2, p2)
      d3 = cross_2d(p1, p2, q1)
      d4 = cross_2d(p1, p2, q2)
      ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
        ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
    end

    # True when a closed 2D polyline has no crossing edges.
    def simple_polygon_2d?(pts)
      n = pts.size
      return false if n < 3
      n.times do |i|
        a1 = pts[i]
        a2 = pts[(i + 1) % n]
        ((i + 2)...n).each do |j|
          next if i.zero? && j == n - 1
          return false if segments_cross_2d?(a1, a2, pts[j], pts[(j + 1) % n])
        end
      end
      true
    end

    def point_in_polygon_2d?(pt, poly)
      inside = false
      j = poly.size - 1
      poly.each_with_index do |pi, i|
        pj = poly[j]
        if ((pi[1] > pt[1]) != (pj[1] > pt[1])) &&
           (pt[0] < (pj[0] - pi[0]) * (pt[1] - pi[1]) / ((pj[1] - pi[1]).nonzero? || EPS) + pi[0])
          inside = !inside
        end
        j = i
      end
      inside
    end

    # Closest points between lines p + s*u and q + t*v. Returns midpoint or nil
    # when the lines are parallel.
    def line_line_mid(p, u, q, v)
      w0 = sub(p, q)
      a = dot(u, u)
      b = dot(u, v)
      c = dot(v, v)
      d = dot(u, w0)
      e = dot(v, w0)
      den = a * c - b * b
      return nil if den.abs < 1.0e-12
      s = (b * e - c * d) / den
      t = (a * e - b * d) / den
      mid(madd(p, u, s), madd(q, v, t))
    end

    # Solve a 3x3 system m * x = r (Cramer). Returns nil if singular.
    def solve3(m, r)
      det = det3(m)
      return nil if det.abs < 1.0e-12
      (0..2).map do |col|
        mm = m.map(&:dup)
        3.times { |row| mm[row][col] = r[row] }
        det3(mm) / det
      end
    end

    def det3(m)
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    end

    # Ear-clipping triangulation of a simple polygon (3D points, any plane).
    # Returns index triples into +points+, wound like the input.
    def triangulate(points)
      n = points.size
      return [] if n < 3
      return [[0, 1, 2]] if n == 3
      normal = newell(points)
      pts = to_2d(points, normal)
      idx = (0...n).to_a
      idx.reverse! if area_2d(pts) < 0
      tris = []
      guard = 0
      while idx.size > 3 && guard < n * n
        guard += 1
        ear = nil
        idx.each_with_index do |cur, k|
          prv = idx[k - 1]
          nxt = idx[(k + 1) % idx.size]
          next if cross_2d(pts[prv], pts[cur], pts[nxt]) <= 1.0e-12
          blocked = idx.any? do |o|
            next false if o == prv || o == cur || o == nxt
            in_triangle_2d?(pts[o], pts[prv], pts[cur], pts[nxt])
          end
          next if blocked
          ear = k
          break
        end
        ear ||= 0 # degenerate input: clip anyway rather than loop forever
        k = ear
        tris << [idx[k - 1], idx[k], idx[(k + 1) % idx.size]]
        idx.delete_at(k)
      end
      tris << idx if idx.size == 3
      # Restore the caller's winding if we flipped for the 2D pass.
      area_2d(pts) < 0 ? tris.map(&:reverse) : tris
    end

    def in_triangle_2d?(p, a, b, c)
      d1 = cross_2d(a, b, p)
      d2 = cross_2d(b, c, p)
      d3 = cross_2d(c, a, p)
      d1 >= -1.0e-12 && d2 >= -1.0e-12 && d3 >= -1.0e-12
    end
  end
end
