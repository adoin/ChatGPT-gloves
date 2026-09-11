Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:StoreSchemaVersion = 1
$script:EntropyLabel = 'OpenAI.Codex.local-ssh-deploy.profiles.v1'

function Assert-NoControlCharacters {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Value
    )

    if ($Value -match '[\x00-\x1F\x7F]') {
        throw "$Name must not contain control characters."
    }
}

function Assert-ProfileName {
    param([Parameter(Mandatory = $true)][string] $ProfileName)

    Assert-NoControlCharacters -Name 'ProfileName' -Value $ProfileName
    if ($ProfileName -notmatch '^[A-Za-z][A-Za-z0-9._-]{0,63}$') {
        throw 'ProfileName must start with a letter and contain only letters, digits, dot, underscore, or hyphen.'
    }
}

function Get-ProfileStoreInfo {
    if ($IsWindows) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [System.IO.Path]::IsPathFullyQualified($env:LOCALAPPDATA)) {
            throw 'LOCALAPPDATA must identify an absolute local directory.'
        }
        $directory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\local-ssh-deploy'
        $path = Join-Path $directory 'profiles.dat'
        return [pscustomobject]@{
            Backend = 'Windows DPAPI CurrentUser'
            Location = $path
            Directory = $directory
            Path = $path
        }
    }
    if ($IsMacOS) {
        return [pscustomobject]@{
            Backend = 'macOS Keychain'
            Location = 'Keychain service openai.codex.local-ssh-deploy, account profiles-v1'
            Directory = $null
            Path = $null
        }
    }
    if ($IsLinux) {
        return [pscustomobject]@{
            Backend = 'Linux Secret Service'
            Location = 'Secret Service item OpenAI Codex Local SSH Deploy Profiles'
            Directory = $null
            Path = $null
        }
    }
    throw 'This operating system does not have a supported secure profile backend.'
}

function Set-RestrictedAcl {
    param(
        [Parameter(Mandatory = $true)][string] $LiteralPath,
        [Parameter(Mandatory = $true)][bool] $Container
    )

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $userSid = $identity.User.Value
    $userGrant = if ($Container) { '*{0}:(OI)(CI)F' -f $userSid } else { '*{0}:F' -f $userSid }
    $systemGrant = if ($Container) { '*S-1-5-18:(OI)(CI)F' } else { '*S-1-5-18:F' }
    $icacls = Get-Command 'icacls.exe' -CommandType Application

    & $icacls.Source $LiteralPath '/inheritance:r' '/grant:r' $userGrant $systemGrant '/Q' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict access to profile storage at $LiteralPath."
    }
}

function Initialize-ProfileStoreDirectory {
    $store = Get-ProfileStoreInfo
    if (-not $IsWindows) {
        throw 'Filesystem profile storage is only used by the Windows DPAPI backend.'
    }
    if (-not (Test-Path -LiteralPath $store.Directory -PathType Container)) {
        New-Item -ItemType Directory -Path $store.Directory -Force | Out-Null
    }
    Set-RestrictedAcl -LiteralPath $store.Directory -Container $true
    return $store
}

function New-EmptyProfileStore {
    return [ordered]@{
        schemaVersion = $script:StoreSchemaVersion
        profiles = [ordered]@{}
    }
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $ArgumentList,
        [AllowNull()][string] $StandardInput
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    foreach ($argument in $ArgumentList) {
        $startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start secure profile backend process $FilePath."
    }
    if ($null -ne $StandardInput) {
        $process.StandardInput.Write($StandardInput)
    }
    $process.StandardInput.Close()
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = $outputTask.GetAwaiter().GetResult()
        Error = $errorTask.GetAwaiter().GetResult()
    }
}

function Initialize-MacKeychainBridge {
    if ($null -ne ('LocalSshDeploy.MacKeychain' -as [type])) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LocalSshDeploy
{
    public static class MacKeychain
    {
        private const int Success = 0;
        private const int ItemNotFound = -25300;
        private const string SecurityFramework = "/System/Library/Frameworks/Security.framework/Security";
        private const string CoreFoundationFramework = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

        [DllImport(SecurityFramework, EntryPoint = "SecKeychainFindGenericPassword")]
        private static extern int FindWithData(
            IntPtr keychainOrArray,
            uint serviceNameLength,
            [In] byte[] serviceName,
            uint accountNameLength,
            [In] byte[] accountName,
            out uint passwordLength,
            out IntPtr passwordData,
            IntPtr itemRef);

        [DllImport(SecurityFramework, EntryPoint = "SecKeychainFindGenericPassword")]
        private static extern int FindItem(
            IntPtr keychainOrArray,
            uint serviceNameLength,
            [In] byte[] serviceName,
            uint accountNameLength,
            [In] byte[] accountName,
            IntPtr passwordLength,
            IntPtr passwordData,
            out IntPtr itemRef);

        [DllImport(SecurityFramework)]
        private static extern int SecKeychainAddGenericPassword(
            IntPtr keychain,
            uint serviceNameLength,
            [In] byte[] serviceName,
            uint accountNameLength,
            [In] byte[] accountName,
            uint passwordLength,
            [In] byte[] passwordData,
            out IntPtr itemRef);

        [DllImport(SecurityFramework)]
        private static extern int SecKeychainItemModifyAttributesAndData(
            IntPtr itemRef,
            IntPtr attributes,
            uint dataLength,
            [In] byte[] data);

        [DllImport(SecurityFramework)]
        private static extern int SecKeychainItemFreeContent(IntPtr attributes, IntPtr data);

        [DllImport(CoreFoundationFramework)]
        private static extern void CFRelease(IntPtr value);

        private static readonly byte[] Service = Encoding.UTF8.GetBytes("openai.codex.local-ssh-deploy");
        private static readonly byte[] Account = Encoding.UTF8.GetBytes("profiles-v1");

        public static byte[] Read()
        {
            uint length;
            IntPtr data;
            int status = FindWithData(
                IntPtr.Zero,
                (uint)Service.Length,
                Service,
                (uint)Account.Length,
                Account,
                out length,
                out data,
                IntPtr.Zero);
            if (status == ItemNotFound)
            {
                return null;
            }
            if (status != Success)
            {
                throw new InvalidOperationException("macOS Keychain read failed with OSStatus " + status + ".");
            }

            try
            {
                byte[] result = new byte[length];
                if (length > 0)
                {
                    Marshal.Copy(data, result, 0, checked((int)length));
                }
                return result;
            }
            finally
            {
                SecKeychainItemFreeContent(IntPtr.Zero, data);
            }
        }

        public static void Write(byte[] value)
        {
            IntPtr item;
            int findStatus = FindItem(
                IntPtr.Zero,
                (uint)Service.Length,
                Service,
                (uint)Account.Length,
                Account,
                IntPtr.Zero,
                IntPtr.Zero,
                out item);

            if (findStatus == Success)
            {
                try
                {
                    int updateStatus = SecKeychainItemModifyAttributesAndData(
                        item,
                        IntPtr.Zero,
                        (uint)value.Length,
                        value);
                    if (updateStatus != Success)
                    {
                        throw new InvalidOperationException("macOS Keychain update failed with OSStatus " + updateStatus + ".");
                    }
                }
                finally
                {
                    CFRelease(item);
                }
                return;
            }

            if (findStatus != ItemNotFound)
            {
                throw new InvalidOperationException("macOS Keychain lookup failed with OSStatus " + findStatus + ".");
            }

            int addStatus = SecKeychainAddGenericPassword(
                IntPtr.Zero,
                (uint)Service.Length,
                Service,
                (uint)Account.Length,
                Account,
                (uint)value.Length,
                value,
                out item);
            if (item != IntPtr.Zero)
            {
                CFRelease(item);
            }
            if (addStatus != Success)
            {
                throw new InvalidOperationException("macOS Keychain add failed with OSStatus " + addStatus + ".");
            }
        }
    }
}
'@
}

function Read-PlatformSecret {
    if ($IsMacOS) {
        Initialize-MacKeychainBridge
        $secretBytes = [LocalSshDeploy.MacKeychain]::Read()
        if ($null -eq $secretBytes) {
            return $null
        }
        try {
            return [System.Text.Encoding]::UTF8.GetString($secretBytes)
        }
        finally {
            [System.Array]::Clear($secretBytes, 0, $secretBytes.Length)
        }
    }

    $secretTool = Get-Command 'secret-tool' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $secretTool) {
        throw 'Linux secure profiles require secret-tool and an available Secret Service provider; no plaintext fallback is used.'
    }
    $result = Invoke-CapturedProcess -FilePath $secretTool.Source -ArgumentList @(
        'lookup', 'application', 'openai-codex-local-ssh-deploy', 'item', 'profiles-v1'
    ) -StandardInput $null
    if ($result.ExitCode -eq 1 -and [string]::IsNullOrWhiteSpace($result.Error)) {
        return $null
    }
    if ($result.ExitCode -ne 0) {
        throw "Linux Secret Service could not read the deployment profiles: $($result.Error.Trim())"
    }
    return $result.Output.TrimEnd("`r", "`n")
}

function Write-PlatformSecret {
    param([Parameter(Mandatory = $true)][string] $Json)

    if ($IsMacOS) {
        Initialize-MacKeychainBridge
        $secretBytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
        try {
            [LocalSshDeploy.MacKeychain]::Write($secretBytes)
        }
        finally {
            [System.Array]::Clear($secretBytes, 0, $secretBytes.Length)
        }
        return
    }

    $secretTool = Get-Command 'secret-tool' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $secretTool) {
        throw 'Linux secure profiles require secret-tool and an available Secret Service provider; no plaintext fallback is used.'
    }
    $result = Invoke-CapturedProcess -FilePath $secretTool.Source -ArgumentList @(
        'store', '--label=OpenAI Codex Local SSH Deploy Profiles',
        'application', 'openai-codex-local-ssh-deploy', 'item', 'profiles-v1'
    ) -StandardInput $Json
    if ($result.ExitCode -ne 0) {
        throw "Linux Secret Service could not save the deployment profiles: $($result.Error.Trim())"
    }
}

function Read-ProfileStore {
    $store = Get-ProfileStoreInfo
    if ($IsWindows) {
        if (-not (Test-Path -LiteralPath $store.Path -PathType Leaf)) {
            return New-EmptyProfileStore
        }

        Set-RestrictedAcl -LiteralPath $store.Directory -Container $true
        Set-RestrictedAcl -LiteralPath $store.Path -Container $false
        $encryptedBytes = [System.IO.File]::ReadAllBytes($store.Path)
        $entropyBytes = [System.Text.Encoding]::UTF8.GetBytes($script:EntropyLabel)
        $plainBytes = $null
        try {
            $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $encryptedBytes,
                $entropyBytes,
                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            $json = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        }
        catch {
            throw "The encrypted profile store could not be read by the current Windows user: $($_.Exception.Message)"
        }
        finally {
            if ($null -ne $plainBytes) {
                [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
            }
            [System.Array]::Clear($encryptedBytes, 0, $encryptedBytes.Length)
            [System.Array]::Clear($entropyBytes, 0, $entropyBytes.Length)
        }
    }
    else {
        $json = Read-PlatformSecret
        if ($null -eq $json) {
            return New-EmptyProfileStore
        }
    }

    try {
        $parsed = $json | ConvertFrom-Json -Depth 8
    }
    catch {
        throw "The secure profile store contains invalid data: $($_.Exception.Message)"
    }

    if ($parsed.schemaVersion -ne $script:StoreSchemaVersion -or $null -eq $parsed.profiles) {
        throw 'The encrypted profile store has an unsupported schema.'
    }

    $profiles = [ordered]@{}
    foreach ($property in $parsed.profiles.PSObject.Properties) {
        Assert-ProfileName -ProfileName $property.Name
        $profiles[$property.Name] = $property.Value
    }

    return [ordered]@{
        schemaVersion = $script:StoreSchemaVersion
        profiles = $profiles
    }
}

function Write-ProfileStore {
    param([Parameter(Mandatory = $true)] $Document)

    $json = $Document | ConvertTo-Json -Depth 8 -Compress
    if (-not $IsWindows) {
        Write-PlatformSecret -Json $json
        return
    }

    $store = Initialize-ProfileStoreDirectory
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $entropyBytes = [System.Text.Encoding]::UTF8.GetBytes($script:EntropyLabel)
    $encryptedBytes = $null
    $temporaryPath = Join-Path $store.Directory ('.profiles-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')

    try {
        $encryptedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $entropyBytes,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes($temporaryPath, $encryptedBytes)
        Set-RestrictedAcl -LiteralPath $temporaryPath -Container $false
        Move-Item -LiteralPath $temporaryPath -Destination $store.Path -Force
        Set-RestrictedAcl -LiteralPath $store.Path -Container $false
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
        [System.Array]::Clear($entropyBytes, 0, $entropyBytes.Length)
        if ($null -ne $encryptedBytes) {
            [System.Array]::Clear($encryptedBytes, 0, $encryptedBytes.Length)
        }
    }
}

function Resolve-ConnectionData {
    param(
        [Parameter(Mandatory = $true)][string] $HostName,
        [Parameter(Mandatory = $true)][int] $Port,
        [Parameter(Mandatory = $true)][string] $Username,
        [Parameter(Mandatory = $true)][string] $IdentityFilePath,
        [Parameter(Mandatory = $true)][string] $RemoteDirectory,
        [Parameter(Mandatory = $true)][string] $DeploymentCommand,
        [string] $ProjectRoot
    )

    if ($Port -lt 1 -or $Port -gt 65535) {
        throw 'Port must be between 1 and 65535.'
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

    if (-not [string]::IsNullOrWhiteSpace($ProjectRoot)) {
        $trimChars = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        $trimmedProjectRoot = ([System.IO.Path]::GetFullPath($ProjectRoot)).TrimEnd($trimChars)
        $comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
        $projectPrefix = $trimmedProjectRoot + [System.IO.Path]::DirectorySeparatorChar
        if ($resolvedIdentityPath.Equals($trimmedProjectRoot, $comparison) -or $resolvedIdentityPath.StartsWith($projectPrefix, $comparison)) {
            throw 'IdentityFilePath must be outside the project directory so the key cannot be included in the deployment archive.'
        }
    }

    return [ordered]@{
        host = $HostName
        port = [int] $Port
        username = $Username
        identityFilePath = $resolvedIdentityPath
        remoteDirectory = $RemoteDirectory
        deploymentCommand = $DeploymentCommand
    }
}

function Save-DeploymentProfile {
    param(
        [Parameter(Mandatory = $true)][string] $ProfileName,
        [Parameter(Mandatory = $true)] $ConnectionData,
        [switch] $ConfirmOverwrite
    )

    Assert-ProfileName -ProfileName $ProfileName
    $normalizedConnection = Resolve-ConnectionData `
        -HostName $ConnectionData.host `
        -Port $ConnectionData.port `
        -Username $ConnectionData.username `
        -IdentityFilePath $ConnectionData.identityFilePath `
        -RemoteDirectory $ConnectionData.remoteDirectory `
        -DeploymentCommand $ConnectionData.deploymentCommand
    $document = Read-ProfileStore
    if ($document.profiles.Contains($ProfileName) -and -not $ConfirmOverwrite) {
        throw "Profile '$ProfileName' already exists. Obtain explicit confirmation and use -ConfirmOverwrite to replace it."
    }
    $document.profiles[$ProfileName] = $normalizedConnection
    Write-ProfileStore -Document $document
}

function Get-DeploymentProfile {
    param(
        [Parameter(Mandatory = $true)][string] $ProfileName,
        [string] $ProjectRoot
    )

    Assert-ProfileName -ProfileName $ProfileName
    $document = Read-ProfileStore
    if (-not $document.profiles.Contains($ProfileName)) {
        throw "Profile '$ProfileName' does not exist."
    }
    $profile = $document.profiles[$ProfileName]
    return Resolve-ConnectionData `
        -HostName $profile.host `
        -Port $profile.port `
        -Username $profile.username `
        -IdentityFilePath $profile.identityFilePath `
        -RemoteDirectory $profile.remoteDirectory `
        -DeploymentCommand $profile.deploymentCommand `
        -ProjectRoot $ProjectRoot
}

function Get-DeploymentProfileNames {
    $document = Read-ProfileStore
    return @($document.profiles.Keys | Sort-Object)
}

function Remove-DeploymentProfile {
    param(
        [Parameter(Mandatory = $true)][string] $ProfileName,
        [switch] $ConfirmDelete
    )

    Assert-ProfileName -ProfileName $ProfileName
    if (-not $ConfirmDelete) {
        throw "Refusing to delete profile '$ProfileName' without -ConfirmDelete."
    }
    $document = Read-ProfileStore
    if (-not $document.profiles.Contains($ProfileName)) {
        throw "Profile '$ProfileName' does not exist."
    }
    $document.profiles.Remove($ProfileName)
    Write-ProfileStore -Document $document
}

Export-ModuleMember -Function @(
    'Get-ProfileStoreInfo',
    'Resolve-ConnectionData',
    'Save-DeploymentProfile',
    'Get-DeploymentProfile',
    'Get-DeploymentProfileNames',
    'Remove-DeploymentProfile'
)
