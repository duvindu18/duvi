# frozen_string_literal: true
#
# .SketchCorner - parametric history and non-destructive editing.
#
# Every fillet operation stores a record on the group that holds it, in the
# attribute dictionary "SketchCorner", key "ops" (a JSON array):
#
#   {
#     "id":       "lq3k9x2a",              # also written on every face it made
#     "version":  1,
#     "created":  "2026-11-02T10:00:00Z",
#     "params":   { profile, segments, radius, ... },
#     "edges":    [[12, 13], [13, 14]],    # edge node indices into the snapshot
#     "faces":    42,                      # faces written; detects later edits
#     "snapshot": "z:eJy..."               # deflated + base64 Mesh#to_h of the
#   }                                      # faces before the operation
#
# Because the snapshot holds the original faces around the selected edges,
# an operation can be regenerated with new parameters, reverted, or baked
# (history dropped) at any time, as long as no later operation consumed its
# faces.

require 'json'
require_relative 'mesh'
require_relative 'engine'
require_relative 'bridge'

begin
  require 'zlib'
rescue LoadError
  nil
end

module SketchCorner
  class UserError < StandardError; end

  module Parametric
    DICT = 'SketchCorner'
    OP_NAME = '.SketchCorner'
    FORMAT_VERSION = 1

    module_function

    def sc_group?(entity)
      entity.is_a?(Sketchup::Group) && entity.valid? && entity.get_attribute(DICT, 'is_sc', false)
    end

    def ops(group)
      JSON.parse(group.get_attribute(DICT, 'ops', '[]'))
    rescue JSON::ParserError
      []
    end

    def save_ops(group, list)
      group.set_attribute(DICT, 'ops', JSON.generate(list))
      group.set_attribute(DICT, 'is_sc', !list.empty?)
    end

    def new_id
      Time.now.to_i.to_s(36) + rand(36**5).to_s(36).rjust(5, '0')
    end

    def pack(hash)
      json = JSON.generate(hash)
      return 'j:' + json unless defined?(Zlib)
      'z:' + [Zlib::Deflate.deflate(json, Zlib::BEST_COMPRESSION)].pack('m0')
    end

    def unpack(str)
      case str[0, 2]
      when 'z:' then JSON.parse(Zlib::Inflate.inflate(str[2..-1].unpack1('m0')))
      when 'j:' then JSON.parse(str[2..-1])
      else raise UserError, 'The stored fillet data is unreadable.'
      end
    end

    # Parameters worth storing (drops UI-only keys).
    def storable(params)
      Engine::DEFAULTS.keys.each_with_object({}) { |k, h| h[k] = params[k] }
    end

    def record(group, op_id, mesh, edge_keys, params, face_count)
      list = ops(group)
      list << {
        'id' => op_id,
        'version' => FORMAT_VERSION,
        'created' => Time.now.utc.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'params' => storable(params),
        'edges' => edge_keys,
        'faces' => face_count,
        'snapshot' => pack(mesh.to_h)
      }
      save_ops(group, list)
      group.name = OP_NAME if group.name.to_s.empty?
    end

    def find(group, op_id)
      ops(group).find { |o| o['id'] == op_id } or raise UserError, 'That fillet no longer exists.'
    end

    def faces_of(entities, op_id)
      entities.grep(Sketchup::Face).select { |f| f.get_attribute(DICT, 'op') == op_id }
    end

    # An op is editable while every face it wrote is still there.
    def editable?(group, op)
      faces_of(group.entities, op['id']).size == op['faces']
    end

    def snapshot_mesh(op) Mesh.from_h(unpack(op['snapshot'])) end

    # Live preview for edit mode: engine result without touching the model.
    def preview(group, op_id, params)
      op = find(group, op_id)
      Engine.run(snapshot_mesh(op), op['edges'], params)
    end

    def regenerate(group, op_id, params)
      op = find(group, op_id)
      ensure_editable!(group, op)
      res = Engine.run(snapshot_mesh(op), op['edges'], params)
      raise UserError, res.fatal unless res.ok
      transact do
        unique!(group)
        Bridge.erase_region(group.entities, faces_of(group.entities, op_id))
        created, warnings = Bridge.write(group.entities, res, op_id, params, Bridge.frame(group.entities))
        update(group, op_id) do |o|
          o['params'] = storable(params)
          o['faces'] = created.size
        end
        [res, warnings]
      end
    end

    # Puts the original faces back and forgets the operation.
    def revert(group, op_id)
      op = find(group, op_id)
      ensure_editable!(group, op)
      mesh = snapshot_mesh(op)
      transact do
        Bridge.erase_region(group.entities, faces_of(group.entities, op_id))
        res = original_result(mesh)
        Bridge.write(group.entities, res, nil, { 'uv' => true }, Bridge.frame(group.entities))
        save_ops(group, ops(group).reject { |o| o['id'] == op_id })
      end
    end

    # Drops the history; the geometry stays as it is.
    def bake(group)
      transact do
        list = ops(group)
        list.each { |o| faces_of(group.entities, o['id']).each { |f| f.delete_attribute(DICT) } }
        group.delete_attribute(DICT)
      end
    end

    def ensure_editable!(group, op)
      return if editable?(group, op)
      raise UserError, 'A later edit changed this fillet. Edit the latest fillet, or bake the history.'
    end

    def update(group, op_id)
      list = ops(group)
      list.each { |o| yield o if o['id'] == op_id }
      save_ops(group, list)
    end

    def unique!(group)
      group.make_unique if group.definition.count_instances > 1 && group.respond_to?(:make_unique)
    end

    # Snapshot faces as an engine Result so Bridge.write can rebuild them.
    def original_result(mesh)
      res = Engine::Result.new
      res.points = mesh.points
      res.point_meta = mesh.points.each_index.map { |i| { v: i } }
      res.polygons = mesh.faces.each_with_index.map do |f, fi|
        { kind: :face, group: [:face, fi], loops: f.loops, attrs: f.attrs || {}, uv: nil }
      end
      res.edge_flags = mesh.edge_flags.dup
      res.ok = true
      res
    end

    def transact
      model = Sketchup.active_model
      model.start_operation(OP_NAME, true)
      begin
        out = yield
        model.commit_operation
        out
      rescue StandardError
        model.abort_operation
        raise
      end
    end
  end

  # Remembered dialog settings (per user, across sessions).
  module Settings
    KEY = 'SketchCorner'

    module_function

    def load
      raw = Sketchup.read_default(KEY, 'params', nil)
      stored = raw ? JSON.parse(raw) : {}
      Engine::DEFAULTS.merge(stored.select { |k, _| Engine::DEFAULTS.key?(k) }).merge('reverse' => false)
    rescue StandardError
      Engine::DEFAULTS.dup
    end

    def save(params)
      Sketchup.write_default(KEY, 'params', JSON.generate(Parametric.storable(params).merge('reverse' => false)))
    end

    def debug?
      Sketchup.read_default(KEY, 'debug', false) ? true : false
    rescue StandardError
      false
    end
  end
end
