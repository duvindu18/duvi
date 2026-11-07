# frozen_string_literal: true
#
# ArchRailing Pro - geometry engine.
#
# The path maths (Vec, Path, Layout) is plain Ruby on [x, y, z] arrays in
# inches so it is fast and testable. Builder turns the result into SketchUp
# geometry: reused ComponentDefinitions for rigid parts (posts, balusters,
# clamps, brackets, base plates) and swept meshes for continuous parts
# (rails, glass, panels).
#
require 'json'

module ArchRailingPro
  class PathError < StandardError; end
  class ParamError < StandardError; end

  DICT     = 'ArchRailingPro'
  VERSION_ATTR = 1
  MM       = 1.0 / 25.4 # millimetres -> inches

  # ------------------------------------------------------------------
  # Tiny vector helpers on [x, y, z] arrays
  # ------------------------------------------------------------------
  module Vec
    module_function

    def sub(a, b)   [a[0] - b[0], a[1] - b[1], a[2] - b[2]] end
    def add(a, b)   [a[0] + b[0], a[1] + b[1], a[2] + b[2]] end
    def scale(a, s) [a[0] * s, a[1] * s, a[2] * s] end
    def dot(a, b)   a[0] * b[0] + a[1] * b[1] + a[2] * b[2] end
    def len(a)      Math.sqrt(dot(a, a)) end

    def cross(a, b)
      [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    end

    def norm(a)
      l = len(a)
      l < 1.0e-12 ? [0.0, 0.0, 0.0] : scale(a, 1.0 / l)
    end

    def lerp(a, b, t) add(a, scale(sub(b, a), t)) end
  end

  # ------------------------------------------------------------------
  # Path: a cleaned polyline with arc-length parameterisation and
  # per-vertex mitre frames (plan bisector, vertical stays vertical).
  # ------------------------------------------------------------------
  class Path
    EPS = 1.0e-3 # inches
    MAX_MITER = 5.0
    MAX_VSCALE = 4.0

    attr_reader :pts, :closed, :cum, :total, :n, :nseg,
                :seg_dir, :seg_pdir, :seg_normal, :v_turn, :v_slope_change

    # Removes duplicate and collinear vertices. Raises PathError when
    # nothing usable is left.
    def self.clean(points, closed)
      pts = []
      points.each do |p|
        q = [p[0].to_f, p[1].to_f, p[2].to_f]
        pts << q if pts.empty? || Vec.len(Vec.sub(q, pts.last)) > EPS
      end
      pts.pop if closed && pts.size > 2 && Vec.len(Vec.sub(pts.first, pts.last)) <= EPS
      min = closed ? 3 : 2
      loop do
        break if pts.size <= min
        n = pts.size
        idx = closed ? (0...n).to_a : (1...(n - 1)).to_a
        hit = idx.find do |i|
          v1 = Vec.sub(pts[i], pts[(i - 1) % n])
          v2 = Vec.sub(pts[(i + 1) % n], pts[i])
          l = Vec.len(v1) * Vec.len(v2)
          l > 1.0e-12 && Vec.len(Vec.cross(v1, v2)) < 1.0e-7 * l && Vec.dot(v1, v2) > 0
        end
        break unless hit
        pts.delete_at(hit)
      end
      if pts.size < min
        raise PathError, closed ? 'The closed path needs at least 3 distinct corners.' :
                                  'The path has zero length. Select at least one edge with length.'
      end
      pts
    end

    def initialize(points, closed, metric = '3d')
      @closed = closed ? true : false
      @metric = metric
      @pts = Path.clean(points, @closed)
      @n = @pts.size
      @nseg = @closed ? @n : @n - 1
      @seg_dir = []
      @seg_pdir = []
      @seg_normal = []
      @seg_vscale = []
      @seg_slope = []
      @cum = [0.0]
      @nseg.times do |i|
        a = @pts[i]
        b = @pts[(i + 1) % @n]
        d = Vec.sub(b, a)
        pl = Math.hypot(d[0], d[1])
        if pl < EPS
          raise PathError, 'The path has a vertical segment. Railings follow paths that run ' \
                           'horizontally or along a slope, not straight up.'
        end
        pd = [d[0] / pl, d[1] / pl, 0.0]
        @seg_dir << Vec.norm(d)
        @seg_pdir << pd
        @seg_normal << [-pd[1], pd[0], 0.0] # left of travel (Z x d)
        @seg_vscale << [Vec.len(d) / pl, MAX_VSCALE].min
        @seg_slope << Math.atan2(d[2], pl)
        @cum << @cum.last + (@metric == 'plan' ? pl : Vec.len(d))
      end
      @total = @cum.last
      raise PathError, 'The path has zero length.' if @total < EPS
      build_vertex_frames
    end

    def incoming(i) @closed ? (i - 1) % @n : (i.positive? ? i - 1 : nil) end
    def outgoing(i) @closed ? i : (i < @n - 1 ? i : nil) end
    def interior?(i) @closed || (i.positive? && i < @n - 1) end

    def build_vertex_frames
      @v_lat = []
      @v_tan = []
      @v_vscale = []
      @v_turn = []
      @v_slope_change = []
      @n.times do |i|
        si = incoming(i)
        so = outgoing(i)
        if si.nil? || so.nil?
          s = si || so
          @v_lat << @seg_normal[s]
          @v_tan << @seg_pdir[s]
          @v_vscale << @seg_vscale[s]
          @v_turn << 0.0
          @v_slope_change << 0.0
          next
        end
        b = Vec.add(@seg_normal[si], @seg_normal[so])
        bl = Vec.len(b)
        if bl < 1.0e-6
          lat = @seg_normal[si]
        else
          b = Vec.scale(b, 1.0 / bl)
          c = Vec.dot(b, @seg_normal[si])
          lat = Vec.scale(b, c > 1.0 / MAX_MITER ? 1.0 / c : MAX_MITER)
        end
        @v_lat << lat
        t = Vec.norm(Vec.add(@seg_pdir[si], @seg_pdir[so]))
        t = @seg_pdir[so] if Vec.len(t) < 0.5
        @v_tan << t
        @v_vscale << (@seg_vscale[si] + @seg_vscale[so]) / 2.0
        @v_turn << Math.acos(Vec.dot(@seg_pdir[si], @seg_pdir[so]).clamp(-1.0, 1.0))
        @v_slope_change << (@seg_slope[si] - @seg_slope[so]).abs
      end
    end

    # A parallel path offset in plan (h, + = left of travel) and in height (v).
    def offset(h, v)
      return self if h.abs < 1.0e-9 && v.abs < 1.0e-9
      moved = @pts.each_with_index.map do |p, i|
        [p[0] + @v_lat[i][0] * h, p[1] + @v_lat[i][1] * h, p[2] + v]
      end
      @nseg.times do |i|
        a = moved[i]
        b = moved[(i + 1) % @n]
        d = [b[0] - a[0], b[1] - a[1], 0.0]
        if Vec.dot(d, @seg_pdir[i]) <= EPS
          raise PathError, 'The horizontal offset is larger than the curve radius of the path. ' \
                           'Reduce the offset or flip its sign.'
        end
      end
      Path.new(moved, @closed, @metric)
    end

    # [segment index, t] for an arc length. prefer_end chooses the segment
    # that ends at a vertex instead of the one that starts there.
    def locate(s, prefer_end = false)
      if @closed
        raw = s
        s %= @total
        return [@nseg - 1, 1.0] if prefer_end && s < EPS && raw > EPS
      else
        s = s.clamp(0.0, @total)
      end
      lo = 0
      hi = @nseg - 1
      while lo < hi
        mid = (lo + hi + 1) / 2
        if prefer_end ? @cum[mid] < s : @cum[mid] <= s
          lo = mid
        else
          hi = mid - 1
        end
      end
      l = @cum[lo + 1] - @cum[lo]
      t = l.positive? ? (s - @cum[lo]) / l : 0.0
      [lo, t.clamp(0.0, 1.0)]
    end

    def point_at(s)
      i, t = locate(s)
      Vec.lerp(@pts[i], @pts[(i + 1) % @n], t)
    end

    # Plan tangent: mitre direction on a vertex, segment direction between.
    def tangent_at(s)
      i, t = locate(s)
      return @v_tan[i] if t < 1.0e-6
      return @v_tan[(i + 1) % @n] if t > 1.0 - 1.0e-6
      @seg_pdir[i]
    end

    def normal_at(s)
      t = tangent_at(s)
      [-t[1], t[0], 0.0]
    end

    def vertex_frame(k) [@pts[k], @v_lat[k], @v_vscale[k]] end

    def seg_frame(i, t)
      [Vec.lerp(@pts[i], @pts[(i + 1) % @n], t), @seg_normal[i], @seg_vscale[i]]
    end

    def full_frames
      (0...@n).map { |k| vertex_frame(k) }
    end

    def cum_v(k)
      @closed ? @cum[k % @n] + (k / @n) * @total : @cum[k]
    end

    # Frames for the stretch [s0, s1]; on closed paths s1 may pass the seam.
    def sub_frames(s0, s1)
      len = s1 - s0
      if @closed
        s0 %= @total
        s1 = s0 + len
      else
        s0 = s0.clamp(0.0, @total)
        s1 = s1.clamp(0.0, @total)
      end
      return [] if s1 - s0 < EPS
      frames = [seg_frame(*locate(s0))]
      kmax = @closed ? 2 * @n : @n - 1
      (1..kmax).each do |k|
        c = cum_v(k)
        break if c >= s1 - EPS
        next if c <= s0 + EPS
        frames << vertex_frame(k % @n)
      end
      frames << seg_frame(*locate(s1, true))
      frames
    end
  end

  # ------------------------------------------------------------------
  # Layout: where posts go, and the bays between them.
  # ------------------------------------------------------------------
  module Layout
    module_function

    # Returns [posts, bays]
    #   posts: [{ 's' => arc length, 'kind' => :start|:end|:corner|:mid }]
    #   bays:  [[s_a, s_b, post_a, post_b]]
    def compute(path, p)
      spacing = p['post_spacing'] * MM
      corner = p['corner_angle'] * Math::PI / 180.0
      slope = p['slope_break'] * Math::PI / 180.0
      breaks = (0...path.n).select do |i|
        path.interior?(i) && (path.v_turn[i] >= corner || path.v_slope_change[i] >= slope)
      end
      corner_s = breaks.map { |i| path.cum[i] }

      runs =
        if path.closed
          if breaks.empty?
            [[0.0, path.total]]
          else
            breaks.each_with_index.map do |b, j|
              s0 = path.cum[b]
              s1 = path.cum[breaks[(j + 1) % breaks.size]]
              s1 += path.total if s1 <= s0 + Path::EPS
              [s0, s1]
            end
          end
        else
          ([0] + breaks + [path.n - 1]).each_cons(2).map { |a, b| [path.cum[a], path.cum[b]] }
        end

      list = []
      runs.each { |s0, s1| list.concat(distribute(s0, s1, spacing, p['spacing_mode'])) }
      list.map! { |s| s % path.total } if path.closed
      list.sort!
      uniq = []
      list.each { |s| uniq << s if uniq.empty? || s - uniq.last > Path::EPS * 10 }
      uniq.pop if path.closed && uniq.size > 1 && path.total - uniq.last < Path::EPS * 10

      posts = uniq.map do |s|
        kind =
          if corner_s.any? { |c| (c - s).abs < Path::EPS * 10 } then :corner
          elsif !path.closed && s < Path::EPS * 10 then :start
          elsif !path.closed && path.total - s < Path::EPS * 10 then :end
          else :mid
          end
        { 's' => s, 'kind' => kind, 'visible' => visible?(kind, p) }
      end

      bays = posts.each_cons(2).map { |a, b| [a['s'], b['s'], a, b] }
      if path.closed && posts.size >= 1
        a = posts.last
        b = posts.first
        bays << [a['s'], b['s'] + path.total, a, b]
      end
      [posts, bays]
    end

    def distribute(s0, s1, spacing, mode)
      l = s1 - s0
      return [s0, s1] if l < Path::EPS
      if mode == 'fixed'
        out = [s0]
        s = s0 + spacing
        while s < s1 - spacing * 0.05
          out << s
          s += spacing
        end
        out << s1
      else
        n = [(l / spacing - 1.0e-6).ceil, 1].max
        (0..n).map { |k| s0 + l * k / n }
      end
    end

    def visible?(kind, p)
      case kind
      when :start then p['show_start_post']
      when :end then p['show_end_post']
      when :corner then p['show_corner_posts']
      else p['show_mid_posts']
      end
    end
  end

  # ------------------------------------------------------------------
  # Builder: writes SketchUp geometry into a railing group.
  # ------------------------------------------------------------------
  class Builder
    attr_reader :stats

    def initialize(model, group, params, local_pts, closed)
      @model = model
      @group = group
      @p = params
      @local_pts = local_pts
      @closed = closed
      @defs = {}
      @mats = {}
      @stats = Hash.new(0)
    end

    def mm(key) @p[key].to_f * MM end

    def build
      p = @p
      base = Path.new(@local_pts, @closed, p['spacing_metric'])
      path = base.offset(mm('offset_h'), mm('offset_v'))
      posts, bays = Layout.compute(path, p)

      ents = @group.entities
      ents.clear!
      @subs = {}

      h = mm('height')
      seg = p['round_segments']
      tr_h = p['top_rail'] ? Defaults.rail_h(p['top_rail_profile'], p['top_rail_width'], p['top_rail_height']) * MM : 0.0
      post_h = h - tr_h
      infill_bottom = Defaults.infill_bottom(p) * MM
      infill_top = h - tr_h - mm('infill_top_gap')

      post_mat = material('Post', p['post_color'])
      rail_mat = material('Rail', p['rail_color'])
      infill_mat = material('Infill', p['infill_color'])
      hw_mat = material('Hardware', p['hardware_color'])

      # ---- posts ----
      post_def = component_or_builtin(p['post_component']) ||
                 box_def('Post', p['post_profile'], mm('post_width'), mm('post_depth'), post_h, seg)
      plate_def = p['base_plate'] ? box_def('BasePlate', 'rect', mm('post_width') + 60 * MM, mm('post_depth') + 60 * MM, 8 * MM, seg) : nil
      posts.each do |pt|
        next unless pt['visible']
        at = path.point_at(pt['s'])
        tan = path.tangent_at(pt['s'])
        place(sub('Posts'), post_def, at, tan, 0.0, post_mat)
        place(sub('Posts'), plate_def, at, tan, 0.0, post_mat) if plate_def
        @stats['posts'] += 1
      end

      # ---- top rail ----
      if p['top_rail']
        frames = path.full_frames
        extend_ends(path, frames, mm('top_rail_overhang')) unless path.closed
        prof = profile(p['top_rail_profile'], mm('top_rail_width'), mm('top_rail_height'), seg)
        sweep(sub('Rails'), 'Top rail', frames, prof, post_h, path.closed, true, rail_mat, p['top_rail_profile'] == 'round')
        @stats['rails'] += 1
      end

      # ---- bottom rail ----
      if p['bottom_rail']
        prof = profile(p['bottom_rail_profile'], mm('bottom_rail_width'), mm('bottom_rail_height'), seg)
        sweep(sub('Rails'), 'Bottom rail', path.full_frames, prof, mm('bottom_rail_elev'), path.closed, true,
              rail_mat, p['bottom_rail_profile'] == 'round')
        @stats['rails'] += 1
      end

      # ---- infill ----
      case p['infill_type']
      when 'balusters'
        build_balusters(path, bays, infill_bottom, infill_top, infill_mat, seg)
      when 'glass', 'panel'
        build_panels(path, bays, infill_bottom, infill_top, hw_mat, seg)
      when 'horizontal'
        build_horizontal(path, infill_bottom, infill_top, infill_mat, seg)
      end

      # ---- secondary handrail on brackets ----
      build_handrail2(path, posts, rail_mat, hw_mat, seg) if p['handrail2']

      @group.name = 'ArchRailing'
      @stats['length_mm'] = (path.total / MM).round
      @stats
    end

    # ---------------- infill builders ----------------

    def build_balusters(path, bays, bottom, top, mat, seg)
      len = top - bottom
      return if len <= 0
      defn = component_or_builtin(@p['baluster_component']) ||
             box_def('Baluster', @p['baluster_profile'], mm('baluster_width'), mm('baluster_depth'), len, seg)
      spacing = mm('baluster_spacing')
      bays.each do |sa, sb, _a, _b|
        l = sb - sa
        count = [(l / spacing - 1.0e-6).ceil - 1, 0].max
        (1..count).each do |k|
          s = sa + l * k / (count + 1)
          place(sub('Infill'), defn, path.point_at(s), path.tangent_at(s), bottom, mat)
          @stats['balusters'] += 1
        end
      end
    end

    def build_panels(path, bays, bottom, top, hw_mat, seg)
      glass = @p['infill_type'] == 'glass'
      mat = glass ? material('Glass', @p['glass_color'], @p['glass_opacity']) :
                    material('Panel', @p['infill_color'], @p['panel_opacity'])
      ht = top - bottom
      return if ht <= 0
      t = mm('glass_thickness')
      go = mm('glass_offset')
      gap = mm('glass_gap')
      half_post = mm('post_width') / 2.0
      prof = [[go - t / 2, 0.0], [go + t / 2, 0.0], [go + t / 2, ht], [go - t / 2, ht]]
      clamp_def = nil
      if glass && @p['show_clamps']
        clamp_def = component_or_builtin(@p['clamp_component']) ||
                    box_def('Clamp', 'rect', mm('clamp_width'), mm('clamp_depth'), mm('clamp_height'), seg)
      end
      bays.each do |sa, sb, a, b|
        s0 = sa + (a['visible'] ? half_post : 0.0) + gap
        s1 = sb - (b['visible'] ? half_post : 0.0) - gap
        next if s1 - s0 < 10 * MM
        frames = path.sub_frames(s0, s1)
        next if frames.size < 2
        sweep(sub('Infill'), glass ? 'Glass panel' : 'Panel', frames, prof, bottom, false, false, mat, false)
        @stats['panels'] += 1
        next unless clamp_def
        heights = clamp_heights(bottom, top)
        [[a, sa, 1.0], [b, sb, -1.0]].each do |post, s_post, dir|
          next unless post['visible']
          s = s_post + dir * (half_post + mm('clamp_width') / 2.0)
          at = path.point_at(s)
          n = path.normal_at(s)
          at = [at[0] + n[0] * go, at[1] + n[1] * go, at[2]]
          heights.each do |z|
            place(sub('Hardware'), clamp_def, at, path.tangent_at(s), z - mm('clamp_height') / 2.0, hw_mat)
            @stats['clamps'] += 1
          end
        end
      end
    end

    def clamp_heights(bottom, top)
      inset = mm('clamp_inset')
      if top - bottom > 2 * inset + mm('clamp_height')
        [bottom + inset, top - inset]
      else
        [(bottom + top) / 2.0]
      end
    end

    def build_horizontal(path, bottom, top, mat, seg)
      n = @p['hrail_count']
      prof_kind = @p['hrail_profile']
      w = mm('hrail_width')
      hh = prof_kind == 'round' ? w : mm('hrail_height')
      gap = (top - bottom - n * hh) / (n + 1)
      gap = (top - bottom) / (n + 1) if gap < 0
      prof = profile(prof_kind, w, hh, [@p['round_segments'] / 2, 8].max)
      n.times do |k|
        elev = bottom + gap * (k + 1) + hh * k
        sweep(sub('Infill'), "Rail #{k + 1}", path.full_frames, prof, elev, path.closed, true, mat, prof_kind == 'round')
        @stats['infill_rails'] += 1
      end
    end

    def build_handrail2(path, posts, rail_mat, hw_mat, seg)
      d = mm('handrail2_diameter')
      off = mm('handrail2_offset')
      elev = mm('handrail2_elev') - d / 2.0
      r = d / 2.0
      prof = (0...seg).map do |i|
        a = 2 * Math::PI * i / seg
        [off + r * Math.cos(a), r + r * Math.sin(a)]
      end
      frames = path.full_frames
      extend_ends(path, frames, mm('top_rail_overhang')) unless path.closed
      sweep(sub('Rails'), 'Handrail', frames, prof, elev, path.closed, true, rail_mat, true)
      @stats['rails'] += 1
      reach = off.abs - r * 0.5
      return if reach <= 0
      b = mm('bracket_size')
      bdef = box_def('Bracket', 'rect', b, reach, b, seg)
      posts.each do |pt|
        at = path.point_at(pt['s'])
        n = path.normal_at(pt['s'])
        sign = off.positive? ? 1.0 : -1.0
        at = [at[0] + n[0] * sign * reach / 2.0, at[1] + n[1] * sign * reach / 2.0, at[2]]
        place(sub('Hardware'), bdef, at, path.tangent_at(pt['s']), elev + r - b / 2.0, hw_mat)
        @stats['brackets'] += 1
      end
    end

    # ---------------- geometry primitives ----------------

    def extend_ends(path, frames, ov)
      return if ov <= 0
      d0 = path.seg_dir.first
      d1 = path.seg_dir.last
      f0 = frames.first
      f1 = frames.last
      frames[0] = [Vec.sub(f0[0], Vec.scale(d0, ov)), f0[1], f0[2]]
      frames[-1] = [Vec.add(f1[0], Vec.scale(d1, ov)), f1[1], f1[2]]
    end

    # Profile polygon in (u = left of travel, v = up), counter-clockwise,
    # anchored with its bottom at v = 0.
    def profile(kind, w, h, seg)
      if kind == 'round'
        r = w / 2.0
        (0...seg).map do |i|
          a = 2 * Math::PI * i / seg
          [r * Math.cos(a), r + r * Math.sin(a)]
        end
      else
        [[-w / 2.0, 0.0], [w / 2.0, 0.0], [w / 2.0, h], [-w / 2.0, h]]
      end
    end

    # Sweeps a profile along frames with plumb (vertical) sections and plan
    # mitres. When scale_v is set, the section height is stretched by
    # 1/cos(slope) so a rail keeps its true thickness on stairs.
    def sweep(ents, name, frames, prof, elev, closed, scale_v, mat, smooth)
      return nil if frames.size < 2
      g = ents.add_group
      g.name = name
      m = prof.size
      mesh = Geom::PolygonMesh.new(frames.size * m, frames.size * m * 2 + 2)
      rings = frames.map do |(pt, lat, vs)|
        s = scale_v ? vs : 1.0
        prof.map do |(u, v)|
          mesh.add_point(Geom::Point3d.new(pt[0] + lat[0] * u, pt[1] + lat[1] * u, pt[2] + elev + v * s))
        end
      end
      count = closed ? rings.size : rings.size - 1
      count.times do |i|
        r0 = rings[i]
        r1 = rings[(i + 1) % rings.size]
        m.times do |k|
          k1 = (k + 1) % m
          mesh.add_polygon(r0[k], r0[k1], r1[k1])
          mesh.add_polygon(r0[k], r1[k1], r1[k])
        end
      end
      unless closed
        mesh.add_polygon(*rings.first.reverse)
        mesh.add_polygon(*rings.last)
      end
      g.entities.fill_from_mesh(mesh, true, 0)
      soften(g.entities, smooth)
      g.material = mat if mat
      g
    end

    def soften(ents, smooth)
      limit = smooth ? 0.8 : 1.0e-3
      ents.grep(Sketchup::Edge).each do |e|
        fs = e.faces
        next unless fs.size == 2
        next unless fs[0].normal.angle_between(fs[1].normal) < limit
        e.soft = true
        e.smooth = true
      end
    end

    def place(ents, defn, pt, tan, z, mat)
      return nil unless defn
      x = Geom::Vector3d.new(tan[0], tan[1], 0.0)
      y = Geom::Vector3d.new(-tan[1], tan[0], 0.0)
      origin = Geom::Point3d.new(pt[0], pt[1], pt[2] + z)
      tr = Geom::Transformation.axes(origin, x, y, Geom::Vector3d.new(0, 0, 1))
      inst = ents.add_instance(defn, tr)
      inst.material = mat if mat
      inst
    end

    # Built-in rigid part: a box or cylinder, centred in plan, base at z = 0.
    # Shared by every railing in the model with the same dimensions.
    def box_def(role, kind, w, d, h, seg)
      key = format('%s_%s_%.1fx%.1fx%.1f_%d', role, kind, w / MM, (kind == 'round' ? w : d) / MM, h / MM, seg)
      return @defs[key] if @defs[key]
      defn = @model.definitions.find { |df| df.get_attribute(DICT, 'key') == key && df.valid? }
      unless defn
        defn = @model.definitions.add("ARP_#{key}")
        defn.set_attribute(DICT, 'key', key)
        defn.set_attribute(DICT, 'builtin', true)
        de = defn.entities
        face =
          if kind == 'round'
            de.add_face(de.add_circle(Geom::Point3d.new(0, 0, 0), Geom::Vector3d.new(0, 0, 1), w / 2.0, seg))
          else
            de.add_face([-w / 2, -d / 2, 0], [w / 2, -d / 2, 0], [w / 2, d / 2, 0], [-w / 2, d / 2, 0])
          end
        face.reverse! if face.normal.z.negative?
        face.pushpull(h)
      end
      @defs[key] = defn
    end

    def component_or_builtin(name)
      return nil if name.nil? || name.empty?
      d = @model.definitions[name]
      return nil unless d && !d.group? && !d.image?
      return nil if d.get_attribute(DICT, 'builtin')
      d
    end

    def material(role, hex, alpha = 1.0)
      key = alpha < 0.999 ? "ARP #{role} #{hex} #{(alpha * 100).round}%" : "ARP #{role} #{hex}"
      return @mats[key] if @mats[key]
      mat = @model.materials[key] || @model.materials.add(key)
      r, g, b = hex.delete('#').scan(/../).map { |c| c.to_i(16) }
      mat.color = Sketchup::Color.new(r, g, b)
      mat.alpha = alpha
      @mats[key] = mat
    end

    def sub(name)
      @subs[name] ||= begin
        g = @group.entities.add_group
        g.name = name
        g.entities
      end
    end
  end

  # ------------------------------------------------------------------
  # Generator: public API used by the UI and menus.
  # ------------------------------------------------------------------
  module Generator
    module_function

    def railing?(e)
      e.is_a?(Sketchup::Group) && e.valid? && !e.get_attribute(DICT, 'path').nil?
    end

    def railings_in(selection)
      selection.to_a.select { |e| railing?(e) }
    end

    def params_of(group)
      raw = group.get_attribute(DICT, 'params')
      Defaults.sanitize(raw ? JSON.parse(raw) : {})
    rescue JSON::ParserError
      Defaults.base
    end

    # Ordered chains of points from the selected edges. One chain per
    # continuous run; junctions with 3 or more edges split chains.
    def chains_from_selection(selection)
      edges = []
      selection.each do |e|
        next unless e.is_a?(Sketchup::Edge)
        edges << e
        edges.concat(e.curve.edges) if e.curve
      end
      edges.uniq!
      if edges.empty?
        raise PathError, 'Select one or more connected edges, a curve or an arc to use as the railing path.'
      end
      chains_from_edges(edges)
    end

    def chains_from_edges(edges)
      adj = Hash.new { |h, k| h[k] = [] }
      edges.each { |e| e.vertices.each { |v| adj[v] << e } }
      visited = {}
      chains = []
      adj.keys.select { |v| adj[v].size != 2 }.each do |v|
        adj[v].each { |e| chains << walk(v, e, adj, visited) unless visited[e] }
      end
      edges.each { |e| chains << walk(e.start, e, adj, visited) unless visited[e] }
      chains
    end

    def walk(v0, e0, adj, visited)
      pts = [v0.position.to_a]
      v = v0
      e = e0
      closed = false
      loop do
        visited[e] = true
        v = e.other_vertex(v)
        pts << v.position.to_a
        if v == v0
          closed = true
          break
        end
        break if adj[v].size != 2
        e = adj[v].find { |x| x != e && !visited[x] }
        break unless e
      end
      { 'points' => pts, 'closed' => closed }
    end

    def create(model, entities, chains, params)
      errs = Defaults.validate(params)
      raise ParamError, errs.join("\n") unless errs.empty?
      chains.map do |ch|
        pts = Path.clean(ch['points'], ch['closed'])
        origin = pts.first
        local = pts.map { |q| Vec.sub(q, origin) }
        grp = entities.add_group
        grp.transformation = Geom::Transformation.new(Geom::Point3d.new(*origin))
        store(grp, params, local, ch['closed'])
        Builder.new(model, grp, params, local, ch['closed']).build
        grp
      end
    end

    def regenerate(model, group, params = nil)
      raise PathError, 'The railing was deleted.' unless group.valid?
      params ||= params_of(group)
      errs = Defaults.validate(params)
      raise ParamError, errs.join("\n") unless errs.empty?
      local = JSON.parse(group.get_attribute(DICT, 'path').to_s) rescue nil
      raise PathError, 'This railing has no stored path. Pick a new path for it.' unless local.is_a?(Array) && local.size >= 2
      closed = group.get_attribute(DICT, 'closed') ? true : false
      group.make_unique if group.definition.count_instances > 1
      store(group, params, local, closed)
      Builder.new(model, group, params, local, closed).build
    end

    # Replaces the stored path of a railing with a chain of edges.
    def replace_path(model, group, chain)
      pts = Path.clean(chain['points'], chain['closed'])
      inv = group.transformation.inverse
      local = pts.map { |q| (inv * Geom::Point3d.new(*q)).to_a }
      params = params_of(group)
      group.make_unique if group.definition.count_instances > 1
      store(group, params, local, chain['closed'])
      Builder.new(model, group, params, local, chain['closed']).build
    end

    def store(group, params, local, closed)
      group.set_attribute(DICT, 'version', VERSION_ATTR)
      group.set_attribute(DICT, 'params', JSON.generate(params))
      group.set_attribute(DICT, 'path', JSON.generate(local.map { |q| q.map { |c| c.to_f.round(6) } }))
      group.set_attribute(DICT, 'closed', closed ? true : false)
    end

    # Removes built-in part definitions that no railing uses any more.
    def purge_builtin(model)
      return unless model.definitions.respond_to?(:remove)
      model.definitions.to_a.each do |d|
        next unless d.get_attribute(DICT, 'builtin') && d.count_instances.zero?
        model.definitions.remove(d)
      end
    end
  end
end
