#version 440
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec2 a_uv;
#include "common.glsl"
layout(location = 0) out vec3 v_wpos;
layout(location = 1) out vec3 v_nrm;
layout(location = 2) out vec2 v_uv;
void main() {
    vec4 w = u.model * vec4(a_pos, 1.0);
    v_wpos = w.xyz;
    v_nrm = normalize(mat3(u.nmat) * a_nrm);
    v_uv = a_uv;
    gl_Position = u.mvp * vec4(a_pos, 1.0);
}
