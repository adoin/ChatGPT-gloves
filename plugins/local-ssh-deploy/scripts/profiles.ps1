[CmdletBinding(DefaultParameterSetName = 'List')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [switch] $Save,

    [Parameter(Mandatory = $true, ParameterSetName = 'List')]
    [switch] $List,

    [Parameter(Mandatory = $true, ParameterSetName = 'Show')]
    [switch] $Show,

    [Parameter(Mandatory = $true, ParameterSetName = 'Delete')]
    [switch] $Delete,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [Parameter(Mandatory = $true, ParameterSetName = 'Show')]
    [Parameter(Mandatory = $true, ParameterSetName = 'Delete')]
    [string] $ProfileName,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [string] $HostName,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [ValidateRange(1, 65535)]
    [int] $Port,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [string] $Username,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [string] $IdentityFilePath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [string] $RemoteDirectory,

    [Parameter(Mandatory = $true, ParameterSetName = 'Save')]
    [string] $DeploymentCommand,

    [Parameter(ParameterSetName = 'Save')]
    [switch] $ConfirmOverwrite,

    [Parameter(ParameterSetName = 'Delete')]
    [switch] $ConfirmDelete
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'LocalSshDeploy.psm1') -Force

$store = Get-ProfileStoreInfo

switch ($PSCmdlet.ParameterSetName) {
    'Save' {
        $connection = Resolve-ConnectionData `
            -HostName $HostName `
            -Port $Port `
            -Username $Username `
            -IdentityFilePath $IdentityFilePath `
            -RemoteDirectory $RemoteDirectory `
            -DeploymentCommand $DeploymentCommand
        Save-DeploymentProfile -ProfileName $ProfileName -ConnectionData $connection -ConfirmOverwrite:$ConfirmOverwrite
        [ordered]@{
            action = 'saved'
            profileName = $ProfileName
            storeBackend = $store.Backend
            storeLocation = $store.Location
            connection = $connection
        } | ConvertTo-Json -Depth 4
    }
    'List' {
        [ordered]@{
            profiles = @(Get-DeploymentProfileNames)
            storeBackend = $store.Backend
            storeLocation = $store.Location
        } | ConvertTo-Json -Depth 3
    }
    'Show' {
        $connection = Get-DeploymentProfile -ProfileName $ProfileName
        [ordered]@{
            profileName = $ProfileName
            storeBackend = $store.Backend
            storeLocation = $store.Location
            connection = $connection
        } | ConvertTo-Json -Depth 4
    }
    'Delete' {
        Remove-DeploymentProfile -ProfileName $ProfileName -ConfirmDelete:$ConfirmDelete
        [ordered]@{
            action = 'deleted'
            profileName = $ProfileName
            storeBackend = $store.Backend
            storeLocation = $store.Location
        } | ConvertTo-Json -Depth 3
    }
}
