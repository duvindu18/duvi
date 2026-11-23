#version 440
#include "common.glsl"
layout(binding = 1) uniform sampler2D t_base;
layout(binding = 2) uniform sampler2D t_op;
layout(binding = 3) uniform sampler2D t_nrm;
layout(binding = 4) uniform sampler2D t_rough;
layout(location = 0) in vec3 v_wpos;
layout(location = 1) in vec3 v_nrm;
layout(location = 2) in vec2 v_uv;
layout(location = 0) out vec4 frag;

// FBX UVs have v=0 at the bottom; uploaded images have row 0 at the top.
vec2 xf(vec4 t) { vec2 q = v_uv * t.xy + t.zw; return vec2(q.x, 1.0 - q.y); }

void main() {
    float alpha = u.base.a;
    vec4 bc = vec4(u.base.rgb, 1.0);
    bool clay = u.flags2.w > 0.5;
    if (u.flags.x > 0.5) {
        vec4 tb = texture(t_base, xf(u.uvx_base));
        bc = clay ? vec4(bc.rgb, tb.a) : tb;
    }
    if (u.flags.y > 0.5) alpha *= texture(t_op, xf(u.uvx_op)).r;
    else if (u.flags2.x > 0.5 && u.flags.x > 0.5) alpha *= bc.a;
    if (alpha < 0.5) discard;

    vec3 N = normalize(v_nrm);
    vec3 V = normalize(u.cam.xyz - v_wpos);
    if (!gl_FrontFacing) N = -N;
    if (u.flags.z > 0.5 && !clay) {
        vec3 t = texture(t_nrm, xf(u.uvx_nrm)).xyz * 2.0 - 1.0;
        if (u.flags2.z > 0.5) t.y = -t.y;       // DirectX map -> this (Y+) frame
        vec3 dp1 = dFdx(v_wpos), dp2 = dFdy(v_wpos) * u.cam.w;
        vec2 du1 = dFdx(v_uv),   du2 = dFdy(v_uv) * u.cam.w;
        vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
        vec3 T = dp2perp * du1.x + dp1perp * du2.x;
        vec3 B = dp2perp * du1.y + dp1perp * du2.y;
        float inv = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-20);
        N = normalize(mat3(T * inv, B * inv, N) * t);
    }
    float rough = u.params.x;
    if (u.flags.w > 0.5 && !clay) {
        rough = texture(t_rough, xf(u.uvx_rough)).r;
        if (u.flags2.y > 0.5) rough = 1.0 - rough;
    }
    vec3 albedo = clay ? vec3(0.72) : pow(bc.rgb, vec3(2.2));
    vec3 L = normalize(vec3(0.45, 0.85, 0.35));
    vec3 H = normalize(L + V);
    float ndl = dot(N, L);
    float diff = max(ndl, 0.0);
    float trans = (u.params.z > 0.5 && !clay) ? max(-ndl, 0.0) * 0.45 : 0.0;
    float sky = 0.5 + 0.5 * N.y;
    vec3 amb = mix(vec3(0.20, 0.19, 0.18), vec3(0.42, 0.45, 0.50), sky);
    float a2 = max(rough * rough, 0.02);
    float spec = pow(max(dot(N, H), 0.0), 2.0 / (a2 * a2) - 1.0) * (1.0 - rough) * 0.6;
    vec3 col = albedo * (amb + diff * vec3(1.05, 1.0, 0.95) + trans * vec3(1.0, 1.0, 0.6));
    col += spec * mix(vec3(0.04), albedo, u.params.y) * diff;
    if (u.params.w > 0.5) {
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
        col = mix(col, u.sel_col.rgb, 0.18 + 0.55 * rim);
    }
    col = col / (col + vec3(0.85)) * 1.6;
    frag = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
