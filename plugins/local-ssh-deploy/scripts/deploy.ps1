[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $HostName,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int] $Port,

    [Parameter(Mandatory = $true)]
    [string] $Username,

    [Parameter(Mandatory = $true)]
    [string] $IdentityFilePath,

    [Parameter(Mandatory = $true)]
    [string] $RemoteDirectory,

    [Parameter(Mandatory = $true)]
    [string] $DeploymentCommand,

    [switch] $DryRun,
    [switch] $ConfirmDeployment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NoControlCharacters {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Name,
        [Parameter(Mandatory = $true)]
        [string] $Value
    )

    if ($Value -match '[\x00-\x1F\x7F]') {
        throw "$Name must not contain control characters."
    }
}

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

foreach ($field in @(
    @{ Name = 'HostName'; Value = $HostName },
    @{ Name = 'Username'; Value = $Username },
    @{ Name = 'IdentityFilePath'; Value = $IdentityFilePath },
    @{ Name = 'RemoteDirectory'; Value = $RemoteDirectory },
    @{ Name = 'DeploymentCommand'; Value = $DeploymentCommand }
)) {
    Assert-NoControlCharacters -Name $field.Name -Value $field.Value
}

if ([string]::IsNullOrWhiteSpace($HostName) -or $HostName.StartsWith('-') -or $HostName -match '[@/\\\[\]]') {
    throw 'HostName must be a plain DNS name, IPv4 address, or IPv6 address without user or port syntax.'
}
if ([System.Uri]::CheckHostName($HostName) -eq [System.UriHostNameType]::Unknown) {
    throw 'HostName is not a valid DNS name, IPv4 address, or IPv6 address.'
}
if ($Username -notmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$') {
    throw 'Username must start with a letter or underscore and contain only letters, digits, underscore, dot, or hyphen.'
}
if ($RemoteDirectory -notmatch '^/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$') {
    throw 'RemoteDirectory must be a non-root absolute POSIX path using only letters, digits, dot, underscore, hyphen, and slash.'
}
if (($RemoteDirectory -split '/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }) {
    throw 'RemoteDirectory must not contain dot or dot-dot path segments.'
}
if ([string]::IsNullOrWhiteSpace($DeploymentCommand)) {
    throw 'DeploymentCommand must be an explicit, non-empty command.'
}
if ($DeploymentCommand.Length -gt 4096) {
    throw 'DeploymentCommand must not exceed 4096 characters.'
}
if (-not [System.IO.Path]::IsPathFullyQualified($IdentityFilePath)) {
    throw 'IdentityFilePath must be an absolute local filesystem path.'
}

$identityItem = Get-Item -LiteralPath $IdentityFilePath -Force
if ($identityItem.PSIsContainer) {
    throw 'IdentityFilePath must identify a file, not a directory.'
}
$resolvedIdentityPath = $identityItem.FullName

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

$comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
$projectPrefix = $trimmedProjectRoot + [System.IO.Path]::DirectorySeparatorChar
if ($resolvedIdentityPath.Equals($trimmedProjectRoot, $comparison) -or $resolvedIdentityPath.StartsWith($projectPrefix, $comparison)) {
    throw 'IdentityFilePath must be outside the project directory so the key cannot be included in the deployment archive.'
}

$uploadName = '.codex-deploy-' + [System.Guid]::NewGuid().ToString('N') + '.tar.gz'
$remoteArchive = "$RemoteDirectory/$uploadName"
$remoteDirectoryQuoted = ConvertTo-PosixSingleQuoted $RemoteDirectory
$remoteArchiveQuoted = ConvertTo-PosixSingleQuoted $remoteArchive
$prepareScript = "mkdir -p -- $remoteDirectoryQuoted"
$cleanupScript = "rm -f -- $remoteArchiveQuoted"
$deployScript = "set -eu; trap $(ConvertTo-PosixSingleQuoted $cleanupScript) 0; tar -xzf $remoteArchiveQuoted -C $remoteDirectoryQuoted; cd -- $remoteDirectoryQuoted; $DeploymentCommand"

$plan = [ordered]@{
    dryRun = [bool] $DryRun
    projectRoot = $projectRoot
    destination = "$Username@$HostName`:$Port"
    identityFilePath = $resolvedIdentityPath
    remoteDirectory = $RemoteDirectory
    deploymentCommand = $DeploymentCommand
    archiveExclusions = @('.git', '.codex')
    hostKeyChecking = 'strict; the host must already exist in known_hosts'
    stages = @(
        'Create a temporary local tar.gz archive.',
        'Create the remote directory through the local ssh client.',
        'Upload the archive through the local scp client.',
        'Extract the archive, remove the uploaded archive, and run the exact deployment command.'
    )
}

if ($DryRun) {
    $plan | ConvertTo-Json -Depth 4
    exit 0
}

$sshCommand = Get-Command 'ssh.exe' -CommandType Application
$scpCommand = Get-Command 'scp.exe' -CommandType Application
$tarCommand = Get-Command 'tar.exe' -CommandType Application
$nullConfigPath = if ($IsWindows) { 'NUL' } else { '/dev/null' }
$commonOptions = @(
    '-F', $nullConfigPath,
    '-i', $resolvedIdentityPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15'
)
$sshArguments = @($commonOptions + @('-p', $Port.ToString(), '-l', $Username, $HostName))
$scpHost = if ($HostName.Contains(':')) { "[$HostName]" } else { $HostName }
$scpDestination = '{0}@{1}:{2}' -f $Username, $scpHost, $remoteArchive
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
        $commonOptions + @('-P', $Port.ToString(), $archivePath, $scpDestination)
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

Write-Output "Deployment completed successfully for $Username@$HostName`:$Port$RemoteDirectory."
