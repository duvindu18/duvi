-- D5 Bridge: headless entry point for 3dsmaxbatch.exe
-- The D5 Bridge app runs:
--   3dsmaxbatch.exe d5bridge_batch.ms -sceneFile "<file.max>"
-- with environment variables D5B_BUNDLE (output folder) and D5B_OPTIONS (json).
(
    local here = getFilenamePath (getSourceFileName())
    local py = here + "d5bridge_max_export.py"
    if doesFileExist py then (python.ExecuteFile py) else (format "D5BRIDGE_FAIL\nexporter not found: %\n" py)
)
