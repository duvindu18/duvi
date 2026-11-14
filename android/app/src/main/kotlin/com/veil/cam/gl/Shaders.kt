package com.veil.cam.gl

/**
 * GLSL ES 3.00 shaders. Conventions: "image" space is the upright camera frame
 * (x right, y down, in pixels of the ring textures); textures store row 0 at the
 * bottom, so image (u, v) is sampled at (u, 1 - v).
 */
object Shaders {
    /** Full-screen triangle: no vertex buffers needed. */
    const val VS = """#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
"""

    /** Camera OES frame -> ring texture (upright image, unmodified colours). */
    const val COPY_OES = """#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision highp float;
uniform samplerExternalOES uOes;
uniform mat4 uSt;
uniform mat3 uPre;     // optional quarter-turn when the producer did not rotate the frame
uniform vec2 uSize;
out vec4 frag;
void main() {
    vec2 t = (uPre * vec3(gl_FragCoord.xy / uSize, 1.0)).xy;
    frag = vec4(texture(uOes, (uSt * vec4(t, 0.0, 1.0)).xy).rgb, 1.0);
}
"""

    /**
     * 4x downsample with a 4-tap box (each tap is a bilinear 2x2). Colour sums are
     * mediump (FP16 on Mali: twice the throughput, half the register file); texture
     * coordinates stay highp.
     */
    const val DOWN = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uDstSize;
out vec4 frag;
void main() {
    vec2 t = gl_FragCoord.xy / uDstSize;
    mediump vec3 c = texture(uSrc, t + uSrcTexel * vec2(-1.0, -1.0)).rgb
           + texture(uSrc, t + uSrcTexel * vec2( 1.0, -1.0)).rgb
           + texture(uSrc, t + uSrcTexel * vec2(-1.0,  1.0)).rgb
           + texture(uSrc, t + uSrcTexel * vec2( 1.0,  1.0)).rgb;
    frag = vec4(c * 0.25, 1.0);
}
"""

    /** Separable 9-tap Gaussian (sigma ~2 texels) using linear sampling. */
    const val BLUR = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform vec2 uDstSize;
out vec4 frag;
void main() {
    vec2 t = gl_FragCoord.xy / uDstSize;
    mediump vec3 c = texture(uSrc, t).rgb * 0.2270270270;
    c += texture(uSrc, t + uStep * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSrc, t - uStep * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSrc, t + uStep * 3.2307692308).rgb * 0.0702702703;
    c += texture(uSrc, t - uStep * 3.2307692308).rgb * 0.0702702703;
    frag = vec4(c, 1.0);
}
"""

    /** Detector canvas: the image warped by the pass transform (black outside). */
    const val PASS = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform mat3 uCanvasToImg;   // canvas px (y down) -> image px
uniform vec2 uImgSize;
uniform float uCanvasH;
out vec4 frag;
void main() {
    vec2 q = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
    vec2 p = (uCanvasToImg * vec3(q, 1.0)).xy / uImgSize;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
    frag = vec4(texture(uSrc, vec2(p.x, 1.0 - p.y)).rgb, 1.0);
}
"""

    const val MAX_FACES = 12

    /** Final picture: face anonymization + white balance + LUT (+ monitoring tools on the preview). */
    const val COMPOSITE = """#version 300 es
precision highp float;
precision highp sampler2D;
precision mediump sampler3D;
#define MAXF 12
uniform sampler2D uColor;
uniform sampler2D uBlur;      // 1/4-res blurred copy with mipmaps
uniform sampler3D uLut;
uniform sampler2D uMask;
uniform sampler2D uPeople;    // person mask (cinematic depth), canvas of the detector base pass
uniform mat3 uImgToPeople;    // image px -> person-mask uv (rows top-down)
uniform float uDepth;         // background blur on (> 0): fallback blur level
uniform float uDepthMix;      // 0..1: 0 = small blur from the full-resolution frame, 1 = lens blur
uniform float uFineRadius;    // blur radius in image px (for the small-blur path)
uniform int uRefined;         // 1 = edge-refined alpha (uCoef) and bokeh (uBokeh) are valid
uniform sampler2D uCoef;      // guided-filter coefficients: alpha = dot(a, I - 0.5) + b
uniform sampler2D uBokeh;     // background-only lens blur: rgb, a = background coverage
uniform mat3 uOutToImg;       // output px (y down) -> image px
uniform vec2 uImgSize;
uniform vec2 uBlurSize;
uniform float uOutH;
uniform int uFaceCount;
uniform vec4 uFA[MAXF];       // centre x, y, half w, half h (image px)
uniform vec4 uFB[MAXF];       // cos, sin, feather band (px), effect parameter
uniform int uStyle;           // 0 gaussian, 1 pixelate, 2 black box, 3 mask
uniform int uEllipse;
uniform int uMaskTex;         // 1 = custom PNG mask in uMask
uniform int uFullBlur;        // privacy-safe start: hide the whole frame
uniform vec3 uGains;
uniform int uLutOn;
uniform float uLutAmount;
uniform float uLutSize;
out vec4 frag;

vec3 img(vec2 p) { return texture(uColor, vec2(p.x / uImgSize.x, 1.0 - p.y / uImgSize.y)).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 blurAt(vec2 p, float lod) {
    vec2 t = vec2(p.x / uImgSize.x, 1.0 - p.y / uImgSize.y);
    vec2 o = exp2(lod) * 0.5 / uBlurSize;
    vec3 c = textureLod(uBlur, t + vec2( o.x,  o.y * 0.3), lod).rgb
           + textureLod(uBlur, t + vec2(-o.x * 0.3,  o.y), lod).rgb
           + textureLod(uBlur, t + vec2(-o.x, -o.y * 0.3), lod).rgb
           + textureLod(uBlur, t + vec2( o.x * 0.3, -o.y), lod).rgb;
    return c * 0.25;
}

// Small disc blur on the full-resolution frame: lets the background blur grow from
// exactly zero (the 1/4-res lens blur takes over once the radius is a few pixels).
vec3 fineBlur(vec2 p, float r) {
    if (r < 0.05) return img(p);
    vec3 s = img(p);
    for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996323;
        s += img(p + r * sqrt((float(i) + 0.5) / 12.0) * vec2(cos(a), sin(a)));
    }
    return s / 13.0;
}

vec3 lut(vec3 c) {
    if (uLutOn == 0) return c;
    vec3 s = clamp(c, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    return mix(c, texture(uLut, s).rgb, uLutAmount);
}

void main() {
    vec2 q = vec2(gl_FragCoord.x, uOutH - gl_FragCoord.y);
    vec2 p = (uOutToImg * vec3(q, 1.0)).xy;
    if (p.x < 0.0 || p.y < 0.0 || p.x > uImgSize.x || p.y > uImgSize.y) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 base = img(p) * uGains;
    if (uDepth > 0.0) {
        // Cinematic depth: people stay sharp, the background gets a lens blur.
        vec2 tuv = vec2(p.x / uImgSize.x, 1.0 - p.y / uImgSize.y);
        if (uRefined == 1) {
            // Alpha rebuilt at full resolution from the guided-filter coefficients, so the
            // edge follows the real outline (hair, shoulders) of this very frame.
            vec4 A = texture(uCoef, tuv);
            float person = smoothstep(0.12, 0.88, clamp(dot(A.rgb, img(p) - 0.5) + A.a, 0.0, 1.0));
            // Small tent filter over the 1/4-res lens blur: soft, round disc rims.
            vec2 bo = 0.7 / uBlurSize;
            vec4 bk = 0.25 * (texture(uBokeh, tuv + vec2(bo.x, bo.y)) + texture(uBokeh, tuv + vec2(-bo.x, bo.y))
                            + texture(uBokeh, tuv + vec2(bo.x, -bo.y)) + texture(uBokeh, tuv + vec2(-bo.x, -bo.y)));
            // Where the lens blur found no background (deep inside a person) use the plain blur.
            vec3 bg = mix(blurAt(p, uDepth), bk.rgb, clamp(bk.a * 3.0, 0.0, 1.0));
            if (uDepthMix < 1.0) bg = mix(fineBlur(p, uFineRadius), bg, uDepthMix);
            base = mix(base, bg * uGains, 1.0 - person);
        } else {
            vec2 mu = (uImgToPeople * vec3(p, 1.0)).xy;
            float person = (mu.x < 0.0 || mu.y < 0.0 || mu.x > 1.0 || mu.y > 1.0) ? 0.0 : texture(uPeople, mu).r;
            person = smoothstep(0.35, 0.75, person);
            vec3 bg = blurAt(p, uDepth);
            if (uDepthMix < 1.0) bg = mix(fineBlur(p, uFineRadius), bg, uDepthMix);
            base = mix(base, bg * uGains, 1.0 - person);
        }
    }

    // Strongest face mask at this pixel.
    float m = 0.0;
    int best = -1;
    vec2 bestLocal = vec2(0.0);
    for (int i = 0; i < MAXF; i++) {
        if (i >= uFaceCount) break;
        vec2 d = p - uFA[i].xy;
        vec2 l = vec2(uFB[i].x * d.x + uFB[i].y * d.y, -uFB[i].y * d.x + uFB[i].x * d.y);
        vec2 hs = uFA[i].zw;
        float dist;
        if (uEllipse == 1) dist = (length(l / hs) - 1.0) * min(hs.x, hs.y);
        else dist = max(abs(l.x) - hs.x, abs(l.y) - hs.y);
        float band = uFB[i].z;
        float mi = band > 0.0 ? 1.0 - smoothstep(0.0, band, dist) : clamp(0.5 - dist, 0.0, 1.0);
        if (mi > m) { m = mi; best = i; bestLocal = l; }
    }
    if (uFullBlur == 1) { m = 1.0; best = -2; }

    vec3 col = base;
    vec3 solid = vec3(0.0);
    bool useSolid = false;
    if (m > 0.0) {
        if (best == -2) {
            col = mix(base, blurAt(p, 4.0) * uGains, m);
        } else if (uStyle == 0) {
            col = mix(base, blurAt(p, uFB[best].w) * uGains, m);
        } else if (uStyle == 1) {
            float blk = uFB[best].w;
            vec2 lq = (floor(bestLocal / blk) + 0.5) * blk;
            vec2 c = uFA[best].xy;
            vec2 ex = vec2(uFB[best].x, uFB[best].y);
            vec2 ey = vec2(-uFB[best].y, uFB[best].x);
            col = mix(base, img(c + lq.x * ex + lq.y * ey) * uGains, m);
        } else if (uStyle == 2) {
            solid = vec3(0.0); useSolid = true;
        } else {
            vec2 hs = uFA[best].zw;
            vec2 n = bestLocal / hs;             // -1..1 across the face
            float blk = max(hs.x, hs.y) * 0.5;   // pixelated base so transparent art never shows the face
            vec2 lq = (floor(bestLocal / blk) + 0.5) * blk;
            vec2 c = uFA[best].xy;
            vec2 ex = vec2(uFB[best].x, uFB[best].y);
            vec2 ey = vec2(-uFB[best].y, uFB[best].x);
            vec3 under = img(c + lq.x * ex + lq.y * ey) * uGains;
            vec4 art;
            if (uMaskTex == 1) {
                art = texture(uMask, vec2(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5));
            } else {
                float r = length(n);
                vec3 g = mix(vec3(0.894, 0.945, 0.478), vec3(0.16, 0.17, 0.08), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
                float eyes = step(length((n - vec2(-0.28, -0.12)) * vec2(1.0, 1.6)), 0.12) + step(length((n - vec2(0.28, -0.12)) * vec2(1.0, 1.6)), 0.12);
                art = vec4(mix(g, vec3(0.04), clamp(eyes, 0.0, 1.0)), smoothstep(1.02, 0.96, r));
            }
            solid = mix(under, art.rgb, art.a); useSolid = true;
        }
    }

    vec3 graded = lut(col);
    if (useSolid) graded = mix(graded, solid, m);

    frag = vec4(graded, 1.0);
}
"""

    // ---- Cinematic depth: edge refinement (colour guided filter) and lens bokeh ----------------
    // Guided filter (He et al.): the coarse person mask p is refined with the frame I as the
    // guide, q = a . I + b, with a, b smooth; evaluated per output pixel the edge snaps to
    // the frame's own edges. Colour version (3x3 covariance) so a person and a background
    // of equal brightness still separate.

    /** Guide-resolution products: I (centred), p, I*p, hair, and the upper triangle of I*I^T. */
    const val DEPTH_PREP = """#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uColor;     // the frame (image space, rows bottom-up)
uniform sampler2D uPeople;    // coarse mask: r person, g hair (canvas space, rows top-down)
uniform mat3 uImgToPeople;    // image px -> mask uv
uniform sampler2D uDepthMap;  // relative depth, 1 = nearest (canvas space, rows top-down)
uniform mat3 uImgToDepth;
uniform int uHaveDepth;
uniform float uFocus;         // depth of the focus plane (centre of the subject)
uniform float uFocusHalf;     // half the subject's own depth extent (a person is not flat)
uniform float uFar;           // depth of the far background (5th percentile)
uniform float uDof;           // depth of field, as a fraction of the subject-to-background gap
uniform float uRange;         // fraction of that gap over which the blur reaches its maximum
uniform vec2 uImgSize;
uniform vec2 uSize;           // guide resolution
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    vec2 d = 0.25 / uSize;
    vec3 I = (texture(uColor, uv + vec2(-d.x, -d.y)).rgb + texture(uColor, uv + vec2(d.x, -d.y)).rgb
            + texture(uColor, uv + vec2(-d.x, d.y)).rgb + texture(uColor, uv + vec2(d.x, d.y)).rgb) * 0.25 - 0.5;
    vec2 p = vec2(uv.x, 1.0 - uv.y) * uImgSize;
    vec2 mu = (uImgToPeople * vec3(p, 1.0)).xy;
    vec2 m = (mu.x < 0.0 || mu.y < 0.0 || mu.x > 1.0 || mu.y > 1.0) ? vec2(0.0) : texture(uPeople, mu).rg;
    // Sharpen the coarse mask first: where the frame has no edge the filter keeps its
    // input, so a soft input would leave a soft fringe; edges are then re-found from I.
    float person = mix(smoothstep(0.3, 0.7, m.r), m.r, 0.35 * m.g);
    float pp = person; // sharpness: 1 in focus, 0 fully blurred
    if (uHaveDepth == 1) {
        // Real depth: sharp around the focus plane, blur growing with the distance from
        // it, in front as well as behind. A person standing on the focus plane stays
        // sharp even where the depth map is unsure.
        vec2 du = (uImgToDepth * vec3(p, 1.0)).xy;
        float D = texture(uDepthMap, clamp(du, 0.0, 1.0)).r;
        // Distance from the subject relative to the subject-to-background gap: the far
        // background always reaches full blur, whatever else is in the shot (a lens blurs
        // with the difference of inverse distances, which is what this depth measures).
        float gap = max(uFocus - uFar, 0.08);
        float dd = max(0.0, abs(D - uFocus) - uFocusHalf) / gap;
        float coc = smoothstep(uDof, uDof + uRange, dd);
        coc *= 1.0 - person * (1.0 - smoothstep(0.15, 0.45, dd));
        pp = 1.0 - coc;
    }
    o0 = vec4(I, pp);
    o1 = vec4(I * pp, m.g);
    o2 = vec4(I.r * I.r, I.r * I.g, I.r * I.b, I.g * I.g);
    o3 = vec4(I.g * I.b, I.b * I.b, 0.0, 0.0);
}
"""

    /** Separable box mean of four textures at once (radius uR along uDir). */
    const val DEPTH_BOX4 = """#version 300 es
precision highp float;
uniform highp sampler2D uT0;
uniform highp sampler2D uT1;
uniform highp sampler2D uT2;
uniform highp sampler2D uT3;
uniform ivec2 uDir;
uniform int uR;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    ivec2 hi = textureSize(uT0, 0) - 1;
    vec4 s0 = vec4(0.0), s1 = vec4(0.0), s2 = vec4(0.0), s3 = vec4(0.0);
    for (int k = -16; k <= 16; k++) {
        if (k < -uR || k > uR) continue;
        ivec2 q = clamp(c + uDir * k, ivec2(0), hi);
        s0 += texelFetch(uT0, q, 0); s1 += texelFetch(uT1, q, 0);
        s2 += texelFetch(uT2, q, 0); s3 += texelFetch(uT3, q, 0);
    }
    float n = float(2 * uR + 1);
    o0 = s0 / n; o1 = s1 / n; o2 = s2 / n; o3 = s3 / n;
}
"""

    /** Per-pixel coefficients a (3) and b from the box means; smaller epsilon on hair. */
    const val DEPTH_COEF = """#version 300 es
precision highp float;
uniform highp sampler2D uT0;
uniform highp sampler2D uT1;
uniform highp sampler2D uT2;
uniform highp sampler2D uT3;
uniform float uEps;
out vec4 frag;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    vec4 t0 = texelFetch(uT0, c, 0), t1 = texelFetch(uT1, c, 0), t2 = texelFetch(uT2, c, 0), t3 = texelFetch(uT3, c, 0);
    vec3 mI = t0.rgb; float mp = t0.a;
    vec3 cov = t1.rgb - mI * mp;
    float e = uEps * mix(1.0, 0.2, clamp(t1.a * 1.5, 0.0, 1.0));
    float rr = t2.r - mI.r * mI.r + e, rg = t2.g - mI.r * mI.g, rb = t2.b - mI.r * mI.b;
    float gg = t2.a - mI.g * mI.g + e, gb = t3.r - mI.g * mI.b, bb = t3.g - mI.b * mI.b + e;
    mat3 S = mat3(rr, rg, rb, rg, gg, gb, rb, gb, bb);
    vec3 a = inverse(S) * cov;
    frag = vec4(a, mp - dot(a, mI));
}
"""

    /** Separable box mean of one texture. */
    const val DEPTH_BOX1 = """#version 300 es
precision highp float;
uniform highp sampler2D uT0;
uniform ivec2 uDir;
uniform int uR;
out vec4 frag;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    ivec2 hi = textureSize(uT0, 0) - 1;
    vec4 s = vec4(0.0);
    for (int k = -16; k <= 16; k++) {
        if (k < -uR || k > uR) continue;
        s += texelFetch(uT0, clamp(c + uDir * k, ivec2(0), hi), 0);
    }
    frag = s / float(2 * uR + 1);
}
"""

    /**
     * Lens-blur source at 1/4 resolution: background only (people weighted out, so they
     * never bleed into the blur as a halo), highlights weighted up so they open into
     * bright discs like out-of-focus lights.
     */
    const val BOKEH_PREP = """#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uColor;
uniform sampler2D uCoef;
uniform sampler2D uLocal;     // 1/4-res blurred frame with mipmaps (local brightness)
uniform vec2 uSize;
uniform float uBloom;
layout(location = 0) out vec4 oCol;   // colour * highlight weight, highlight weight
layout(location = 1) out vec4 oCoc;   // circle of confusion 0..1 (r)
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    vec2 d = 1.0 / uSize * 0.25;
    vec3 c0 = texture(uColor, uv + vec2(-d.x, -d.y)).rgb, c1 = texture(uColor, uv + vec2(d.x, -d.y)).rgb;
    vec3 c2 = texture(uColor, uv + vec2(-d.x, d.y)).rgb, c3 = texture(uColor, uv + vec2(d.x, d.y)).rgb;
    vec3 c = (c0 + c1 + c2 + c3) * 0.25;
    // The brightest quarter, so small lights survive the downsampling.
    vec3 hi = c0;
    if (luma(c1) > luma(hi)) hi = c1;
    if (luma(c2) > luma(hi)) hi = c2;
    if (luma(c3) > luma(hi)) hi = c3;
    vec4 A = texture(uCoef, uv);
    float sharp = clamp(dot(A.rgb, c - 0.5) + A.a, 0.0, 1.0);
    // Lights: clearly brighter than their surroundings. An 8-bit light is clipped, so it
    // gets the weight its real brightness would have had: it opens into a full disc.
    float local = luma(textureLod(uLocal, uv, 3.0).rgb);
    float t = clamp((luma(hi) - max(local * 1.3 + 0.08, 0.55)) / 0.25, 0.0, 1.0);
    float coc = 1.0 - sharp;
    float h = 1.0 + uBloom * 160.0 * t * t * coc;
    vec3 col = mix(c, hi, min(1.0, t * 2.0));
    oCol = vec4(col * h, h);
    oCoc = vec4(coc, 0.0, 0.0, 1.0);
}
"""

    /**
     * Lens blur: a gather over a disc of [uTaps] golden-angle samples (radius uRadius px of
     * this 1/4-res target), shaped like a lens aperture. 0 circle (with cat-eye at the frame
     * edges, as real lenses vignette), 1 six-blade aperture, 2 anamorphic (tall ovals in the
     * recorded frame), 3 swirl (spinning towards the edges, like vintage Petzval lenses).
     */
    const val BOKEH = """#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPrep;      // colour * weight, weight (mipmapped)
uniform sampler2D uCoc;       // circle of confusion (mipmapped)
uniform vec2 uSize;
uniform float uRadius;        // blur radius for coc = 1 (px of this target)
uniform int uTaps;
uniform int uShape;
uniform vec2 uAxisX;          // recorded frame's x and y axes in this texture (unit, px)
uniform vec2 uAxisY;
out vec4 frag;
void main() {
    vec2 px = gl_FragCoord.xy;
    vec2 c = (px / uSize - 0.5) * vec2(uSize.x / uSize.y, 1.0);
    float rr = clamp(length(c) / 0.75, 0.0, 1.2);
    vec2 dir = length(c) > 1e-4 ? normalize(c) : vec2(0.0, 1.0);
    vec2 tang = vec2(-dir.y, dir.x);
    // This pixel's blur radius from its depth: sharp areas gather from a small disc only.
    float R = uRadius * texture(uCoc, px / uSize).r;
    float lod = max(0.0, log2(max(R, 1.0) * 1.77 / sqrt(float(uTaps))) + 0.4);
    float jitter = 6.2831853 * fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
    vec4 centre = textureLod(uPrep, px / uSize, 0.0);
    vec4 acc = centre;
    float n = 1.0;
    if (R > 0.5) for (int i = 0; i < 96; i++) {
        if (i >= uTaps) break;
        float t = (float(i) + 0.5) / float(uTaps);
        float a = float(i) * 2.39996323 + jitter;
        vec2 o = sqrt(t) * vec2(cos(a), sin(a));
        if (uShape == 1) {
            float s = mod(a + 0.2618, 1.0472) - 0.5236;
            o *= 0.866 / cos(s);
        } else if (uShape == 2) {
            o = o.x * 0.6 * uAxisX + o.y * uAxisY;
        } else if (uShape == 3) {
            o = dir * dot(o, dir) * (1.0 - 0.4 * rr) + tang * dot(o, tang) * (1.0 + 0.7 * rr);
        }
        // Optical vignetting: discs turn into cat's eyes towards the corners.
        if (uShape != 3 && length(o + dir * rr * 0.42) > 1.0) continue;
        vec2 q = (px + o * R) / uSize;
        // Scatter as gather: a sample counts only if its own blur reaches this pixel, so
        // sharp things (the person, objects on the focus plane) never bleed into the blur.
        float reach = textureLod(uCoc, q, lod).r * uRadius - length(o) * R;
        float w = smoothstep(-1.0, 1.0, reach);
        acc += textureLod(uPrep, q, lod) * w;
        n += w;
    }
    frag = vec4(acc.a > 1e-4 ? acc.rgb / acc.a : centre.rgb, clamp(n / (1.0 + 0.5 * float(uTaps)), 0.0, 1.0));
}
"""

    /**
     * Film emulation and monitoring on the finished (already anonymized) picture,
     * so no effect can ever bring back original face pixels.
     */
    const val FILM = """#version 300 es
precision highp float;
uniform sampler2D uStage;     // anonymized + graded picture, mipmapped
uniform vec2 uSize;
uniform float uTime;
uniform float uGrain;
uniform float uGrainSize;
uniform float uHalation;
uniform float uBloom;
uniform float uAberration;
uniform float uLeak;
uniform float uBurn;
uniform float uVignette;
uniform int uZebra;
uniform float uZebraLevel;
uniform int uFalse;
uniform int uPeak;
uniform vec3 uPeakColor;
uniform float uPeakThresh;
out vec4 frag;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 x, float t) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(vec3(i, t)), b = hash(vec3(i + vec2(1, 0), t));
    float c = hash(vec3(i + vec2(0, 1), t)), d = hash(vec3(i + vec2(1, 1), t));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 x, float t) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(x, t); x *= 2.03; a *= 0.5; }
    return v;
}
vec3 falseColor(float y) {
    if (y < 0.02) return vec3(0.45, 0.0, 0.6);
    if (y < 0.10) return vec3(0.0, 0.25, 1.0);
    if (y < 0.38) return vec3(y);
    if (y < 0.45) return vec3(0.1, 0.8, 0.2);
    if (y < 0.52) return vec3(y);
    if (y < 0.58) return vec3(1.0, 0.55, 0.7);
    if (y < 0.90) return vec3(y);
    if (y < 0.97) return vec3(1.0, 0.9, 0.0);
    return vec3(1.0, 0.0, 0.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    vec3 c;
    if (uAberration > 0.0) {
        // Lateral chromatic aberration: red and blue scale apart towards the edges.
        vec2 d = (uv - 0.5) * uAberration * 0.0045;
        c = vec3(texture(uStage, uv + d).r, texture(uStage, uv).g, texture(uStage, uv - d).b);
    } else {
        c = texture(uStage, uv).rgb;
    }
    if (uBloom > 0.0 || uHalation > 0.0) {
        vec3 wide = textureLod(uStage, uv, 5.0).rgb * 0.5 + textureLod(uStage, uv, 4.0).rgb * 0.5;
        vec3 near = textureLod(uStage, uv, 2.5).rgb;
        // Bloom: only the top of the range glows, screen-blended so it can never blow out.
        vec3 bright = clamp((wide - 0.8) / 0.2, 0.0, 1.0);
        c = 1.0 - (1.0 - c) * (1.0 - bright * uBloom * 0.45);
        // Halation: a tight red-orange fringe around strong highlights (light reflected
        // back through the emulsion by the film base); dark areas next to them pick it up.
        float h = clamp((luma(near) - 0.86) / 0.14, 0.0, 1.0) * 0.7 + clamp((luma(wide) - 0.86) / 0.14, 0.0, 1.0) * 0.3;
        float room = 1.0 - luma(c);
        c = 1.0 - (1.0 - c) * (1.0 - vec3(1.0, 0.32, 0.12) * h * uHalation * 0.5 * (0.35 + 0.65 * room));
    }
    if (uLeak > 0.0) {
        // Slowly drifting warm light leaks from the frame edges (screen blend).
        float t = uTime * 0.07;
        vec2 q = uv * vec2(uSize.x / uSize.y, 1.0);
        float f = fbm(q * 1.3 + vec2(t, -t * 0.6), 0.0);
        float edge = smoothstep(0.55, 1.0, max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0 * (0.75 + 0.5 * sin(t * 2.0 + uv.y * 3.0)));
        vec3 leak = mix(vec3(1.0, 0.35, 0.1), vec3(1.0, 0.8, 0.35), f) * edge * smoothstep(0.35, 0.8, f) * uLeak;
        c = 1.0 - (1.0 - c) * (1.0 - clamp(leak, 0.0, 1.0));
    }
    if (uBurn > 0.0) {
        // Film burn: occasional over-exposed bursts that flare in from a corner.
        float cycle = floor(uTime / 7.0);
        float phase = fract(uTime / 7.0);
        float env = smoothstep(0.0, 0.15, phase) * (1.0 - smoothstep(0.25, 0.55, phase)) * step(0.45, hash(vec3(cycle, 3.1, 7.7)));
        vec2 corner = vec2(step(0.5, hash(vec3(cycle, 1.0, 2.0))), step(0.5, hash(vec3(cycle, 5.0, 9.0))));
        float dist = length(uv - corner);
        float n = fbm(uv * 3.0 + cycle, cycle);
        float burn = clamp((1.0 - dist * 1.4) + n * 0.6 - 0.35, 0.0, 1.0) * env * uBurn;
        c = mix(c, vec3(1.0, 0.55, 0.15) * 1.4, burn * 0.8);
        c += vec3(1.0, 0.85, 0.6) * burn * burn * 0.6;
    }
    if (uVignette > 0.0) {
        vec2 d = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
        c *= mix(1.0, smoothstep(1.05, 0.25, length(d)), uVignette);
    }
    if (uGrain > 0.0) {
        // Luminance-dependent grain: strongest in the mid-tones, as with real stock.
        vec2 gp = gl_FragCoord.xy / uGrainSize;
        float t = floor(uTime * 24.0);
        float g = (vnoise(gp, t) + vnoise(gp * 1.9 + 7.3, t) * 0.5) / 1.5 - 0.5;
        float y = luma(c);
        c += g * uGrain * 0.16 * (1.0 - abs(y - 0.45) * 1.2);
    }
    c = clamp(c, 0.0, 1.0);

    // Monitoring tools (preview only; never recorded).
    float y = luma(c);
    if (uFalse == 1) c = falseColor(y);
    if (uPeak == 1) {
        vec2 px = 1.5 / uSize;
        float l00 = luma(texture(uStage, uv + vec2(-px.x, -px.y)).rgb), l10 = luma(texture(uStage, uv + vec2(0.0, -px.y)).rgb);
        float l20 = luma(texture(uStage, uv + vec2(px.x, -px.y)).rgb), l01 = luma(texture(uStage, uv + vec2(-px.x, 0.0)).rgb);
        float l21 = luma(texture(uStage, uv + vec2(px.x, 0.0)).rgb), l02 = luma(texture(uStage, uv + vec2(-px.x, px.y)).rgb);
        float l12 = luma(texture(uStage, uv + vec2(0.0, px.y)).rgb), l22 = luma(texture(uStage, uv + vec2(px.x, px.y)).rgb);
        float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
        float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
        if (length(vec2(gx, gy)) > uPeakThresh) c = uPeakColor;
    }
    if (uZebra == 1 && y >= uZebraLevel) {
        if (mod(gl_FragCoord.x + gl_FragCoord.y, 16.0) < 8.0) c = mix(c, vec3(0.0), 0.75);
    }
    frag = vec4(c, 1.0);
}
"""

    // ---- burst merge (photos) -----------------------------------------------------------------

    /** Small luma image for burst alignment: a 4x4 box of bilinear taps per output pixel. */
    const val BURST_LUMA = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDstSize;
uniform vec2 uStep; // source uv between taps
out vec4 frag;
void main() {
    vec2 uv = gl_FragCoord.xy / uDstSize;
    mediump float l = 0.0;
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
        vec2 o = (vec2(float(x), float(y)) - 1.5) * uStep;
        l += dot(texture(uSrc, uv + o).rgb, vec3(0.299, 0.587, 0.114));
    }
    l *= 1.0 / 16.0;
    frag = vec4(l, l, l, 1.0);
}
"""

    /**
     * One frame into the running merge: the new frame, shifted onto the reference, is
     * added where it matches the reference (local means within the noise), and left out
     * where something moved, so moving subjects never ghost. Sums stay in half floats.
     */
    const val BURST_MERGE = """#version 300 es
precision highp float;
uniform sampler2D uRef;
uniform sampler2D uCur;
uniform sampler2D uAcc;
uniform vec2 uSize;
uniform vec2 uShift;  // uv
uniform float uSigma; // noise level (0..1 colour units)
uniform int uFirst;
out vec4 frag;
mediump vec3 local(sampler2D t, vec2 uv) {
    vec2 px = 1.0 / uSize;
    return (texture(t, uv).rgb * 2.0 + texture(t, uv + vec2(px.x, 0.0)).rgb + texture(t, uv - vec2(px.x, 0.0)).rgb
        + texture(t, uv + vec2(0.0, px.y)).rgb + texture(t, uv - vec2(0.0, px.y)).rgb) / 6.0;
}
void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    vec4 acc = uFirst == 1 ? vec4(texture(uRef, uv).rgb, 1.0) : texture(uAcc, uv);
    vec2 q = uv + uShift;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { frag = acc; return; }
    mediump vec3 d = local(uCur, q) - local(uRef, uv);
    float e = dot(d, d) / (uSigma * uSigma);
    float w = exp(-0.5 * e);
    w = w < 0.05 ? 0.0 : w;
    frag = acc + vec4(texture(uCur, q).rgb * w, w);
}
"""

    /** Merge sum -> mean (mipmapped, for the local tone curve). */
    const val BURST_MEAN = """#version 300 es
precision highp float;
uniform sampler2D uAcc;
uniform vec2 uSize;
out vec4 frag;
void main() {
    vec4 a = texture(uAcc, gl_FragCoord.xy / uSize);
    frag = vec4(a.rgb / max(a.a, 1e-4), 1.0);
}
"""

    /**
     * Tone for the merged photo: shadows lifted by [uLift] where the neighbourhood is
     * dark (the merge removed the noise that would show), highlights rolled off softly,
     * and a light sharpen to restore what sub-pixel alignment softened.
     */
    const val BURST_TONE = """#version 300 es
precision highp float;
uniform sampler2D uMean;
uniform vec2 uSize;
uniform float uLift;
uniform float uLod;
uniform float uSharpen;
out vec4 frag;
void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    vec3 c = texture(uMean, uv).rgb;
    vec3 soft = textureLod(uMean, uv, 1.0).rgb;
    c += (c - soft) * uSharpen;
    const vec3 W = vec3(0.2126, 0.7152, 0.0722);
    float lp = 0.5 * (dot(textureLod(uMean, uv, uLod).rgb, W) + dot(textureLod(uMean, uv, uLod + 2.0).rgb, W));
    float gain = mix(uLift, 1.0, smoothstep(0.0, 0.55, lp));
    c = max(c * gain, 0.0);
    vec3 over = max(c - 0.8, 0.0);
    c = min(c, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));
    frag = vec4(c, 1.0);
}
"""
}
