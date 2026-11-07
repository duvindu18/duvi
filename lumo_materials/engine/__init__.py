"""Map engine: everything that turns photos or map files into seamless PBR map sets.

Pure numpy + Pillow. No GUI imports, so it can be tested and used headless.
All maps are float32 arrays in 0..1:
    albedo  (H, W, 3) sRGB
    normal  (H, W, 3) tangent space, OpenGL convention (+Y up), encoded n * 0.5 + 0.5
    roughness, metallic, height, ao  (H, W)
"""

MAP_NAMES = ("albedo", "normal", "roughness", "metallic", "height", "ao")
