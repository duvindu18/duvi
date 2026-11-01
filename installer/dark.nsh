; ---------------------------------------------------------------------------
; Dark "Noir" look for the Modern UI 2 wizard, matching the Veil app:
; near-black surfaces, light text, lime accent progress bar.
;
; MUI_BGCOLOR / MUI_TEXTCOLOR colour the welcome, finish and header areas;
; DarkWindow recolours every native control of a page: static texts and the
; dialog background through SetCtlColors, buttons/combos/edits/lists through
; Windows' own dark control themes (Windows 10 1809+, ignored elsewhere), the
; component tree, install log and progress bar through their colour messages.
; ---------------------------------------------------------------------------
!include "LogicLib.nsh"

!define NOIR_BG "0B0B0C"
!define NOIR_SURFACE "141416"
!define NOIR_TEXT "F4F4F5"
; COLORREF (0x00BBGGRR) versions for SendMessage
!define NOIR_BG_REF 0x000C0B0B
!define NOIR_SURFACE_REF 0x00161414
!define NOIR_CONTROL_REF 0x00211E1E
!define NOIR_TEXT_REF 0x00F5F4F4
!define NOIR_ACCENT_REF 0x007AF1E4

!define MUI_BGCOLOR ${NOIR_BG}
!define MUI_TEXTCOLOR ${NOIR_TEXT}

!macro NOIR_DARK_TITLEBAR
  ; Dark caption (Windows 10 2004+ / 11) and caption colour (Windows 11).
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${NOIR_BG_REF}, i 4)'
!macroend

!macro NOIR_DARK_FUNCS UN
Function ${UN}NoirDarkChildren
  ; $R9 = parent window
  Push $R8
  Push $R7
  Push $R6
  StrCpy $R8 0
  ${Do}
    FindWindow $R8 "" "" $R9 $R8
    ${If} $R8 == 0
      ${Break}
    ${EndIf}
    System::Call 'user32::GetClassNameW(p $R8, w .R7, i 64)'
    ${If} $R7 == "Button"
      System::Call 'user32::GetWindowLongW(p $R8, i -16) i .R6'
      IntOp $R6 $R6 & 0xF
      ${If} $R6 <= 1
        ; push buttons: native dark theme
        System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_Explorer", p 0)'
      ${ElseIf} $R6 == 7
        ; group box
        System::Call 'uxtheme::SetWindowTheme(p $R8, w "", w "")'
        SetCtlColors $R8 ${NOIR_TEXT} ${NOIR_BG}
      ${Else}
        ; check boxes / radio buttons: unthemed so the light text colour applies
        System::Call 'uxtheme::SetWindowTheme(p $R8, w "", w "")'
        SetCtlColors $R8 ${NOIR_TEXT} ${NOIR_BG}
      ${EndIf}
    ${ElseIf} $R7 == "SysTreeView32"
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_Explorer", p 0)'
      SendMessage $R8 0x111D 0 ${NOIR_SURFACE_REF} ; TVM_SETBKCOLOR
      SendMessage $R8 0x111E 0 ${NOIR_TEXT_REF}    ; TVM_SETTEXTCOLOR
      SendMessage $R8 0x1128 0 0x00F5F4F4          ; TVM_SETLINECOLOR
    ${ElseIf} $R7 == "SysListView32"
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_Explorer", p 0)'
      SendMessage $R8 0x1001 0 ${NOIR_SURFACE_REF} ; LVM_SETBKCOLOR
      SendMessage $R8 0x1026 0 ${NOIR_SURFACE_REF} ; LVM_SETTEXTBKCOLOR
      SendMessage $R8 0x1024 0 ${NOIR_TEXT_REF}    ; LVM_SETTEXTCOLOR
    ${ElseIf} $R7 == "msctls_progress32"
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "", w "")'
      SendMessage $R8 0x0409 0 ${NOIR_ACCENT_REF}  ; PBM_SETBARCOLOR
      SendMessage $R8 0x2001 0 ${NOIR_CONTROL_REF} ; PBM_SETBKCOLOR
    ${ElseIf} $R7 == "RichEdit20W"
    ${OrIf} $R7 == "RichEdit20A"
    ${OrIf} $R7 == "RICHEDIT"
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_Explorer", p 0)'
      SendMessage $R8 0x0443 0 ${NOIR_SURFACE_REF} ; EM_SETBKGNDCOLOR
    ${ElseIf} $R7 == "Edit"
    ${OrIf} $R7 == "ComboBox"
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_CFD", p 0)'
      SetCtlColors $R8 ${NOIR_TEXT} ${NOIR_SURFACE}
    ${ElseIf} $R7 == "Static"
      SetCtlColors $R8 ${NOIR_TEXT} ${NOIR_BG}
    ${EndIf}
  ${Loop}
  Pop $R6
  Pop $R7
  Pop $R8
FunctionEnd

Function ${UN}NoirDarkPage
  ; Outer window (buttons, branding text, header) and the current inner page.
  Push $R9
  SetCtlColors $HWNDPARENT ${NOIR_TEXT} ${NOIR_BG}
  StrCpy $R9 $HWNDPARENT
  Call ${UN}NoirDarkChildren
  FindWindow $R9 "#32770" "" $HWNDPARENT
  ${If} $R9 != 0
    SetCtlColors $R9 ${NOIR_TEXT} ${NOIR_BG}
    Call ${UN}NoirDarkChildren
  ${EndIf}
  !insertmacro NOIR_DARK_TITLEBAR
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'
  Pop $R9
FunctionEnd
!macroend

!insertmacro NOIR_DARK_FUNCS ""
!insertmacro NOIR_DARK_FUNCS "un."
