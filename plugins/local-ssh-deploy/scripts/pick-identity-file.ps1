[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.OpenFileDialog]::new()
$dialog.Title = '选择 SSH 私钥文件'
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.Multiselect = $false
$dialog.Filter = '所有文件 (*.*)|*.*'
$dialog.RestoreDirectory = $true

try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [ordered]@{
            status = 'selected'
            path = [System.IO.Path]::GetFullPath($dialog.FileName)
        } | ConvertTo-Json -Compress
    }
    else {
        [ordered]@{
            status = 'cancelled'
            path = ''
        } | ConvertTo-Json -Compress
    }
}
finally {
    $dialog.Dispose()
}
