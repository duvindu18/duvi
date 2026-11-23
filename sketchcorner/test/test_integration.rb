# frozen_string_literal: true
#
# Runs the SketchUp-facing code (Bridge, Commands, Parametric, FilletTool)
# against the in-memory API double in support/fake_sketchup.rb.

require 'minitest/autorun'
require 'json'
require_relative 'support/fake_sketchup'
%w[vmath mesh profiles uv engine bridge parametric tool ui].each do |f|
  require_relative "../src/SketchCorner/core/#{f}"
end
module SketchCorner
  VERSION = '1.0.0' unless defined?(VERSION)
end

class NullUI
  attr_reader :pushes
  def initialize() @pushes = 0 end
  def attach(*) end
  def detach(*) end
  def push() @pushes += 1 end
end

class TestIntegration < Minitest::Test
  P = Geom::Point3d

  def setup
    Sketchup.reset!
    @model = Sketchup.active_model
    @ents = @model.active_entities
    c = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map { |a| P.new(*a) }
    [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]].each do |l|
      f = @ents.add_face(l.map { |i| c[i] })
      f.material = @model.materials['Oak']
    end
  end

  def edge(p, q)
    SketchCorner::Bridge.find_edges(@ents, [[P.new(*p), P.new(*q)]]).first
  end

  def solid?(entities)
    entities.grep(Sketchup::Edge).all? { |e| e.faces.size == 2 }
  end

  def test_apply_edit_revert_bake
    top = [edge([0, 0, 10], [10, 0, 10]), edge([10, 0, 10], [10, 10, 10]), edge([10, 0, 0], [10, 0, 10])]
    params = SketchCorner::Engine.normalize_params('radius' => 1.0, 'segments' => 4)
    msg = SketchCorner::Commands.fillet(top, @ents, params)
    assert_match(/Rounded 3 edge/, msg)
    assert_equal [[:start, '.SketchCorner'], [:commit]], @model.ops

    group = @ents.grep(Sketchup::Group).first
    assert SketchCorner::Parametric.sc_group?(group)
    ops = SketchCorner::Parametric.ops(group)
    assert_equal 1, ops.size
    assert_equal [[0, 1], [1, 2], [3, 1]].size, ops[0]['edges'].size
    assert solid?(group.entities), 'result is a closed solid'

    soft = group.entities.grep(Sketchup::Edge).count(&:soft?)
    assert soft.positive?, 'internal strip edges are soft'
    textured = group.entities.grep(Sketchup::Face).select { |f| f.get_attribute('SketchCorner', 'kind') == 'strip' }
    assert textured.all? { |f| f.material && f.material.name == 'Oak' }, 'strips inherit the face material'
    assert textured.all? { |f| f.uv_calls.any? }, 'strips get UV placement'

    before = group.entities.grep(Sketchup::Face).size
    SketchCorner::Parametric.regenerate(group, ops[0]['id'], params.merge('segments' => 8, 'miter' => 'blend'))
    after = group.entities.grep(Sketchup::Face).size
    assert after > before, 'more segments, more faces'
    assert solid?(group.entities)
    assert_equal 8, SketchCorner::Parametric.ops(group)[0]['params']['segments']

    SketchCorner::Parametric.revert(group, ops[0]['id'])
    assert_equal 6, group.entities.grep(Sketchup::Face).size, 'revert restores the box'
    assert solid?(group.entities)
    assert_empty SketchCorner::Parametric.ops(group)
  end

  def test_stale_op_is_locked
    params = SketchCorner::Engine.normalize_params('radius' => 1.0)
    SketchCorner::Commands.fillet([edge([0, 0, 10], [10, 0, 10])], @ents, params)
    group = @ents.grep(Sketchup::Group).first
    first = SketchCorner::Parametric.ops(group)[0]
    e2 = SketchCorner::Bridge.find_edges(group.entities, [[P.new(0, 0, 0), P.new(10, 0, 0)]])
    SketchCorner::Commands.fillet(e2, group.entities, params)
    assert_equal 2, SketchCorner::Parametric.ops(group).size
    second = SketchCorner::Parametric.ops(group)[1]
    refute SketchCorner::Parametric.editable?(group, first), 'the second fillet rewrote faces of the first'
    assert SketchCorner::Parametric.editable?(group, second), 'the latest fillet stays editable'
    assert_raises(SketchCorner::UserError) { SketchCorner::Parametric.regenerate(group, first['id'], params) }
    SketchCorner::Parametric.bake(group)
    refute SketchCorner::Parametric.sc_group?(group)
  end

  def test_failed_apply_aborts
    params = SketchCorner::Engine.normalize_params('radius' => 30.0, 'clamp' => false)
    assert_raises(SketchCorner::UserError) do
      SketchCorner::Commands.fillet([edge([0, 0, 10], [10, 0, 10]), edge([0, 10, 10], [10, 10, 10])], @ents, params)
    end
    assert_equal :abort, @model.ops.last[0]
  end

  def test_tool_preview_and_chain
    ui = NullUI.new
    tool = SketchCorner::FilletTool.new(ui)
    e = edge([0, 0, 10], [10, 0, 10])
    assert SketchCorner::Chain.crease?(e)
    assert SketchCorner::Chain.convex?(e)
    assert_equal [e], SketchCorner::Chain.tangent_chain(e), 'box corners are not tangent'
    loop_edges = SketchCorner::Chain.face_loop(@ents.grep(Sketchup::Face).find { |f| f.normal.z > 0.9 })
    assert_equal 4, loop_edges.size
    tool.instance_variable_set(:@entities, @ents)
    tool.instance_variable_set(:@edges, loop_edges)
    tool.send(:refresh)
    st = tool.state
    assert_equal 4, st['stats']['edges']
    assert_equal 'Ready', st['message']
    tool.set_params('radius' => 7.0)
    assert tool.state['stats']['clamped'].positive?, 'oversized radius is clamped in the preview'
    assert_match(/clamped/, tool.state['message'])
  end

  def test_settings_round_trip
    SketchCorner::Settings.save(SketchCorner::Engine.normalize_params('profile' => 'cove', 'segments' => 9))
    s = SketchCorner::Settings.load
    assert_equal 'cove', s['profile']
    assert_equal 9, s['segments']
  end
end
