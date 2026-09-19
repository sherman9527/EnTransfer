; Uninstall hook — zero-residue guarantee for the portable data layout.
; Models / jobs / checkpoints / translation cache / Chromium session data all
; live under $INSTDIR (models\ and data\) and are created at RUNTIME, so they
; are not in the installer file manifest. Delete them explicitly here; the
; remaining install directory then uninstalls clean.
!macro customUnInstall
  RMDir /r "$INSTDIR\models"
  RMDir /r "$INSTDIR\data"
!macroend
