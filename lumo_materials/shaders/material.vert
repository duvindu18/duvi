#version 440
// lumo materials preview, vertex stage (Vulkan-style GLSL; compiled by qsb to HLSL for Direct3D 12 / 11,
// SPIR-V and GLSL). The uniform block must match material.frag and RhiViewer._uniform_bytes().

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 aTan;

layout(location = 0) out vec3 vPos;
layout(location = 1) out vec2 vUV;
layout(location = 2) out vec3 vN;
layout(location = 3) out vec4 vT;

layout(std140, binding = 0) uniform Params {
    mat4 viewProj;
    mat4 model;
    vec4 cam;          // xyz camera position
    vec4 tiling;       // xy uv tiling, z displacement amount, w display mode
    vec4 lightDir[3];  // xyz direction towards the light
    vec4 lightCol[3];  // rgb colour * intensity
    vec4 skyTop;       // rgb
    vec4 skyBot;       // rgb
    vec4 misc;         // x softbox strength, y exposure, z parallax scale, w unused
};

layout(binding = 5) uniform sampler2D tHeight;

void main()
{
    vec2 uv = aUV * tiling.xy;
    float h = textureLod(tHeight, uv, 0.0).r;
    vec3 p = aPos + aNrm * (h - 0.5) * tiling.z;
    vec4 wp = model * vec4(p, 1.0);
    mat3 nm = mat3(model);
    vPos = wp.xyz;
    vN = nm * aNrm;
    vT = vec4(nm * aTan.xyz, aTan.w);
    vUV = uv;
    gl_Position = viewProj * wp;
}
