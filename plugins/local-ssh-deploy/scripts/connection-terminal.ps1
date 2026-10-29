param([Parameter(Mandatory)][string]$NodePath, [Parameter(Mandatory)][string]$ClientPath, [Parameter(Mandatory)][string]$Alias)
& $NodePath $ClientPath $Alias
if ($LASTEXITCODE -eq 0) { Write-Host 'SSH connection succeeded.' }
else { Write-Host 'SSH connection was not completed. Review the message above.' }
