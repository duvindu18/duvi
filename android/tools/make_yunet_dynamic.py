"""Make OpenCV Zoo's YuNet (face_detection_yunet_2023mar.onnx, MIT) accept any input
size that is a multiple of 32, as the app's detector canvases are.

    python3 tools/make_yunet_dynamic.py face_detection_yunet_2023mar.onnx models/face_yunet_2023mar_dyn.onnx

Source: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
(sha256 of the 2023mar file: 8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4).
The graph's reshapes already use -1, so only the declared shapes change.
"""
import sys
import onnx

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
d = m.graph.input[0].type.tensor_type.shape.dim
d[2].dim_param = "H"; d[3].dim_param = "W"
for o in m.graph.output:
    o.type.tensor_type.shape.dim[1].dim_param = "N"
del m.graph.value_info[:]
onnx.checker.check_model(m)
onnx.save(m, dst)
print("wrote", dst)
