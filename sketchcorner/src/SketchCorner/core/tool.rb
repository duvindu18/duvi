# frozen_string_literal: true
#
# .SketchCorner - interactive tools.
#
#   FilletTool       pick edges (tangent chains on one click), live preview,
#                    apply. Shift toggles, Ctrl adds, Alt picks one edge only,
#                    double-click a face to take its whole edge loop.
#   EditTool         click a .SketchCorner group to reload a stored fillet,
#                    change parameters, update / revert / bake.
#   ProfilePickTool  click an open polyline or curve to use as custom profile.

require_relative 'vmath'
require_relative 'engine'
require_relative 'bridge'
require_relative 'parametric'

module SketchCorner
  # ------------------------------------------------------------- chaining
  module Chain
    module_function

    # An edge that can be rounded: two faces, not soft, not coplanar.
    def crease?(edge)
      return false unless edge.valid? && edge.faces.size == 2 && !edge.soft?
      f1, f2 = edge.faces
      f1.normal.angle_between(f2.normal) > 0.5.degrees
    end

    def convex?(edge)
      f1, f2 = edge.faces
      u = edge.line[1]
      u = u.reverse if edge.reversed_in?(f1)
      m1 = f1.normal * u
      f2.normal.dot(m1) < 0
    end

    def other_vertex(edge, v) edge.start == v ? edge.end : edge.start end

    # Ordered list of edges continuing +edge+ smoothly in both directions.
    def tangent_chain(edge, tolerance = 30.degrees)
      return [edge] unless crease?(edge)
      convex = convex?(edge)
      chain = [edge]
      [edge.start, edge.end].each_with_index do |v0, side|
        cur = edge
        v = v0
        loop do
          dir_in = v.position - other_vertex(cur, v).position
          scored = v.edges.map do |c|
            next if c == cur || chain.include?(c) && c != edge
            next unless crease?(c) && convex?(c) == convex
            ang = dir_in.angle_between(other_vertex(c, v).position - v.position)
            ang <= tolerance ? [c, ang] : nil
          end.compact.sort_by { |_c, a| a }
          break if scored.empty?
          break if scored.size > 1 && scored[1][1] - scored[0][1] < 5.degrees
          nxt = scored[0][0]
          break if nxt == edge # closed loop
          side.zero? ? chain.unshift(nxt) : chain.push(nxt)
          cur = nxt
          v = other_vertex(nxt, v)
        end
      end
      chain
    end

    def face_loop(face)
      face.outer_loop.edges.select { |e| crease?(e) }
    end

    # Ordered points of an open polyline/curve through +edge+.
    def polyline_points(edge)
      edges = [edge]
      [edge.start, edge.end].each_with_index do |v0, side|
        cur = edge
        v = v0
        loop do
          nxt = v.edges.find { |c| c != cur && !edges.include?(c) }
          break if nxt.nil? || v.edges.size != 2
          side.zero? ? edges.unshift(nxt) : edges.push(nxt)
          cur = nxt
          v = other_vertex(nxt, v)
        end
      end
      if edges.size == 1
        return [edge.start.position, edge.end.position]
      end
      first = edges[0]
      shared = (first.vertices & edges[1].vertices).first
      v = other_vertex(first, shared)
      pts = [v.position]
      edges.each do |e|
        v = other_vertex(e, v)
        pts << v.position
      end
      pts
    end
  end

  # --------------------------------------------------------------- picking
  module Picking
    module_function

    # [edge_or_face, entities, world_transformation] for an entity under the
    # cursor that lives in the active context or one group level below it.
    def pick(view, x, y, klass)
      ph = view.pick_helper
      ph.do_pick(x, y)
      ph.count.times do |i|
        leaf = ph.leaf_at(i)
        next unless leaf.is_a?(klass)
        path = ph.path_at(i) || []
        ctx = leaf.parent.is_a?(Sketchup::Model) ? leaf.model.active_entities : leaf.parent.entities
        if path.size == 1
          return [leaf, view.model.active_entities, view.model.edit_transform]
        elsif path.size == 2 && path[0].is_a?(Sketchup::Group)
          return [leaf, ctx, view.model.edit_transform * path[0].transformation]
        end
      end
      nil
    end

    def pick_group(view, x, y)
      ph = view.pick_helper
      ph.do_pick(x, y)
      ph.count.times do |i|
        path = ph.path_at(i) || []
        grp = path.find { |e| Parametric.sc_group?(e) }
        if grp
          idx = path.index(grp)
          tr = view.model.edit_transform
          path[0..idx].each { |e| tr *= e.transformation }
          return [grp, tr, ph.leaf_at(i)]
        end
      end
      # inside an open .SketchCorner group: the group is the active context
      active = view.model.active_path
      if active && Parametric.sc_group?(active.last)
        leaf = ph.count.positive? ? ph.leaf_at(0) : nil
        return [active.last, view.model.edit_transform, leaf]
      end
      nil
    end
  end

  # ---------------------------------------------------------------- drawing
  module Overlay
    BLUE = Sketchup::Color.new(11, 92, 255) if defined?(Sketchup::Color)
    BLUE_SOFT = Sketchup::Color.new(111, 155, 255) if defined?(Sketchup::Color)
    RED = Sketchup::Color.new(230, 30, 30) if defined?(Sketchup::Color)
    INK = Sketchup::Color.new(17, 17, 17) if defined?(Sketchup::Color)

    module_function

    # Converts an engine result into world-space line lists by category.
    def lines_for(res, tr)
      hard = []
      soft = []
      return { hard: hard, soft: soft } unless res && res.points.any?
      pts = res.points.map { |p| tr * Geom::Point3d.new(*p) }
      res.edge_flags.each do |(a, b), fl|
        (fl['soft'] ? soft : hard) << pts[a] << pts[b]
      end
      { hard: hard, soft: soft }
    end

    def edge_lines(edges, tr)
      edges.select(&:valid?).flat_map { |e| [tr * e.start.position, tr * e.end.position] }
    end

    def draw_lines(view, pts, color, width, stipple = '')
      return if pts.empty?
      view.drawing_color = color
      view.line_width = width
      view.line_stipple = stipple
      view.draw(GL_LINES, pts)
    end
  end

  # ============================================================ FilletTool
  class FilletTool
    attr_reader :params

    def initialize(ui)
      @ui = ui
      @params = Settings.load
      @edges = []
      @entities = nil
      @world = Geom::Transformation.new
      @hover = []
      @preview = nil
      @lines = { hard: [], soft: [] }
      @collide = []
      @message = nil
    end

    # ---- lifecycle

    def activate
      @ui.attach(self, :create)
      adopt_selection
      refresh
      status
    end

    def deactivate(view)
      @ui.detach(self)
      view.invalidate
    end

    def resume(view)
      status
      view.invalidate
    end

    def suspend(_view) end

    def onCancel(_reason, view)
      clear_selection
      view.invalidate
    end

    def enableVCB?() true end

    # ---- mouse

    def onMouseMove(_flags, x, y, view)
      hit = Picking.pick(view, x, y, Sketchup::Edge)
      chain = []
      if hit && Chain.crease?(hit[0])
        chain = alt_down? ? [hit[0]] : Chain.tangent_chain(hit[0], chain_tolerance)
        @hover_world = hit[1] == @entities ? api_world : hit[2] * Bridge.frame(hit[1]).inverse
      end
      if chain != @hover
        @hover = chain
        view.invalidate
      end
    end

    def onLButtonDown(flags, x, y, view)
      hit = Picking.pick(view, x, y, Sketchup::Edge)
      return clear_selection unless hit
      edge, entities, world = hit
      unless Chain.crease?(edge)
        message('This edge has no crease to round: it needs two faces that meet at an angle.')
        return
      end
      switch_context(entities, world)
      chain = (flags & ALT_MODIFIER_MASK) != 0 ? [edge] : Chain.tangent_chain(edge, chain_tolerance)
      toggle = (flags & CONSTRAIN_MODIFIER_MASK) != 0
      add = (flags & COPY_MODIFIER_MASK) != 0
      if toggle
        chain.each { |e| @edges.include?(e) ? @edges.delete(e) : @edges << e }
      elsif add
        chain.each { |e| @edges << e unless @edges.include?(e) }
      else
        @edges = chain
      end
      refresh
      view.invalidate
    end

    def onLButtonDoubleClick(_flags, x, y, view)
      hit = Picking.pick(view, x, y, Sketchup::Face)
      return unless hit
      switch_context(hit[1], hit[2])
      Chain.face_loop(hit[0]).each { |e| @edges << e unless @edges.include?(e) }
      refresh
      view.invalidate
    end

    def onReturn(_view) apply end

    # VCB: "8mm", "5mm;12mm" (start;end radius), "6s" (segments)
    def onUserText(text, view)
      t = text.strip
      if t =~ /\A(\d+)\s*s\z/i
        set_params('segments' => Regexp.last_match(1).to_i)
      else
        r1, r2 = t.split(';').map { |s| s.strip.to_l.to_f }
        updates = { 'radius' => r1 }
        updates.merge!('radius_end' => r2, 'variable' => true) if r2
        set_params(updates)
      end
      @ui.push
      view.invalidate
    rescue ArgumentError
      UI.beep
      message('Type a length such as 5 mm, two lengths such as 5 mm;12 mm, or a segment count such as 8s.')
    end

    # ---- drawing

    def draw(view)
      Overlay.draw_lines(view, Overlay.edge_lines(@hover, @hover_world || api_world), Overlay::BLUE_SOFT, 3, '-')
      Overlay.draw_lines(view, Overlay.edge_lines(@edges, api_world), Overlay::BLUE, 4)
      Overlay.draw_lines(view, @lines[:soft], Overlay::BLUE_SOFT, 1)
      Overlay.draw_lines(view, @lines[:hard], Overlay::BLUE, 2)
      Overlay.draw_lines(view, Overlay.edge_lines(@collide, api_world), Overlay::RED, 5)
    end

    def getExtents
      bb = Geom::BoundingBox.new
      pts = @lines[:hard] + @lines[:soft] + Overlay.edge_lines(@edges, api_world)
      bb.add(pts) unless pts.empty?
      bb
    end

    # ---- dialog bridge

    def set_params(updates)
      @params = Engine.normalize_params(@params.merge(updates))
      Settings.save(@params)
      refresh
      Sketchup.active_model.active_view.invalidate
    rescue ArgumentError => e
      message(e.message)
    end

    def state
      {
        'mode' => 'create',
        'params' => @params,
        'stats' => stats,
        'message' => @message
      }
    end

    def action(name)
      case name
      when 'apply' then apply
      when 'clear' then clear_selection
      when 'reverse' then set_params('reverse' => !@params['reverse'])
      when 'pick_profile' then Sketchup.active_model.tools.push_tool(ProfilePickTool.new(self))
      end
    end

    def custom_profile_picked(unit)
      set_params('custom_profile' => unit, 'profile' => 'custom')
      message("Custom profile set: #{unit.size} points.")
      @ui.push
    end

    # ---- operation

    def apply
      edges = @edges.select(&:valid?)
      return message('Select edges to round first.') if edges.empty?
      result = Commands.fillet(edges, @entities, @params)
      @edges = []
      @preview = nil
      @lines = { hard: [], soft: [] }
      @collide = []
      message(result)
      @ui.push
      Sketchup.active_model.active_view.invalidate
    rescue UserError => e
      message(e.message)
      UI.beep
    rescue StandardError => e
      Diagnostics.report(e, 'apply')
      message("The fillet failed: #{e.message}")
    end

    private

    def alt_down?() false end

    # Transformation from API positions of the edited entities to world.
    def api_world
      @api_world || @world
    end

    def chain_tolerance() 30.degrees end

    def adopt_selection
      model = Sketchup.active_model
      edges = model.selection.grep(Sketchup::Edge).select { |e| Chain.crease?(e) }
      return if edges.empty?
      @entities = model.active_entities
      @world = model.edit_transform
      @api_world = nil
      @edges = edges
      model.selection.clear
    end

    def switch_context(entities, world)
      return if @entities == entities
      @entities = entities
      @world = world
      @api_world = nil
      @edges = []
    end

    def clear_selection
      @edges = []
      refresh
      Sketchup.active_model.active_view.invalidate
    end

    def refresh
      @edges.select!(&:valid?)
      @collide = []
      if @edges.empty?
        @preview = nil
        @lines = { hard: [], soft: [] }
        @message = nil
        @ui.push
        return
      end
      frame = Bridge.frame(@entities)
      @api_world = @world * frame.inverse
      mesh, vmap = Bridge.capture(Bridge.region_faces(@edges), frame, with_uv: false)
      keys = @edges.map { |e| [vmap[e.start], vmap[e.end]] }
      @preview = Engine.run(mesh, keys, @params)
      # engine points are local to the edited entities
      @lines = Overlay.lines_for(@preview, @world)
      bad = @preview.collisions.keys + @preview.rejected.keys
      @collide = @edges.select { |e| bad.include?(Mesh.edge_key(vmap[e.start], vmap[e.end])) }
      @message = summary
      @ui.push
    rescue StandardError => e
      Diagnostics.report(e, 'preview')
      @message = "Preview failed: #{e.message}"
      @ui.push
    end

    def summary
      res = @preview
      return res.fatal if res.fatal
      if res.collisions.any?
        max = res.collisions.values.min
        return "Radius clamped to #{Sketchup.format_length(max)} where it would overrun a face." if @params['clamp']
      end
      return "#{res.rejected.size} edge(s) skipped: #{res.rejected.values.first}" if res.rejected.any?
      'Ready'
    end

    def stats
      return { 'edges' => 0, 'chains' => 0, 'junctions' => 0, 'clamped' => 0 } unless @preview
      s = @preview.stats.dup
      s['edges'] ||= @edges.size
      s['clamped'] = @preview.collisions.size
      s
    end

    def message(text)
      @message = text
      Sketchup.status_text = ".SketchCorner: #{text}"
      @ui.push
    end

    def status
      Sketchup.status_text = 'Click an edge to round it and its tangent chain. Shift toggles, Ctrl adds, ' \
                             'double-click a face for its loop, Enter applies.'
      Sketchup.vcb_label = 'Radius'
      Sketchup.vcb_value = Sketchup.format_length(@params['radius'])
    end
  end

  # ============================================================== EditTool
  class EditTool
    def initialize(ui)
      @ui = ui
      @group = nil
      @op_id = nil
      @params = Settings.load
      @world = Geom::Transformation.new
      @lines = { hard: [], soft: [] }
      @hover = nil
      @message = nil
    end

    def activate
      @ui.attach(self, :edit)
      sel = Sketchup.active_model.selection.find { |e| Parametric.sc_group?(e) }
      pick(sel, sel.transformation, nil) if sel
      Sketchup.status_text = 'Click a .SketchCorner group (or a rounded face inside it) to edit its fillet.'
      @ui.push
    end

    def deactivate(view)
      @ui.detach(self)
      view.invalidate
    end

    def resume(view) view.invalidate end

    def onMouseMove(_flags, x, y, view)
      hit = Picking.pick_group(view, x, y)
      h = hit && [hit[0], hit[1]]
      return if h == @hover
      @hover = h
      view.invalidate
    end

    def onLButtonDown(_flags, x, y, view)
      hit = Picking.pick_group(view, x, y)
      return message('That is not a .SketchCorner group.') unless hit
      pick(*hit)
      view.invalidate
    end

    def onReturn(_view) action('apply') end

    def draw(view)
      if @hover
        bb = @hover[0].definition.bounds
        corners = (0..7).map { |i| @hover[1] * bb.corner(i) }
        box = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
        Overlay.draw_lines(view, box.flat_map { |a, b| [corners[a], corners[b]] }, Overlay::BLUE_SOFT, 1, '-')
      end
      Overlay.draw_lines(view, @lines[:soft], Overlay::BLUE_SOFT, 1)
      Overlay.draw_lines(view, @lines[:hard], Overlay::BLUE, 2)
    end

    def getExtents
      bb = Geom::BoundingBox.new
      pts = @lines[:hard] + @lines[:soft]
      bb.add(pts) unless pts.empty?
      bb
    end

    def set_params(updates)
      if updates.key?('op_id')
        select_op(updates.delete('op_id'))
      end
      @params = Engine.normalize_params(@params.merge(updates))
      refresh
    rescue ArgumentError => e
      message(e.message)
    end

    def state
      list = @group ? Parametric.ops(@group) : []
      {
        'mode' => 'edit',
        'params' => @params,
        'ops' => list.each_with_index.map do |o, i|
          { 'id' => o['id'], 'label' => "Fillet #{i + 1}: #{o['params']['profile']}, #{o['edges'].size} edges",
            'editable' => @group && Parametric.editable?(@group, o) }
        end,
        'op_id' => @op_id,
        'stats' => @preview ? @preview.stats.merge('clamped' => @preview.collisions.size) : {},
        'message' => @message
      }
    end

    def action(name)
      return message('Click a .SketchCorner group first.') unless @group && @op_id
      case name
      when 'apply'
        _res, warnings = Parametric.regenerate(@group, @op_id, @params)
        message(warnings.empty? ? 'Fillet updated.' : "Fillet updated. #{warnings.join(' ')}")
      when 'revert'
        Parametric.revert(@group, @op_id)
        message('Fillet removed; the original edges are back.')
        reload
      when 'bake'
        Parametric.bake(@group)
        message('History baked. The geometry is now plain faces.')
        @group = nil
        @op_id = nil
        @lines = { hard: [], soft: [] }
      when 'pick_profile'
        Sketchup.active_model.tools.push_tool(ProfilePickTool.new(self))
      end
      @ui.push
      Sketchup.active_model.active_view.invalidate
    rescue UserError => e
      UI.beep
      message(e.message)
    rescue StandardError => e
      Diagnostics.report(e, 'edit')
      message("Edit failed: #{e.message}")
    end

    def custom_profile_picked(unit)
      set_params('custom_profile' => unit, 'profile' => 'custom')
      @ui.push
    end

    private

    def pick(group, world, leaf)
      @group = group
      @world = world
      list = Parametric.ops(group)
      return message('This group has no stored fillets.') if list.empty?
      op = leaf.is_a?(Sketchup::Face) && list.find { |o| o['id'] == leaf.get_attribute(Bridge::DICT, 'op') }
      select_op((op || list.last)['id'])
      Sketchup.status_text = 'Change the parameters, then Update fillet (Enter).'
    end

    def reload
      list = Parametric.ops(@group)
      if list.empty?
        @op_id = nil
        @lines = { hard: [], soft: [] }
      else
        select_op(list.last['id'])
      end
    end

    def select_op(id)
      op = Parametric.find(@group, id)
      @op_id = id
      @params = Engine.normalize_params(Engine::DEFAULTS.merge(op['params']))
      @message = Parametric.editable?(@group, op) ? nil : 'A later edit changed this fillet; it can only be baked.'
      refresh
    end

    def refresh
      return unless @group && @op_id
      @preview = Parametric.preview(@group, @op_id, @params)
      @lines = Overlay.lines_for(@preview, @world)
      @message = @preview.fatal if @preview.fatal
      @ui.push
      Sketchup.active_model.active_view.invalidate
    end

    def message(text)
      @message = text
      Sketchup.status_text = ".SketchCorner: #{text}"
      @ui.push
    end
  end

  # ======================================================= ProfilePickTool
  class ProfilePickTool
    def initialize(owner)
      @owner = owner
      @flip = false
    end

    def activate
      Sketchup.status_text = 'Click an open polyline or arc drawn as the profile. ' \
                             'Hold Shift to flip which side it bulges. Esc cancels.'
    end

    def onLButtonDown(flags, x, y, view)
      hit = Picking.pick(view, x, y, Sketchup::Edge)
      return UI.beep unless hit
      pts = Chain.polyline_points(hit[0]).map(&:to_a)
      flip = (flags & CONSTRAIN_MODIFIER_MASK) != 0
      unit = Profiles.normalize_custom(pts.map { |p| p.map(&:to_f) }, flip)
      view.model.tools.pop_tool
      @owner.custom_profile_picked(unit)
    rescue ArgumentError => e
      UI.beep
      Sketchup.status_text = ".SketchCorner: #{e.message}"
    end

    def onCancel(_reason, view) view.model.tools.pop_tool end
  end

  # ============================================================= Commands
  module Commands
    module_function

    # Rounds +edges+ (all in +entities+). Returns a status message.
    def fillet(edges, entities, params)
      model = Sketchup.active_model
      model.start_operation(Parametric::OP_NAME, true)
      begin
        group = Bridge.owner_group(entities)
        if group.nil? && entities.parent.is_a?(Sketchup::Model)
          # loose geometry: wrap everything connected into a .SketchCorner
          # group so the fillet can be edited later
          pairs = edges.map { |e| [e.start.position, e.end.position] }
          connected = edges.flat_map(&:all_connected).uniq
          group = entities.add_group(connected)
          group.name = Parametric::OP_NAME
          entities = group.entities
          edges = Bridge.find_edges(entities, pairs)
          raise UserError, 'The selection could not be grouped.' if edges.empty?
        end
        Parametric.unique!(group) if group
        frame = Bridge.frame(entities)
        faces = Bridge.region_faces(edges)
        mesh, vmap = Bridge.capture(faces, frame, with_uv: true)
        keys = edges.map { |e| [vmap[e.start], vmap[e.end]] }
        res = Engine.run(mesh, keys, params)
        raise UserError, res.fatal unless res.ok
        op_id = group ? Parametric.new_id : nil
        Bridge.erase_region(entities, faces)
        created, warnings = Bridge.write(entities, res, op_id, params, frame)
        Parametric.record(group, op_id, mesh, keys, params, created.size) if group
        model.commit_operation
        msg = "Rounded #{res.stats['edges']} edge(s): #{created.size} faces."
        msg += ' Inside a component: history is not stored.' unless group
        msg += " #{res.collisions.size} edge(s) clamped." if res.collisions.any?
        msg += " #{warnings.join(' ')}" if warnings.any?
        msg
      rescue StandardError
        model.abort_operation
        raise
      end
    end
  end
end
