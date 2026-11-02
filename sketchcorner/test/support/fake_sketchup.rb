# frozen_string_literal: true
#
# Minimal in-memory stand-in for the parts of the SketchUp Ruby API that
# .SketchCorner uses. It merges vertices/edges by position like SketchUp does,
# so the extension's capture -> engine -> write -> regenerate path can be run
# end to end under plain Ruby. It is a test double, not a geometry kernel.

require_relative '../../src/SketchCorner/core/vmath'

class Numeric
  def degrees() self * Math::PI / 180.0 end
end

class Length < Float; end

class String
  UNIT = { 'mm' => 1 / 25.4, 'cm' => 1 / 2.54, 'm' => 1 / 0.0254, 'in' => 1.0, '"' => 1.0, '' => 1.0 }.freeze
  def to_l
    m = strip.match(/\A(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|")?\z/) or raise ArgumentError, "Cannot convert #{self} to length"
    m[1].to_f * UNIT[m[2].to_s]
  end
end

MF_CHECKED = 1
MF_UNCHECKED = 0
CONSTRAIN_MODIFIER_MASK = 4
COPY_MODIFIER_MASK = 8
ALT_MODIFIER_MASK = 32
GL_LINES = 1

$fake_loaded = []
def file_loaded?(f) $fake_loaded.include?(f) end
def file_loaded(f) $fake_loaded << f end

module Geom
  class Vector3d
    attr_reader :x, :y, :z
    def initialize(x = 0, y = 0, z = 0) @x, @y, @z = x.to_f, y.to_f, z.to_f end
    def to_a() [x, y, z] end
    def dot(o) x * o.x + y * o.y + z * o.z end
    def *(o) Vector3d.new(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x) end
    def length() Math.sqrt(dot(self)) end
    def normalize() l = length; Vector3d.new(x / l, y / l, z / l) end
    def reverse() Vector3d.new(-x, -y, -z) end
    def angle_between(o) Math.acos([[dot(o) / (length * o.length), -1.0].max, 1.0].min) end
    def axes
      xa = (Vector3d.new(0, 0, 1) * self)
      xa = (Vector3d.new(0, 1, 0) * self) if xa.length < 1e-9
      xa = xa.normalize
      [xa, (self * xa).normalize, self]
    end
  end

  class Point3d
    attr_reader :x, :y, :z
    def initialize(x = 0, y = 0, z = 0) @x, @y, @z = x.to_f, y.to_f, z.to_f end
    def to_a() [x, y, z] end
    def -(o) Vector3d.new(x - o.x, y - o.y, z - o.z) end
    def offset(v, d) l = v.length; Point3d.new(x + v.x / l * d, y + v.y / l * d, z + v.z / l * d) end
    def ==(o) o.respond_to?(:to_a) && SketchCorner::VMath.same?(to_a, o.to_a, 1e-6) end
  end

  class Transformation
    attr_reader :t
    def initialize(t = [0, 0, 0]) @t = t end
    def identity?() @t.all?(&:zero?) end
    def inverse() Transformation.new(@t.map(&:-@)) end
    def *(o)
      case o
      when Point3d then Point3d.new(o.x + t[0], o.y + t[1], o.z + t[2])
      when Vector3d then o
      when Transformation then Transformation.new([t[0] + o.t[0], t[1] + o.t[1], t[2] + o.t[2]])
      end
    end
  end

  class BoundingBox
    def initialize() @pts = [] end
    def add(*p) @pts.concat(p.flatten); self end
    def contains?(_p) true end
    def empty?() @pts.empty? end
  end
end

module Sketchup
  class Entity
    def initialize() @attrs = {}; @valid = true end
    def valid?() @valid end
    def erase_() @valid = false end
    def get_attribute(d, k, default = nil) (@attrs[d] || {}).fetch(k, default) end
    def set_attribute(d, k, v) (@attrs[d] ||= {})[k] = v end
    def delete_attribute(d, k = nil) k ? (@attrs[d] || {}).delete(k) : @attrs.delete(d) end
    def model() Sketchup.active_model end
  end

  class Vertex < Entity
    attr_reader :position, :edges
    def initialize(p) super(); @position = p; @edges = [] end
    def faces() @edges.flat_map(&:faces).uniq end
  end

  class Edge < Entity
    attr_reader :start, :end, :faces, :parent
    attr_accessor :soft, :smooth, :hidden
    def initialize(a, b, parent) super(); @start, @end, @parent = a, b, parent; @faces = []; @soft = @smooth = @hidden = false end
    def soft?() @soft end
    def smooth?() @smooth end
    def hidden?() @hidden end
    def vertices() [@start, @end] end
    def line() [@start.position, (@end.position - @start.position).normalize] end
    def reversed_in?(face)
      face.loops.each do |lp|
        vs = lp.vertices
        vs.each_with_index do |v, i|
          w = vs[(i + 1) % vs.size]
          return false if v == @start && w == @end
          return true if v == @end && w == @start
        end
      end
      false
    end

    def all_connected
      seen = {}
      stack = [self]
      until stack.empty?
        e = stack.pop
        next if seen[e]
        seen[e] = true
        e.vertices.each { |v| v.edges.each { |x| stack << x unless seen[x] } }
        e.faces.each { |f| seen[f] = true }
      end
      seen.keys
    end
  end

  class Loop
    attr_reader :vertices
    def initialize(v) @vertices = v end
    def edges() @edges ||= [] end
  end

  class Face < Entity
    attr_reader :loops, :parent
    attr_accessor :material, :back_material, :layer, :uv_calls
    def initialize(loops, parent) super(); @loops = loops; @parent = parent; @uv_calls = [] end
    def outer_loop() @loops[0] end
    def vertices() @loops[0].vertices end
    def edges() @loops.flat_map(&:edges).uniq end
    def normal
      n = SketchCorner::VMath.norm(SketchCorner::VMath.newell(outer_loop.vertices.map { |v| v.position.to_a }))
      Geom::Vector3d.new(*n)
    end
    def reverse!
      @loops.each { |l| l.vertices.reverse! }
      self
    end
    def position_material(m, pairs, front) @uv_calls << [m, pairs, front] end
    def get_UVHelper(*) UVHelper.new end
  end

  class UVHelper
    def get_front_UVQ(p) Geom::Point3d.new(p.x / 10.0, p.y / 10.0 + p.z / 10.0, 1) end
    alias get_back_UVQ get_front_UVQ
  end

  class Texture
    def width() 10.0 end
    def height() 10.0 end
  end

  class Material
    attr_reader :name, :texture
    def initialize(name, textured) @name = name; @texture = textured ? Texture.new : nil end
  end

  class Layer
    attr_reader :name
    def initialize(n) @name = n end
  end

  class Entities
    include Enumerable
    attr_reader :parent
    def initialize(parent) @parent = parent; @items = []; @verts = [] end
    def each(&b) @items.select(&:valid?).each(&b) end
    def model() Sketchup.active_model end

    def vertex_at(p)
      @verts.find { |v| v.position == p } || (@verts << Vertex.new(p)).last
    end

    def edge_between(a, b)
      e = a.edges.find { |x| x.valid? && x.vertices.include?(b) }
      return e if e
      e = Edge.new(a, b, @parent)
      a.edges << e
      b.edges << e
      @items << e
      e
    end

    def add_face(*pts)
      pts = pts.flatten
      vs = pts.map { |p| vertex_at(p) }
      raise ArgumentError, 'Duplicate points in array' if vs.uniq.size != vs.size
      raise ArgumentError, 'Points are not planar' unless SketchCorner::VMath.planar?(pts.map(&:to_a), 1e-3)
      lp = Loop.new(vs)
      face = Face.new([lp], @parent)
      vs.each_with_index do |v, i|
        e = edge_between(v, vs[(i + 1) % vs.size])
        e.faces << face
        lp.edges << e
      end
      @items << face
      face
    end

    def add_group(ents)
      g = Group.new
      ents.grep(Face).each do |f|
        nf = g.entities.add_face(f.outer_loop.vertices.map(&:position))
        nf.material = f.material
      end
      ents.grep(Edge).each do |e|
        ne = g.entities.edge_between(g.entities.vertex_at(e.start.position), g.entities.vertex_at(e.end.position))
        ne.soft = e.soft
        ne.smooth = e.smooth
      end
      erase_entities(ents)
      @items << g
      g
    end

    def erase_entities(ents)
      ents.each do |x|
        next unless x.valid?
        x.erase_
        if x.is_a?(Edge)
          x.faces.each(&:erase_)
          x.vertices.each { |v| v.edges.delete(x) }
        end
        if x.is_a?(Face)
          x.edges.each { |e| e.faces.delete(x) }
        end
      end
      @items.select(&:valid?).grep(Edge).each { |e| e.faces.select!(&:valid?) }
      @verts.reject! { |v| v.edges.none?(&:valid?) }
    end
  end

  class ComponentDefinition < Entity
    attr_reader :entities, :instances
    def initialize(group) super(); @entities = Entities.new(self); @instances = [group] end
    def group?() true end
    def count_instances() 1 end
    def bounds() Geom::BoundingBox.new end
  end

  class Group < Entity
    attr_accessor :name
    attr_reader :definition
    def initialize() super(); @definition = ComponentDefinition.new(self); @name = '' end
    def entities() @definition.entities end
    def transformation() Geom::Transformation.new end
  end

  class Model
    attr_reader :entities, :materials, :layers, :ops, :selection
    def initialize
      @entities = Entities.new(self)
      @materials = Collection.new([Material.new('Oak', true), Material.new('Paint', false)])
      @layers = Collection.new([Layer.new('Untagged')])
      @ops = []
      @selection = []
    end
    def active_entities() @entities end
    def active_path() nil end
    def edit_transform() Geom::Transformation.new end
    def start_operation(name, _ui = false) @ops << [:start, name] end
    def commit_operation() @ops << [:commit] end
    def abort_operation() @ops << [:abort] end
    def active_view() View.new end
  end

  class View
    def invalidate() end
  end

  class Collection
    include Enumerable
    def initialize(items) @items = items end
    def each(&b) @items.each(&b) end
    def [](n) @items.find { |i| i.name == n } end
    def add(n) (@items << Layer.new(n)).last end
  end

  @defaults = {}
  class << self
    attr_accessor :status_text, :vcb_label, :vcb_value
    def active_model() @model ||= Model.new end
    def reset!() @model = Model.new end
    def read_default(s, k, d = nil) @defaults.fetch([s, k], d) end
    def write_default(s, k, v) @defaults[[s, k]] = v end
    def format_length(l) format('%.2f mm', l.to_f * 25.4) end
    def create_texture_writer() Object.new end
    def platform() :platform_win end
  end
end

module UI
  def self.beep() end
end
