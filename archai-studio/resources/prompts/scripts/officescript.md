## Target: Excel Office Script (TypeScript)
- Excel for Microsoft 365 (desktop or web), **Automate → New Script**. Office Scripts are TypeScript with the `ExcelScript` API. They are not VBA. If the user asks for VBA, say that this target is Office Scripts, and offer the script anyway.
- The entry point is always `function main(workbook: ExcelScript.Workbook) { ... }`. Extra parameters become prompts in Power Automate only.
- No `any` type, no external imports, and no DOM or `fetch`. Use `console.log()` for messages to the user.
- Prefer **tables** (`workbook.getTable("Name")`, `table.getColumnByName("...")`) over hard-coded cell addresses. If a table or column is missing, log a clear message and `return`.
- Read values in one call (`range.getValues()`), compute in memory, then write back in one call (`range.setValues(...)`). Avoid cell-by-cell loops over large ranges.
- Areas in m², with number format `"#,##0.00"`. Write real Excel formulas where totals should stay live (for example `=SUBTOTAL(109,...)`).

### Known-good example: area schedule totals
```typescript
/**
 * Area schedule: adds a live total to the "Area (m²)" column of the table "Rooms",
 * formats areas to 2 decimals, and highlights rooms under a minimum size.
 * Excel for Microsoft 365, Office Scripts.
 */
function main(workbook: ExcelScript.Workbook) {
  const MIN_AREA_M2 = 9.0;
  const table = workbook.getTable("Rooms");
  if (!table) {
    console.log('Add a table named "Rooms" with an "Area (m²)" column first.');
    return;
  }
  const areaCol = table.getColumnByName("Area (m²)");
  if (!areaCol) {
    console.log('The "Rooms" table has no "Area (m²)" column.');
    return;
  }

  const body = areaCol.getRangeBetweenHeaderAndTotal();
  body.setNumberFormatLocal("#,##0.00");

  table.setShowTotals(true);
  areaCol.getTotalRowRange().setFormula("=SUBTOTAL(109,[Area (m²)])");

  const values = body.getValues();
  values.forEach((row, i) => {
    const cell = body.getCell(i, 0);
    const area = Number(row[0]);
    cell.getFormat().getFill().clear();
    if (area > 0 && area < MIN_AREA_M2) cell.getFormat().getFill().setColor("#F4D9CC");
  });
  console.log(`Checked ${values.length} rooms. Rooms under ${MIN_AREA_M2} m² are highlighted.`);
}
```
