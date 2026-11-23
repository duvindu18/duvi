# frozen_string_literal: true
#
# .SketchCorner - lightweight polygon mesh (pure Ruby).
#
# A Mesh is the engine's view of the SketchUp faces it is allowed to change:
# points, planar faces made of loops of point indices (outer loop first,
# counter-clockwise around the face normal; holes clockwise, exactly like
# SketchUp), per-face attributes (materials, tag, UV maps) and per-edge flags.
# It serialises to a plain Hash, which is what the parametric history stores.

module SketchCorner
  class Mesh
    Face = Struct.new(:loops, :normal, :attrs)

    # One face corner: face index, loop index, position in that loop.
    Corner = Struct.new(:face, :loop, :pos)

    attr_reader :points, :faces, :edge_flags

    def initialize
      @points = []
      @faces = []
      @edge_flags = {}
      @topology = nil
    end

    def self.edge_key(a, b) a < b ? [a, b] : [b, a] end

    def add_point(p)
      @points << p.map(&:to_f)
      @topology = nil
      @points.size - 1
    end

    def add_face(loops, normal, attrs = {})
      @faces << Face.new(loops.map { |l| l.map(&:to_i) }, normal.map(&:to_f), attrs)
      @topology = nil
      @faces.size - 1
    end

    def set_edge_flags(a, b, flags)
      @edge_flags[Mesh.edge_key(a, b)] = flags
    end

    def flags_for(key)
      @edge_flags[key] || { 'soft' => false, 'smooth' => false, 'hidden' => false }
    end

    # ---- topology ---------------------------------------------------------

    # edge key => [[corner_of_tail, +1|-1]] ; +1 when the loop runs key[0]->key[1]
    def edge_uses
      build_topology
      @topology[:edge_uses]
    end

    def vertex_corners(v)
      build_topology
      @topology[:vertex_corners][v] || []
    end

    def edges_at(v)
      build_topology
      @topology[:vertex_edges][v] || []
    end

    def edge?(key) edge_uses.key?(key) end

    def loop_at(corner) @faces[corner.face].loops[corner.loop] end

    def corner_prev(corner)
      l = loop_at(corner)
      l[(corner.pos - 1) % l.size]
    end

    def corner_next(corner)
      l = loop_at(corner)
      l[(corner.pos + 1) % l.size]
    end

    def corner_vertex(corner) loop_at(corner)[corner.pos] end

    # Faces using an edge, with the loop direction relative to the key.
    def edge_faces(key) (edge_uses[key] || []).map { |c, _d| c.face } end

    def manifold_edge?(key)
      uses = edge_uses[key] || []
      uses.size == 2 && uses[0][1] != uses[1][1] && uses[0][0].face != uses[1][0].face
    end

    # Ordered fan of corners around vertex v. Consecutive corners share an
    # edge: corner i's out-edge is corner i+1's in-edge.
    # Returns [corners, closed] or nil when the vertex is non-manifold.
    def fan(v)
      corners = vertex_corners(v)
      return nil if corners.empty?
      by_in = {}
      corners.each do |c|
        key = [corner_prev(c), v]
        return nil if by_in.key?(key) # same directed edge twice: non-manifold
        by_in[key] = c
      end
      # An open fan starts at a corner whose in-edge has no partner face.
      start = corners.find { |c| !partner_for_in(c, v, corners) } || corners.first
      ordered = [start]
      cur = start
      loop do
        nxt = by_in[[corner_next(cur), v]]
        break if nxt.nil? || nxt.equal?(start)
        return nil if ordered.include?(nxt)
        ordered << nxt
        cur = nxt
      end
      return nil if ordered.size != corners.size # several disjoint fans
      closed = !by_in[[corner_next(ordered.last), v]].nil?
      [ordered, closed]
    end

    def to_h
      {
        'points' => @points,
        'faces' => @faces.map { |f| { 'loops' => f.loops, 'normal' => f.normal, 'attrs' => f.attrs } },
        'edges' => @edge_flags.map { |k, v| [k[0], k[1], v] }
      }
    end

    def self.from_h(h)
      m = Mesh.new
      h['points'].each { |p| m.add_point(p) }
      h['faces'].each { |f| m.add_face(f['loops'], f['normal'], f['attrs'] || {}) }
      (h['edges'] || []).each { |a, b, fl| m.set_edge_flags(a, b, fl) }
      m
    end

    private

    def partner_for_in(c, v, corners)
      prev = corner_prev(c)
      corners.any? { |o| !o.equal?(c) && corner_next(o) == prev }
    end

    def build_topology
      return if @topology
      edge_uses = {}
      vertex_corners = {}
      vertex_edges = {}
      @faces.each_with_index do |f, fi|
        f.loops.each_with_index do |l, li|
          l.each_with_index do |v, pos|
            c = Corner.new(fi, li, pos)
            (vertex_corners[v] ||= []) << c
            w = l[(pos + 1) % l.size]
            key = Mesh.edge_key(v, w)
            (edge_uses[key] ||= []) << [c, v < w ? 1 : -1]
            (vertex_edges[v] ||= []) << key
            (vertex_edges[w] ||= []) << key
          end
        end
      end
      vertex_edges.each_value(&:uniq!)
      @topology = { edge_uses: edge_uses, vertex_corners: vertex_corners, vertex_edges: vertex_edges }
    end
  end
end
