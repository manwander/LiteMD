; LiteMD NSIS 自定义脚本
; 安装后创建桌面快捷方式；卸载时删除快捷方式并清理整个安装目录
; （含卸载期间新增的运行时文件/配置），避免安装目录残留空壳。
!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\LiteMD.lnk" "$INSTDIR\LiteMD.exe"
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\LiteMD.lnk"
  RMDir /r "$INSTDIR"
!macroend
