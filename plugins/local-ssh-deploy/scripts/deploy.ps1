[CmdletBinding(DefaultParameterSetName = 'Direct')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Profile')]
    [string] $ProfileName,

    [Parameter(Mandatory = $true, ParameterSetName = 'Direct')]
    [string] $HostName,

    [Parameter(Mandatory = $true, ParameterSetName = 'Direct')]
    [ValidateRange(1, 65535)]
    [int] $Port,

    [Parameter(Mandatory = $true, ParameterSetName = 'Direct')]
    [string] $Username,

    [Parameter(Mandatory = $true, ParameterSetName = 'Direct')]
    [string] $IdentityFilePath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Direct')]
    [string] $RemoteDirectory,

    [Parameter(Mandatory = $true, ParameterSetName = 'Direct')]
    [string] $DeploymentCommand,

    [switch] $DryRun,
    [switch] $ConfirmDeployment,
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

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $ArgumentList,
        [Parameter(Mandatory = $true)][string] $Operation
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

if ($DryRun -and $ConfirmDeployment) {
    throw 'Choose either -DryRun or -ConfirmDeployment, not both.'
}
if (-not $DryRun -and -not $ConfirmDeployment) {
    throw 'Refusing to deploy without -ConfirmDeployment. Run -DryRun first and obtain explicit user confirmation.'
}
if ($DryRun -and -not [string]::IsNullOrWhiteSpace($PlanHash)) {
    throw 'Do not supply -PlanHash during a dry run; use the hash returned by that dry run for confirmed execution.'
}
if ($ConfirmDeployment -and ($PlanHash -notmatch '^[A-Fa-f0-9]{64}$')) {
    throw 'Confirmed deployment requires the 64-character -PlanHash returned by the approved dry run.'
}

$location = Get-Location
if ($location.Provider.Name -ne 'FileSystem') {
    throw 'Run this script from a local filesystem project directory.'
}
$projectRoot = [System.IO.Path]::GetFullPath($location.Path)
$projectItem = Get-Item -LiteralPath $projectRoot -Force
if (-not $projectItem.PSIsContainer) {
    throw 'The current working directory must be a project directory.'
}

$trimChars = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$trimmedProjectRoot = $projectRoot.TrimEnd($trimChars)
$trimmedFilesystemRoot = ([System.IO.Path]::GetPathRoot($projectRoot)).TrimEnd($trimChars)
if ($trimmedProjectRoot -eq $trimmedFilesystemRoot) {
    throw 'Refusing to package an entire filesystem root. Run from the intended project directory.'
}
if (-not (Get-ChildItem -LiteralPath $projectRoot -Force | Where-Object { $_.Name -notin @('.git', '.codex') } | Select-Object -First 1)) {
    throw 'The current project directory has no deployable content.'
}

if ($PSCmdlet.ParameterSetName -eq 'Profile') {
    $connection = Get-DeploymentProfile -ProfileName $ProfileName -ProjectRoot $projectRoot
}
else {
    $connection = Resolve-ConnectionData `
        -HostName $HostName `
        -Port $Port `
        -Username $Username `
        -IdentityFilePath $IdentityFilePath `
        -RemoteDirectory $RemoteDirectory `
        -DeploymentCommand $DeploymentCommand `
        -ProjectRoot $projectRoot
}

$planData = [ordered]@{
    projectRoot = $projectRoot
    profileName = if ($PSCmdlet.ParameterSetName -eq 'Profile') { $ProfileName } else { $null }
    host = $connection.host
    port = $connection.port
    username = $connection.username
    identityFilePath = $connection.identityFilePath
    remoteDirectory = $connection.remoteDirectory
    deploymentCommand = $connection.deploymentCommand
    archiveExclusions = @('.git', '.codex')
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
        stages = @(
            'Create a temporary local tar.gz archive.',
            'Create the remote directory through the local ssh client.',
            'Upload the archive through the local scp client.',
            'Extract the archive, remove the uploaded archive, and run the exact deployment command.'
        )
    } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not $computedPlanHash.Equals($PlanHash, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The current deployment values do not match the approved dry-run plan hash. Run a new dry run and confirm the new plan.'
}

$sshName = if ($IsWindows) { 'ssh.exe' } else { 'ssh' }
$scpName = if ($IsWindows) { 'scp.exe' } else { 'scp' }
$tarName = if ($IsWindows) { 'tar.exe' } else { 'tar' }
$sshCommand = Get-Command $sshName -CommandType Application
$scpCommand = Get-Command $scpName -CommandType Application
$tarCommand = Get-Command $tarName -CommandType Application
$nullConfigPath = if ($IsWindows) { 'NUL' } else { '/dev/null' }

$uploadName = '.codex-deploy-' + [System.Guid]::NewGuid().ToString('N') + '.tar.gz'
$remoteArchive = "$($connection.remoteDirectory)/$uploadName"
$remoteDirectoryQuoted = ConvertTo-PosixSingleQuoted $connection.remoteDirectory
$remoteArchiveQuoted = ConvertTo-PosixSingleQuoted $remoteArchive
$prepareScript = "mkdir -p -- $remoteDirectoryQuoted"
$cleanupScript = "rm -f -- $remoteArchiveQuoted"
$deployScript = "set -eu; trap $(ConvertTo-PosixSingleQuoted $cleanupScript) 0; tar -xzf $remoteArchiveQuoted -C $remoteDirectoryQuoted; cd -- $remoteDirectoryQuoted; $($connection.deploymentCommand)"

$commonOptions = @(
    '-F', $nullConfigPath,
    '-i', $connection.identityFilePath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15'
)
$sshArguments = @($commonOptions + @('-p', $connection.port.ToString(), '-l', $connection.username, $connection.host))
$scpHost = if ($connection.host.Contains(':')) { "[$($connection.host)]" } else { $connection.host }
$scpDestination = '{0}@{1}:{2}' -f $connection.username, $scpHost, $remoteArchive
$archivePath = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-deploy-' + [System.Guid]::NewGuid().ToString('N') + '.tar.gz')

try {
    Invoke-NativeChecked -FilePath $tarCommand.Source -ArgumentList @(
        '-czf', $archivePath,
        '--exclude=.git',
        '--exclude=.codex',
        '-C', $projectRoot,
        '.'
    ) -Operation 'Local project packaging'

    Invoke-NativeChecked -FilePath $sshCommand.Source -ArgumentList @(
        $sshArguments + @('sh -lc ' + (ConvertTo-PosixSingleQuoted $prepareScript))
    ) -Operation 'Remote directory creation'

    Invoke-NativeChecked -FilePath $scpCommand.Source -ArgumentList @(
        $commonOptions + @('-P', $connection.port.ToString(), $archivePath, $scpDestination)
    ) -Operation 'Project upload'

    Invoke-NativeChecked -FilePath $sshCommand.Source -ArgumentList @(
        $sshArguments + @('sh -lc ' + (ConvertTo-PosixSingleQuoted $deployScript))
    ) -Operation 'Remote extraction and deployment command'
}
finally {
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        Remove-Item -LiteralPath $archivePath -Force
    }
}

Write-Output "Deployment completed successfully for $($connection.username)@$($connection.host):$($connection.port)$($connection.remoteDirectory)."
