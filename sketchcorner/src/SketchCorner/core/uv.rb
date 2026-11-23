# frozen_string_literal: true
#
# .SketchCorner - UV mapping math.
#
# A face's texture placement is captured as an affine map
#     u(p) = u0 + gu . (p - o),  v(p) = v0 + gv . (p - o)
# (UVQ from SketchUp's UVHelper divided by q). New faces in the same plane
# reuse the map directly. Transition strips are "unrolled": the texture of
# the start face continues across the strip by arc length, the texture of the
# end face does the same from the other side, and the two are blended along
# the profile so the strip meets both neighbours without a seam.

require_relative 'vmath'

module SketchCorner
  module UV
    module_function

    # Build a map from three points and their [u, v] values.
    def map_from_samples(p0, p1, p2, uv0, uv1, uv2)
      e1 = VMath.sub(p1, p0)
      e2 = VMath.sub(p2, p0)
      n = VMath.cross(e1, e2)
      return nil if VMath.len(n) < 1.0e-12
      # Dual basis: g . e1 = du1, g . e2 = du2, g . n = 0
      g = lambda do |d1, d2|
        a = VMath.cross(e2, n)
        b = VMath.cross(n, e1)
        den = VMath.dot(e1, a)
        VMath.add(VMath.scale(a, d1 / den), VMath.scale(b, d2 / den))
      end
      {
        'o' => p0, 'u0' => uv0[0], 'v0' => uv0[1],
        'gu' => g.call(uv1[0] - uv0[0], uv2[0] - uv0[0]),
        'gv' => g.call(uv1[1] - uv0[1], uv2[1] - uv0[1])
      }
    end

    def apply(map, p)
      d = VMath.sub(p, map['o'])
      [map['u0'] + VMath.dot(map['gu'], d), map['v0'] + VMath.dot(map['gv'], d)]
    end

    # UVs for one strip row (profile points at one end of an edge).
    #   profile  - 3D points from the start face side to the end face side
    #   map1/2   - texture maps of the start/end faces (either may be nil)
    #   out1/2   - unit directions that continue each face across the fold
    #              (from the tangent point toward the original edge)
    def strip_row(profile, map1, map2, out1, out2)
      return nil if map1.nil? && map2.nil?
      arcs = [0.0]
      profile.each_cons(2) { |a, b| arcs << arcs.last + VMath.dist(a, b) }
      total = arcs.last
      profile.each_index.map do |i|
        s = total < 1.0e-12 ? 0.0 : arcs[i] / total
        uv1 = map1 && apply(map1, VMath.madd(profile.first, out1, arcs[i]))
        uv2 = map2 && apply(map2, VMath.madd(profile.last, out2, total - arcs[i]))
        if uv1 && uv2
          [uv1[0] + (uv2[0] - uv1[0]) * s, uv1[1] + (uv2[1] - uv1[1]) * s]
        else
          uv1 || uv2
        end
      end
    end
  end
end
