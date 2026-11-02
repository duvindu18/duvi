# frozen_string_literal: true
#
# .SketchCorner - SketchUp <-> engine bridge.
#
# capture : SketchUp faces  -> Mesh (positions, loops, materials, UV maps,
#           edge soft/smooth/hidden states)
# write   : engine Result   -> SketchUp faces (orientation, materials, UVs,
#           tags, edge states, op attribute)
#
# All engine math happens in the local coordinates of the entities being
# edited. Bridge.frame works out how SketchUp reports positions for those
# entities (see the note there) so capture and write stay consistent.

require 'set'
require_relative 'vmath'
require_relative 'mesh'
require_relative 'uv'

module SketchCorner
  module Bridge
    DICT = 'SketchCorner'
    KEY_SCALE = 1000.0 # 0.001" grid for matching written edges

    module_function

    # ------------------------------------------------------------- context

    # Transformation T with  api_position = T * local_position  for the given
    # entities. When the user has a group open for editing, older SketchUp
    # versions report (and expect) world positions for the active entities.
    # We detect that by testing vertices against the definition's local bounds.
    def frame(entities)
      model = entities.model
      return IDENTITY if model.active_path.nil? || model.active_path.empty?
      return IDENTITY unless entities == model.active_entities
      definition = entities.parent
      return IDENTITY unless definition.is_a?(Sketchup::ComponentDefinition)
      tr = model.edit_transform
      return IDENTITY if tr.identity?
      verts = entities.grep(Sketchup::Edge).first(12).flat_map(&:vertices).uniq
      return IDENTITY if verts.empty?
      bb = definition.bounds
      local = verts.all? { |v| bb.contains?(v.position) }
      local ? IDENTITY : tr
    end

    IDENTITY = Geom::Transformation.new if defined?(Geom::Transformation)

    # The group that owns these entities, or nil for the model root or a
    # component definition (parametric history lives on groups only).
    def owner_group(entities)
      definition = entities.parent
      return nil unless definition.is_a?(Sketchup::ComponentDefinition) && definition.group?
      definition.instances.first
    end

    # ------------------------------------------------------------- capture

    # Faces that the engine may rebuild: every face touching a vertex of a
    # selected edge.
    def region_faces(edges)
      edges.flat_map(&:vertices).uniq.flat_map(&:faces).uniq
    end

    def capture(faces, frame = IDENTITY, with_uv: true)
      inv = frame.inverse
      mesh = Mesh.new
      vmap = {}
      index = ->(v) { vmap[v] ||= mesh.add_point((inv * v.position).to_a) }
      faces.each do |face|
        normal = (inv * face.normal).normalize
        loops = [face.outer_loop] + (face.loops - [face.outer_loop])
        ids = loops.each_with_index.map do |l, li|
          lv = l.vertices.map { |v| index.call(v) }
          pts = lv.map { |i| mesh.points[i] }
          ccw = VMath.dot(VMath.newell(pts), normal.to_a).positive?
          # outer loops run counter-clockwise around the normal, holes clockwise
          (li.zero? ? ccw : !ccw) ? lv : lv.reverse
        end
        mesh.add_face(ids, normal.to_a, face_attrs(face, inv, with_uv))
      end
      faces.flat_map(&:edges).uniq.each do |e|
        a = vmap[e.start]
        b = vmap[e.end]
        next unless a && b
        mesh.set_edge_flags(a, b, 'soft' => e.soft?, 'smooth' => e.smooth?, 'hidden' => e.hidden?)
      end
      [mesh, vmap]
    end

    def face_attrs(face, inv, with_uv)
      attrs = {
        'material' => face.material && face.material.name,
        'back_material' => face.back_material && face.back_material.name,
        'layer' => face.layer && face.layer.name
      }
      if with_uv
        attrs['uv'] = uv_map(face, true, inv)
        attrs['uv_back'] = uv_map(face, false, inv)
      end
      attrs
    end

    # Affine texture map of one side of a face, in local coordinates.
    def uv_map(face, front, inv)
      mat = front ? face.material : face.back_material
      return nil unless mat && mat.texture
      helper = face.get_UVHelper(front, !front, Sketchup.create_texture_writer)
      p0 = face.vertices.first.position
      xa, ya, = face.normal.axes
      p1 = p0.offset(xa, 10)
      p2 = p0.offset(ya, 10)
      uv = lambda do |p|
        q = front ? helper.get_front_UVQ(p) : helper.get_back_UVQ(p)
        z = q.z.to_f.abs < 1.0e-12 ? 1.0 : q.z.to_f
        [q.x.to_f / z, q.y.to_f / z]
      end
      UV.map_from_samples((inv * p0).to_a, (inv * p1).to_a, (inv * p2).to_a, uv.call(p0), uv.call(p1), uv.call(p2))
    rescue StandardError => e
      Diagnostics.log("UV capture skipped: #{e.message}")
      nil
    end

    # Edges in +entities+ matching [[p, q], ...] position pairs (api coords).
    def find_edges(entities, pairs)
      lookup = {}
      entities.grep(Sketchup::Edge).each { |e| lookup[edge_key(e.start.position, e.end.position)] = e }
      pairs.map { |p, q| lookup[edge_key(p, q)] }.compact
    end

    def edge_key(p, q)
      a = p.to_a.map { |c| (c.to_f * KEY_SCALE).round }
      b = q.to_a.map { |c| (c.to_f * KEY_SCALE).round }
      (a <=> b) <= 0 ? [a, b] : [b, a]
    end

    # --------------------------------------------------------------- erase

    def erase_region(entities, faces)
      set = faces.to_set
      edges = faces.flat_map(&:edges).uniq.select { |e| e.faces.all? { |f| set.include?(f) } }
      entities.erase_entities((faces + edges).select(&:valid?))
    end

    # --------------------------------------------------------------- write

    # Writes engine polygons. Returns [created_faces, warnings].
    def write(entities, res, op_id, params, frame = IDENTITY)
      model = entities.model
      warnings = []
      mats = Hash.new { |h, name| h[name] = name && model.materials[name] }
      tag = tag_for(model, params['tag'])
      pts = res.points.map { |p| frame * Geom::Point3d.new(*p) }
      created = []
      res.polygons.each do |poly|
        face = add_polygon(entities, poly[:loops].map { |l| l.map { |i| pts[i] } })
        unless face
          warnings << 'A face could not be created and was skipped.'
          next
        end
        expected = frame * Geom::Vector3d.new(*VMath.newell(poly[:loops][0].map { |i| res.points[i] }))
        face.reverse! if face.normal.dot(expected) < 0
        style_face(face, poly, res, params, mats, pts)
        if poly[:kind] == :face
          layer = model.layers[poly[:attrs]['layer'].to_s]
          face.layer = layer if layer
        elsif tag
          face.layer = tag
        end
        face.set_attribute(DICT, 'op', op_id) if op_id
        face.set_attribute(DICT, 'kind', poly[:kind].to_s) if op_id
        created << face
      end
      apply_edge_flags(created, res, frame)
      [created, warnings.uniq]
    end

    def tag_for(model, name)
      return nil if name.nil? || name.to_s.strip.empty?
      model.layers[name] || model.layers.add(name)
    end

    def add_polygon(entities, loops)
      face = entities.add_face(loops.first)
      return nil unless face
      loops[1..-1].each do |hole|
        inner = entities.add_face(hole)
        inner.erase! if inner && inner.valid?
      end
      face.valid? ? face : nil
    rescue ArgumentError => e
      Diagnostics.log("add_face failed: #{e.message}")
      nil
    end

    def style_face(face, poly, res, params, mats, pts)
      a = poly[:attrs]
      front = mats[a['material']]
      back = mats[a['back_material']]
      face.material = front if front
      face.back_material = back if back
      return unless params['uv']
      ids = poly[:loops][0]
      [[front, true, poly[:uv] || (a['uv'] && ids.map { |i| UV.apply(a['uv'], res.points[i]) })],
       [back, false, a['uv_back'] && ids.map { |i| UV.apply(a['uv_back'], res.points[i]) }]].each do |mat, side, uvs|
        next unless mat && mat.texture && uvs
        if a['uv_mode'] == 'strip'
          w = mat.texture.width.to_f
          h = mat.texture.height.to_f
          uvs = uvs.map { |u, v| [u / w, v / h] }
        end
        tri = spread_triangle(ids.map { |i| res.points[i] })
        pairs = tri.flat_map { |k| [pts[ids[k]], Geom::Point3d.new(uvs[k][0], uvs[k][1], 0)] }
        face.position_material(mat, pairs, side)
      end
    rescue ArgumentError => e
      Diagnostics.log("position_material skipped: #{e.message}")
    end

    # Three well-spread polygon corners (largest triangle over a few probes).
    def spread_triangle(points)
      n = points.size
      return [0, 1, 2] if n == 3
      best = [0, 1, 2]
      area = -1.0
      probe = (0...n).step([n / 6, 1].max).to_a
      probe.combination(3).each do |i, j, k|
        ar = VMath.len(VMath.cross(VMath.sub(points[j], points[i]), VMath.sub(points[k], points[i])))
        next unless ar > area
        area = ar
        best = [i, j, k]
      end
      best
    end

    def apply_edge_flags(faces, res, frame)
      lookup = {}
      res.edge_flags.each do |(a, b), fl|
        p = frame * Geom::Point3d.new(*res.points[a])
        q = frame * Geom::Point3d.new(*res.points[b])
        lookup[edge_key(p, q)] = fl
      end
      faces.select(&:valid?).flat_map(&:edges).uniq.each do |e|
        fl = lookup[edge_key(e.start.position, e.end.position)]
        next unless fl
        e.soft = fl['soft']
        e.smooth = fl['smooth']
        e.hidden = fl['hidden'] ? true : false
      end
    end
  end

  module Diagnostics
    module_function

    def log(msg)
      puts "[.SketchCorner] #{msg}" if $VERBOSE || ENV['SKETCHCORNER_DEBUG'] || Settings.debug?
    end

    def report(error, context = '')
      puts "[.SketchCorner] #{context} #{error.class}: #{error.message}"
      (error.backtrace || []).first(8).each { |l| puts "    #{l}" }
    end
  end
end
