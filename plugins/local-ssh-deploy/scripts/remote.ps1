[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ProfileName,

    [string] $WorkingDirectory,

    [Parameter(Mandatory = $true)]
    [string] $Command,

    [switch] $DryRun,
    [switch] $ConfirmExecution,
    [string] $PlanHash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LocalSshDeploy.psm1') -Force

function ConvertTo-PosixSingleQuoted {
    param([Parameter(Mandatory = $true)][string] $Value)
    $replacement = "'" + [char] 34 + "'" + [char] 34 + "'"
    return "'" + $Value.Replace("'", $replacement) + "'"
}

if ($DryRun -and $ConfirmExecution) {
    throw 'Choose either -DryRun or -ConfirmExecution, not both.'
}
if (-not $DryRun -and -not $ConfirmExecution) {
    throw 'Refusing to run a remote command without -ConfirmExecution. Run -DryRun first and obtain explicit user confirmation.'
}
if ($DryRun -and -not [string]::IsNullOrWhiteSpace($PlanHash)) {
    throw 'Do not supply -PlanHash during a dry run.'
}
if ($ConfirmExecution -and ($PlanHash -notmatch '^[A-Fa-f0-9]{64}$')) {
    throw 'Confirmed execution requires the 64-character -PlanHash returned by the approved dry run.'
}

$connection = Get-DeploymentProfile -ProfileName $ProfileName
$task = Resolve-RemoteTaskData -WorkingDirectory $WorkingDirectory -Command $Command
$planData = [ordered]@{
    profileName = $ProfileName
    host = $connection.host
    port = $connection.port
    username = $connection.username
    identityFilePath = $connection.identityFilePath
    workingDirectory = $task.workingDirectory
    command = $task.command
    hostKeyChecking = 'strict; the host must already exist in known_hosts'
}
$planJson = $planData | ConvertTo-Json -Depth 4 -Compress
$planBytes = [System.Text.Encoding]::UTF8.GetBytes($planJson)
try {
    $computedPlanHash = [System.Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($planBytes)).ToLowerInvariant()
}
finally {
    [System.Array]::Clear($planBytes, 0, $planBytes.Length)
}

if ($DryRun) {
    [ordered]@{
        dryRun = $true
        planHash = $computedPlanHash
        plan = $planData
    } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not $computedPlanHash.Equals($PlanHash, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The current remote-command values do not match the approved dry-run plan hash. Run a new dry run and confirm the new plan.'
}

$sshName = if ($IsWindows) { 'ssh.exe' } else { 'ssh' }
$sshCommand = Get-Command $sshName -CommandType Application
$nullConfigPath = if ($IsWindows) { 'NUL' } else { '/dev/null' }
$commonOptions = @(
    '-F', $nullConfigPath,
    '-i', $connection.identityFilePath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15'
)
$sshArguments = @($commonOptions + @('-p', $connection.port.ToString(), '-l', $connection.username, $connection.host))
$remoteScript = if ($null -eq $task.workingDirectory) {
    $task.command
}
else {
    "cd -- $(ConvertTo-PosixSingleQuoted $task.workingDirectory); $($task.command)"
}

& $sshCommand.Source @sshArguments ('sh -lc ' + (ConvertTo-PosixSingleQuoted $remoteScript))
if ($LASTEXITCODE -ne 0) {
    throw "Remote command failed with exit code $LASTEXITCODE."
}
