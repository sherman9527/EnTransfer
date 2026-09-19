; Uninstall hook — zero-residue guarantee for the portable data layout.
; Models / jobs / checkpoints / translation cache / Chromium session data all
; live under $INSTDIR (models\ and data\) and are created at RUNTIME, so they
; are not in the installer file manifest. Delete them explicitly here; the
; remaining install directory then uninstalls clean.
;
; R13: electron-builder's ASSISTED (oneClick:false) installer always caches a
; full copy of itself to %LOCALAPPDATA%\entransfer-updater\installer.exe
; (config cannot disable it — verified experimentally 2026-09-19; we ship no
; electron-updater code). The uninstaller runs from %TEMP%, so wiping it here
; is safe and restores the zero-residue promise.
!macro customUnInstall
  RMDir /r "$INSTDIR\models"
  RMDir /r "$INSTDIR\data"
  RMDir /r "$LOCALAPPDATA\entransfer-updater"
!macroend
