#version 440
// lumo materials preview, fragment stage: GGX PBR, three lights + studio environment with softbox
// reflections, parallax occlusion mapping from the height map, specular occlusion from AO, ACES tone mapping.

layout(location = 0) in vec3 vPos;
layout(location = 1) in vec2 vUV;
layout(location = 2) in vec3 vN;
layout(location = 3) in vec4 vT;

layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform Params {
    mat4 viewProj;
    mat4 model;
    vec4 cam;
    vec4 tiling;
    vec4 lightDir[3];
    vec4 lightCol[3];
    vec4 skyTop;
    vec4 skyBot;
    vec4 misc;
};

layout(binding = 1) uniform sampler2D tAlbedo;
layout(binding = 2) uniform sampler2D tNormal;
layout(binding = 3) uniform sampler2D tRough;
layout(binding = 4) uniform sampler2D tMetal;
layout(binding = 5) uniform sampler2D tHeight;
layout(binding = 6) uniform sampler2D tAO;

const float PI = 3.14159265;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float g1(float x, float k) { return x / (x * (1.0 - k) + k); }
vec3 fresnel(float c, vec3 f0) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }

// Studio environment: sky gradient, ground bounce, an overhead softbox and a vertical strip light.
vec3 env(vec3 d, float rough)
{
    vec3 c = mix(skyBot.rgb, skyTop.rgb, smoothstep(-0.25, 0.9, d.y));
    float spread = mix(1.0, 6.0, rough);                       // rough surfaces see blurred light sources
    float box = exp(-pow(max(abs(d.x) - 0.25, 0.0) * 4.0 / spread, 2.0)) *
                exp(-pow((d.y - 0.75) * 5.0 / spread, 2.0)) * step(0.0, d.z + 0.6);
    float strip = exp(-pow((d.x + 0.85) * 7.0 / spread, 2.0)) * smoothstep(-0.3, 0.2, d.y) * (1.0 - smoothstep(0.6, 0.95, d.y));
    float k = misc.x / spread;
    return c + skyTop.rgb * (box * 2.2 + strip * 1.1) * k;
}

// Parallax occlusion mapping (steps with explicit LOD: no gradients inside the loop, which HLSL needs).
vec2 parallax(vec2 uv, vec3 vts)
{
    float scale = misc.z;
    if (scale <= 0.0)
        return uv;
    const int STEPS = 24;
    float layer = 1.0 / float(STEPS);
    vec2 dir = vec2(vts.x, -vts.y) / max(vts.z, 0.25);            // tangent y is "up" in the image (-v)
    vec2 duv = dir * scale * layer;
    vec2 cur = uv;
    float depth = 0.0;
    float h = 1.0 - textureLod(tHeight, cur, 0.0).r;
    for (int i = 0; i < STEPS; ++i) {
        if (depth >= h)
            break;
        cur -= duv;
        h = 1.0 - textureLod(tHeight, cur, 0.0).r;
        depth += layer;
    }
    vec2 prev = cur + duv;
    float after = h - depth;
    float before = (1.0 - textureLod(tHeight, prev, 0.0).r) - depth + layer;
    float w = after / (after - before + 1e-5);
    return mix(cur, prev, clamp(w, 0.0, 1.0));
}

vec3 shade(vec3 n, vec3 V, vec3 alb, float r, float m, vec3 f0, vec3 Ld, vec3 Lc)
{
    vec3 L = normalize(Ld);
    vec3 H = normalize(L + V);
    float nl = max(dot(n, L), 0.0);
    float nv = max(dot(n, V), 1e-4);
    float nh = max(dot(n, H), 0.0);
    float vh = max(dot(V, H), 0.0);
    float a = r * r;
    float k = (r + 1.0) * (r + 1.0) / 8.0;
    vec3 F = fresnel(vh, f0);
    float spec = ggx(nh, a) * g1(nl, k) * g1(nv, k) / (4.0 * nl * nv + 1e-4);
    vec3 kd = (1.0 - F) * (1.0 - m);
    return (kd * alb / PI + F * spec) * Lc * nl;
}

void main()
{
    vec3 N = normalize(vN);
    vec3 T = normalize(vT.xyz - N * dot(N, vT.xyz));
    vec3 B = cross(N, T) * vT.w;
    vec3 V = normalize(cam.xyz - vPos);
    vec2 uv = parallax(vUV, vec3(dot(V, T), dot(V, B), dot(V, N)));

    int mode = int(tiling.w + 0.5);
    vec4 a4 = texture(tAlbedo, uv);
    if (mode == 1) { fragColor = vec4(a4.rgb, 1.0); return; }
    if (mode == 2) { fragColor = vec4(texture(tNormal, uv).rgb, 1.0); return; }
    if (mode == 3) { fragColor = vec4(vec3(texture(tRough, uv).r), 1.0); return; }
    if (mode == 4) { fragColor = vec4(vec3(texture(tMetal, uv).r), 1.0); return; }
    if (mode == 5) { fragColor = vec4(vec3(texture(tHeight, uv).r), 1.0); return; }
    if (mode == 6) { fragColor = vec4(vec3(texture(tAO, uv).r), 1.0); return; }

    vec3 tn = texture(tNormal, uv).xyz * 2.0 - 1.0;
    vec3 n = normalize(T * tn.x + B * tn.y + N * max(tn.z, 0.05));
    vec3 alb = pow(a4.rgb, vec3(2.2));
    float r = clamp(texture(tRough, uv).r, 0.04, 1.0);
    float m = texture(tMetal, uv).r;
    float ao = texture(tAO, uv).r;
    vec3 f0 = mix(vec3(0.04), alb, m);

    vec3 col = shade(n, V, alb, r, m, f0, lightDir[0].xyz, lightCol[0].rgb)
             + shade(n, V, alb, r, m, f0, lightDir[1].xyz, lightCol[1].rgb)
             + shade(n, V, alb, r, m, f0, lightDir[2].xyz, lightCol[2].rgb);

    float nv = max(dot(n, V), 1e-4);
    vec3 Fr = fresnel(nv, f0) * (1.0 - r * 0.6);
    vec3 R = reflect(-V, n);
    float specOcc = clamp(pow(nv + ao, exp2(-16.0 * r - 1.0)) - 1.0 + ao, 0.0, 1.0);   // Lagarde's approximation
    vec3 spec = env(R, r) * Fr * specOcc;
    vec3 diff = env(n, 1.0) * alb * (1.0 - m) * (1.0 - Fr) * ao;
    col += diff * 0.9 + spec;

    col = aces(col * misc.y);
    fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
