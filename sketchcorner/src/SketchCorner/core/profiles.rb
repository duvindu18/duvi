# frozen_string_literal: true
#
# .SketchCorner - transition profiles.
#
# Every profile is expressed in "triangle coordinates" (a, b): a point is
#
#     X = apex + a * (start - apex) + b * (end - apex)
#
# so the start tangent point is (1, 0), the end tangent point is (0, 1) and
# the apex (where the two tangent lines meet, i.e. the original edge) is
# (0, 0). Because the map is affine, one unit profile serves both the
# perpendicular cross-section of an edge and its sheared end caps, and a
# circular arc stays exactly tangent to both faces after the projection.

require_relative 'vmath'

module SketchCorner
  module Profiles
    TYPES = %w[circular conic bevel cove custom].freeze
    BEVEL_MODES = %w[chamfer stepped facet].freeze

    module_function

    # Unit profile for one edge.
    #   type      - one of TYPES
    #   phi       - angle (radians) between the two faces' in-plane directions
    #   opts      - 'segments', 'rho', 'bevel_mode', 'steps', 'custom_profile'
    # Returns an array of [a, b] from [1, 0] to [0, 1].
    def unit(type, phi, opts)
      seg = [[opts['segments'].to_i, 1].max, 64].min
      pts =
        case type
        when 'circular' then circular(phi, seg)
        when 'conic'    then conic(conic_weight(opts['rho']), seg)
        when 'cove'     then circular(phi, seg).map { |a, b| [1.0 - b, 1.0 - a] }
        when 'custom'   then custom(opts['custom_profile'])
        when 'bevel'
          case opts['bevel_mode']
          when 'stepped' then stepped([[opts['steps'].to_i, 1].max, 32].min)
          when 'facet'   then circular(phi, seg)
          else [[1.0, 0.0], [0.0, 1.0]]
          end
        else
          raise ArgumentError, "Unknown profile type: #{type}"
        end
      pts.first.replace([1.0, 0.0])
      pts.last.replace([0.0, 1.0])
      pts
    end

    # True when interior profile edges should be softened/smoothed.
    def smooth?(type, opts)
      return false if type == 'bevel'
      return opts['custom_smooth'] != false if type == 'custom'
      true
    end

    # Map unit coordinates onto a concrete triangle.
    def place(unit_pts, start_pt, apex, end_pt)
      da = VMath.sub(start_pt, apex)
      db = VMath.sub(end_pt, apex)
      unit_pts.map { |a, b| VMath.add(apex, VMath.add(VMath.scale(da, a), VMath.scale(db, b))) }
    end

    # Circular arc tangent to both legs, sampled at equal angles. The apex
    # angle is (pi - phi) in the cross-section, so the arc sweeps phi... we
    # build it in a canonical unit circle and convert to (a, b).
    def circular(phi, seg)
      sweep = Math::PI - phi            # angle swept by the arc
      half = sweep / 2.0
      return [[1.0, 0.0], [0.0, 1.0]] if half < 1.0e-6
      c = Math.cos(half)
      s = Math.sin(half)
      p0 = [c, -s]
      p2 = [c, s]
      apex = [1.0 / c, 0.0]
      (0..seg).map do |i|
        ang = -half + sweep * i / seg.to_f
        x = [Math.cos(ang), Math.sin(ang)]
        bary(x, p0, apex, p2)
      end
    end

    # Rational quadratic conic with weight w, resampled to equal arc length.
    def conic(w, seg)
      dense = (0..(seg * 16)).map do |i|
        t = i / (seg * 16).to_f
        d = (1 - t)**2 + 2 * w * t * (1 - t) + t**2
        [(1 - t)**2 / d, t**2 / d]
      end
      resample(dense, seg)
    end

    # Conic shape factor rho (0..1): 0.5 = parabola, below = ellipse.
    def conic_weight(rho)
      r = rho.to_f
      r = 0.5 if r <= 0.0 || r >= 1.0
      r = [[r, 0.02].max, 0.98].min
      r / (1.0 - r)
    end

    # Equal steps between the two tangent points; outer corners sit on the
    # chamfer line, inner corners toward the apex.
    def stepped(n)
      pts = [[1.0, 0.0]]
      a = 1.0
      b = 0.0
      n.times do
        a -= 1.0 / n
        pts << [a, b]
        b += 1.0 / n
        pts << [a, b]
      end
      pts
    end

    def custom(profile)
      raise ArgumentError, 'No custom profile picked. Use Pick profile first.' if profile.nil? || profile.size < 2
      profile.map { |a, b| [a.to_f, b.to_f] }
    end

    # Normalise a user-drawn open polyline (3D points) into unit coordinates.
    # The first point maps to (1,0), the last to (0,1); the apex is placed on
    # the side of the chord the curve bulges toward (flip mirrors that).
    def normalize_custom(points3d, flip = false)
      raise ArgumentError, 'A profile needs at least 3 points.' if points3d.size < 3
      s = points3d.first
      e = points3d.last
      chord = VMath.sub(e, s)
      clen = VMath.len(chord)
      raise ArgumentError, 'The profile ends must not touch.' if clen < 1.0e-6
      normal = VMath.newell(points3d)
      raise ArgumentError, 'A straight line cannot be a profile.' if VMath.len(normal) < 1.0e-9
      perp = VMath.norm(VMath.cross(normal, chord))
      m = VMath.mid(s, e)
      side = VMath.dot(VMath.sub(VMath.centroid(points3d[1..-2]), m), perp)
      sign = side >= 0 ? 1.0 : -1.0
      sign = -sign if flip
      k = VMath.madd(m, perp, sign * clen / 2.0)
      x, y = VMath.plane_basis(normal)
      to2 = ->(p) { d = VMath.sub(p, k); [VMath.dot(d, x), VMath.dot(d, y)] }
      sa = to2.call(s)
      eb = to2.call(e)
      den = sa[0] * eb[1] - sa[1] * eb[0]
      points3d.map do |p|
        q = to2.call(p)
        [(q[0] * eb[1] - q[1] * eb[0]) / den, (sa[0] * q[1] - sa[1] * q[0]) / den]
      end
    end

    # Resample a polyline (2D) to n equal-length segments.
    def resample(pts, n)
      lens = [0.0]
      pts.each_cons(2) { |p, q| lens << lens.last + Math.hypot(q[0] - p[0], q[1] - p[1]) }
      total = lens.last
      return pts if total < 1.0e-12
      j = 0
      (0..n).map do |i|
        target = total * i / n.to_f
        j += 1 while j < lens.size - 2 && lens[j + 1] < target
        span = lens[j + 1] - lens[j]
        t = span < 1.0e-12 ? 0.0 : (target - lens[j]) / span
        p = pts[j]
        q = pts[j + 1]
        [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      end
    end

    # Coordinates (a, b) of 2D point x in the triangle frame apex/p0/p2.
    def bary(x, p0, apex, p2)
      da = [p0[0] - apex[0], p0[1] - apex[1]]
      db = [p2[0] - apex[0], p2[1] - apex[1]]
      d = [x[0] - apex[0], x[1] - apex[1]]
      den = da[0] * db[1] - da[1] * db[0]
      [(d[0] * db[1] - d[1] * db[0]) / den, (da[0] * d[1] - da[1] * d[0]) / den]
    end

    # Centre of the circle tangent to apex->p0 at p0 and apex->p2 at p2
    # (least-squares when the legs differ in length). nil if degenerate.
    def arc_center(p0, apex, p2)
      n = VMath.cross(VMath.sub(p0, apex), VMath.sub(p2, apex))
      return nil if VMath.len(n) < 1.0e-12
      u0 = VMath.cross(n, VMath.sub(p0, apex))
      u2 = VMath.cross(n, VMath.sub(p2, apex))
      VMath.line_line_mid(p0, u0, p2, u2)
    end
  end
end
