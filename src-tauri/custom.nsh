; LiteMD NSIS 自定义脚本
; 卸载完成后直接删除整个安装目录（含卸载期间新增的运行时文件/配置），
; 避免安装目录残留空壳。
!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR"
!macroend
