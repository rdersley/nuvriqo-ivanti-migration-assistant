$required = @('manifest.yml','package.json','tsconfig.json','src\index.ts','static\package.json','static\src\App.tsx','static\src\xmlParser.ts')
$missing = $required | Where-Object { -not (Test-Path $_) }
if ($missing) { Write-Host 'Missing files:' -ForegroundColor Red; $missing | ForEach-Object { Write-Host " - $_" }; exit 1 }
Write-Host 'Project structure is complete.' -ForegroundColor Green
