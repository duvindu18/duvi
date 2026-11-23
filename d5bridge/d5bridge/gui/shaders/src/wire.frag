#version 440
#include "common.glsl"
layout(location = 0) in vec3 v_wpos;
layout(location = 1) in vec3 v_nrm;
layout(location = 2) in vec2 v_uv;
layout(location = 0) out vec4 frag;
void main() { frag = vec4(u.params.w > 0.5 ? u.sel_col.rgb : u.wire_col.rgb, 0.4); }
