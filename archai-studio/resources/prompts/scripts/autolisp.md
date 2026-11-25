## Target: AutoLISP for AutoCAD
- AutoCAD 2018 to 2026, full AutoCAD (not LT before 2024). Load with APPLOAD and run by the command name.
- Define commands as `(defun c:NAME (/ local vars ...) ... (princ))`. Declare **every** local variable after the slash.
- Call `(vl-load-com)` before any `vla-`/`vlax-` function.
- Always include a local `*error*` handler that ends the undo mark and stays quiet on cancel ("Function cancelled", "quit / exit abort").
- Wrap changes in `(vla-StartUndoMark doc)` / `(vla-EndUndoMark doc)`, so one U undoes the command.
- Selection: `ssget` with DXF filters. For closed polylines use `'((0 . "LWPOLYLINE") (-4 . "&") (70 . 1))`. Loop with `repeat` and `ssname`.
- Drawing units: assume **millimetres**. Divide areas by 1,000,000 for m². Write the superscript as `\U+00B2` in text.
- Use `entmakex` or `vla-AddText` / `vla-AddMText` to create objects. Put new objects on a named layer and create the layer if it is missing.
- End every command with `(princ)` to avoid echoing nil. Add a `(princ "\nType RAREA to run.")` style hint at the end of the file.

### Known-good example: label closed polylines with their area
```lisp
;;; RAREA - labels selected closed polylines with their area in m².
;;; Drawing units: millimetres. Text goes on layer A-AREA-IDEN, 250 high.
(defun c:RAREA (/ *error* doc ss i obj area mn mx pt)
  (vl-load-com)
  (setq doc (vla-get-ActiveDocument (vlax-get-acad-object)))
  (defun *error* (msg)
    (vla-EndUndoMark doc)
    (if (not (member msg '("Function cancelled" "quit / exit abort")))
      (princ (strcat "\nError: " msg)))
    (princ))
  (if (not (tblsearch "LAYER" "A-AREA-IDEN"))
    (entmake '((0 . "LAYER") (100 . "AcDbSymbolTableRecord") (100 . "AcDbLayerTableRecord")
               (2 . "A-AREA-IDEN") (70 . 0) (62 . 3))))
  (vla-StartUndoMark doc)
  (if (setq ss (ssget '((0 . "LWPOLYLINE") (-4 . "&") (70 . 1))))
    (progn
      (repeat (setq i (sslength ss))
        (setq obj  (vlax-ename->vla-object (ssname ss (setq i (1- i))))
              area (/ (vla-get-Area obj) 1000000.0))
        (vla-GetBoundingBox obj 'mn 'mx)
        (setq pt (mapcar '(lambda (a b) (/ (+ a b) 2.0))
                         (vlax-safearray->list mn) (vlax-safearray->list mx)))
        (entmakex (list '(0 . "TEXT") '(8 . "A-AREA-IDEN") (cons 10 pt) (cons 11 pt)
                        '(40 . 250.0) '(72 . 1) '(73 . 2)
                        (cons 1 (strcat (rtos area 2 2) " m\\U+00B2")))))
      (princ (strcat "\nLabelled " (itoa (sslength ss)) " polylines.")))
    (princ "\nNo closed polylines selected."))
  (vla-EndUndoMark doc)
  (princ))
(princ "\nType RAREA to label closed polylines with their area.")
(princ)
```
