# frozen_string_literal: true
#
# .SketchCorner - core geometric engine (pure Ruby, no SketchUp API).
#
# Input : a Mesh holding every face that touches a vertex of a selected edge,
#         the selected edges (as point-index pairs) and a parameter Hash.
# Output: a Result with replacement polygons for those faces, the new
#         transition strips and corner patches, edge soft/smooth states, UVs
#         and collision data for the live preview.
#
# Algorithm outline
#   1. Edge frames  - for every selected edge e(a,b): its two faces F1 (loop
#      runs a->b) and F2, the in-face directions m1/m2 pointing away from e,
#      and phi = angle(m1, m2). Offset t = R / tan(phi/2) puts the tangent
#      line of an arc of radius R on each face.
#   2. Corners      - every face corner at a touched vertex moves to the
#      intersection of its offset lines ("offset meet"): both edges beveled ->
#      intersection of both offset lines; one edge beveled -> slide along the
#      other edge.
#   3. End profiles - at each end of e the profile runs from F1's corner point
#      to F2's corner point with its apex on the edge line, so the same unit
#      profile describes the cross-section and the sheared end caps exactly.
#   4. Junctions    - walk the fan of faces around each vertex and build the
#      boundary ring. One bevel: the cap absorbs the profile. Two matching
#      bevels: the profiles coincide and form a sharp miter. Otherwise the
#      ring is closed with a patch (smooth sphere patch, sharp facets or a
#      blended loop).
#   5. Clamping     - offsets that would push a corner past the next vertex or
#      fold a face are scaled back per edge; remaining failures fall back to a
#      global bisection.

require_relative 'vmath'
require_relative 'mesh'
require_relative 'profiles'
require_relative 'uv'

module SketchCorner
  class Engine
    DEFAULTS = {
      'profile' => 'circular',      # circular | conic | bevel | cove | custom
      'bevel_mode' => 'chamfer',    # chamfer | stepped | facet
      'segments' => 6,
      'steps' => 3,
      'radius' => 0.19685,          # inches (5 mm)
      'radius_end' => 0.19685,
      'variable' => false,
      'interp' => 'linear',         # linear | cubic
      'ratio' => 1.0,               # conic: offset on F2 / offset on F1
      'rho' => 0.4142,              # conic shape (0.5 parabola, ~0.414 circle at 90 deg)
      'measure' => 'radius',        # radius | setback
      'miter' => 'smooth',          # smooth | sharp | blend
      'custom_profile' => nil,
      'custom_smooth' => true,
      'material_mode' => 'inherit', # inherit | assign
      'material' => nil,
      'tag' => nil,
      'uv' => true,
      'soften_boundary' => false,
      'clamp' => true,
      'reverse' => false
    }.freeze

    MITERS = %w[smooth sharp blend].freeze
    MIN_PHI = 1.0 * Math::PI / 180
    MAX_PHI = 179.0 * Math::PI / 180

    class Result
      attr_accessor :ok, :fatal, :points, :point_meta, :polygons, :edge_flags,
                    :collisions, :rejected, :warnings, :scales, :stats, :params

      def initialize
        @ok = false
        @fatal = nil
        @points = []
        @point_meta = []
        @polygons = []
        @edge_flags = {}
        @collisions = {}
        @rejected = {}
        @warnings = []
        @scales = {}
        @stats = {}
      end

      # Each polygon edge once, as [p, q, flags].
      def each_edge
        @edge_flags.each { |(a, b), fl| yield @points[a], @points[b], fl }
      end
    end

    class Failure < StandardError
      attr_reader :edges
      def initialize(msg, edges = [])
        super(msg)
        @edges = edges
      end
    end

    def self.normalize_params(params)
      p = DEFAULTS.merge((params || {}).each_with_object({}) { |(k, v), h| h[k.to_s] = v })
      p['segments'] = [[p['segments'].to_i, 1].max, 64].min
      p['steps'] = [[p['steps'].to_i, 1].max, 32].min
      p['radius'] = p['radius'].to_f.abs
      p['radius_end'] = p['variable'] ? p['radius_end'].to_f.abs : p['radius']
      p['ratio'] = [[p['ratio'].to_f, 0.05].max, 20.0].min
      p['ratio'] = 1.0 unless p['profile'] == 'conic'
      p['miter'] = 'smooth' unless MITERS.include?(p['miter'])
      raise ArgumentError, "Unknown profile '#{p['profile']}'" unless Profiles::TYPES.include?(p['profile'])
      p
    end

    def self.run(mesh, edge_keys, params)
      new(mesh, edge_keys, params).run
    end

    def initialize(mesh, edge_keys, params)
      @mesh = mesh
      @params = Engine.normalize_params(params)
      @requested = edge_keys.map { |a, b| Mesh.edge_key(a, b) }.uniq
    end

    def run
      res = Result.new
      res.params = @params
      validate_edges(res)
      if @edges.empty?
        res.fatal = res.rejected.empty? ? 'Select at least one edge.' : res.rejected.values.first
        return res
      end
      build_chains
      @scales = Hash.new(1.0)
      clamp_iteratively(res)
      out = attempt(@scales)
      if out.is_a?(Failure) && @params['clamp']
        out = bisect_global(res)
      end
      if out.is_a?(Failure)
        res.fatal = out.message
        out.edges.each { |k| res.collisions[k] ||= 0.0 }
        return res
      end
      fill_result(res, out)
      res.ok = res.collisions.empty? || @params['clamp']
      res.fatal = 'Radius is too large for the selected geometry. Turn on Clamp radius or reduce it.' unless res.ok
      res
    rescue Failure => e
      res.fatal = e.message
      e.edges.each { |k| res.collisions[k] ||= 0.0 }
      res
    rescue ArgumentError => e
      res.fatal = e.message
      res
    end

    private

    P = VMath

    # ------------------------------------------------------------------ edges

    def validate_edges(res)
      @edges = {}
      @requested.each do |key|
        unless @mesh.edge?(key)
          res.rejected[key] = 'The edge is not part of a face.'
          next
        end
        unless @mesh.manifold_edge?(key)
          uses = @mesh.edge_uses[key]
          res.rejected[key] =
            if uses.size == 1 then 'An edge on an open border cannot be rounded.'
            elsif uses.size > 2 then 'The edge is shared by more than two faces.'
            else 'The faces on this edge point opposite ways. Use Orient Faces first.'
            end
          next
        end
        frame = edge_frame(key)
        if frame[:phi] > MAX_PHI
          res.rejected[key] = 'The faces on this edge are coplanar.'
        elsif frame[:phi] < MIN_PHI
          res.rejected[key] = 'The faces on this edge fold back on each other.'
        else
          @edges[key] = frame
        end
      end
      @vertex_k = Hash.new(0)
      @edges.each_key { |a, b| @vertex_k[a] += 1; @vertex_k[b] += 1 }
    end

    def edge_frame(key)
      a, b = key
      uses = @mesh.edge_uses[key]
      c1 = uses.find { |_c, d| d == 1 }[0]
      c2 = uses.find { |_c, d| d == -1 }[0]
      f1 = c1.face
      f2 = c2.face
      u = P.norm(P.sub(pt(b), pt(a)))
      n1 = P.norm(@mesh.faces[f1].normal)
      n2 = P.norm(@mesh.faces[f2].normal)
      m1 = P.norm(P.cross(n1, u))
      m2 = P.norm(P.cross(n2, P.neg(u)))
      { a: a, b: b, f1: f1, f2: f2, u: u, m1: m1, m2: m2, len: P.dist(pt(a), pt(b)),
        phi: P.angle(m1, m2), convex: P.dot(n2, m1) < 0 }
    end

    def pt(i) @mesh.points[i] end
    def beveled?(key) @edges.key?(key) end

    # ----------------------------------------------------------------- chains

    # Groups selected edges into paths/loops (vertices with exactly two
    # selected edges link them) and records the arc-length parameter of every
    # edge end for variable radius.
    def build_chains
      adj = Hash.new { |h, k| h[k] = [] }
      @edges.each_key { |k| adj[k[0]] << k; adj[k[1]] << k }
      seen = {}
      @chains = []
      order = @requested.select { |k| @edges.key?(k) }
      order.each do |seed|
        next if seen[seed]
        # walk back to an end (or around a loop) first
        start_v = seed[0]
        cur = seed
        guard = 0
        loop do
          nxt = link(adj, start_v, cur)
          break if nxt.nil? || nxt == seed || guard > @edges.size
          start_v = other(nxt, start_v)
          cur = nxt
          guard += 1
        end
        closed = link(adj, start_v, cur) == seed && guard <= @edges.size && guard.positive?
        # now walk forward from cur away from start_v
        verts = [start_v]
        keys = []
        e = cur
        v = start_v
        while e && !seen[e]
          seen[e] = true
          keys << e
          v = other(e, v)
          verts << v
          e = link(adj, v, e)
        end
        closed ||= verts.size > 2 && verts.first == verts.last
        if @params['reverse']
          keys.reverse!
          verts.reverse!
        end
        @chains << { keys: keys, verts: verts, closed: closed }
      end
      @param_at = {}
      @chains.each do |ch|
        total = ch[:keys].sum { |k| @edges[k][:len] }
        acc = 0.0
        ch[:keys].each_with_index do |k, i|
          v0 = ch[:verts][i]
          v1 = ch[:verts][i + 1]
          s0 = total.positive? ? acc / total : 0.0
          acc += @edges[k][:len]
          s1 = total.positive? ? acc / total : 1.0
          if ch[:closed]
            s0 = 1.0 - (2.0 * s0 - 1.0).abs
            s1 = 1.0 - (2.0 * s1 - 1.0).abs
          end
          @param_at[[k, v0]] = s0
          @param_at[[k, v1]] = s1
        end
      end
    end

    def link(adj, v, from)
      cands = adj[v] - [from]
      adj[v].size == 2 && cands.size == 1 ? cands.first : nil
    end

    def other(key, v) key[0] == v ? key[1] : key[0] end

    # --------------------------------------------------------------- offsets

    def radius_at(key, v)
      r1 = @params['radius']
      return r1 unless @params['variable']
      s = @param_at[[key, v]] || 0.0
      s = s * s * (3.0 - 2.0 * s) if @params['interp'] == 'cubic'
      r1 + (@params['radius_end'] - r1) * s
    end

    def offset(key, v, face, scales)
      e = @edges[key]
      r = radius_at(key, v)
      t = @params['measure'] == 'setback' ? r : r / Math.tan(e[:phi] / 2.0)
      t *= @params['ratio'] if face == e[:f2]
      t * scales[key]
    end

    # ---------------------------------------------------------------- corners

    # Computes the moved point for every affected face corner.
    # Returns { corner => { x: offset vector, slide: [edge, dist, len] } }.
    def solve_corners(scales)
      out = {}
      errors = []
      @vertex_k.each_key do |v|
        @mesh.vertex_corners(v).each do |c|
          prev = @mesh.corner_prev(c)
          nxt = @mesh.corner_next(c)
          kin = Mesh.edge_key(prev, v)
          kout = Mesh.edge_key(v, nxt)
          bi = beveled?(kin)
          bo = beveled?(kout)
          next unless bi || bo
          n = P.norm(@mesh.faces[c.face].normal)
          u_in = P.norm(P.sub(pt(v), pt(prev)))
          u_out = P.norm(P.sub(pt(nxt), pt(v)))
          m_in = P.norm(P.cross(n, u_in))
          m_out = P.norm(P.cross(n, u_out))
          rec = {}
          if bi && bo
            ti = offset(kin, v, c.face, scales)
            to = offset(kout, v, c.face, scales)
            cc = P.dot(m_in, m_out)
            if 1.0 - cc < 1.0e-9
              rec[:x] = P.scale(m_in, (ti + to) / 2.0)
            elsif 1.0 + cc < 1.0e-6
              errors << [kin, kout]
              next
            else
              aa = (ti - cc * to) / (1.0 - cc * cc)
              bb = (to - cc * ti) / (1.0 - cc * cc)
              rec[:x] = P.add(P.scale(m_in, aa), P.scale(m_out, bb))
            end
          else
            key, dir, m, along = bi ? [kin, u_out, m_in, kout] : [kout, P.neg(u_in), m_out, kin]
            t = offset(key, v, c.face, scales)
            den = P.dot(dir, m)
            if den > 1.0e-6
              d = t / den
              rec[:x] = P.scale(dir, d)
              rec[:slide] = [along, d, P.dist(pt(along[0]), pt(along[1])), key]
            elsif den.abs <= 1.0e-6
              rec[:x] = P.scale(m, t)
            else
              # reflex face corner: the offset line runs away from the next
              # edge. Supported only when that edge is selected as well.
              errors << [key]
              next
            end
          end
          out[c] = rec
        end
      end
      [out, errors]
    end

    # Per-edge clamp: shrink offsets that make a corner slide past the middle
    # of the next edge or make the strip on an edge collapse.
    def clamp_iteratively(res)
      6.times do
        corners, errors = solve_corners(@scales)
        break unless errors.empty? # reflex corners are reported by attempt()
        ratios = Hash.new(1.0)
        corners.each_value do |rec|
          next unless rec[:slide]
          along, d, len, key = rec[:slide]
          far = @vertex_k[along[0]].positive? && @vertex_k[along[1]].positive?
          lim = len * (far ? 0.49 : 0.95)
          ratios[key] = [ratios[key], lim / d].min if d > lim
        end
        @edges.each do |key, e|
          [e[:f1], e[:f2]].each do |f|
            ca = corner_of(f, e[:a], e[:b])
            cb = corner_of(f, e[:b], e[:a])
            next unless ca && cb && corners[ca] && corners[cb]
            pa = P.dot(corners[ca][:x], e[:u])
            pb = -P.dot(corners[cb][:x], e[:u])
            span = pa + pb
            lim = e[:len] * 0.95
            ratios[key] = [ratios[key], lim / span].min if span > lim
          end
        end
        break if ratios.empty? || ratios.values.all? { |r| r >= 0.999 }
        unless @params['clamp']
          # report the largest radius that would fit, keep the requested one
          ratios.each { |k, r| res.collisions[k] = @params['radius'] * r if r < 0.999 }
          break
        end
        ratios.each { |k, r| @scales[k] *= [r * 0.995, 0.0].max if r < 0.999 }
      end
    end

    def bisect_global(res)
      lo = 0.0
      hi = 1.0
      best = nil
      12.times do
        mid = (lo + hi) / 2.0
        sc = Hash.new(1.0)
        @edges.each_key { |k| sc[k] = @scales[k] * mid }
        out = attempt(sc)
        if out.is_a?(Failure)
          hi = mid
        else
          lo = mid
          best = [out, sc]
        end
      end
      return Failure.new('The radius cannot fit this geometry.', @edges.keys) unless best
      @scales = best[1]
      @edges.each_key { |k| res.collisions[k] = 0.0 }
      best[0]
    end

    # Corner of face f at vertex v whose loop neighbour (either side) is w.
    def corner_of(f, v, w)
      @mesh.vertex_corners(v).find do |c|
        c.face == f && (@mesh.corner_next(c) == w || @mesh.corner_prev(c) == w)
      end
    end

    # ------------------------------------------------------ registry helpers

    def reset_registry
      @pts = []
      @meta = []
      @grid = {}
      @vid = {}
    end

    def reg(p, meta = {})
      cell = p.map { |c| (c / 1.0e-3).floor }
      (-1..1).each do |dx|
        (-1..1).each do |dy|
          (-1..1).each do |dz|
            (@grid[[cell[0] + dx, cell[1] + dy, cell[2] + dz]] || []).each do |i|
              if P.same?(@pts[i], p)
                @meta[i] = meta.merge(@meta[i]) unless meta.empty?
                return i
              end
            end
          end
        end
      end
      @pts << p
      @meta << meta
      (@grid[cell] ||= []) << (@pts.size - 1)
      @pts.size - 1
    end

    def vid(v) @vid[v] ||= reg(pt(v), v: v) end

    # --------------------------------------------------------------- attempt

    # Build every output polygon for the given scales. Returns a Hash or a
    # Failure describing which edges collide.
    def attempt(scales)
      reset_registry
      corners, errors = solve_corners(scales)
      unless errors.empty?
        return Failure.new('An inside corner meets a selected edge. Select the inside-corner edge as well.',
                           errors.flatten(1).uniq)
      end
      @corner_id = {}
      @vertex_k.each_key { |v| vid(v) }
      corners.each do |c, rec|
        v = @mesh.corner_vertex(c)
        meta = rec[:slide] ? { e: rec[:slide][0] } : {}
        @corner_id[c] = reg(P.add(pt(v), rec[:x]), meta)
      end
      build_end_profiles
      @replace = {}
      @polys = []
      @diagonals = {}
      @vertex_k.each_key { |v| build_junction(v) }
      build_strips
      build_faces
      problem = validate_faces
      return problem if problem
      { points: @pts, meta: @meta, polygons: @polys }
    rescue Failure => e
      e
    end

    def build_end_profiles
      @end_prof = {}
      @apex = {}
      @unit = {}
      @edges.each do |key, e|
        unit = (@unit[key] ||= Profiles.unit(@params['profile'], e[:phi], @params))
        [[e[:a], e[:b]], [e[:b], e[:a]]].each do |v, w|
          c1 = corner_of(e[:f1], v, w)
          c2 = corner_of(e[:f2], v, w)
          raise Failure.new('Edge corner not found.', [key]) unless c1 && c2 && @corner_id[c1] && @corner_id[c2]
          i1 = @corner_id[c1]
          i2 = @corner_id[c2]
          p1 = @pts[i1]
          p2 = @pts[i2]
          dir = P.norm(P.sub(pt(w), pt(v)))
          a1 = P.dot(P.sub(p1, pt(v)), dir)
          a2 = P.dot(P.sub(p2, pt(v)), dir)
          tol = 1.0e-6 + 1.0e-3 * [P.dist(p1, pt(v)), P.dist(p2, pt(v))].max
          apex = (a1 - a2).abs < tol ? P.madd(pt(v), dir, (a1 + a2) / 2.0) : pt(v)
          placed = Profiles.place(unit, p1, apex, p2)
          ids = [i1] + placed[1..-2].map { |q| reg(q) } + [i2]
          @end_prof[[key, v]] = ids
          @apex[[key, v]] = apex
        end
      end
      unify_profiles
    end

    # Two beveled edges whose end profiles share both end points (a sharp
    # miter or a tangent continuation) must use one identical profile.
    def unify_profiles
      @vertex_k.each_key do |v|
        keys = @edges.keys.select { |k| k.include?(v) }
        keys.combination(2).each do |ka, kb|
          pa = @end_prof[[ka, v]]
          pb = @end_prof[[kb, v]]
          next unless pa.size == pb.size
          if pa.first == pb.last && pa.last == pb.first
            pb = pb.reverse
            rev = true
          elsif !(pa.first == pb.first && pa.last == pb.last)
            next
          end
          merged = [pa.first] + (1...(pa.size - 1)).map { |i| reg(P.mid(@pts[pa[i]], @pts[pb[i]])) } + [pa.last]
          @end_prof[[ka, v]] = merged
          @end_prof[[kb, v]] = rev ? merged.reverse : merged
        end
      end
    end

    # ------------------------------------------------------------ junctions

    def build_junction(v)
      fan = @mesh.fan(v)
      raise Failure.new('A vertex of the selection is non-manifold.', @edges.keys.select { |k| k.include?(v) }) unless fan
      corners, closed = fan
      n = corners.size
      outk = corners.map { |c| Mesh.edge_key(v, @mesh.corner_next(c)) }
      ink = corners.map { |c| Mesh.edge_key(@mesh.corner_prev(c), v) }
      lists = corners.map { |c| @corner_id[c] ? [@corner_id[c]] : nil }
      had = lists.map { |l| !l.nil? }
      k = @vertex_k[v]

      # runs of faces without a beveled edge at v
      runs = []
      if closed
        s = had.index(true)
        cur = []
        n.times do |j|
          i = (s + 1 + j) % n
          if had[i]
            runs << cur unless cur.empty?
            cur = []
          else
            cur << i
          end
        end
        runs << cur unless cur.empty?
      else
        cur = []
        n.times do |i|
          if had[i]
            runs << cur unless cur.empty?
            cur = []
          else
            cur << i
          end
        end
        runs << cur unless cur.empty?
      end

      runs.each do |run|
        if !closed && (run.first.zero? || run.last == n - 1)
          run.each { |i| lists[i] = [vid(v)] }
          next
        end
        lp = lists[(run.first - 1) % n].last
        fq = lists[(run.last + 1) % n].first
        m = run.size
        if k == 1 && closed
          key = @edges.keys.find { |kk| kk.include?(v) }
          prof = @end_prof[[key, v]]
          bridge = prof.first == lp ? prof : prof.reverse
          bridge = [lp, fq] unless bridge.first == lp && bridge.last == fq
          if m == 1
            lists[run.first] = bridge
          else
            cuts = [0]
            run[0...-1].each_with_index do |fi, j|
              e = outk[fi]
              dir = P.norm(P.sub(pt(other(e, v)), pt(v)))
              lo = cuts.last + 1
              hi = bridge.size - 1 - (m - 1 - j)
              hi = lo if hi < lo
              best = (lo..hi).max_by { |idx| P.dot(P.norm(P.sub(@pts[bridge[idx]], pt(v))), dir) }
              cuts << [best, bridge.size - 1].min
              @meta[bridge[cuts.last]] = { e: e }
            end
            cuts << bridge.size - 1
            run.each_with_index { |fi, j| lists[fi] = bridge[cuts[j]..cuts[j + 1]] }
          end
        else
          dl = P.dist(@pts[lp], pt(v))
          dq = P.dist(@pts[fq], pt(v))
          prevp = lp
          run.each_with_index do |fi, j|
            if j == m - 1
              lists[fi] = [prevp, fq]
            else
              e = outk[fi]
              w = other(e, v)
              d = [dl + (dq - dl) * (j + 1) / m.to_f, 0.9 * P.dist(pt(w), pt(v))].min
              b = reg(P.madd(pt(v), P.norm(P.sub(pt(w), pt(v))), d), e: e)
              lists[fi] = [prevp, b]
              prevp = b
            end
          end
        end
      end

      # unbeveled edge with two different slide points: the farther point is
      # shared by both faces so the edge stays manifold
      (closed ? (0...n) : (1...n)).each do |j|
        next if beveled?(ink[j])
        i = (j - 1) % n
        next unless had[i] && had[j]
        a = lists[i].last
        b = lists[j].first
        next if a == b
        if P.dist(@pts[a], pt(v)) > P.dist(@pts[b], pt(v))
          lists[j].unshift(a)
        else
          lists[i].push(b)
        end
      end

      corners.each_with_index { |c, i| @replace[c] = lists[i] }
      build_patch(v, lists, outk, n) if closed && k >= 2
    end

    def build_patch(v, lists, outk, n)
      ring = []
      n.times do |i|
        ring.concat(lists[i])
        e = outk[i]
        next unless beveled?(e)
        prof = @end_prof[[e, v]]
        last = lists[i].last
        if prof.first == last
          ring.concat(prof[1..-2])
        elsif prof.last == last
          ring.concat(prof.reverse[1..-2])
        else
          ring.concat(prof)
        end
      end
      ring = clean_ring(ring)
      return if ring.size < 3
      pts = ring.map { |i| @pts[i] }
      return if P.polygon_area(pts) < 1.0e-8

      rr = ring.reverse
      mode = @params['miter']
      gid = [:patch, v]
      if mode == 'sharp'
        if P.planar?(rr.map { |i| @pts[i] })
          add_poly(:patch, gid, [rr])
        else
          c = reg(P.centroid(rr.map { |i| @pts[i] }))
          rr.each_index { |i| add_poly(:patch, gid, [[rr[i], rr[(i + 1) % rr.size], c]]) }
        end
        return
      end

      sphere = patch_sphere(v, rr)
      cen = P.centroid(rr.map { |i| @pts[i] })
      levels = mode == 'blend' ? 2 : [[@params['segments'] / 2, 1].max, 8].min
      proj = lambda do |p, i, f|
        next p unless sphere
        o, radii, rbar = sphere
        d = P.sub(p, o)
        next p if P.len(d) < 1.0e-9
        r = i ? radii[i] * (1 - f) + rbar * f : rbar
        P.madd(o, P.norm(d), r)
      end
      rings = [rr]
      (1...levels).each do |l|
        f = l / levels.to_f
        rings << rr.each_with_index.map { |id, i| reg(proj.call(P.lerp(@pts[id], cen, f), i, f)) }
      end
      inner = rings.last
      center_id = reg(proj.call(cen, nil, 1.0))
      rings.each_cons(2) do |outer, inn|
        outer.size.times do |i|
          j = (i + 1) % outer.size
          add_poly(:patch, gid, [[outer[i], outer[j], inn[j]]])
          add_poly(:patch, gid, [[outer[i], inn[j], inn[i]]])
        end
      end
      if mode == 'blend' && P.planar?(inner.map { |i| @pts[i] }, 1.0e-3) && rings.size > 1
        add_poly(:patch, gid, [inner])
      else
        inner.size.times { |i| add_poly(:patch, gid, [[inner[i], inner[(i + 1) % inner.size], center_id]]) }
      end
    end

    # Sphere through the corner: average of the end-profile arc centres.
    def patch_sphere(v, rr)
      return nil unless %w[circular conic cove].include?(@params['profile']) ||
                        (@params['profile'] == 'bevel' && @params['bevel_mode'] == 'facet')
      centers = @edges.keys.select { |k| k.include?(v) }.map do |k|
        ids = @end_prof[[k, v]]
        Profiles.arc_center(@pts[ids.first], @apex[[k, v]], @pts[ids.last])
      end.compact
      return nil if centers.empty?
      o = P.centroid(centers)
      radii = rr.map { |i| P.dist(@pts[i], o) }
      return nil if radii.min < 1.0e-6
      [o, radii, radii.sum / radii.size]
    end

    def clean_ring(ring)
      r = ring.dup
      changed = true
      while changed && r.size >= 3
        changed = false
        r = r.each_with_index.reject { |id, i| id == r[(i + 1) % r.size] }.map(&:first) if r.size > 1
        r.size.times do |i|
          if r[(i - 1) % r.size] == r[(i + 1) % r.size]
            # spike a, b, a -> a
            drop = [i, (i + 1) % r.size].sort.reverse
            drop.each { |d| r.delete_at(d) }
            changed = true
            break
          end
        end
      end
      r
    end

    # ---------------------------------------------------------------- strips

    def build_strips
      @edges.each do |key, e|
        a = @end_prof[[key, e[:a]]]
        b = @end_prof[[key, e[:b]]]
        nseg = a.size - 1
        f1 = @mesh.faces[e[:f1]].attrs || {}
        f2 = @mesh.faces[e[:f2]].attrs || {}
        uv_a, uv_b, mats = strip_uv(e, a, b, f1, f2)
        nseg.times do |i|
          quad = [b[i], a[i], a[i + 1], b[i + 1]]
          uvq = uv_a && uv_b ? [uv_b[i], uv_a[i], uv_a[i + 1], uv_b[i + 1]] : nil
          mat = mats[i]
          if P.planar?(quad.map { |q| @pts[q] }, 1.0e-4)
            add_poly(:strip, key, [quad], mat, uvq)
          else
            @diagonals[Mesh.edge_key(quad[0], quad[2])] = true
            add_poly(:strip, key, [[quad[0], quad[1], quad[2]]], mat, uvq && uvq.values_at(0, 1, 2))
            add_poly(:strip, key, [[quad[0], quad[2], quad[3]]], mat, uvq && uvq.values_at(0, 2, 3))
          end
        end
      end
    end

    # Materials and UVs for one strip (rows at end a and end b).
    def strip_uv(e, a, b, f1, f2)
      nseg = a.size - 1
      if @params['material_mode'] == 'assign' && @params['material']
        mat = { 'material' => @params['material'], 'back_material' => nil, 'uv_mode' => 'strip' }
        return [nil, nil, Array.new(nseg, mat)] unless @params['uv']
        rows = [a, b].map do |ids|
          acc = 0.0
          ids.each_with_index.map do |id, i|
            acc += P.dist(@pts[ids[i - 1]], @pts[id]) if i.positive?
            [P.dot(@pts[id], e[:u]), acc]
          end
        end
        return [rows[0], rows[1], Array.new(nseg, mat)]
      end
      same = f1['material'] == f2['material']
      mats = (0...nseg).map do |i|
        src = same || (i + 0.5) / nseg < 0.5 ? f1 : f2
        { 'material' => src['material'], 'back_material' => src['back_material'] }
      end
      return [nil, nil, mats] unless @params['uv']
      out1 = P.neg(e[:m1])
      out2 = P.neg(e[:m2])
      map1 = f1['uv']
      map2 = f2['uv']
      unless same
        # each half keeps its own face's texture only
        rows = [a, b].map do |ids|
          r1 = UV.strip_row(ids.map { |i| @pts[i] }, map1, nil, out1, out2)
          r2 = UV.strip_row(ids.map { |i| @pts[i] }, nil, map2, out1, out2)
          next nil unless r1 || r2
          ids.each_index.map { |i| (i.to_f / nseg) < 0.5 ? (r1 || r2)[i] : (r2 || r1)[i] }
        end
        return [rows[0], rows[1], mats]
      end
      ra = UV.strip_row(a.map { |i| @pts[i] }, map1, map2, out1, out2)
      rb = UV.strip_row(b.map { |i| @pts[i] }, map1, map2, out1, out2)
      [ra, rb, mats]
    end

    # ----------------------------------------------------------------- faces

    def build_faces
      @mesh.faces.each_with_index do |f, fi|
        loops = f.loops.each_with_index.map do |l, li|
          ids = []
          l.each_with_index do |v, pos|
            rep = @replace[Mesh::Corner.new(fi, li, pos)]
            ids.concat(rep || [vid(v)])
          end
          ids = ids.each_with_index.reject { |id, i| id == ids[(i + 1) % ids.size] }.map(&:first)
          ids
        end
        next if loops.first.size < 3
        loops = [loops.first] + loops[1..-1].select { |l| l.size >= 3 }
        attrs = (f.attrs || {}).merge('src' => fi)
        if loops.size == 1 && !P.planar?(loops[0].map { |i| @pts[i] }, 1.0e-3)
          P.triangulate(loops[0].map { |i| @pts[i] }).each do |t|
            add_poly(:face, [:face, fi], [t.map { |x| loops[0][x] }], attrs)
          end
        else
          add_poly(:face, [:face, fi], loops, attrs)
        end
      end
    end

    def add_poly(kind, group, loops, attrs = nil, uv = nil)
      loops = loops.map { |l| l.each_with_index.reject { |id, i| id == l[(i + 1) % l.size] }.map(&:first) }
      return if loops.first.size < 3
      return if P.polygon_area(loops.first.map { |i| @pts[i] }) < 1.0e-10
      @polys << { kind: kind, group: group, loops: loops, attrs: attrs || {}, uv: uv }
    end

    # A rebuilt face must stay a simple polygon wound like the original.
    def validate_faces
      @polys.each do |poly|
        next unless poly[:kind] == :face
        src = @mesh.faces[poly[:group][1]]
        n = src.normal
        poly[:loops].each_with_index do |l, li|
          p2 = P.to_2d(l.map { |i| @pts[i] }, n, @pts[l.first])
          area = P.area_2d(p2)
          wrong = li.zero? ? area <= 0 : area >= 0
          next unless wrong || !P.simple_polygon_2d?(p2)
          edges = @edges.keys.select do |k|
            src.loops.flatten.include?(k[0]) || src.loops.flatten.include?(k[1])
          end
          return Failure.new('The radius folds a face over itself.', edges)
        end
      end
      nil
    end

    # ---------------------------------------------------------------- result

    def fill_result(res, out)
      res.points = out[:points]
      res.point_meta = out[:meta]
      res.polygons = out[:polygons]
      res.scales = @scales.dup
      @edges.each_key do |k|
        next if @scales[k] >= 0.999
        res.collisions[k] = @params['radius'] * @scales[k]
      end
      res.edge_flags = edge_flags(res)
      res.stats = {
        'edges' => @edges.size,
        'chains' => @chains.size,
        'junctions' => @vertex_k.count { |_v, k| k >= 2 },
        'patches' => res.polygons.map { |p| p[:group] if p[:kind] == :patch }.compact.uniq.size,
        'faces' => res.polygons.size
      }
    end

    def edge_flags(res)
      uses = Hash.new { |h, k| h[k] = [] }
      res.polygons.each_with_index do |poly, pi|
        poly[:loops].each do |l|
          l.each_with_index { |a, i| uses[Mesh.edge_key(a, l[(i + 1) % l.size])] << pi }
        end
      end
      prof_smooth = Profiles.smooth?(@params['profile'], @params)
      soft = { 'soft' => true, 'smooth' => true, 'hidden' => false }
      hard = { 'soft' => false, 'smooth' => false, 'hidden' => false }
      flags = {}
      uses.each do |key, pis|
        polys = pis.map { |i| res.polygons[i] }
        kinds = polys.map { |p| p[:kind] }
        flags[key] =
          if kinds.all?(:face)
            if polys.size == 2 && polys[0][:group] == polys[1][:group]
              soft # triangulation diagonal inside one original face
            else
              original_flags(key, res.point_meta) || hard
            end
          elsif kinds.include?(:face)
            @params['soften_boundary'] ? soft : hard
          elsif polys.map { |p| p[:group] }.uniq.size == 1
            if kinds.first == :patch
              @params['miter'] == 'sharp' ? hard : soft
            else
              prof_smooth || diagonal?(key, polys.first) ? soft : hard
            end
          else
            crease = polys.size == 2 ? P.angle(poly_normal(polys[0], res), poly_normal(polys[1], res)) : 0
            if @params['miter'] == 'sharp' && crease > 20 * Math::PI / 180
              hard
            elsif prof_smooth || crease < 20 * Math::PI / 180
              soft
            else
              hard
            end
          end
      end
      flags
    end

    # Strip triangles share a diagonal that never shows a crease.
    def diagonal?(key, _poly) @diagonals.key?(key) end

    def poly_normal(poly, res) P.norm(P.newell(poly[:loops][0].map { |i| res.points[i] })) end

    def original_flags(key, meta)
      ea = edges_of(meta[key[0]])
      eb = edges_of(meta[key[1]])
      common = ea & eb
      common.empty? ? nil : @mesh.flags_for(common.first)
    end

    def edges_of(m)
      return [] unless m
      return @mesh.edges_at(m[:v]) if m[:v]
      return [m[:e]] if m[:e]
      []
    end
  end
end
